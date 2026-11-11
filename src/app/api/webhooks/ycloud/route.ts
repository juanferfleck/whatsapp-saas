import { type NextRequest, NextResponse, after } from "next/server";
import { createClient as createSbClient } from "@supabase/supabase-js";
import {
  verifyYCloudSignature,
  parseInbound,
  parseSmbEcho,
} from "@/features/inbox/services/ycloud-webhook-handler";
import { processInbound, processSmbEcho } from "@/features/inbox/services/normalizer";
import {
  adoptExternalOutbound,
  ingestUntrackedFromStatus,
} from "@/features/inbox/services/outbound-ingest";
import { checkRateLimits } from "@/features/inbox/services/cost-tracker";
import {
  upsertBatch,
  processNextBatch,
} from "@/features/inbox/services/buffer";
import {
  downloadAndStoreMedia,
  patchMessageMedia,
} from "@/features/inbox/services/media-handler";
import {
  transcribeAudio,
  describeImage,
} from "@/features/inbox/services/media-understanding";
import { applyTransition } from "@/features/inbox/services/decision-engine";
import { getActiveAgent } from "@/features/agents/services/active-agent";

// Keep the function alive long enough for the best-effort fast path below
// (sleep through the buffer window + AI generation). The cron is the fallback.
export const maxDuration = 60;

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

// WH-02: monotonic status order — never go backwards
const STATUS_ORDER = ["queued", "sent", "delivered", "read"] as const;
type OrderedStatus = (typeof STATUS_ORDER)[number];
type MessageStatus = OrderedStatus | "failed";

async function handleStatusUpdate(
  supabase: ReturnType<typeof svc>,
  workspaceId: string,
  whatsappMessage: Parameters<typeof ingestUntrackedFromStatus>[1],
  wamid: string,
  newStatus: string,
): Promise<void> {
  const { data: found } = await supabase
    .from("messages")
    .select("id, status")
    .eq("workspace_id", workspaceId)
    .eq("wamid", wamid)
    .maybeSingle();

  let msg: { id: string; status: string | null } | null = found ?? null;

  // A row pushed by another system (e.g. booking confirmations) has no wamid
  // yet — YCloud only reveals it here. Attach it so the status applies to it.
  if (!msg) {
    try {
      msg = await adoptExternalOutbound(workspaceId, whatsappMessage);
    } catch (e) {
      console.warn(
        "[webhook] adopt external outbound skipped:",
        e instanceof Error ? e.message : "unknown",
      );
    }
  }

  // Still not found — an outbound we didn't track at all: typically a template
  // sent by another system through this same YCloud number that never pushed.
  // Record it so the agent has the context when the customer replies. Never let
  // a failure here break the status webhook.
  if (!msg) {
    try {
      await ingestUntrackedFromStatus(workspaceId, whatsappMessage, newStatus);
    } catch (e) {
      console.warn(
        "[webhook] untracked outbound ingest skipped:",
        e instanceof Error ? e.message : "unknown",
      );
    }
    return;
  }

  const current = msg.status as MessageStatus | null;

  // 'failed' is terminal — always apply regardless of current state
  if (newStatus === "failed") {
    await supabase
      .from("messages")
      .update({ status: "failed" })
      .eq("id", msg.id);
    return;
  }

  // For ordered statuses: only advance, never go back
  const currentIdx = current
    ? STATUS_ORDER.indexOf(current as OrderedStatus)
    : -1;
  const newIdx = STATUS_ORDER.indexOf(newStatus as OrderedStatus);

  if (newIdx > currentIdx) {
    await supabase
      .from("messages")
      .update({ status: newStatus })
      .eq("id", msg.id);
  }
  // else: same or lower status — ignore (monotonic guarantee)
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const rawBody = await request.text();
    const sigHeader = request.headers.get("YCloud-Signature");

    // E3: per-tenant webhook routing via ?wsid query param
    const wsidParam = request.nextUrl.searchParams.get("wsid");

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // WH-02: classify the event. Status updates carry NO `to` phone — they can
    // only be routed via the ?wsid query param. Signature verification MUST
    // happen before we act on EITHER a status update or an inbound message.
    const isStatusUpdate =
      typeof body === "object" &&
      body !== null &&
      "type" in body &&
      (body as { type: string }).type === "whatsapp.message.updated";

    // Coexistence: message sent by the business from the native WhatsApp
    // Business App (not through our API) — YCloud syncs it back to us so we
    // know a human already replied and the AI should stop on that thread.
    const isSmbEcho =
      typeof body === "object" &&
      body !== null &&
      "type" in body &&
      (body as { type: string }).type === "whatsapp.smb.message.echoes";

    // Extract destination phone to identify the workspace integration (inbound).
    // For an echo, the identifying phone is the BUSINESS number (whatsappMessage.from)
    // rather than the customer's — the message direction is reversed.
    const toPhone =
      typeof body === "object" &&
      body !== null &&
      "whatsappInboundMessage" in body
        ? ((body as { whatsappInboundMessage?: { to?: string } })
            .whatsappInboundMessage?.to ?? null)
        : isSmbEcho &&
            typeof body === "object" &&
            body !== null &&
            "whatsappMessage" in body
          ? ((body as { whatsappMessage?: { from?: string } })
              .whatsappMessage?.from ?? null)
          : null;

    // Events that carry NO actionable data AND cannot identify a workspace
    // (no wsid, no inbound `to`, not a status update) → harmless early 200.
    if (!isStatusUpdate && !toPhone && !wsidParam) {
      return NextResponse.json({ received: true });
    }

    const supabase = svc();

    type IntegrationRow = {
      workspace_id: string;
      credentials: Record<string, unknown>;
      config: Record<string, unknown>;
    };

    let ws: IntegrationRow | null = null;

    if (wsidParam) {
      // E3: direct lookup by workspace_id — faster, no phone scan needed.
      // Status updates always take this path (they have no inbound `to`).
      const { data } = await supabase
        .from("integrations")
        .select("workspace_id, credentials, config")
        .eq("workspace_id", wsidParam)
        .eq("provider", "ycloud")
        .eq("enabled", true)
        .single();
      ws = data ?? null;
    } else {
      // Fallback: phone-based lookup across all enabled integrations (inbound)
      const { data: integrations } = await supabase
        .from("integrations")
        .select("workspace_id, credentials, config")
        .eq("provider", "ycloud")
        .eq("enabled", true)
        .limit(10);

      ws =
        (integrations ?? []).find(
          (i: IntegrationRow) =>
            (i.config as { phone_number?: string }).phone_number === toPhone,
        ) ?? null;
    }

    // No resolvable workspace → 401. A status update without a resolvable
    // (and below, verified) workspace must NEVER fall through to 200.
    if (!ws) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const creds = ws.credentials as {
      ycloud_api_key?: string;
      webhook_signing_secret?: string;
    };

    const webhookSecret = creds.webhook_signing_secret;
    if (!webhookSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // CRITICAL: verify the signature BEFORE acting on ANY event (status or inbound).
    if (!verifyYCloudSignature(rawBody, sigHeader, webhookSecret)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // WH-02: monotonic status updates — only reached after signature verification.
    if (isStatusUpdate) {
      const statusData = (
        body as {
          whatsappMessage?: { wamid?: string; status?: string } & NonNullable<
            Parameters<typeof ingestUntrackedFromStatus>[1]
          >;
        }
      ).whatsappMessage;
      if (statusData?.wamid && statusData?.status) {
        await handleStatusUpdate(
          supabase,
          ws.workspace_id as string,
          statusData,
          statusData.wamid,
          statusData.status,
        );
      }
      return NextResponse.json({ received: true });
    }

    // Coexistence echo — the business replied from the native app. Record it
    // and stop the AI on this thread, same as a manual inbox reply does.
    if (isSmbEcho) {
      const normalizedEcho = parseSmbEcho(body);
      if (!normalizedEcho) {
        return NextResponse.json({ received: true });
      }

      const workspaceId = ws.workspace_id as string;
      const { conversation, message } = await processSmbEcho(
        workspaceId,
        normalizedEcho,
      );

      // Duplicate wamid (webhook retry) — already handled on first delivery.
      if (message && conversation.ai_enabled) {
        try {
          const activeAgent = await getActiveAgent(workspaceId);
          const sleepOnManual =
            activeAgent?.config.sleepOnManualMessage !== false;
          if (sleepOnManual) {
            await applyTransition(conversation.id, "human_active");
          }
        } catch (e) {
          console.warn(
            "[webhook] echo sleep-on-manual skipped:",
            e instanceof Error ? e.message : e,
          );
        }
      }

      return NextResponse.json({ received: true, echo: true });
    }

    const normalized = parseInbound(body);
    if (!normalized) {
      return NextResponse.json({ received: true });
    }

    const workspaceId = ws.workspace_id as string;
    const { contact, conversation, message } = await processInbound(
      workspaceId,
      normalized,
    );

    // Duplicate wamid — already processed
    if (!message) {
      return NextResponse.json({ received: true, dedup: true });
    }

    // Media handling (download + AI understanding) runs AFTER the response so
    // the webhook stays fast. transcript/description land in meta before the
    // batch is processed, so the agent reads voice notes/images as text.
    const mediaLink = normalized.type !== "text" ? normalized.mediaLink : null;
    const messageId = message.id;
    const conversationId = conversation.id;
    const mediaJob = mediaLink
      ? async () => {
          try {
            const mediaMeta = await downloadAndStoreMedia({
              link: mediaLink,
              apiKey: creds.ycloud_api_key ?? "",
              workspaceId,
              conversationId,
              mimeType: normalized.mediaMime ?? undefined,
              filename: normalized.mediaFilename ?? undefined,
              caption:
                normalized.text && normalized.text !== "[Multimedia]"
                  ? normalized.text
                  : undefined,
              ycloudMediaId: normalized.mediaId ?? undefined,
            });
            if (!mediaMeta) return;

            // Translate voice/image to text so the agent understands them.
            if (normalized.type === "audio" || normalized.type === "voice") {
              const transcript = await transcribeAudio({
                storagePath: mediaMeta.storage_path,
                mimeType: mediaMeta.mime_type,
                workspaceId,
              });
              if (transcript) mediaMeta.transcript = transcript;
            } else if (normalized.type === "image") {
              const description = await describeImage({
                storagePath: mediaMeta.storage_path,
                mimeType: mediaMeta.mime_type,
                caption: mediaMeta.caption,
                workspaceId,
              });
              if (description) mediaMeta.description = description;
            }

            await patchMessageMedia(workspaceId, messageId, mediaMeta);
          } catch (mediaErr) {
            console.error(
              "[webhook] media handling failed:",
              mediaErr instanceof Error ? mediaErr.message : "unknown",
            );
          }
        }
      : null;

    // AI is toggled off — still fetch the media so the human agent sees it.
    if (!conversation.ai_enabled) {
      if (mediaJob) after(mediaJob);
      return NextResponse.json({ received: true, ai: false });
    }

    // Rate-limit check — still runs here to avoid buffering rate-limited contacts
    const { allowed, reason } = await checkRateLimits(workspaceId, contact.id);
    if (!allowed) {
      // SEC-09: log only non-sensitive fields (no credentials or contact PII)
      console.warn("[webhook] rate limited:", reason ?? "unknown reason");
      if (mediaJob) after(mediaJob);
      return NextResponse.json({ received: true, rateLimited: true });
    }

    // Buffer the message — AI reply is deferred to the cron job.
    // The silence window is configurable per workspace (YCloud settings).
    const bufferSeconds = Number(
      (ws.config as { buffer_silence_seconds?: number }).buffer_silence_seconds,
    );
    const silenceMs =
      Number.isFinite(bufferSeconds) && bufferSeconds >= 3
        ? Math.min(bufferSeconds, 120) * 1000
        : undefined;

    await upsertBatch({
      workspaceId,
      conversationId: conversation.id,
      messageId: message.id,
      silenceMs,
    });

    // Best-effort fast path: process the batch the moment its buffer window
    // closes, instead of waiting up to ~60s for the next cron tick. Runs after
    // the response is sent. If the function is recycled before it fires, the
    // every-minute cron still picks the batch up — so this only ever speeds
    // things up, never breaks them. A later message extends flush_at, so an
    // early fire simply claims nothing and the latest fire does the work.
    const effectiveSilenceMs = silenceMs ?? 30_000;
    after(async () => {
      // Download + understand media first so the transcript/description is in
      // meta before the batch is consolidated for the agent.
      if (mediaJob) await mediaJob();
      await new Promise((resolve) =>
        setTimeout(resolve, effectiveSilenceMs + 500),
      );
      try {
        await processNextBatch();
      } catch (e) {
        console.error(
          "[webhook] fast-path process error:",
          e instanceof Error ? e.message : "unknown",
        );
      }
    });

    return NextResponse.json({ received: true, buffered: true });
  } catch (err) {
    // SEC-09: never log full error objects — they may contain credentials or raw payloads
    console.error(
      "[webhook] unhandled error:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
