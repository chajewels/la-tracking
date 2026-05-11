import { appendOneReceipt, type CashReceiptSlot } from "../_shared/cash-receipt.ts";

interface RequestBody {
  sheet_id: string;
  slot_index: number;
  proof_url: string;
  invoice_number: string;
  payment_date: string;
  amount: number;
}

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

    const slot: CashReceiptSlot = {
      slot_index: body.slot_index,
      proof_url: body.proof_url,
      invoice_number: body.invoice_number,
      payment_date: body.payment_date,
      amount: body.amount,
    };

    // Delegate to shared helper
    const result = await appendOneReceipt(body.sheet_id, slot);

    console.log(
      `[append-cash-receipt] Wrote slot ${body.slot_index} to sheet ${body.sheet_id}: ` +
      `${result.cells_updated} cells updated`,
    );

    return jsonResponse(200, {
      success: true,
      slot_index: body.slot_index,
      sheet_id: body.sheet_id,
      cells_updated: result.cells_updated,
    });
  } catch (err) {
    console.error("[append-cash-receipt] error:", err);
    return jsonResponse(500, { error: (err as Error).message });
  }
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
