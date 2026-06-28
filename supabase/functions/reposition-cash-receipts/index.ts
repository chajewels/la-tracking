import { getServiceAccountAccessToken } from "../_shared/google-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const TAB = "Cash Receipt";

// OLD row-major map (pre-fix layout) — where existing slips currently sit.
// Band anchors image/meta: 5/40, 58/93, 110/145, 163/198, 216/251, 269/304.
const OLD_SLOTS: Record<number, { image: string; metadata: string }> = {
  1:{image:`${TAB}!B5`,metadata:`${TAB}!B40`},   2:{image:`${TAB}!I5`,metadata:`${TAB}!I40`},
  3:{image:`${TAB}!P5`,metadata:`${TAB}!P40`},   4:{image:`${TAB}!W5`,metadata:`${TAB}!W40`},
  5:{image:`${TAB}!B58`,metadata:`${TAB}!B93`},  6:{image:`${TAB}!I58`,metadata:`${TAB}!I93`},
  7:{image:`${TAB}!P58`,metadata:`${TAB}!P93`},  8:{image:`${TAB}!W58`,metadata:`${TAB}!W93`},
  9:{image:`${TAB}!B110`,metadata:`${TAB}!B145`},10:{image:`${TAB}!I110`,metadata:`${TAB}!I145`},
  11:{image:`${TAB}!P110`,metadata:`${TAB}!P145`},12:{image:`${TAB}!W110`,metadata:`${TAB}!W145`},
  13:{image:`${TAB}!B163`,metadata:`${TAB}!B198`},14:{image:`${TAB}!I163`,metadata:`${TAB}!I198`},
  15:{image:`${TAB}!P163`,metadata:`${TAB}!P198`},16:{image:`${TAB}!W163`,metadata:`${TAB}!W198`},
  17:{image:`${TAB}!B216`,metadata:`${TAB}!B251`},18:{image:`${TAB}!I216`,metadata:`${TAB}!I251`},
  19:{image:`${TAB}!P216`,metadata:`${TAB}!P251`},20:{image:`${TAB}!W216`,metadata:`${TAB}!W251`},
  21:{image:`${TAB}!B269`,metadata:`${TAB}!B304`},22:{image:`${TAB}!I269`,metadata:`${TAB}!I304`},
  23:{image:`${TAB}!P269`,metadata:`${TAB}!P304`},24:{image:`${TAB}!W269`,metadata:`${TAB}!W304`},
};

// NEW column-major map (post-fix layout) — where slips should go.
// Columns B,I,P,W; band anchors 5/40, 58/93, 110/145, 163/198, 214/249, 265/300.
const NEW_SLOTS: Record<number, { image: string; metadata: string }> = {
  1:{image:`${TAB}!B5`,metadata:`${TAB}!B40`},   2:{image:`${TAB}!B58`,metadata:`${TAB}!B93`},
  3:{image:`${TAB}!B110`,metadata:`${TAB}!B145`},4:{image:`${TAB}!B163`,metadata:`${TAB}!B198`},
  5:{image:`${TAB}!B214`,metadata:`${TAB}!B249`},6:{image:`${TAB}!B265`,metadata:`${TAB}!B300`},
  7:{image:`${TAB}!I5`,metadata:`${TAB}!I40`},   8:{image:`${TAB}!I58`,metadata:`${TAB}!I93`},
  9:{image:`${TAB}!I110`,metadata:`${TAB}!I145`},10:{image:`${TAB}!I163`,metadata:`${TAB}!I198`},
  11:{image:`${TAB}!I214`,metadata:`${TAB}!I249`},12:{image:`${TAB}!I265`,metadata:`${TAB}!I300`},
  13:{image:`${TAB}!P5`,metadata:`${TAB}!P40`},  14:{image:`${TAB}!P58`,metadata:`${TAB}!P93`},
  15:{image:`${TAB}!P110`,metadata:`${TAB}!P145`},16:{image:`${TAB}!P163`,metadata:`${TAB}!P198`},
  17:{image:`${TAB}!P214`,metadata:`${TAB}!P249`},18:{image:`${TAB}!P265`,metadata:`${TAB}!P300`},
  19:{image:`${TAB}!W5`,metadata:`${TAB}!W40`},  20:{image:`${TAB}!W58`,metadata:`${TAB}!W93`},
  21:{image:`${TAB}!W110`,metadata:`${TAB}!W145`},22:{image:`${TAB}!W163`,metadata:`${TAB}!W198`},
  23:{image:`${TAB}!W214`,metadata:`${TAB}!W249`},24:{image:`${TAB}!W265`,metadata:`${TAB}!W300`},
};

interface Body {
  sheet_id: string;
  slots: Array<{ slot_index: number; proof_url: string }>; // chronological, 1-based
  dry_run?: boolean;
}

async function valuesGet(sheetId: string, range: string, token: string): Promise<string> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`values.get ${range} failed ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return (j.values?.[0]?.[0] ?? "") as string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = (await req.json()) as Body;
    if (!body.sheet_id || !Array.isArray(body.slots) || body.slots.length === 0) {
      return new Response(JSON.stringify({ error: "sheet_id and non-empty slots[] required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const n = body.slots.length;
    for (const s of body.slots) {
      if (!Number.isInteger(s.slot_index) || s.slot_index < 1 || s.slot_index > 24) {
        return new Response(JSON.stringify({ error: `bad slot_index ${s.slot_index}` }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }
    const token = await getServiceAccountAccessToken();

    // 1. READ existing metadata text from OLD positions.
    const meta: Record<number, string> = {};
    for (const s of body.slots) {
      meta[s.slot_index] = await valuesGet(body.sheet_id, OLD_SLOTS[s.slot_index].metadata, token);
    }

    // 2. Build CLEAR list (all old image+meta cells for slots 1..n) and WRITE list (new cells).
    const clearRanges: string[] = [];
    for (const s of body.slots) {
      clearRanges.push(OLD_SLOTS[s.slot_index].image, OLD_SLOTS[s.slot_index].metadata);
    }
    const writeData: Array<{ range: string; values: string[][] }> = [];
    for (const s of body.slots) {
      const url = s.proof_url.replace(/"/g, '""');
      writeData.push({ range: NEW_SLOTS[s.slot_index].image, values: [[`=IMAGE("${url}", 1)`]] });
      writeData.push({ range: NEW_SLOTS[s.slot_index].metadata, values: [[meta[s.slot_index]]] });
    }

    if (body.dry_run) {
      return new Response(JSON.stringify({ dry_run: true, sheet_id: body.sheet_id, n, read_metadata: meta, clear: clearRanges, write: writeData }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 3. CLEAR old cells (batchClear), then 4. WRITE new cells (values:batchUpdate).
    const clearRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${body.sheet_id}/values:batchClear`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ranges: clearRanges }),
    });
    if (!clearRes.ok) throw new Error(`batchClear failed ${clearRes.status}: ${await clearRes.text()}`);

    const writeRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${body.sheet_id}/values:batchUpdate`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ valueInputOption: "USER_ENTERED", data: writeData }),
    });
    if (!writeRes.ok) throw new Error(`batchUpdate failed ${writeRes.status}: ${await writeRes.text()}`);
    const wj = await writeRes.json();

    return new Response(JSON.stringify({ success: true, sheet_id: body.sheet_id, slots_repositioned: n, cells_cleared: clearRanges.length, cells_written: wj.totalUpdatedCells ?? 0 }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
