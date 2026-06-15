import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getServiceAccountAccessToken } from "../_shared/google-auth.ts";
import { isServiceRole } from "../_shared/jwt-claims.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * append-payment-tracking
 *
 * Incrementally updates the ALREADY-GENERATED payment tracking Google Sheet
 * (id in system_settings.payment_tracking_sheet_id) after a single confirmed
 * payment — WITHOUT regenerating the sheet (that is fill-payment-tracking's job).
 *
 * Service-role only (isServiceRole). Fire-and-forget caller:
 * review-payment-submission on each confirm. Never throws — returns
 * { ok: false, error } on failure so the caller is never blocked.
 *
 * Sheet conventions (mirrors fill-payment-tracking):
 *   - Two tabs: "Overseas", "Japan".
 *   - Column B (index 1) holds the invoice number; the header row has
 *     "Customer" in column B.
 *   - Column D (index 3) = Sum of Amt Paid Posted; E (index 4) = Sum of Balance.
 *   - Month columns start at G (FIRST_MONTH_COL = 6); the header row labels
 *     them MAY/JUN/JUL... — match the payment month abbreviation.
 */

const MONTH_ABBR = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const FIRST_MONTH_COL = 6; // column G (0-indexed)
const COL_PAID = 3;        // column D — Sum of Amt Paid Posted
const COL_BALANCE = 4;     // column E — Sum of Balance
const TABS = ["Overseas", "Japan"];

function colLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

/** Row index whose column B (index 1) matches `colB` (case-insensitive). */
function findRowIdx(rows: string[][], colB: string): number {
  const want = colB.trim().toLowerCase();
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i]?.[1] ?? "").trim().toLowerCase() === want) return i;
  }
  return -1;
}

/** Parse a money-ish cell: strip commas/spaces/symbols. Blank/missing → 0. */
function num(s: unknown): number {
  const cleaned = String(s ?? "").replace(/[^0-9.\-]/g, "");
  if (cleaned === "" || cleaned === "-") return 0;
  const n = Number(cleaned);
  return Number.isNaN(n) ? 0 : n;
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
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  // Service-role-only gate.
  const authToken = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
  if (!isServiceRole(authToken)) {
    return json({ ok: false, error: "Forbidden" }, 403);
  }

  try {
    const body = await req.json().catch(() => null) as
      | { invoice_number?: string; payment_date?: string; amount_jpy?: number; currency?: string }
      | null;
    if (!body) return json({ ok: false, error: "Invalid JSON body" }, 400);

    const invoice_number = String(body.invoice_number ?? "").trim();
    const payment_date = String(body.payment_date ?? "").trim();
    const amount_jpy = Number(body.amount_jpy ?? 0);
    const currency = String(body.currency ?? "");
    if (!invoice_number || !payment_date || !Number.isFinite(amount_jpy)) {
      return json({ ok: false, error: "invoice_number, payment_date, amount_jpy required" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 1. Sheet id from system_settings.payment_tracking_sheet_id (jsonb scalar).
    const { data: setting, error: settingErr } = await supabase
      .from("system_settings")
      .select("value")
      .eq("key", "payment_tracking_sheet_id")
      .maybeSingle();
    if (settingErr) return json({ ok: false, error: `settings read failed: ${settingErr.message}` }, 500);

    let sheetId = "";
    const raw = setting?.value;
    if (raw != null) {
      if (typeof raw === "string") {
        try {
          const parsed = JSON.parse(raw);
          sheetId = typeof parsed === "string" ? parsed : String(parsed ?? "");
        } catch {
          sheetId = raw;
        }
      } else {
        sheetId = String(raw);
      }
    }
    sheetId = sheetId.trim();
    if (!sheetId) return json({ ok: false, error: "payment_tracking_sheet_id not set" }, 200);

    // 2. Google auth.
    const token = await getServiceAccountAccessToken();

    // 3 + 4. Read both tabs, locate the invoice in column B.
    let foundTab: string | null = null;
    let rows: string[][] = [];
    let rowIdx = -1;
    for (const tab of TABS) {
      const tabRows = await readTab(token, sheetId, tab);
      const idx = findRowIdx(tabRows, invoice_number);
      if (idx >= 0) {
        foundTab = tab;
        rows = tabRows;
        rowIdx = idx;
        break;
      }
    }
    if (!foundTab) {
      // New accounts not yet in the sheet are silently skipped.
      return json({ ok: true, note: "invoice not in sheet" });
    }

    // 5. Header row (column B = "Customer") → month column mapping.
    const hdrIdx = findRowIdx(rows, "Customer");
    if (hdrIdx < 0) return json({ ok: false, error: `no "Customer" header in tab ${foundTab}` }, 200);

    const monthNum = parseInt(payment_date.slice(5, 7), 10); // 1..12
    if (!monthNum || monthNum < 1 || monthNum > 12) {
      return json({ ok: false, error: `bad payment_date month: ${payment_date}` }, 200);
    }
    const wantAbbr = MONTH_ABBR[monthNum - 1];
    const hdrRow = rows[hdrIdx] ?? [];
    let monthCol = -1;
    for (let c = FIRST_MONTH_COL; c < hdrRow.length; c++) {
      if (String(hdrRow[c] ?? "").trim().toUpperCase() === wantAbbr) {
        monthCol = c;
        break;
      }
    }
    if (monthCol < 0) {
      return json({ ok: false, error: `month ${wantAbbr} column not found in tab ${foundTab}` }, 200);
    }

    // 6 + 7. Invoice row: read current values, compute new cumulative totals.
    const invoiceRow = rows[rowIdx] ?? [];
    const newMonth = num(invoiceRow[monthCol]) + amount_jpy;
    const newPaid = num(invoiceRow[COL_PAID]) + amount_jpy;
    const newBalance = num(invoiceRow[COL_BALANCE]) - amount_jpy;

    const rowNum = rowIdx + 1; // 1-based sheet row

    // 8. Single batchUpdate (USER_ENTERED): month cell, col D, col E.
    const data = [
      { range: `${foundTab}!${colLetter(monthCol)}${rowNum}`, values: [[newMonth]] },
      { range: `${foundTab}!${colLetter(COL_PAID)}${rowNum}`, values: [[newPaid]] },
      { range: `${foundTab}!${colLetter(COL_BALANCE)}${rowNum}`, values: [[newBalance]] },
    ];
    const updRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
      },
    );
    if (!updRes.ok) {
      throw new Error(`values:batchUpdate failed (${updRes.status}): ${await updRes.text()}`);
    }

    return json({ ok: true, invoice_number, tab: foundTab, row: rowNum, amount_jpy, currency });
  } catch (err) {
    console.error("[append-payment-tracking] error:", err);
    return json({ ok: false, error: (err as Error).message || "internal_error" }, 200);
  }
});
