import { getServiceAccountAccessToken } from "../_shared/google-auth.ts";

interface RequestBody {
  sheet_id: string;       // Google Sheet ID (the invoice file)
  slot_index: number;     // 1-13
  proof_url: string;      // public URL of receipt image
  invoice_number: string; // value for INVOICE # cell
  payment_date: string;   // value for DATE cell (formatted string)
  amount: number;         // value for AMOUNT cell
}

interface SlotCells {
  image: string;    // e.g., "Cash Receipt!B5"
  invoice: string;  // e.g., "Cash Receipt!B40"
  date: string;     // e.g., "Cash Receipt!B42"
  amount: string;   // e.g., "Cash Receipt!B44"
}

const TAB = "Cash Receipt";

const SLOTS: Record<number, SlotCells> = {
  1:  { image: `${TAB}!B5`,   invoice: `${TAB}!B40`,  date: `${TAB}!B42`,  amount: `${TAB}!B44`  },
  2:  { image: `${TAB}!B58`,  invoice: `${TAB}!B93`,  date: `${TAB}!B95`,  amount: `${TAB}!B97`  },
  3:  { image: `${TAB}!B110`, invoice: `${TAB}!B145`, date: `${TAB}!B147`, amount: `${TAB}!B149` },
  4:  { image: `${TAB}!I5`,   invoice: `${TAB}!I40`,  date: `${TAB}!I42`,  amount: `${TAB}!I44`  },
  5:  { image: `${TAB}!I58`,  invoice: `${TAB}!I93`,  date: `${TAB}!I95`,  amount: `${TAB}!I97`  },
  6:  { image: `${TAB}!I110`, invoice: `${TAB}!I145`, date: `${TAB}!I147`, amount: `${TAB}!I149` },
  7:  { image: `${TAB}!P5`,   invoice: `${TAB}!P40`,  date: `${TAB}!P42`,  amount: `${TAB}!P44`  },
  8:  { image: `${TAB}!P58`,  invoice: `${TAB}!P93`,  date: `${TAB}!P95`,  amount: `${TAB}!P97`  },
  9:  { image: `${TAB}!P110`, invoice: `${TAB}!P145`, date: `${TAB}!P147`, amount: `${TAB}!P149` },
  10: { image: `${TAB}!W5`,   invoice: `${TAB}!W40`,  date: `${TAB}!W42`,  amount: `${TAB}!W44`  },
  11: { image: `${TAB}!W58`,  invoice: `${TAB}!W93`,  date: `${TAB}!W95`,  amount: `${TAB}!W97`  },
  12: { image: `${TAB}!W110`, invoice: `${TAB}!W145`, date: `${TAB}!W147`, amount: `${TAB}!W149` },
  13: { image: `${TAB}!W158`, invoice: `${TAB}!W191`, date: `${TAB}!W193`, amount: `${TAB}!W195` },
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  try {
    const body: RequestBody = await req.json();

    // Validate inputs
    if (!body.sheet_id) {
      return jsonResponse(400, { error: "sheet_id is required" });
    }
    if (!body.proof_url) {
      return jsonResponse(400, { error: "proof_url is required" });
    }
    if (!body.invoice_number) {
      return jsonResponse(400, { error: "invoice_number is required" });
    }
    if (!Number.isInteger(body.slot_index) || body.slot_index < 1 || body.slot_index > 13) {
      return jsonResponse(400, { error: "slot_index must be an integer between 1 and 13" });
    }
    if (typeof body.amount !== "number" || isNaN(body.amount)) {
      return jsonResponse(400, { error: "amount must be a valid number" });
    }
    if (!body.payment_date) {
      return jsonResponse(400, { error: "payment_date is required" });
    }

    const slot = SLOTS[body.slot_index];
    if (!slot) {
      return jsonResponse(400, { error: `Invalid slot_index: ${body.slot_index}` });
    }

    // Sanitize proof_url for use inside =IMAGE() formula —
    // wrap in double quotes, escape any embedded double quotes
    const safeUrl = body.proof_url.replace(/"/g, '""');
    const imageFormula = `=IMAGE("${safeUrl}", 1)`;

    // Build values:batchUpdate payload (4 cells: image + 3 metadata)
    const requestBody = {
      valueInputOption: "USER_ENTERED",
      data: [
        { range: slot.image,   values: [[imageFormula]] },
        { range: slot.invoice, values: [[body.invoice_number]] },
        { range: slot.date,    values: [[body.payment_date]] },
        { range: slot.amount,  values: [[body.amount]] },
      ],
    };

    // Authenticate
    const accessToken = await getServiceAccountAccessToken();

    // Call Sheets API
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${body.sheet_id}/values:batchUpdate`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`Sheets API batchUpdate failed (${res.status}):`, errText);
      throw new Error(`Sheets API batchUpdate failed (${res.status}): ${errText}`);
    }

    const result = await res.json();
    console.log(
      `Wrote slot ${body.slot_index} to sheet ${body.sheet_id}: ` +
      `${result.totalUpdatedCells ?? 0} cells updated`,
    );

    return jsonResponse(200, {
      success: true,
      slot_index: body.slot_index,
      sheet_id: body.sheet_id,
      cells_updated: result.totalUpdatedCells ?? 0,
    });
  } catch (err) {
    console.error("append-cash-receipt error:", err);
    return jsonResponse(500, { error: (err as Error).message });
  }
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
