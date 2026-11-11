import { createClient as createSbClient } from "@supabase/supabase-js";
import type { NormalizedInbound, NormalizedEcho } from "./ycloud-webhook-handler";
import type { ContactRow, ConversationRow, MessageRow } from "../types/index";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

/** Default country code when a workspace hasn't configured one (Mexico). */
export const DEFAULT_COUNTRY_CODE = "52";

/**
 * Normalises a phone string to E.164 format.
 * - Trims whitespace and separators, prepends '+' if missing.
 * - When the number arrives WITHOUT a country code (no '+', national length
 *   ≤ 10 digits), prepends the workspace's `defaultCountryCode`.
 */
export function normalizePhone(
  phone: string,
  defaultCountryCode?: string,
): string {
  const trimmed = phone.trim().replace(/[\s\-()]/g, "");
  if (trimmed.startsWith("+")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (defaultCountryCode && digits.length > 0 && digits.length <= 10) {
    return `+${defaultCountryCode}${digits}`;
  }
  return `+${digits}`;
}

/**
 * All E.164 spellings the same customer may arrive with. WhatsApp reports
 * Argentine mobiles as 54 9 XXXXXXXXXX or 54 XXXXXXXXXX, and Mexican ones as
 * 52 1 XXXXXXXXXX or 52 XXXXXXXXXX, depending on the API/direction. The first
 * element is the canonical spelling of the input.
 */
export function phoneVariants(phone: string): string[] {
  const digits = phone.replace(/\D/g, "");
  const out = [`+${digits}`];
  const swap = (cc: string, mobilePrefix: string) => {
    const withPrefix = cc + mobilePrefix;
    if (digits.startsWith(withPrefix) && digits.length === withPrefix.length + 10) {
      out.push(`+${cc}${digits.slice(withPrefix.length)}`);
    } else if (
      digits.startsWith(cc) &&
      !digits.startsWith(withPrefix) &&
      digits.length === cc.length + 10
    ) {
      out.push(`+${withPrefix}${digits.slice(cc.length)}`);
    }
  };
  swap("54", "9");
  swap("52", "1");
  return out;
}

/** True when two phone strings are the same number under any known spelling. */
export function samePhone(a: string, b: string): boolean {
  const bs = new Set(phoneVariants(b));
  return phoneVariants(a).some((v) => bs.has(v));
}

/**
 * If this customer already exists under another spelling of the same number
 * (e.g. created as +549… by an outbound notification, now writing from +54…),
 * returns the spelling that is already stored so the contact upsert hits the
 * existing row instead of creating a duplicate — a duplicate would split the
 * conversation and the agent would lose its context. Otherwise returns `phone`.
 */
export async function resolveStoredPhone(
  supabase: ReturnType<typeof svc>,
  workspaceId: string,
  phone: string,
): Promise<string> {
  const variants = phoneVariants(phone);
  if (variants.length === 1) return phone; // no alternate spelling exists

  const { data } = await supabase
    .from("contacts")
    .select("phone")
    .eq("workspace_id", workspaceId)
    .in("phone", variants);

  const stored = ((data ?? []) as { phone: string }[])
    .map((r) => r.phone)
    .sort((a, b) => variants.indexOf(a) - variants.indexOf(b));
  return stored[0] ?? phone;
}

export interface ProcessInboundResult {
  contact: ContactRow;
  conversation: ConversationRow;
  message: MessageRow | null;
}

/**
 * Persists an inbound message and its related contact/conversation records.
 *
 * - Upserts the contact (by workspace_id + phone).
 * - Upserts the conversation (by workspace_id + contact_id + channel),
 *   incrementing unread_count and refreshing last_message_at.
 * - Inserts the message, deduplicating on workspace_id + wamid.
 *   Returns message: null when the wamid already exists.
 */
export async function processInbound(
  workspaceId: string,
  normalized: NormalizedInbound,
): Promise<ProcessInboundResult> {
  const supabase = svc();

  // Per-workspace default country code for numbers without one.
  const { data: biRow } = await supabase
    .from("business_info")
    .select("structured")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const defaultCc =
    ((biRow?.structured as { default_country_code?: string } | null)
      ?.default_country_code as string) ?? DEFAULT_COUNTRY_CODE;

  const phone = await resolveStoredPhone(
    supabase,
    workspaceId,
    normalizePhone(normalized.from, defaultCc),
  );

  // 1. Upsert contact
  // A user messaging the business first is implicit opt-in for service
  // messages within the 24h window, so inbound contacts are opted in.
  // (STOP-keyword opt-out handling is future work and would guard this.)
  const { data: contactData, error: contactError } = await supabase
    .from("contacts")
    .upsert(
      {
        workspace_id: workspaceId,
        phone,
        // Only update name when the incoming value is non-null — a missing
        // profile name must not wipe one we already have (e.g. the name given
        // on the booking form).
        ...(normalized.customerName ? { name: normalized.customerName } : {}),
        opt_in: true,
        opt_in_at: new Date().toISOString(),
      },
      {
        onConflict: "workspace_id,phone",
        ignoreDuplicates: false,
      },
    )
    .select()
    .single();

  if (contactError || !contactData) {
    throw new Error(
      `[normalizer] contact upsert failed: ${contactError?.message}`,
    );
  }

  const contact = contactData as ContactRow;

  // 2. Upsert conversation — reset 24h window on every inbound
  const windowExpiresAt = new Date(
    Date.now() + 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data: convData, error: convError } = await supabase
    .from("conversations")
    .upsert(
      {
        workspace_id: workspaceId,
        contact_id: contact.id,
        channel: "whatsapp",
        last_message_at: new Date().toISOString(),
        window_expires_at: windowExpiresAt,
        unread_count: 1,
      },
      {
        onConflict: "workspace_id,contact_id,channel",
        ignoreDuplicates: false,
      },
    )
    .select()
    .single();

  if (convError || !convData) {
    throw new Error(
      `[normalizer] conversation upsert failed: ${convError?.message}`,
    );
  }

  const conversation = convData as ConversationRow;

  // 3. Insert message — deduplicate on wamid
  const { data: msgData, error: msgError } = await supabase
    .from("messages")
    .upsert(
      {
        workspace_id: workspaceId,
        conversation_id: conversation.id,
        direction: "in" as const,
        type: normalized.type,
        body: normalized.text,
        wamid: normalized.wamid,
        status: "delivered",
        meta: { from_name: normalized.customerName },
      },
      {
        onConflict: "workspace_id,wamid",
        ignoreDuplicates: true,
      },
    )
    .select()
    .single();

  // ignoreDuplicates: true means a conflict returns no rows — treat as dedup
  if (msgError && msgError.code !== "PGRST116") {
    throw new Error(`[normalizer] message insert failed: ${msgError?.message}`);
  }

  const message = msgData ? (msgData as MessageRow) : null;

  // F8-D1: media download hooks in here when message.type !== 'text' and message is not a dedup.
  // The webhook handler extracts the media `link` from the raw YCloud payload and passes it
  // alongside the NormalizedInbound. Once available, the call pattern is:
  //
  //   if (message && normalized.mediaLink && normalized.type !== 'text') {
  //     void downloadAndStoreMedia({ link: normalized.mediaLink, apiKey, workspaceId, ... })
  //       .then((meta) => meta && patchMessageMedia(workspaceId, message.id, meta))
  //   }
  //
  // See media-handler.ts for downloadAndStoreMedia() and patchMessageMedia().
  // NormalizedInbound extension (mediaLink field) + webhook wiring is D2 scope.

  return { contact, conversation, message };
}

export interface ProcessEchoResult {
  contact: ContactRow;
  conversation: ConversationRow;
  message: MessageRow | null;
}

/**
 * Persists a message the business sent from the native WhatsApp Business App
 * (coexistence "echo"), so the panel reflects what was replied outside it.
 *
 * - Upserts the contact/conversation, same as processInbound, but does NOT
 *   touch window_expires_at (only a customer inbound resets the service
 *   window) — it does clear unread_count since a human just handled this.
 * - Inserts the message with direction 'out' and meta.source marking it as
 *   sent from the native app, so the UI doesn't attribute it to the AI
 *   (sender_user_id is null here too, since no panel user sent it).
 */
export async function processSmbEcho(
  workspaceId: string,
  normalized: NormalizedEcho,
): Promise<ProcessEchoResult> {
  const supabase = svc();

  const { data: biRow } = await supabase
    .from("business_info")
    .select("structured")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const defaultCc =
    ((biRow?.structured as { default_country_code?: string } | null)
      ?.default_country_code as string) ?? DEFAULT_COUNTRY_CODE;

  const phone = await resolveStoredPhone(
    supabase,
    workspaceId,
    normalizePhone(normalized.to, defaultCc),
  );

  const { data: contactData, error: contactError } = await supabase
    .from("contacts")
    .upsert(
      {
        workspace_id: workspaceId,
        phone,
        opt_in: true,
        opt_in_at: new Date().toISOString(),
      },
      {
        onConflict: "workspace_id,phone",
        ignoreDuplicates: false,
      },
    )
    .select()
    .single();

  if (contactError || !contactData) {
    throw new Error(
      `[normalizer] echo contact upsert failed: ${contactError?.message}`,
    );
  }

  const contact = contactData as ContactRow;

  const { data: convData, error: convError } = await supabase
    .from("conversations")
    .upsert(
      {
        workspace_id: workspaceId,
        contact_id: contact.id,
        channel: "whatsapp",
        last_message_at: new Date().toISOString(),
        unread_count: 0,
      },
      {
        onConflict: "workspace_id,contact_id,channel",
        ignoreDuplicates: false,
      },
    )
    .select()
    .single();

  if (convError || !convData) {
    throw new Error(
      `[normalizer] echo conversation upsert failed: ${convError?.message}`,
    );
  }

  const conversation = convData as ConversationRow;

  const { data: msgData, error: msgError } = await supabase
    .from("messages")
    .upsert(
      {
        workspace_id: workspaceId,
        conversation_id: conversation.id,
        direction: "out" as const,
        type: normalized.type,
        body: normalized.text,
        wamid: normalized.wamid,
        status: "sent",
        meta: { source: "whatsapp_business_app" },
      },
      {
        onConflict: "workspace_id,wamid",
        ignoreDuplicates: true,
      },
    )
    .select()
    .single();

  if (msgError && msgError.code !== "PGRST116") {
    throw new Error(`[normalizer] echo message insert failed: ${msgError?.message}`);
  }

  const message = msgData ? (msgData as MessageRow) : null;

  return { contact, conversation, message };
}
