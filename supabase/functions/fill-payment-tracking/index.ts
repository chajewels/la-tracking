import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getServiceAccountAccessToken } from "../_shared/google-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const TRACKER_ROOT_FOLDER_ID = "18ShmrYP90ywvB9WUgXVio1sEXxhjsmZX"; // "SALES_Payment List"
const TEMPLATE_ID = "1Ah5ScUN7tI06JT7qpTeuc6Xi1SoGEXGlzq7nqcAfheA"; // 11-month master template

const MONTH_NAMES = [
  "01. January", "02. February", "03. March", "04. April",
  "05. May", "06. June", "07. July", "08. August",
  "09. September", "10. October", "11. November", "12. December",
];

const MONTH_ABBR = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

const STATUS_FLAG: Record<string, string> = { cancelled: "Cancelled", final_forfeited: "Final Forfeited" };
const FIRST_MONTH_COL = 6; // column G (0-indexed)
const TABS = ["Overseas", "Japan"];

async function findOrCreateFolder(token: string, parentId: string, name: string): Promise<string> {
  const escaped = name.replace(/'/g, "\\'");
  const q = `'${parentId}' in parents and name='${escaped}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const sRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`, { headers: { Authorization: `Bearer ${token}` } });
  if (!sRes.ok) throw new Error(`folder search failed (${sRes.status}): ${await sRes.text()}`);
  const sData = await sRes.json();
  if (sData.files && sData.files.length > 0) return sData.files[0].id;
  const cRes = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
  });
  if (!cRes.ok) throw new Error(`folder create failed (${cRes.status}): ${await cRes.text()}`);
  return (await cRes.json()).id;
}

async function readTab(token: string, sheetId: string, tab: string): Promise<string[][]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tab + "!A1:Z400")}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`read ${tab} failed (${r.status}): ${await r.text()}`);
  return (await r.json()).values || [];
}

async function deleteFile(token: string, id: string): Promise<void> {
  await fetch(`https://www.googleapis.com/drive/v3/files/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
}

function findTotalCol(rows: string[][]): number {
  for (const row of rows) {
    if (!row) continue;
    for (let c = 0; c < row.length; c++) if (String(row[c] ?? "").trim().toUpperCase() === "TOTAL") return c;
  }
  return -1;
}

function findRowIdx(rows: string[][], colB: string): number {
  const want = colB.trim().toLowerCase();
  for (let i = 0; i < rows.length; i++) if (String(rows[i]?.[1] ?? "").trim().toLowerCase() === want) return i;
  return -1;
}

function colLetter(index: number): string { return String.fromCharCode(65 + index); }

function parseMoney(s: unknown): number | null {
  if (s === null || s === undefined) return null;
  const cleaned = String(s).replace(/[^0-9.\-]/g, "");
  if (cleaned === "" || cleaned === "-") return null;
  const n = Number(cleaned);
  return isNaN(n) ? null : n;
}

type RosterRow = { colB: string; total: number | null; isInvoice: boolean };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Auth gate — JWT verification + admin/staff/finance/csr role check.
  // Mirrors dashboard-summary (commit 27a3877). Frontend caller is
  // src/components/finance/PaymentTrackingReport.tsx via
  // supabase.functions.invoke (staff JWT attached automatically).
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const supabaseAuth = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(
    authHeader.replace("Bearer ", ""),
  );
  if (authError || !user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const { data: roleRows } = await supabaseAuth
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .in("role", ["admin", "staff", "finance", "csr"])
    .limit(1);
  if (!roleRows || roleRows.length === 0) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let token = "";
  let tempSrcId = "";
  let outId = "";

  try {
    const { fileId } = await req.json();
    if (!fileId) {
      return new Response(JSON.stringify({ error: "fileId required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    token = await getServiceAccountAccessToken();

    // 1. Convert-copy uploaded SOURCE -> temp native Sheet (to read its roster)
    const srcCopy = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/copy`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "tracking-src-temp", mimeType: "application/vnd.google-apps.spreadsheet" }),
    });
    if (!srcCopy.ok) throw new Error(`source convert-copy failed (${srcCopy.status}): ${await srcCopy.text()}`);
    tempSrcId = (await srcCopy.json()).id;

    // 2. Copy the TEMPLATE -> output sheet
    const tplCopy = await fetch(`https://www.googleapis.com/drive/v3/files/${TEMPLATE_ID}/copy?fields=id,parents`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "tracking-temp" }),
    });
    if (!tplCopy.ok) throw new Error(`template copy failed (${tplCopy.status}): ${await tplCopy.text()}`);
    const tplCopyJson = await tplCopy.json();
    outId = tplCopyJson.id;
    const outParents: string[] = tplCopyJson.parents || [];

    // 2b. tab -> gid for output (insert rows + red rows)
    const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${outId}?fields=sheets.properties(sheetId,title)`, { headers: { Authorization: `Bearer ${token}` } });
    if (!metaRes.ok) throw new Error(`output meta failed (${metaRes.status}): ${await metaRes.text()}`);
    const gidByTab: Record<string, number> = {};
    for (const s of (await metaRes.json()).sheets ?? []) gidByTab[s.properties.title] = s.properties.sheetId;

    // 3. Read SOURCE roster per tab
    const rosterByTab: Record<string, RosterRow[]> = {};
    const invoiceSet = new Set<string>();
    for (const tab of TABS) {
      const rows = await readTab(token, tempSrcId, tab);
      const hdr = findRowIdx(rows, "Customer");
      let gt = findRowIdx(rows, "Grand Total");
      if (hdr < 0) throw new Error(`source tab ${tab}: no "Customer" header`);
      if (gt < 0) gt = rows.length;
      const roster: RosterRow[] = [];
      for (let i = hdr + 1; i < gt; i++) {
        const b = String(rows[i]?.[1] ?? "").trim();
        if (b === "") continue;
        const isInvoice = /^\d{4,6}$/.test(b);
        roster.push({ colB: b, total: isInvoice ? parseMoney(rows[i]?.[2]) : null, isInvoice });
        if (isInvoice) invoiceSet.add(b);
      }
      rosterByTab[tab] = roster;
    }

    const invoices = Array.from(invoiceSet);
    if (invoices.length === 0) {
      await deleteFile(token, outId); await deleteFile(token, tempSrcId);
      return new Response(JSON.stringify({ ok: true, invoices: 0, note: "no invoice rows in source" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 4. RPC
    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_tracking_for_invoices`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ p_invoices: invoices }),
    });
    if (!rpcRes.ok) throw new Error(`RPC failed (${rpcRes.status}): ${await rpcRes.text()}`);
    const tracking: Array<{ invoice_number: string; order_date: string; status: string; month_paid_jpy: Record<string, number> | null }> = await rpcRes.json();

    // 5. cohort + maps
    let earliest: Date | null = null;
    for (const t of tracking) { if (!t.order_date) continue; const d = new Date(t.order_date); if (!earliest || d < earliest) earliest = d; }
    if (!earliest) throw new Error("no order_date in tracking results");
    const cohortYear = earliest.getUTCFullYear();
    const cohortMonth = earliest.getUTCMonth() + 1;

    const byInvoice = new Map<string, Record<string, number>>();
    const statusByInvoice = new Map<string, string>();
    for (const t of tracking) { if (t.month_paid_jpy) byInvoice.set(t.invoice_number, t.month_paid_jpy); if (t.status) statusByInvoice.set(t.invoice_number, t.status); }

    // 4b. Country lookup per invoice (layaway + cash orders).
    // Reads from customers.location (NOT customers.country) because the
    // Customer Details edit form writes the country value to the
    // `location` column. The `country` column on customers exists but
    // is not populated by the active UI. See Bug #162 in docs/FIXED-BUGS.md.
    const countryByInvoice = new Map<string, string>();
    const inList = invoices.join(",");
    const laCountryRes = await fetch(
      `${SUPABASE_URL}/rest/v1/layaway_accounts?select=invoice_number,customer:customers(location)&invoice_number=in.(${inList})`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    if (laCountryRes.ok) {
      for (const r of await laCountryRes.json()) {
        if (r.customer?.location) countryByInvoice.set(r.invoice_number, r.customer.location);
      }
    }
    const coCountryRes = await fetch(
      `${SUPABASE_URL}/rest/v1/cash_orders?select=invoice_number,customer:customers(location)&invoice_number=in.(${inList})`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    if (coCountryRes.ok) {
      for (const r of await coCountryRes.json()) {
        if (r.customer?.location && !countryByInvoice.has(r.invoice_number)) {
          countryByInvoice.set(r.invoice_number, r.customer.location);
        }
      }
    }

    // 6. Lay roster into template + fill
    const rawData: Array<{ range: string; values: (string | number)[][] }> = [];
    const ueData: Array<{ range: string; values: (string | number)[][] }> = [];
    const structReqs: Array<Record<string, unknown>> = [];
    let flagged = 0;

    for (const tab of TABS) {
      const roster = rosterByTab[tab];
      const trows = await readTab(token, outId, tab);
      const hdr = findRowIdx(trows, "Customer");
      let gt = findRowIdx(trows, "Grand Total");
      const totalCol = findTotalCol(trows);
      if (hdr < 0) throw new Error(`template tab ${tab}: no "Customer" header`);
      if (totalCol < 0) throw new Error(`template tab ${tab}: no "TOTAL" header`);
      if (gt < 0) gt = trows.length;

      const numMonths = totalCol - FIRST_MONTH_COL;
      const labels: string[] = [];
      for (let k = 0; k < numMonths; k++) labels.push(MONTH_ABBR[(cohortMonth - 1 + k) % 12]);
      rawData.push({ range: `${tab}!${colLetter(FIRST_MONTH_COL)}${hdr + 1}:${colLetter(totalCol - 1)}${hdr + 1}`, values: [labels] });

      const dataStart0 = hdr + 1;
      const capacity = gt - dataStart0;
      const insertCount = Math.max(0, roster.length - capacity);
      if (insertCount > 0) {
        structReqs.push({ insertDimension: { range: { sheetId: gidByTab[tab], dimension: "ROWS", startIndex: dataStart0, endIndex: dataStart0 + insertCount }, inheritFromBefore: false } });
        gt += insertCount;
      }

      const totalLetter = colLetter(totalCol);
      for (let idx = 0; idx < roster.length; idx++) {
        const r0 = dataStart0 + idx;
        const row = r0 + 1;
        const rr = roster[idx];
        rawData.push({ range: `${tab}!B${row}`, values: [[rr.colB]] });
        if (!rr.isInvoice) continue;

        if (rr.total !== null) ueData.push({ range: `${tab}!C${row}`, values: [[rr.total]] });
        ueData.push({ range: `${tab}!D${row}`, values: [[`=${totalLetter}${row}`]] });
        ueData.push({ range: `${tab}!E${row}`, values: [[`=C${row}-D${row}`]] });
        ueData.push({ range: `${tab}!${totalLetter}${row}`, values: [[`=SUM(${colLetter(FIRST_MONTH_COL)}${row}:${colLetter(totalCol - 1)}${row})`]] });

        const mp = byInvoice.get(rr.colB);
        if (mp) {
          const cells: Array<{ col: number; value: number }> = [];
          for (const [ym, value] of Object.entries(mp)) {
            const m = /^(\d{4})-(\d{2})$/.exec(ym);
            if (!m) continue;
            const offset = (parseInt(m[1], 10) - cohortYear) * 12 + (parseInt(m[2], 10) - cohortMonth);
            const colIndex = FIRST_MONTH_COL + offset;
            if (offset < 0 || colIndex >= totalCol) continue;
            cells.push({ col: colIndex, value: Number(value) });
          }
          if (rr.total !== null && cells.length > 0) {
            const sum = cells.reduce((a, c) => a + c.value, 0);
            if (sum > rr.total) { const diff = sum - rr.total; cells.sort((a, b) => b.value - a.value); cells[0].value = Math.max(0, cells[0].value - diff); }
          }
          for (const c of cells) ueData.push({ range: `${tab}!${colLetter(c.col)}${row}`, values: [[c.value]] });
        }

        // Country column T (Overseas tab only)
        if (tab === "Overseas") {
          const country = countryByInvoice.get(rr.colB);
          if (country) {
            rawData.push({ range: `${tab}!${colLetter(totalCol + 2)}${row}`, values: [[country]] });
          }
        }

        const st = statusByInvoice.get(rr.colB);
        if (st && STATUS_FLAG[st]) {
          rawData.push({ range: `${tab}!${colLetter(totalCol + 1)}${row}`, values: [[STATUS_FLAG[st]]] });
          structReqs.push({ repeatCell: { range: { sheetId: gidByTab[tab], startRowIndex: r0, endRowIndex: r0 + 1, startColumnIndex: 0, endColumnIndex: tab === "Overseas" ? totalCol + 3 : totalCol + 2 }, cell: { userEnteredFormat: { backgroundColor: { red: 0.96, green: 0.80, blue: 0.80 } } }, fields: "userEnteredFormat.backgroundColor" } });
          flagged++;
        }
      }

      const gtRow = gt + 1;
      const first = dataStart0 + 1;
      const last = dataStart0 + roster.length;
      if (roster.length > 0) {
        for (const L of ["C", "D", "E"]) ueData.push({ range: `${tab}!${L}${gtRow}`, values: [[`=SUM(${L}${first}:${L}${last})`]] });
        for (let c = FIRST_MONTH_COL; c <= totalCol; c++) { const L = colLetter(c); ueData.push({ range: `${tab}!${L}${gtRow}`, values: [[`=SUM(${L}${first}:${L}${last})`]] }); }
      }
    }

    // 7. Apply: structural first, then RAW, then USER_ENTERED
    if (structReqs.length > 0) {
      const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${outId}:batchUpdate`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ requests: structReqs }) });
      if (!r.ok) throw new Error(`structural batchUpdate failed (${r.status}): ${await r.text()}`);
    }
    for (const [opt, payload] of [["RAW", rawData], ["USER_ENTERED", ueData]] as const) {
      if (payload.length === 0) continue;
      const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${outId}/values:batchUpdate`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ valueInputOption: opt, data: payload }) });
      if (!r.ok) throw new Error(`${opt} values batchUpdate failed (${r.status}): ${await r.text()}`);
    }

    // 8. Move into year/month folder; clean up temp source
    const monthName = MONTH_NAMES[cohortMonth - 1];
    const yearId = await findOrCreateFolder(token, TRACKER_ROOT_FOLDER_ID, String(cohortYear));
    const monthId = await findOrCreateFolder(token, yearId, monthName);

    const removeParents = outParents.length > 0 ? `&removeParents=${encodeURIComponent(outParents.join(","))}` : "";
    const patchRes = await fetch(`https://www.googleapis.com/drive/v3/files/${outId}?addParents=${monthId}${removeParents}&fields=id`, { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: monthName }) });
    if (!patchRes.ok) throw new Error(`Drive move failed (${patchRes.status}): ${await patchRes.text()}`);

    await deleteFile(token, tempSrcId);

    return new Response(JSON.stringify({ ok: true, invoices: invoices.length, cells: rawData.length + ueData.length, flagged, sheetId: outId, movedTo: monthId }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    if (token && tempSrcId) await deleteFile(token, tempSrcId);
    console.error("[fill-payment-tracking] error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message || "internal_error" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
