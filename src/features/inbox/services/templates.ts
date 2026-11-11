/**
 * templates.ts — Template management: list, sync from YCloud, helpers.
 */

import { createClient as createSbClient } from "@supabase/supabase-js";
import { fetchYCloudTemplates } from "./ycloud-client";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface TemplateRow {
  id: string;
  workspace_id: string;
  name: string;
  language: string;
  category: string;
  status: "draft" | "submitted" | "approved" | "rejected" | "paused";
  body_template: string;
  components: Record<string, unknown>;
  variables: unknown[];
  // Rich fields (Phase 4) — header text only for now.
  header_type: "none" | "text";
  header_text: string | null;
  footer_text: string | null;
  buttons: unknown[];
  submitted_at: string | null;
  approved_at: string | null;
  provider_template_id: string | null;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// YCloud API shape (raw response)
// ──────────────────────────────────────────────────────────────────────────────

interface YCloudTemplateComponent {
  type: string;
  text?: string;
  parameters?: unknown[];
  [key: string]: unknown;
}

interface YCloudTemplate {
  id?: string;
  name?: string;
  language?: string;
  category?: string;
  status?: string;
  components?: YCloudTemplateComponent[];
  [key: string]: unknown;
}

// Maps YCloud status strings to our enum
const YCLOUD_STATUS_MAP: Record<string, TemplateRow["status"]> = {
  APPROVED: "approved",
  PENDING: "submitted",
  PENDING_DELETION: "submitted",
  REJECTED: "rejected",
  PAUSED: "paused",
  DISABLED: "paused",
};

function mapYCloudStatus(raw: string): TemplateRow["status"] {
  return YCLOUD_STATUS_MAP[raw.toUpperCase()] ?? "submitted";
}

// Extracts the body text from YCloud components array
function extractBodyText(components: YCloudTemplateComponent[]): string {
  const bodyComp = components.find((c) => c.type?.toUpperCase() === "BODY");
  return typeof bodyComp?.text === "string" ? bodyComp.text : "";
}

// ──────────────────────────────────────────────────────────────────────────────
// listTemplates
// ──────────────────────────────────────────────────────────────────────────────

export async function listTemplates(
  workspaceId: string,
  status?: string,
): Promise<TemplateRow[]> {
  const supabase = svc();

  let query = supabase
    .from("templates")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("name", { ascending: true });

  if (status) {
    query = query.eq("status", status);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`[templates] listTemplates error: ${error.message}`);
  }

  return (data ?? []) as TemplateRow[];
}

// ──────────────────────────────────────────────────────────────────────────────
// syncTemplatesFromYCloud
// ──────────────────────────────────────────────────────────────────────────────

export async function syncTemplatesFromYCloud(
  workspaceId: string,
): Promise<{ synced: number; errors: number }> {
  const supabase = svc();

  // 1. Load YCloud integration credentials
  const { data: integration, error: intError } = await supabase
    .from("integrations")
    .select("credentials")
    .eq("workspace_id", workspaceId)
    .eq("provider", "ycloud")
    .eq("enabled", true)
    .single();

  if (intError || !integration) {
    throw new Error(
      `[templates] YCloud integration not found: ${intError?.message}`,
    );
  }

  const credentials = integration.credentials as Record<string, unknown>;
  const apiKey = (credentials.ycloud_api_key as string | undefined) ?? "";

  if (!apiKey || apiKey === "placeholder") {
    return { synced: 0, errors: 0 };
  }

  // 2. Fetch templates from YCloud
  const records = await fetchYCloudTemplates(apiKey);

  let synced = 0;
  let errors = 0;

  // 3. Upsert each template
  for (const raw of records) {
    try {
      const t = raw as YCloudTemplate;
      const name = typeof t.name === "string" ? t.name : "";
      const language = typeof t.language === "string" ? t.language : "es";
      const category = typeof t.category === "string" ? t.category : "UTILITY";
      const status = mapYCloudStatus(
        typeof t.status === "string" ? t.status : "PENDING",
      );
      const components = Array.isArray(t.components) ? t.components : [];
      const bodyTemplate = extractBodyText(components);
      const variables = extractTemplateVariables(bodyTemplate);

      const { error: upsertError } = await supabase.from("templates").upsert(
        {
          workspace_id: workspaceId,
          name,
          language,
          category,
          status,
          body_template: bodyTemplate,
          components: t.components ?? {},
          variables,
          provider_template_id: typeof t.id === "string" ? t.id : null,
          rejection_reason: null,
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: "workspace_id,name,language",
          ignoreDuplicates: false,
        },
      );

      if (upsertError) {
        console.error("[templates] upsert error:", upsertError.message, {
          name,
        });
        errors++;
      } else {
        synced++;
      }
    } catch (err) {
      console.error("[templates] record processing error:", err);
      errors++;
    }
  }

  return { synced, errors };
}

// ──────────────────────────────────────────────────────────────────────────────
// extractTemplateVariables
// Returns positional placeholders found in a template body: ["1", "2", ...]
// ──────────────────────────────────────────────────────────────────────────────

export function extractTemplateVariables(bodyTemplate: string): string[] {
  const matches = bodyTemplate.matchAll(/\{\{(\d+)\}\}/g);
  const seen = new Set<string>();
  const result: string[] = [];

  for (const match of matches) {
    const pos = match[1];
    if (pos && !seen.has(pos)) {
      seen.add(pos);
      result.push(pos);
    }
  }

  // Return sorted by numeric value: ["1", "2", "3", ...]
  return result.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}

// ──────────────────────────────────────────────────────────────────────────────
// fillTemplateVariables
// Replaces {{1}}, {{2}}, ... with provided values array (index 0 → {{1}})
// ──────────────────────────────────────────────────────────────────────────────

export function fillTemplateVariables(
  bodyTemplate: string,
  values: string[],
): string {
  let result = bodyTemplate;

  values.forEach((value, index) => {
    const placeholder = `{{${index + 1}}}`;
    result = result.replaceAll(placeholder, value);
  });

  return result;
}

// ──────────────────────────────────────────────────────────────────────────────
// renderTemplateBody
// Like fillTemplateVariables, but variables we cannot fill become "[dato]"
// instead of leaking a raw "{{2}}" to the agent, and it reports whether every
// placeholder was resolved. Used to store the text a customer really received.
// ──────────────────────────────────────────────────────────────────────────────

/** Marker for a `{{n}}` whose value we could not recover. */
const UNKNOWN_VARIABLE = "[dato]";

/** Fills `{{1}}`, `{{2}}`… (`params[0]` ↔ `{{1}}`). */
export function renderTemplateBody(
  body: string,
  params: string[] = [],
): { text: string; complete: boolean } {
  let complete = true;
  const text = body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, n: string) => {
    const value = params[Number(n) - 1];
    if (typeof value === "string" && value.length > 0) return value;
    complete = false;
    return UNKNOWN_VARIABLE;
  });
  return { text, complete };
}

// ──────────────────────────────────────────────────────────────────────────────
// loadTemplateBody
// Body text of a workspace template by name, preferring the given language.
// Returns null when the template isn't synced into this workspace.
// ──────────────────────────────────────────────────────────────────────────────

export async function loadTemplateBody(
  workspaceId: string,
  name: string,
  language?: string,
): Promise<string | null> {
  const { data } = await svc()
    .from("templates")
    .select("language, body_template")
    .eq("workspace_id", workspaceId)
    .eq("name", name);

  const rows = (data ?? []) as { language: string; body_template: string }[];
  const row = rows.find((r) => r.language === language) ?? rows[0];
  return row?.body_template || null;
}
