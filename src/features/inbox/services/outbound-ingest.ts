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
  /** Required: it is the dedup key and what status webhooks match on. */
  wamid: string;
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

  const meta: Record<string, unknown> = {
    source: "external_automation",
    automated: true,
    origin,
    template_name: input.templateName,
    ...(input.placeholder ? { placeholder: true } : {}),
  };

  const findExisting = async () => {
    const { data } = await supabase
      .from("messages")
      .select("id, meta")
      .eq("workspace_id", input.workspaceId)
      .eq("wamid", input.wamid)
      .maybeSingle();
    return data as { id: string; meta: Record<string, unknown> | null } | null;
  };

  // Same wamid may arrive twice (push + webhook, or webhook retries). If what
  // we already stored is only a placeholder and we now hold the exact text,
  // upgrade it instead of discarding the better data.
  const reconcile = async (
    existing: { id: string; meta: Record<string, unknown> | null },
  ): Promise<OutboundIngestResult> => {
    if (existing.meta?.placeholder === true && !input.placeholder) {
      await supabase
        .from("messages")
        .update({ body: input.body, meta })
        .eq("id", existing.id);
      return { conversationId, messageId: existing.id, created: false, upgraded: true };
    }
    return { conversationId, messageId: existing.id, created: false, upgraded: false };
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
      wamid: input.wamid,
      status: input.status ?? "sent",
      sender_user_id: null,
      meta,
      created_at: sentAt,
    })
    .select("id")
    .single();

  if (error) {
    // Lost a race with the other entry point inserting the same wamid.
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

interface StatusWhatsappMessage {
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
    templateName,
    body,
    origin: "ycloud_webhook",
    sentAt: wm.sendTime ?? wm.createTime ?? null,
    status: status === "read" ? "read" : "delivered",
    placeholder,
  });
}
