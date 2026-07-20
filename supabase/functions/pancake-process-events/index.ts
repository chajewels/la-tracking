import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Pancake POS event processor — Phase 2.
// Drains pending rows from pancake_events and converts qualifying orders into
// cash_orders + cash_order_items. Mirrors shopify-webhook's insert shape.
// Auth: x-pancake-secret (same shared secret as the receiver — this is the
// Pancake integration's internal trust boundary). Low blast radius: it only
// processes events already captured in our own ledger; it cannot inject data.
// MUST run with verify_jwt = false at the gateway.
//
// SCOPE (Phase 2): creates NEW cash orders only.
//   - Empty shells (no items or total <= 0) -> skipped
//   - Cancellations (status 6) -> skipped, flagged for manual handling
//   - Update events for an order that already exists -> marked processed, NOT re-synced

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-pancake-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const LOG = "[pancake-process-events]";
const UNIQUE_VIOLATION = "23505";
const BATCH_SIZE = 25;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

// Strip non-digits; require a plausible length. Same rule as shopify-webhook.
function normalizePhone(raw: unknown): string | null {
  if (!raw || typeof raw !== "string") return null;
  const digits = raw.replace(/[^\d]/g, "");
  return digits.length >= 7 ? digits : null;
}

// PHT (Asia/Manila) day boundary, per CLAUDE.md TIMEZONE STANDARD.
function phtToday(): string {
  return new Date(Date.now() + 8 * 3600000).toISOString().split("T")[0];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const expected = Deno.env.get("PANCAKE_WEBHOOK_SECRET");
  if (!expected) return json({ error: "Server misconfigured" }, 500);
  if (!timingSafeEqual(req.headers.get("x-pancake-secret") ?? "", expected)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: events, error: fetchErr } = await supabase
    .from("pancake_events")
    .select("id, pancake_order_id, event_type, event_updated_at, raw_payload")
    .eq("status", "pending")
    .order("event_updated_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (fetchErr) {
    console.error(`${LOG} fetch failed`, fetchErr);
    return json({ error: "Fetch failed" }, 500);
  }
  if (!events || events.length === 0) return json({ ok: true, processed: 0, skipped: 0, errors: 0 });

  let processed = 0, skipped = 0, errors = 0;

  const mark = async (id: string, status: string, detail: string | null) => {
    await supabase
      .from("pancake_events")
      .update({ status, error_detail: detail, processed_at: new Date().toISOString() })
      .eq("id", id);
  };

  for (const ev of events) {
    try {
      const p = (ev.raw_payload ?? {}) as Record<string, any>;
      const pancakeOrderId: string = ev.pancake_order_id;

      // Cancellations are money-adjacent — never auto-handled here.
      if (Number(p.status) === 6) {
        await mark(ev.id, "skipped", "cancellation (status 6) — manual handling required");
        skipped++; continue;
      }

      const items: any[] = Array.isArray(p.items) ? p.items : [];
      const totalPrice = Number(p.total_price) || 0;
      if (items.length === 0 || totalPrice <= 0) {
        await mark(ev.id, "skipped", "no items or total <= 0");
        skipped++; continue;
      }

      // Already converted? (create+update share an order id)
      const { data: existingOrder } = await supabase
        .from("cash_orders").select("id").eq("pancake_order_id", pancakeOrderId).maybeSingle();
      if (existingOrder) {
        await mark(ev.id, "processed", "cash_order already exists — not re-synced (Phase 2 scope)");
        processed++; continue;
      }

      // ---- Customer cascade: email -> pancake_fb_id -> phone -> create+flag ----
      const cust = (p.customer ?? {}) as Record<string, any>;
      let customerId: string | null = null;

      const email: string | null =
        (Array.isArray(cust.emails) && cust.emails.length > 0 ? String(cust.emails[0]) : null) ||
        (typeof p.bill_email === "string" && p.bill_email ? p.bill_email : null);
      if (email) {
        const { data } = await supabase.from("customers").select("id").ilike("email", email).limit(1);
        if (data && data.length > 0) customerId = data[0].id;
      }

      const fbId: string | null = typeof cust.fb_id === "string" && cust.fb_id ? cust.fb_id : null;
      if (!customerId && fbId) {
        const { data } = await supabase.from("customers").select("id").eq("pancake_fb_id", fbId).limit(1);
        if (data && data.length > 0) customerId = data[0].id;
      }

      const phone = normalizePhone(
        (Array.isArray(cust.phone_numbers) && cust.phone_numbers.length > 0 ? cust.phone_numbers[0] : null) ??
        p.shipping_address?.phone_number ?? p.bill_phone_number,
      );
      if (!customerId && phone) {
        const { data } = await supabase.from("customers").select("id").eq("mobile_number", phone).limit(1);
        if (data && data.length > 0) customerId = data[0].id;
      }

      if (!customerId) {
        const fullName =
          (typeof p.bill_full_name === "string" && p.bill_full_name) ||
          (typeof cust.name === "string" && cust.name) || "Pancake Customer";
        const { data: newCust, error: custErr } = await supabase
          .from("customers")
          .insert({
            full_name: fullName,
            email: email ?? null,
            mobile_number: phone ?? null,
            facebook_name: typeof cust.name === "string" ? cust.name : null,
            pancake_fb_id: fbId,
            source: "pancake",
            needs_review: true,
          })
          .select("id").single();
        if (custErr || !newCust) {
          await mark(ev.id, "error", `customer create failed: ${custErr?.message ?? "unknown"}`);
          errors++; continue;
        }
        customerId = newCust.id;
        console.log(`${LOG} created flagged customer ${customerId}`);
      } else if (fbId) {
        // Backfill the stable key — only when empty, never overwrite.
        const { error: bfErr } = await supabase
          .from("customers").update({ pancake_fb_id: fbId })
          .eq("id", customerId).is("pancake_fb_id", null);
        if (bfErr && bfErr.code !== UNIQUE_VIOLATION) {
          console.warn(`${LOG} fb_id backfill failed: ${bfErr.message}`);
        }
      }

      // ---- cash_order (mirrors create-cash-order / shopify-webhook shape) ----
      const orderDate =
        (typeof p.inserted_at === "string" ? p.inserted_at.split("T")[0] : null) || phtToday();
      const expiresAt = new Date(new Date(orderDate + "T00:00:00Z").getTime() + 30 * 86400000).toISOString();
      const invoiceNumber = "PKE-" + pancakeOrderId;
      const currency = typeof p.order_currency === "string" && p.order_currency ? p.order_currency : "JPY";

      let cashOrderId: string | null = null;
      const { data: newOrder, error: orderErr } = await supabase
        .from("cash_orders")
        .insert({
          customer_id: customerId,
          invoice_number: invoiceNumber,
          currency,
          total_amount: totalPrice,
          order_date: orderDate,
          expires_at: expiresAt,
          status: "pending",
          total_paid: 0,
          remaining_balance: totalPrice,
          loyalty_jpy_amount: totalPrice,
          source_channel: "pancake",
          pancake_order_id: pancakeOrderId,
        })
        .select("id").single();

      if (orderErr) {
        if (orderErr.code === UNIQUE_VIOLATION) {
          const { data: ex } = await supabase
            .from("cash_orders").select("id").eq("pancake_order_id", pancakeOrderId).maybeSingle();
          cashOrderId = ex?.id ?? null;
        } else {
          await mark(ev.id, "error", `cash_order insert failed: ${orderErr.message}`);
          errors++; continue;
        }
      } else {
        cashOrderId = newOrder?.id ?? null;
      }

      // ---- line items (best-effort; order still stands if these fail) ----
      if (cashOrderId && items.length > 0) {
        try {
          const rows = items.map((it: any) => {
            const vi = it?.variation_info ?? {};
            const unit = Number(vi.retail_price) || 0;
            const qty = Number(it?.quantity) || 1;
            return {
              cash_order_id: cashOrderId,
              title: String(vi.name ?? it?.note_product ?? "Pancake item"),
              sku: vi.barcode ? String(vi.barcode) : (vi.display_id ? String(vi.display_id) : null),
              quantity: qty,
              unit_price_jpy: unit,
              line_total_jpy: unit * qty,
              product_id: null,
              image_url: null,
            };
          });
          const { error: itemsErr } = await supabase.from("cash_order_items").insert(rows);
          if (itemsErr && itemsErr.code !== UNIQUE_VIOLATION) {
            console.warn(`${LOG} items insert failed for ${pancakeOrderId}: ${itemsErr.message}`);
          }
        } catch (e) {
          console.warn(`${LOG} items exception: ${(e as Error).message}`);
        }
      }

      await mark(ev.id, "processed", null);
      processed++;
      console.log(`${LOG} converted ${pancakeOrderId} -> cash_order ${cashOrderId}`);
    } catch (e) {
      await mark(ev.id, "error", (e as Error).message);
      errors++;
    }
  }

  return json({ ok: true, processed, skipped, errors, batch: events.length });
});
