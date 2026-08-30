import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isServiceRole } from "../_shared/jwt-claims.ts";
import { getServiceAccountAccessToken } from "../_shared/google-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * sync-backup-sheets
 *
 * Daily full-overwrite mirror of four DB tables to a single Google
 * Spreadsheet. Cron-only, service-role gated. Invoked by pg_cron with the
 * Vault-stored service-role bearer (same pattern as penalty-engine,
 * daily-reconciliation).
 *
 * Per table:
 *   1. Fetch ALL rows with paginated .range() (1000/page) — never relies
 *      on the default PostgREST limit.
 *   2. Build a cell matrix: [header, ...rows]. Headers derived from
 *      Object.keys of the first row so schema additions are picked up
 *      automatically.
 *   3. Ensure a tab named after the table exists on the spreadsheet
 *      (batchUpdate addSheet if missing).
 *   4. Clear the tab with values:clear.
 *   5. Write the matrix with values:update valueInputOption=RAW.
 *
 * Failures are per-table: a table's error is logged and pushed to the
 * `errors` array; the rest continue. Returns 200 when every table
 * synced, 500 when any failed. Response body shape:
 *   { synced: { table: rowCount }, errors: [{ table, error }] }
 */

const SPREADSHEET_ID = "1bc1hdHJLic3vCVr4CbuG6o9BRPcwCDF0Pfd5xJbKOKo";
const PAGE_SIZE = 1000;

type TableSpec = {
  name: string;
  /** Ordered list of (column, ascending) pairs forwarded to Supabase. */
  order: { column: string; ascending: boolean }[];
};

const TABLES: TableSpec[] = [
  {
    name: "sales_log",
    order: [
      { column: "sale_date", ascending: true },
      { column: "created_at", ascending: true },
    ],
  },
  {
    name: "commission_agents",
    order: [{ column: "sort_order", ascending: true }],
  },
  {
    name: "commission_splits",
    order: [{ column: "month", ascending: true }],
  },
  {
    name: "product_inquiries",
    order: [
      { column: "last_inquired_date", ascending: true },
      { column: "created_at", ascending: true },
    ],
  },
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // SECURITY: service-role only. Cron-only entry point; no user-facing access.
  const authToken = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
  if (!isServiceRole(authToken)) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const synced: Record<string, number> = {};
  const errors: { table: string; error: string }[] = [];

  let token: string;
  try {
    token = await getServiceAccountAccessToken();
  } catch (err) {
    const msg = `Google auth failed: ${(err as Error).message}`;
    console.error(`[sync-backup-sheets] ${msg}`);
    return new Response(
      JSON.stringify({ synced, errors: [{ table: "__auth__", error: msg }] }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Cache the spreadsheet's existing tab titles once — every per-table
  // ensureTab() then checks against this set and only issues addSheet when
  // the tab is genuinely missing.
  let existingTabs: Set<string>;
  try {
    existingTabs = await fetchExistingTabs(token, SPREADSHEET_ID);
  } catch (err) {
    const msg = `Spreadsheet metadata fetch failed: ${(err as Error).message}`;
    console.error(`[sync-backup-sheets] ${msg}`);
    return new Response(
      JSON.stringify({ synced, errors: [{ table: "__metadata__", error: msg }] }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  for (const spec of TABLES) {
    try {
      const rows = await fetchAllRows(supabase, spec);
      const headers = deriveHeaders(rows);
      const matrix = headers.length === 0
        ? []
        : [headers, ...rows.map((r) => headers.map((h) => serializeCell((r as Record<string, unknown>)[h])))];

      if (!existingTabs.has(spec.name)) {
        await addTab(token, SPREADSHEET_ID, spec.name);
        existingTabs.add(spec.name);
      }
      await clearTab(token, SPREADSHEET_ID, spec.name);
      if (matrix.length > 0) {
        await writeTab(token, SPREADSHEET_ID, spec.name, matrix);
      }

      synced[spec.name] = rows.length;
      console.log(`[sync-backup-sheets] ${spec.name}: ${rows.length} rows`);
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[sync-backup-sheets] ${spec.name}: ${msg}`);
      errors.push({ table: spec.name, error: msg });
      synced[spec.name] = synced[spec.name] ?? 0;
    }
  }

  return new Response(
    JSON.stringify({ synced, errors }),
    {
      status: errors.length === 0 ? 200 : 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});

async function fetchAllRows(
  supabase: any,
  spec: TableSpec,
): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  let from = 0;
  // Defensive cap (~250k rows) to keep a runaway from hanging the cron;
  // legitimate tables are nowhere near this size.
  const maxPages = 250;
  for (let page = 0; page < maxPages; page++) {
    let q = supabase.from(spec.name).select("*").range(from, from + PAGE_SIZE - 1);
    for (const o of spec.order) {
      q = q.order(o.column, { ascending: o.ascending });
    }
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    all.push(...(data as Record<string, unknown>[]));
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

function deriveHeaders(rows: Record<string, unknown>[]): string[] {
  if (rows.length === 0) return [];
  // Use the first row's key order. PostgREST returns columns in a stable
  // order across rows of the same select.
  return Object.keys(rows[0]);
}

function serializeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "string") return value; // dates / timestamps arrive pre-formatted
  if (typeof value === "number") return String(value);
  // objects / arrays (e.g. merge_groups jsonb) → JSON
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function fetchExistingTabs(token: string, sheetId: string): Promise<Set<string>> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties(sheetId,title)`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    throw new Error(`metadata GET failed (${res.status}): ${await res.text()}`);
  }
  const json = await res.json();
  const titles = new Set<string>();
  for (const s of json.sheets ?? []) {
    const t = s?.properties?.title;
    if (typeof t === "string") titles.add(t);
  }
  return titles;
}

async function addTab(token: string, sheetId: string, title: string): Promise<void> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [{ addSheet: { properties: { title } } }],
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`addSheet failed for "${title}" (${res.status}): ${await res.text()}`);
  }
}

async function clearTab(token: string, sheetId: string, title: string): Promise<void> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(title)}:clear`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    },
  );
  if (!res.ok) {
    throw new Error(`clear failed for "${title}" (${res.status}): ${await res.text()}`);
  }
}

async function writeTab(
  token: string,
  sheetId: string,
  title: string,
  values: string[][],
): Promise<void> {
  const range = `${title}!A1`;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    },
  );
  if (!res.ok) {
    throw new Error(`write failed for "${title}" (${res.status}): ${await res.text()}`);
  }
}
