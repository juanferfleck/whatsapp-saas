import { timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  ingestOutboundTemplate,
  resolveWorkspaceByBusinessPhone,
} from "@/features/inbox/services/outbound-ingest";

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/internal/outbound-message
//
// Server-to-server. Another system (e.g. the class-booking app) that sent a
// WhatsApp template through the SAME YCloud number reports it here right after
// sending, so the message lands in `messages` and the AI agent knows about it
// when the customer replies.
//
// Auth: `Authorization: Bearer ${OUTBOUND_INGEST_SECRET}` (shared secret).
// The workspace is resolved from the business number (`from`) via the YCloud
// integration, or given explicitly with `workspace_id`.
// ──────────────────────────────────────────────────────────────────────────────

const bodySchema = z
  .object({
    /** Business WhatsApp number that sent the message (E.164). */
    from: z.string().min(5).max(30).optional(),
    workspace_id: z.string().uuid().optional(),
    /** Customer phone. */
    to: z.string().min(5).max(30),
    /** YCloud's own message id, returned synchronously by the send API. */
    ycloud_id: z.string().min(1).max(200).optional(),
    /** WhatsApp message id. YCloud does not return it on send; usually omit. */
    wamid: z.string().min(1).max(200).optional(),
    template_name: z.string().min(1).max(200),
    /** The text the customer actually received (variables already filled). */
    text: z.string().min(1).max(4096),
    contact_name: z.string().max(200).optional(),
    /** Sender system label, e.g. "reservas". */
    source: z.string().max(50).optional(),
    sent_at: z.string().max(40).optional(),
  })
  .refine((d) => d.from || d.workspace_id, {
    message: "Provide `from` (business number) or `workspace_id`",
  })
  .refine((d) => d.ycloud_id || d.wamid, {
    message: "Provide `ycloud_id` (from the YCloud send response) or `wamid`",
  });

function secretMatches(header: string | null): boolean {
  const secret = process.env.OUTBOUND_INGEST_SECRET;
  if (!secret || !header) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(header);
  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!process.env.OUTBOUND_INGEST_SECRET) {
    // Fail closed: an unset secret must never mean "open endpoint".
    return NextResponse.json(
      { error: "Outbound ingest not configured" },
      { status: 503 },
    );
  }
  if (!secretMatches(request.headers.get("Authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const body = parsed.data;

  try {
    const workspaceId =
      body.workspace_id ??
      (await resolveWorkspaceByBusinessPhone(body.from as string));

    if (!workspaceId) {
      return NextResponse.json(
        { error: "No workspace matches that business number" },
        { status: 404 },
      );
    }

    const result = await ingestOutboundTemplate({
      workspaceId,
      to: body.to,
      wamid: body.wamid,
      ycloudId: body.ycloud_id,
      templateName: body.template_name,
      body: body.text,
      origin: body.source,
      contactName: body.contact_name,
      sentAt: body.sent_at,
    });

    return NextResponse.json({
      ok: true,
      created: result.created,
      upgraded: result.upgraded,
    });
  } catch (err) {
    // SEC-09: never log full error objects / payloads (customer PII).
    console.error(
      "[outbound-message] failed:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
