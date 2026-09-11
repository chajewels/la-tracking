import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getServiceAccountAccessToken } from "../_shared/google-auth.ts";
import { isServiceRole } from "../_shared/jwt-claims.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * append-payment-tracking (v2 — per-invoice rewrite)
 *
 * Rewrites ONE invoice's month cells on whichever registered tracking sheet
 * holds it, using get_tracking_for_invoices as the single source of truth
 * (same RPC + same cohort/offset/pre-cohort-merge logic as fill-payment-tracking).
 * Idempotent: safe to call after confirm, void, edit, restore.
 *
 * Sheets are registered in system_settings.payment_tracking_sheets:
 *   [{ "id": "<spreadsheetId>", "cohort": "YYYY-MM" }, ...]  (newest first)
 * fill-payment-tracking prepends its output on every successful run.
 *
 * Body: { invoice_number }. Service-role only. Never throws to the caller;
 * returns { ok:false, error } on failure. Only columns G..(TOTAL-1) on the
 * invoice row are written; C/D/E/TOTAL formulas are left untouched.
 */

const FIRST_MONTH_COL = 6; // column G (0-indexed)
const TABS = ["Overseas", "Japan"];

type SheetReg = { id: string; cohort: string };
type TrackingRow = { invoice_number: string; order_date: string | null; status: string | null; month_paid_jpy: Record<string, number> | null };

function colLetter(index: number): string {
  let s = "";
  let n = index;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

function findRowIdx(rows: string[][], colB: string): number {
  const want = colB.trim().toLowerCase();
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i]?.[1] ?? "").trim().toLowerCase() === want) return i;
  }
  return -1;
}

function findTotalCol(hdrRow: string[]): number {
  for (let c = 0; c < hdrRow.length; c++) {
    if (String(hdrRow[c] ?? "").trim().toUpperCase() === "TOTAL") return c;
  }
  return -1;
}

function parseMoney(s: unknown): number | null {
  if (s === null || s === undefined) return null;
  const cleaned = String(s).replace(/[^0-9.\-]/g, "");
  if (cleaned === "" || cleaned === "-") return null;
  const n = Number(cleaned);
  return isNaN(n) ? null : n;
}

async function readTab(token: string, sheetId: string, tab: string): Promise<string[][]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tab + "!A1:Z500")}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`read ${tab} failed (${r.status}): ${await r.text()}`);
  return (await r.json()).values || [];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const authToken = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
  if (!isServiceRole(authToken)) return json({ ok: false, error: "Forbidden" }, 403);

  let invoice_number = "";
  try {
    const body = await req.json().catch(() => null) as { invoice_number?: string } | null;
    if (!body) return json({ ok: false, error: "Invalid JSON body" }, 400);
    invoice_number = String(body.invoice_number ?? "").trim();
    if (!invoice_number) return json({ ok: false, error: "invoice_number required" }, 400);

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

    // 1. Registered sheets (newest first).
    const { data: setting, error: settingErr } = await supabase
      .from("system_settings").select("value").eq("key", "payment_tracking_sheets").maybeSingle();
    if (settingErr) return json({ ok: false, invoice_number, error: `settings read failed: ${settingErr.message}` });
    let regs: SheetReg[] = [];
    const raw = setting?.value;
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) {
        regs = parsed
          .filter((x) => x && typeof x.id === "string" && /^\d{4}-\d{2}$/.test(String(x.cohort ?? "")))
          .map((x) => ({ id: String(x.id).trim(), cohort: String(x.cohort) }));
      }
    } catch { /* fall through to empty */ }
    if (regs.length === 0) return json({ ok: false, invoice_number, error: "payment_tracking_sheets not set or empty" });

    // 2. Google auth + locate the invoice across registered sheets.
    const token = await getServiceAccountAccessToken();
    let hit: { reg: SheetReg; tab: string; rows: string[][]; rowIdx: number } | null = null;
    for (const reg of regs) {
      for (const tab of TABS) {
        let tabRows: string[][];
        try { tabRows = await readTab(token, reg.id, tab); }
        catch (e) { console.warn(`[append-payment-tracking] ${invoice_number}: skip ${reg.id}/${tab}: ${(e as Error).message}`); continue; }
        const idx = findRowIdx(tabRows, invoice_number);
        if (idx >= 0) { hit = { reg, tab, rows: tabRows, rowIdx: idx }; break; }
      }
      if (hit) break;
    }
    if (!hit) return json({ ok: true, invoice_number, note: "invoice not in any registered sheet" });

    const { reg, tab, rows, rowIdx } = hit;
    const hdrIdx = findRowIdx(rows, "Customer");
    if (hdrIdx < 0) return json({ ok: false, invoice_number, error: `no "Customer" header in ${reg.id}/${tab}` });
    const hdrRow = rows[hdrIdx] ?? [];
    const totalCol = findTotalCol(hdrRow);
    if (totalCol <= FIRST_MONTH_COL) return json({ ok: false, invoice_number, error: `no "TOTAL" header in ${reg.id}/${tab}` });

    const cm = /^(\d{4})-(\d{2})$/.exec(reg.cohort)!;
    const cohortYear = parseInt(cm[1], 10);
    const cohortMonth = parseInt(cm[2], 10);

    // 3. DB truth for this invoice.
    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_tracking_for_invoices`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ p_invoices: [invoice_number] }),
    });
    if (!rpcRes.ok) return json({ ok: false, invoice_number, error: `RPC failed (${rpcRes.status}): ${await rpcRes.text()}` });
    const tracking: TrackingRow[] = await rpcRes.json();
    const merged: Record<string, number> = {};
    for (const t of tracking) {
      for (const [ym, v] of Object.entries(t.month_paid_jpy ?? {})) merged[ym] = (merged[ym] ?? 0) + Number(v);
    }

    // 4. Month → column, identical to fill-payment-tracking (pre-cohort → first column, merge by column).
    const byCol = new Map<number, number>();
    for (const [ym, value] of Object.entries(merged)) {
      const m = /^(\d{4})-(\d{2})$/.exec(ym);
      if (!m) continue;
      const offset = (parseInt(m[1], 10) - cohortYear) * 12 + (parseInt(m[2], 10) - cohortMonth);
      const colIndex = offset < 0 ? FIRST_MONTH_COL : FIRST_MONTH_COL + offset;
      if (colIndex >= totalCol) continue;
      byCol.set(colIndex, (byCol.get(colIndex) ?? 0) + value);
    }
    const invoiceRow = rows[rowIdx] ?? [];
    const rowTotal = parseMoney(invoiceRow[2]);
    const cells = [...byCol.entries()].map(([col, value]) => ({ col, value }));
    if (rowTotal !== null && cells.length > 0) {
      const sum = cells.reduce((a, c) => a + c.value, 0);
      if (sum > rowTotal) { const diff = sum - rowTotal; cells.sort((a, b) => b.value - a.value); cells[0].value = Math.max(0, cells[0].value - diff); }
    }
    const valueByCol = new Map(cells.map((c) => [c.col, c.value]));
    const rowValues: (number | string)[] = [];
    for (let c = FIRST_MONTH_COL; c < totalCol; c++) rowValues.push(valueByCol.has(c) ? valueByCol.get(c)! : "");

    // 5. Single write: G..(TOTAL-1) on the invoice row. C/D/E/TOTAL untouched.
    const rowNum = rowIdx + 1;
    const range = `${tab}!${colLetter(FIRST_MONTH_COL)}${rowNum}:${colLetter(totalCol - 1)}${rowNum}`;
    const updRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${reg.id}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ range, majorDimension: "ROWS", values: [rowValues] }),
    });
    if (!updRes.ok) return json({ ok: false, invoice_number, error: `values.update failed (${updRes.status}): ${await updRes.text()}` });

    return json({ ok: true, invoice_number, sheet: reg.id, cohort: reg.cohort, tab, row: rowNum, months_written: cells.length });
  } catch (err) {
    console.error(`[append-payment-tracking] ${invoice_number} error:`, err);
    return json({ ok: false, invoice_number, error: (err as Error).message || "internal_error" });
  }
});
