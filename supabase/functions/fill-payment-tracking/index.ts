import { getServiceAccountAccessToken } from "../_shared/google-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const TRACKER_ROOT_FOLDER_ID = "18ShmrYP90ywvB9WUgXVio1sEXxhjsmZX"; // "SALES_Payment List"

const MONTH_NAMES = [
  "01. January", "02. February", "03. March", "04. April",
  "05. May", "06. June", "07. July", "08. August",
  "09. September", "10. October", "11. November", "12. December",
];

// Statuses that get the red row + STATUS-cell label.
const STATUS_FLAG: Record<string, string> = {
  cancelled: "Cancelled",
  final_forfeited: "Final Forfeited",
};

async function findOrCreateFolder(
  accessToken: string,
  parentId: string,
  folderName: string,
): Promise<string> {
  const escaped = folderName.replace(/'/g, "\\'");
  const q = `'${parentId}' in parents and name='${escaped}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`;
  const searchRes = await fetch(searchUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!searchRes.ok) {
    throw new Error(`Drive folder search failed (${searchRes.status}): ${await searchRes.text()}`);
  }
  const searchData = await searchRes.json();
  if (searchData.files && searchData.files.length > 0) {
    return searchData.files[0].id;
  }
  const createRes = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    }),
  });
  if (!createRes.ok) {
    throw new Error(`Drive folder create failed (${createRes.status}): ${await createRes.text()}`);
  }
  const created = await createRes.json();
  return created.id;
}

async function readTab(token: string, sheetId: string, tab: string): Promise<string[][]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tab + "!A1:Z400")}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`read ${tab} failed (${r.status}): ${await r.text()}`);
  return (await r.json()).values || [];
}

function findTotalCol(rows: string[][]): number {
  for (const row of rows) {
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      if (String(row[c] ?? "").trim().toUpperCase() === "TOTAL") return c;
    }
  }
  return -1;
}

function colLetter(index: number): string {
  return String.fromCharCode(65 + index); // 0->A, 6->G ... stays within A..Z
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { fileId } = await req.json();
    if (!fileId) {
      return new Response(JSON.stringify({ error: "fileId required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const token = await getServiceAccountAccessToken();

    // 2. Convert-copy input into a NEW native Google Sheet
    const copyRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}/copy`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "tracking-temp",
          mimeType: "application/vnd.google-apps.spreadsheet",
        }),
      },
    );
    if (!copyRes.ok) {
      throw new Error(`Drive copy failed (${copyRes.status}): ${await copyRes.text()}`);
    }
    const newId = (await copyRes.json()).id as string;

    // 2b. Map tab name -> numeric sheetId (gid) for formatting requests
    const metaRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${newId}?fields=sheets.properties(sheetId,title)`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!metaRes.ok) {
      throw new Error(`Sheet meta fetch failed (${metaRes.status}): ${await metaRes.text()}`);
    }
    const gidByTab: Record<string, number> = {};
    for (const s of (await metaRes.json()).sheets ?? []) {
      gidByTab[s.properties.title] = s.properties.sheetId;
    }

    // 3. Read both tabs, locate TOTAL column, record data rows
    type Rec = { tab: string; invoice: string; sheetRow: number };
    const records: Rec[] = [];
    const totalColByTab: Record<string, number> = {};
    for (const tab of ["Overseas", "Japan"]) {
      const rows = await readTab(token, newId, tab);
      const totalCol = findTotalCol(rows);
      if (totalCol < 0) throw new Error(`Could not locate "TOTAL" header in tab ${tab}`);
      totalColByTab[tab] = totalCol;
      for (let i = 0; i < rows.length; i++) {
        const b = rows[i]?.[1];
        if (b && /^\d{4,6}$/.test(String(b).trim())) {
          records.push({ tab, invoice: String(b).trim(), sheetRow: i + 1 });
        }
      }
    }

    // 4. RPC
    const invoices = Array.from(new Set(records.map((r) => r.invoice)));
    if (invoices.length === 0) {
      await fetch(`https://www.googleapis.com/drive/v3/files/${newId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      return new Response(
        JSON.stringify({ ok: true, invoices: 0, note: "no invoice rows in column B of either tab" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_tracking_for_invoices`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({ p_invoices: invoices }),
    });
    if (!rpcRes.ok) {
      throw new Error(`RPC get_tracking_for_invoices failed (${rpcRes.status}): ${await rpcRes.text()}`);
    }
    const tracking: Array<{
      invoice_number: string;
      order_date: string;
      status: string;
      month_paid_jpy: Record<string, number> | null;
    }> = await rpcRes.json();

    if (tracking.length === 0) {
      await fetch(`https://www.googleapis.com/drive/v3/files/${newId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      return new Response(
        JSON.stringify({ ok: true, invoices: 0, note: "no invoice rows in column B of either tab" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 5. Earliest order_date -> cohort
    let earliest: Date | null = null;
    for (const t of tracking) {
      if (!t.order_date) continue;
      const d = new Date(t.order_date);
      if (!earliest || d < earliest) earliest = d;
    }
    if (!earliest) {
      throw new Error("No order_date found in tracking results");
    }
    const cohortYear = earliest.getUTCFullYear();
    const cohortMonth = earliest.getUTCMonth() + 1;

    const byInvoice = new Map<string, Record<string, number>>();
    const statusByInvoice = new Map<string, string>();
    for (const t of tracking) {
      if (t.month_paid_jpy) byInvoice.set(t.invoice_number, t.month_paid_jpy);
      if (t.status) statusByInvoice.set(t.invoice_number, t.status);
    }

    // 6. Build value ranges (months + D/E + STATUS) and red-row format requests
    const data: Array<{ range: string; values: (string | number)[][] }> = [];
    const formatReqs: Array<Record<string, unknown>> = [];
    const FIRST_MONTH_COL = 6; // column G (0-indexed)

    for (const rec of records) {
      const totalCol = totalColByTab[rec.tab];
      const totalLetter = colLetter(totalCol);

      // D (Amt Paid Posted) = this row's TOTAL cell; E (Balance) = C - D. Every invoice row.
      data.push({ range: `${rec.tab}!D${rec.sheetRow}`, values: [[`=${totalLetter}${rec.sheetRow}`]] });
      data.push({ range: `${rec.tab}!E${rec.sheetRow}`, values: [[`=C${rec.sheetRow}-D${rec.sheetRow}`]] });

      // Month columns (G .. last month before TOTAL)
      const mp = byInvoice.get(rec.invoice);
      if (mp) {
        for (const [ym, value] of Object.entries(mp)) {
          const m = /^(\d{4})-(\d{2})$/.exec(ym);
          if (!m) continue;
          const yyyy = parseInt(m[1], 10);
          const mm = parseInt(m[2], 10);
          const offset = (yyyy - cohortYear) * 12 + (mm - cohortMonth);
          const colIndex = FIRST_MONTH_COL + offset;
          if (offset < 0 || colIndex >= totalCol) continue; // never touch TOTAL/STATUS
          data.push({ range: `${rec.tab}!${colLetter(colIndex)}${rec.sheetRow}`, values: [[value]] });
        }
      }

      // Cancelled / final_forfeited -> STATUS label + red row
      const st = statusByInvoice.get(rec.invoice);
      if (st && STATUS_FLAG[st]) {
        const statusCol = colLetter(totalCol + 1); // column right after TOTAL
        data.push({ range: `${rec.tab}!${statusCol}${rec.sheetRow}`, values: [[STATUS_FLAG[st]]] });
        formatReqs.push({
          repeatCell: {
            range: {
              sheetId: gidByTab[rec.tab],
              startRowIndex: rec.sheetRow - 1,
              endRowIndex: rec.sheetRow,
              startColumnIndex: 0,
              endColumnIndex: totalCol + 2, // A .. STATUS inclusive
            },
            cell: { userEnteredFormat: { backgroundColor: { red: 0.96, green: 0.80, blue: 0.80 } } },
            fields: "userEnteredFormat.backgroundColor",
          },
        });
      }
    }

    if (data.length > 0) {
      const buRes = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${newId}/values:batchUpdate`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
        },
      );
      if (!buRes.ok) {
        throw new Error(`batchUpdate failed (${buRes.status}): ${await buRes.text()}`);
      }
    }

    // 6b. Red-row highlighting for cancelled / final_forfeited
    if (formatReqs.length > 0) {
      const fmtRes = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${newId}:batchUpdate`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ requests: formatReqs }),
        },
      );
      if (!fmtRes.ok) {
        throw new Error(`format batchUpdate failed (${fmtRes.status}): ${await fmtRes.text()}`);
      }
    }

    // 7. Place into year/month folder
    const monthName = MONTH_NAMES[cohortMonth - 1];
    const yearId = await findOrCreateFolder(token, TRACKER_ROOT_FOLDER_ID, String(cohortYear));
    const monthId = await findOrCreateFolder(token, yearId, monthName);

    const patchRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${newId}?addParents=${monthId}&removeParents=root&fields=id`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: monthName }),
      },
    );
    if (!patchRes.ok) {
      throw new Error(`Drive move failed (${patchRes.status}): ${await patchRes.text()}`);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        invoices: invoices.length,
        cells: data.length,
        flagged: formatReqs.length,
        sheetId: newId,
        movedTo: monthId,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[fill-payment-tracking] error:", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message || "internal_error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
