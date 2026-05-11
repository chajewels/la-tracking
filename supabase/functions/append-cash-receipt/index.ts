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
  image: string;     // e.g., "Cash Receipt!B5" (merge anchor of B5:F32)
  metadata: string;  // e.g., "Cash Receipt!B40" (merge anchor of B40:F45,
                     //   receives multi-line INVOICE/DATE/AMOUNT text)
}

const TAB = "Cash Receipt";

const SLOTS: Record<number, SlotCells> = {
  1:  { image: `${TAB}!B5`,   metadata: `${TAB}!B40`  },
  2:  { image: `${TAB}!B58`,  metadata: `${TAB}!B93`  },
  3:  { image: `${TAB}!B110`, metadata: `${TAB}!B145` },
  4:  { image: `${TAB}!I5`,   metadata: `${TAB}!I40`  },
  5:  { image: `${TAB}!I58`,  metadata: `${TAB}!I93`  },
  6:  { image: `${TAB}!I110`, metadata: `${TAB}!I145` },
  7:  { image: `${TAB}!P5`,   metadata: `${TAB}!P40`  },
  8:  { image: `${TAB}!P58`,  metadata: `${TAB}!P93`  },
  9:  { image: `${TAB}!P110`, metadata: `${TAB}!P145` },
  10: { image: `${TAB}!W5`,   metadata: `${TAB}!W40`  },
  11: { image: `${TAB}!W58`,  metadata: `${TAB}!W93`  },
  12: { image: `${TAB}!W110`, metadata: `${TAB}!W145` },
  13: { image: `${TAB}!W158`, metadata: `${TAB}!W191` },
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

    // Format amount with thousands separator + JPY suffix
    // (25488 → "25,488 JPY")
    const formattedAmount = `${body.amount.toLocaleString("en-US")} JPY`;

    // Build the metadata text block. Spaced format matches the
    // template's 6-row merged metadata cell layout.
    const metadataText =
      `INVOICE #: ${body.invoice_number}\n\n` +
      `DATE: ${body.payment_date}\n\n` +
      `AMOUNT: ${formattedAmount}`;

    // Build values:batchUpdate payload (2 cells: image + combined metadata)
    const requestBody = {
      valueInputOption: "USER_ENTERED",
      data: [
        { range: slot.image,    values: [[imageFormula]] },
        { range: slot.metadata, values: [[metadataText]] },
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
