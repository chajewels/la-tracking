import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Phase 4 — Shopify storefront order webhook receiver (PATH B).
// PUBLIC, security-critical endpoint: HMAC-verify BEFORE any processing.
// Handles orders/create + orders/paid only; other topics are acknowledged
// (200) and ignored. All DB access is via the service-role client — there is
// no user JWT on an inbound webhook. This function MUST run with
// verify_jwt = false at the gateway (configured at deploy time).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-shopify-hmac-sha256, x-shopify-topic, x-shopify-webhook-id",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const LOG = "[shopify-webhook]";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Constant-time string comparison over the full length — accumulate all
// differences (including a length mismatch) and never early-return.
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

// base64(HMAC-SHA256(rawBody, secret)) using the Web Crypto API.
async function computeHmacBase64(secret: string, rawBytes: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, rawBytes);
  let binary = "";
  const bytes = new Uint8Array(sig);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// PHT (Asia/Manila) day-boundary date string, per CLAUDE.md TIMEZONE STANDARD.
function phtToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
}

function normalizePhone(raw: unknown): string | null {
  if (!raw || typeof raw !== "string") return null;
  const digits = raw.replace(/[^\d]/g, "");
  return digits.length >= 7 ? digits : null;
}

const UNIQUE_VIOLATION = "23505";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // ── 1. HMAC verification FIRST — before reading/parsing/writing anything ──
  const secret = Deno.env.get("SHOPIFY_API_SECRET");
  if (!secret) {
    console.error(`${LOG} SHOPIFY_API_SECRET not configured`);
    return json({ error: "not configured" }, 500);
  }

  // Raw body text is required for HMAC — read it BEFORE any JSON.parse.
  const raw = await req.text();
  const rawBytes = new TextEncoder().encode(raw);

  const hmacHeader = req.headers.get("X-Shopify-Hmac-Sha256") ?? "";
  const expected = await computeHmacBase64(secret, rawBytes);
  if (!hmacHeader || !timingSafeEqual(expected, hmacHeader)) {
    console.warn(`${LOG} HMAC verification failed — rejecting`);
    return json({ error: "unauthorized" }, 401);
  }

  // ── 2. Routing ──
  const topic = req.headers.get("X-Shopify-Topic") ?? "";
  const webhookId = req.headers.get("X-Shopify-Webhook-Id") ?? null;

  let order: any;
  try {
    order = JSON.parse(raw);
  } catch {
    return json({ error: "invalid payload" }, 400);
  }

  const shopifyOrderId = order?.id != null ? String(order.id) : null;
  if (!shopifyOrderId) {
    return json({ error: "missing order id" }, 400);
  }

  // Only orders/create + orders/paid are handled in Phase 4. Everything else
  // (cancel/update/etc.) is acknowledged and ignored — deferred to Phase 5.
  if (topic !== "orders/create" && topic !== "orders/paid") {
    console.log(`${LOG} ignoring topic=${topic} order=${shopifyOrderId}`);
    return json({ ignored: topic }, 200);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Record an error event, then surface a 500 so Shopify retries (idempotency
  // makes retries safe). Unique-violation "already exists" cases are NOT errors.
  const recordError = async (message: string): Promise<Response> => {
    try {
      await supabase.from("shopify_webhook_events").insert({
        shopify_order_id: shopifyOrderId,
        topic,
        webhook_id: webhookId,
        status: "error",
        error_detail: message,
      });
    } catch (_e) { /* best-effort */ }
    return json({ error: "processing_failed" }, 500);
  };

  try {
    // ── 3. Idempotency: skip if this (order, topic) was already processed ──
    const { data: existingEvent } = await supabase
      .from("shopify_webhook_events")
      .select("id")
      .eq("shopify_order_id", shopifyOrderId)
      .eq("topic", topic)
      .maybeSingle();
    if (existingEvent) {
      console.log(`${LOG} already processed topic=${topic} order=${shopifyOrderId}`);
      return json({ skipped: "already_processed" }, 200);
    }

    // ════════════════════════════════════════════════════════════
    // orders/create
    // ════════════════════════════════════════════════════════════
    if (topic === "orders/create") {
      // §6 customer matching: email → phone → create-and-flag.
      let customerId: string | null = null;

      const email: string | null = order.email ?? order.customer?.email ?? null;
      if (email) {
        const { data: byEmail } = await supabase
          .from("customers")
          .select("id")
          .ilike("email", email)
          .limit(1);
        if (byEmail && byEmail.length > 0) customerId = byEmail[0].id;
      }

      const phone = normalizePhone(order.phone ?? order.customer?.phone ?? order.billing_address?.phone);
      if (!customerId && phone) {
        const { data: byPhone } = await supabase
          .from("customers")
          .select("id")
          .eq("mobile_number", phone)
          .limit(1);
        if (byPhone && byPhone.length > 0) customerId = byPhone[0].id;
      }

      if (!customerId) {
        const fullName =
          [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(" ").trim() ||
          email ||
          "Shopify Customer";
        const { data: newCust, error: custErr } = await supabase
          .from("customers")
          .insert({
            full_name: fullName,
            email: email ?? null,
            mobile_number: phone ?? null,
            source: "shopify",
            needs_review: true,
          })
          .select("id")
          .single();
        if (custErr || !newCust) {
          return await recordError(`customer create failed: ${custErr?.message ?? "unknown"}`);
        }
        customerId = newCust.id;
        console.log(`${LOG} created flagged customer ${customerId} for order ${shopifyOrderId}`);
      }

      // Build the cash_order (mirrors create-cash-order's insert shape).
      const totalAmount = Number(order.total_price) || 0;
      const orderDate = (typeof order.created_at === "string" ? order.created_at.split("T")[0] : null) || phtToday();
      const expiresAt = new Date(new Date(orderDate + "T00:00:00Z").getTime() + 30 * 86400000).toISOString();
      const invoiceNumber = "SH-" + String(order.order_number ?? order.name ?? order.id);

      let cashOrderId: string | null = null;
      const { data: newOrder, error: orderErr } = await supabase
        .from("cash_orders")
        .insert({
          customer_id: customerId,
          invoice_number: invoiceNumber,
          currency: "JPY",
          total_amount: totalAmount,
          order_date: orderDate,
          expires_at: expiresAt,
          status: "pending",
          total_paid: 0,
          remaining_balance: totalAmount,
          loyalty_jpy_amount: totalAmount,
          source_channel: "shopify_direct",
          shopify_order_id: shopifyOrderId,
        })
        .select("id")
        .single();

      if (orderErr) {
        // Unique violation on shopify_order_id → a race/retry already created it.
        if (orderErr.code === UNIQUE_VIOLATION) {
          const { data: existing } = await supabase
            .from("cash_orders")
            .select("id")
            .eq("shopify_order_id", shopifyOrderId)
            .maybeSingle();
          cashOrderId = existing?.id ?? null;
          console.log(`${LOG} cash_order already exists for ${shopifyOrderId}`);
        } else {
          return await recordError(`cash_order insert failed: ${orderErr.message}`);
        }
      } else {
        cashOrderId = newOrder?.id ?? null;
      }

      // Line items — best-effort. If they fail the order still stands.
      if (cashOrderId && Array.isArray(order.line_items) && order.line_items.length > 0) {
        try {
          const rows = order.line_items.map((line: any) => {
            const unit = Number(line.price) || 0;
            const qty = Number(line.quantity) || 1;
            const title = line.variant_title ? `${line.title} (${line.variant_title})` : line.title;
            return {
              cash_order_id: cashOrderId,
              shopify_line_item_id: String(line.id),
              title,
              sku: line.sku ?? null,
              quantity: qty,
              unit_price_jpy: unit,
              line_total_jpy: unit * qty,
              product_id: null,
              image_url: null,
            };
          });
          // Ignore-on-conflict so retries don't duplicate line items.
          const { error: itemsErr } = await supabase
            .from("cash_order_items")
            .upsert(rows, { onConflict: "shopify_line_item_id", ignoreDuplicates: true });
          if (itemsErr && itemsErr.code !== UNIQUE_VIOLATION) {
            console.warn(`${LOG} line items partial failure for ${shopifyOrderId}: ${itemsErr.message}`);
          }
        } catch (e) {
          console.warn(`${LOG} line items exception for ${shopifyOrderId}: ${(e as Error).message}`);
        }
      }

      // Record the processed event (idempotency ledger).
      const { error: evtErr } = await supabase.from("shopify_webhook_events").insert({
        shopify_order_id: shopifyOrderId,
        topic,
        webhook_id: webhookId,
        status: "processed",
      });
      if (evtErr && evtErr.code !== UNIQUE_VIOLATION) {
        console.warn(`${LOG} event record failed for ${shopifyOrderId}: ${evtErr.message}`);
      }

      console.log(`${LOG} orders/create done order=${shopifyOrderId} cash_order=${cashOrderId}`);
      return json({ ok: true }, 200);
    }

    // ════════════════════════════════════════════════════════════
    // orders/paid
    // ════════════════════════════════════════════════════════════
    // orders/create + orders/paid normally arrive together; if paid lands
    // before create (order not yet in the DB), we acknowledge and defer rather
    // than create the order here. Shopify does not retry a 200 — acceptable for
    // Phase 4 given the near-simultaneous delivery of the two events.
    const { data: cashOrder } = await supabase
      .from("cash_orders")
      .select("id, total_amount, total_paid")
      .eq("shopify_order_id", shopifyOrderId)
      .maybeSingle();

    if (!cashOrder) {
      console.log(`${LOG} orders/paid: order ${shopifyOrderId} not found — deferring`);
      return json({ deferred: "order_not_found" }, 200);
    }

    const totalAmount = Number(cashOrder.total_amount) || 0;
    const alreadyPaid = Number(cashOrder.total_paid) || 0;

    if (alreadyPaid < totalAmount) {
      const paidAmount = Number(order.total_price) || totalAmount;
      const { error: payErr } = await supabase.from("cash_payments").insert({
        cash_order_id: cashOrder.id,
        amount_paid: paidAmount,
        currency: "JPY",
        date_paid: phtToday(),
        reference_number: "SHOPIFY-" + shopifyOrderId,
        remarks: "Shopify storefront order (auto)",
      });
      if (payErr) {
        return await recordError(`cash_payment insert failed: ${payErr.message}`);
      }

      const { error: updErr } = await supabase
        .from("cash_orders")
        .update({ total_paid: totalAmount, remaining_balance: 0, status: "completed" })
        .eq("id", cashOrder.id);
      if (updErr) {
        return await recordError(`cash_order completion update failed: ${updErr.message}`);
      }

      // Loyalty award — reads loyalty_jpy_amount from the order. Fire-and-forget:
      // a loyalty failure must NEVER fail the webhook.
      try {
        await supabase.functions.invoke("award-loyalty-points", {
          body: { cash_order_id: cashOrder.id },
        });
      } catch (e) {
        console.warn(`${LOG} loyalty award failed for ${shopifyOrderId}: ${(e as Error).message}`);
      }

      console.log(`${LOG} orders/paid completed order=${shopifyOrderId} cash_order=${cashOrder.id}`);
    } else {
      console.log(`${LOG} orders/paid: order ${shopifyOrderId} already fully paid`);
    }

    const { error: evtErr } = await supabase.from("shopify_webhook_events").insert({
      shopify_order_id: shopifyOrderId,
      topic,
      webhook_id: webhookId,
      status: "processed",
    });
    if (evtErr && evtErr.code !== UNIQUE_VIOLATION) {
      console.warn(`${LOG} event record failed for ${shopifyOrderId}: ${evtErr.message}`);
    }

    return json({ ok: true }, 200);
  } catch (e) {
    return await recordError((e as Error).message ?? "unknown error");
  }
});
