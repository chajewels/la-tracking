import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Pancake invoice pre-fill — mirrors get-page365-order's request/response
// contract exactly so the Invoice Generator can treat both sources alike.
// Reads from our own pancake_events ledger (the captured webhook payload),
// NOT from the Pancake API — no single-order endpoint is documented, and the
// ledger already holds the full order. Read-only: writes nothing.
// Accepts invoice_number ("PKE-<order_id>") or a bare Pancake order_id.

interface Item {
  description: string;
  qty: number;
  unit_price_with_tax: number;
}

interface OrderResponse {
  found: boolean;
  address?: string;
  phone?: string;
  shipping_fee?: number;
  discount?: number;
  items?: Item[];
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function num(val: unknown): number {
  if (val === null || val === undefined || val === "") return 0;
  const n = Number(val);
  return isNaN(n) ? 0 : n;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse(405, { error: "Method not allowed" });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return jsonResponse(401, { error: "Unauthorized" });
  const token = authHeader.replace("Bearer ", "");

  const authClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data: { user }, error: authError } = await authClient.auth.getUser(token);
  if (authError || !user) return jsonResponse(401, { error: "Unauthorized" });

  const { data: roleRows } = await authClient
    .from("user_roles").select("role").eq("user_id", user.id)
    .in("role", ["admin", "staff", "finance", "csr"]).limit(1);
  if (!roleRows || roleRows.length === 0) return jsonResponse(403, { error: "Forbidden" });

  try {
    const body = await req.json();
    const rawKey = String(body?.invoice_number ?? "").trim();
    if (!rawKey) return jsonResponse(400, { error: "invoice_number is required" });

    // "PKE-90085118275294" -> "90085118275294"; a bare order id passes through.
    const orderId = rawKey.replace(/^PKE-/i, "").trim();

    // Newest captured event for this order wins (updates supersede creates).
    const { data: rows, error } = await authClient
      .from("pancake_events")
      .select("raw_payload")
      .eq("pancake_order_id", orderId)
      .order("event_updated_at", { ascending: false })
      .limit(1);

    if (error) {
      console.error("get-pancake-order query error:", error);
      return jsonResponse(500, { error: error.message });
    }
    if (!rows || rows.length === 0) return jsonResponse(200, { found: false });

    const p = (rows[0].raw_payload ?? {}) as Record<string, any>;
    const rawItems: any[] = Array.isArray(p.items) ? p.items : [];

    const items: Item[] = rawItems.map((it: any) => {
      const vi = it?.variation_info ?? {};
      return {
        description: String(vi.name ?? it?.note_product ?? "").trim(),
        qty: num(it?.quantity) || 1,
        // retail_price is treated as tax-INCLUSIVE (matches captured orders where
        // total_price === retail_price despite tax_rate 0.1). Revisit if a real
        // multi-item order shows otherwise.
        unit_price_with_tax: num(vi.retail_price),
      };
    });

    const addr = p.shipping_address ?? {};
    const phone =
      (typeof p.bill_phone_number === "string" && p.bill_phone_number) ||
      (typeof addr.phone_number === "string" && addr.phone_number) ||
      (Array.isArray(p.customer?.phone_numbers) && p.customer.phone_numbers.length > 0
        ? String(p.customer.phone_numbers[0])
        : "");

    const response: OrderResponse = {
      found: true,
      address: String(addr.full_address ?? "").trim(),
      phone: String(phone).trim(),
      shipping_fee: num(p.shipping_fee),
      discount: num(p.total_discount),
      items,
    };

    return jsonResponse(200, response);
  } catch (err) {
    console.error("get-pancake-order error:", err);
    return jsonResponse(500, { error: (err as Error).message });
  }
});
