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
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tab + "!A1:P400")}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`read ${tab} failed (${r.status}): ${await r.text()}`);
  return (await r.json()).values || [];
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

    // 3. Read both tabs, record data rows
    type Rec = { tab: string; invoice: string; sheetRow: number };
    const records: Rec[] = [];
    for (const tab of ["Overseas", "Japan"]) {
      const rows = await readTab(token, newId, tab);
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

    // 5. Earliest order_date → cohort
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
    for (const t of tracking) {
      if (t.month_paid_jpy) byInvoice.set(t.invoice_number, t.month_paid_jpy);
    }

    // 6. Build ranges (G..N only)
    const data: Array<{ range: string; values: (string | number)[][] }> = [];
    for (const rec of records) {
      const mp = byInvoice.get(rec.invoice);
      if (!mp) continue;
      for (const [ym, value] of Object.entries(mp)) {
        const m = /^(\d{4})-(\d{2})$/.exec(ym);
        if (!m) continue;
        const yyyy = parseInt(m[1], 10);
        const mm = parseInt(m[2], 10);
        const offset = (yyyy - cohortYear) * 12 + (mm - cohortMonth);
        if (offset < 0 || offset > 7) continue;
        const col = String.fromCharCode(71 + offset); // G..N
        data.push({
          range: `${rec.tab}!${col}${rec.sheetRow}`,
          values: [[value]],
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
