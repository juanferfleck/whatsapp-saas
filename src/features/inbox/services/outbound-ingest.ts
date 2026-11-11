/**
 * outbound-ingest.ts — records template messages the business sent OUTSIDE
 * this app (e.g. the booking system calling the YCloud API directly), so they
 * show up in the inbox AND in the agent's conversation history.
 *
 * Without this, the customer's reply ("gracias") reaches an agent that has no
 * idea what it is replying to, because `getConversationHistory` only reads the
 * `messages` table.
 *
 * Two entry points feed this module:
 *   1. POST /api/internal/outbound-message — the sender pushes the exact
 *      rendered text right after sending (precise).
 *   2. The YCloud `whatsapp.message.updated` webhook — for a wamid we never
 *      tracked, rebuilt from the approved template (safety net; variables may
 *      be unknown, so the row is flagged `meta.placeholder`).
 *
 * Deliberately does NOT: reset the 24h window (only a customer inbound does),
 * clear unread_count, or move the conversation to `human_active` — an
 * automated notification must never put the AI to sleep.
 */

import { createClient as createSbClient } from "@supabase/supabase-js";
import { phoneVariants, samePhone } from "./normalizer";
import { loadTemplateBody, renderTemplateBody } from "./templates";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Core ingest
// ──────────────────────────────────────────────────────────────────────────────

export interface OutboundIngestInput {
  workspaceId: string;
  /** Customer phone (any spelling). */
  to: string;
  /**
   * WhatsApp message id. YCloud does NOT return it when a message is sent — it
   * only arrives later in the status webhook — so external senders normally
   * omit it and identify the message with `ycloudId` instead.
   */
  wamid?: string | null;
  /** YCloud's own message id (returned synchronously by the send API). */
  ycloudId?: string | null;
  templateName: string;
  /** Rendered message text the customer actually received. */
  body: string;
  /** Who sent it, e.g. "reservas". Free text, shown nowhere critical. */
  origin?: string;
  contactName?: string | null;
  /** ISO timestamp of the send; defaults to now. */
  sentAt?: string | null;
  status?: "queued" | "sent" | "delivered" | "read";
  /** True when `body` still contains unknown variables (webhook fallback). */
  placeholder?: boolean;
}

export interface OutboundIngestResult {
  conversationId: string;
  messageId: string | null;
  /** A new row was inserted. */
  created: boolean;
  /** An existing placeholder row was replaced with the exact text. */
  upgraded: boolean;
}

type Svc = ReturnType<typeof svc>;

async function findOrCreateContact(
  supabase: Svc,
  workspaceId: string,
  to: string,
  name: string | null | undefined,
  origin: string,
): Promise<string> {
  const variants = phoneVariants(to);

  const lookup = async () => {
    const { data } = await supabase
      .from("contacts")
      .select("id, phone, name")
      .eq("workspace_id", workspaceId)
      .in("phone", variants);
    const rows = (data ?? []) as { id: string; phone: string; name: string | null }[];
    // Prefer the spelling we were given, then the alternates, in order.
    rows.sort((a, b) => variants.indexOf(a.phone) - variants.indexOf(b.phone));
    return rows[0] ?? null;
  };

  let contact = await lookup();

  if (!contact) {
    // ignoreDuplicates → a concurrent insert of the same phone is not an error.
    // opt_in is intentionally left at its default (false): booking a class is
    // not a marketing opt-in, so we must not claim one.
    await supabase.from("contacts").upsert(
      {
        workspace_id: workspaceId,
        phone: variants[0],
        name: name ?? null,
        source: origin,
      },
      { onConflict: "workspace_id,phone", ignoreDuplicates: true },
    );
    contact = await lookup();
  } else if (!contact.name && name) {
    await supabase.from("contacts").update({ name }).eq("id", contact.id);
  }

  if (!contact) {
    throw new Error("[outbound-ingest] contact lookup/insert failed");
  }
  return contact.id;
}

async function findOrCreateConversation(
  supabase: Svc,
  workspaceId: string,
  contactId: string,
): Promise<string> {
  const select = () =>
    supabase
      .from("conversations")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("contact_id", contactId)
      .eq("channel", "whatsapp")
      .maybeSingle();

  let { data: conv } = await select();

  if (!conv) {
    // ignoreDuplicates → never overwrites an existing row's unread_count,
    // window or state. A brand-new conversation starts with no open window.
    await supabase.from("conversations").upsert(
      {
        workspace_id: workspaceId,
        contact_id: contactId,
        channel: "whatsapp",
        unread_count: 0,
      },
      { onConflict: "workspace_id,contact_id,channel", ignoreDuplicates: true },
    );
    ({ data: conv } = await select());
  }

  if (!conv) {
    throw new Error("[outbound-ingest] conversation lookup/insert failed");
  }
  return (conv as { id: string }).id;
}

export async function ingestOutboundTemplate(
  input: OutboundIngestInput,
): Promise<OutboundIngestResult> {
  const supabase = svc();
  const origin = input.origin?.trim() || "external";

  const contactId = await findOrCreateContact(
    supabase,
    input.workspaceId,
    input.to,
    input.contactName,
    origin,
  );
  const conversationId = await findOrCreateConversation(
    supabase,
    input.workspaceId,
    contactId,
  );

  const wamid = input.wamid || null;
  const ycloudId = input.ycloudId || null;
  if (!wamid && !ycloudId) {
    throw new Error("[outbound-ingest] wamid or ycloudId is required");
  }

  const buildMeta = (prev?: Record<string, unknown> | null) => {
    const keepId = ycloudId ?? (prev?.ycloud_id as string | undefined) ?? null;
    return {
      source: "external_automation",
      automated: true,
      origin,
      template_name: input.templateName,
      ...(keepId ? { ycloud_id: keepId } : {}),
      ...(input.placeholder ? { placeholder: true } : {}),
    } as Record<string, unknown>;
  };

  type Existing = {
    id: string;
    wamid: string | null;
    meta: Record<string, unknown> | null;
  };

  // A message can be reported more than once under different ids: the sender
  // pushes it by ycloudId, then the status webhook brings the wamid (or the
  // webhook gets there first and the push follows). Look by both.
  const findExisting = async (): Promise<Existing | null> => {
    if (wamid) {
      const { data } = await supabase
        .from("messages")
        .select("id, wamid, meta")
        .eq("workspace_id", input.workspaceId)
        .eq("wamid", wamid)
        .limit(1)
        .maybeSingle();
      if (data) return data as Existing;
    }
    if (ycloudId) {
      const { data } = await supabase
        .from("messages")
        .select("id, wamid, meta")
        .eq("workspace_id", input.workspaceId)
        .contains("meta", { ycloud_id: ycloudId })
        .limit(1)
        .maybeSingle();
      if (data) return data as Existing;
    }
    return null;
  };

  // If what we already stored is only a placeholder and we now hold the exact
  // text, upgrade it instead of discarding the better data; also fill in a
  // wamid the existing row was still missing.
  const reconcile = async (existing: Existing): Promise<OutboundIngestResult> => {
    const patch: Record<string, unknown> = {};
    if (!existing.wamid && wamid) patch.wamid = wamid;
    if (existing.meta?.placeholder === true && !input.placeholder) {
      patch.body = input.body;
      patch.meta = buildMeta(existing.meta);
    } else if (ycloudId && !existing.meta?.ycloud_id) {
      patch.meta = { ...(existing.meta ?? {}), ycloud_id: ycloudId };
    }

    if (Object.keys(patch).length > 0) {
      let { error } = await supabase.from("messages").update(patch).eq("id", existing.id);
      if (error?.code === "23505" && patch.wamid) {
        // Another row already owns that wamid — keep the rest of the patch.
        delete patch.wamid;
        if (Object.keys(patch).length > 0) {
          ({ error } = await supabase.from("messages").update(patch).eq("id", existing.id));
        }
      }
      if (error && error.code !== "23505") {
        throw new Error(`[outbound-ingest] message update failed: ${error.message}`);
      }
    }
    return {
      conversationId,
      messageId: existing.id,
      created: false,
      upgraded: patch.body !== undefined,
    };
  };

  const existing = await findExisting();
  if (existing) return reconcile(existing);

  const sentAt = input.sentAt && !Number.isNaN(Date.parse(input.sentAt))
    ? new Date(input.sentAt).toISOString()
    : new Date().toISOString();

  const { data: inserted, error } = await supabase
    .from("messages")
    .insert({
      workspace_id: input.workspaceId,
      conversation_id: conversationId,
      direction: "out",
      // type='template' bypasses the 24h-window DB guard (and is what it is).
      type: "template",
      body: input.body,
      wamid,
      status: input.status ?? "sent",
      sender_user_id: null,
      meta: buildMeta(),
      created_at: sentAt,
    })
    .select("id")
    .single();

  if (error) {
    // Lost a race with the other entry point inserting the same message.
    if (error.code === "23505") {
      const winner = await findExisting();
      if (winner) return reconcile(winner);
    }
    throw new Error(`[outbound-ingest] message insert failed: ${error.message}`);
  }

  // Surface it at the top of the inbox without touching unread_count,
  // window_expires_at or state.
  await supabase
    .from("conversations")
    .update({ last_message_at: sentAt })
    .eq("id", conversationId);

  return {
    conversationId,
    messageId: (inserted as { id: string }).id,
    created: true,
    upgraded: false,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Workspace resolution (by the business number that sent the message)
// ──────────────────────────────────────────────────────────────────────────────

export async function resolveWorkspaceByBusinessPhone(
  businessPhone: string,
): Promise<string | null> {
  const { data } = await svc()
    .from("integrations")
    .select("workspace_id, config")
    .eq("provider", "ycloud")
    .eq("enabled", true);

  const match = ((data ?? []) as {
    workspace_id: string;
    config: { phone_number?: string } | null;
  }[]).find(
    (i) => i.config?.phone_number && samePhone(i.config.phone_number, businessPhone),
  );
  return match?.workspace_id ?? null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Webhook fallback — `whatsapp.message.updated` for a wamid we never tracked
// ──────────────────────────────────────────────────────────────────────────────

export interface StatusWhatsappMessage {
  /** YCloud's own message id (same one the send API returned). */
  id?: string;
  wamid?: string;
  to?: string;
  type?: string;
  sendTime?: string;
  createTime?: string;
  template?: {
    name?: string;
    language?: { code?: string };
    components?: { type?: string; parameters?: { text?: string }[] }[];
  };
}

/** Body parameters ({{1}}, {{2}}…) if YCloud echoes them back, else []. */
function extractBodyParams(wm: StatusWhatsappMessage): string[] {
  const components = wm.template?.components;
  if (!Array.isArray(components)) return [];
  const body = components.find((c) => c.type?.toLowerCase() === "body");
  return (body?.parameters ?? []).map((p) => (typeof p.text === "string" ? p.text : ""));
}

/**
 * Called when a status webhook references a wamid that is not in `messages`.
 * That happens for template messages sent by another system through the same
 * YCloud account. Records them so the agent has context.
 *
 * Only reacts to `delivered`/`read`: those arrive after the customer's phone
 * acknowledged the message, which keeps us clear of the short window in which
 * our own dispatchTemplate() has sent but not yet persisted its row.
 */
export async function ingestUntrackedFromStatus(
  workspaceId: string,
  wm: StatusWhatsappMessage | undefined,
  status: string,
): Promise<OutboundIngestResult | null> {
  if (status !== "delivered" && status !== "read") return null;
  if (!wm?.wamid || !wm.to || wm.type !== "template") return null;

  const templateName = wm.template?.name;
  if (!templateName) return null;

  const templateBody = await loadTemplateBody(
    workspaceId,
    templateName,
    wm.template?.language?.code,
  );

  let body: string;
  let placeholder: boolean;
  if (templateBody) {
    const rendered = renderTemplateBody(templateBody, extractBodyParams(wm));
    body = rendered.text;
    placeholder = !rendered.complete;
  } else {
    // Template not synced into this workspace — still tell the agent something
    // was sent, even if we cannot say what it said.
    body = `[Se envió automáticamente la plantilla "${templateName}"]`;
    placeholder = true;
  }

  return ingestOutboundTemplate({
    workspaceId,
    to: wm.to,
    wamid: wm.wamid,
    ycloudId: wm.id ?? null,
    templateName,
    body,
    origin: "ycloud_webhook",
    sentAt: wm.sendTime ?? wm.createTime ?? null,
    status: status === "read" ? "read" : "delivered",
    placeholder,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Adopt a pushed row when its wamid finally shows up in a status webhook
// ──────────────────────────────────────────────────────────────────────────────

type AdoptedRow = { id: string; status: string | null };

/** How long after a push a status event may still be matched by template+phone. */
const ADOPT_WINDOW_MS = 30 * 60 * 1000;

/**
 * An external sender pushes its message BEFORE the wamid exists (YCloud only
 * reveals it in the first status webhook), so that row has `wamid = null`.
 * When a status event arrives for an unknown wamid, find that row, store the
 * wamid on it and hand it back — the caller then applies the status to it like
 * to any tracked message, and the later events match by wamid directly.
 *
 * Matching: by YCloud's message id when the event carries it (exact);
 * otherwise by template name + customer phone among rows pushed in the last
 * 30 min, oldest first, since events arrive in send order.
 */
export async function adoptExternalOutbound(
  workspaceId: string,
  wm: StatusWhatsappMessage | undefined,
): Promise<AdoptedRow | null> {
  if (!wm?.wamid) return null;
  const supabase = svc();

  let row: AdoptedRow | null = null;

  if (wm.id) {
    const { data } = await supabase
      .from("messages")
      .select("id, status")
      .eq("workspace_id", workspaceId)
      .is("wamid", null)
      .contains("meta", { ycloud_id: wm.id })
      .limit(1)
      .maybeSingle();
    row = (data as AdoptedRow | null) ?? null;
  } else if (wm.type === "template" && wm.template?.name && wm.to) {
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id")
      .eq("workspace_id", workspaceId)
      .in("phone", phoneVariants(wm.to));
    const contactIds = ((contacts ?? []) as { id: string }[]).map((c) => c.id);

    if (contactIds.length > 0) {
      const { data: convs } = await supabase
        .from("conversations")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("channel", "whatsapp")
        .in("contact_id", contactIds);
      const convIds = ((convs ?? []) as { id: string }[]).map((c) => c.id);

      if (convIds.length > 0) {
        const { data } = await supabase
          .from("messages")
          .select("id, status")
          .eq("workspace_id", workspaceId)
          .in("conversation_id", convIds)
          .eq("direction", "out")
          .eq("type", "template")
          .is("wamid", null)
          .contains("meta", { template_name: wm.template.name, automated: true })
          .gte("created_at", new Date(Date.now() - ADOPT_WINDOW_MS).toISOString())
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        row = (data as AdoptedRow | null) ?? null;
      }
    }
  }

  if (!row) return null;

  const { error } = await supabase
    .from("messages")
    .update({ wamid: wm.wamid })
    .eq("id", row.id)
    .is("wamid", null);
  // 23505: another row already owns this wamid (a concurrent event won). Let
  // the caller treat it as untracked; the ingest path dedups by itself.
  return error ? null : row;
}
