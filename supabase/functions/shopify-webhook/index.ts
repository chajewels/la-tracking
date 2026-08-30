import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Phase 4 — Shopify storefront order webhook receiver (PATH B).
// PUBLIC, security-critical endpoint: HMAC-verify BEFORE any processing.
// Handles orders/create + orders/paid + orders/cancelled + orders/updated only;
// other topics are acknowledged (200) and ignored. orders/cancelled hands off to
// cancel_cash_order_atomic (store-credit issuance + earned-points revocation).
// orders/updated re-syncs the Hub order's line items and total_amount to Shopify
// (which is authoritative for what was ORDERED); total_paid is never changed.
// All DB access is via the service-role client — there is
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
  const sig = await crypto.subtle.sign("HMAC", key, rawBytes as BufferSource);
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

// Shopify Admin API version — matches shopify-register-webhooks (hardcoded const,
// NOT an env var).
const SHOPIFY_API_VERSION = "2026-07";

// Mint a short-lived Admin API token via the client-credentials grant — the SAME
// helper shopify-order-diag / shopify-register-webhooks use. There is NO
// SHOPIFY_ADMIN_ACCESS_TOKEN secret; the token is minted at runtime from
// SHOPIFY_API_KEY + SHOPIFY_API_SECRET. Content-Type MUST be
// x-www-form-urlencoded — JSON is rejected by Shopify.
async function mintAccessToken(): Promise<string> {
  const storeDomain = Deno.env.get("SHOPIFY_STORE_DOMAIN")!;
  const apiKey = Deno.env.get("SHOPIFY_API_KEY")!;
  const apiSecret = Deno.env.get("SHOPIFY_API_SECRET")!;
  const res = await fetch(`https://${storeDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: apiKey,
      client_secret: apiSecret,
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`${LOG} token grant failed (${res.status}): ${body}`);
    throw new Error(`Shopify token grant failed (${res.status}): ${body}`);
  }
  const j = await res.json();
  if (!j?.access_token) {
    console.error(`${LOG} token grant returned no access_token: ${JSON.stringify(j)}`);
    throw new Error("Shopify token grant returned no access_token");
  }
  return j.access_token as string;
}

// Records the Shopify store-credit portion of an order as a Hub payment and draws down the
// Hub's lots. Shopify consumes store credit at CHECKOUT, so this must run as soon as we see
// the transaction — at orders/create if it is already there, otherwise at orders/paid.
// Idempotent: the payment reference SHOPIFY-SC-<orderId> is unique per order, and the DB
// unique constraint means a second attempt is a no-op.
// Returns the store-credit amount recorded (0 if none).
async function applyShopifyStoreCredit(
  supabase: any,
  shopifyOrderId: string,
  order: any,
  cashOrder: { id: string; customer_id: string | null },
): Promise<number> {
  const gateways: string[] = Array.isArray(order?.payment_gateway_names)
    ? order.payment_gateway_names.map((g: unknown) => String(g))
    : [];
  if (!gateways.includes("shopify_store_credit")) return 0;

  // Fetch the per-gateway amounts (the webhook payload does not contain them).
  let txns: any[] = [];
  try {
    const token = await mintAccessToken();
    const txUrl = `https://${Deno.env.get("SHOPIFY_STORE_DOMAIN")}/admin/api/${SHOPIFY_API_VERSION}/orders/${shopifyOrderId}/transactions.json`;
    const txRes = await fetch(txUrl, {
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    });
    const txJson = await txRes.json().catch(() => null);
    txns = Array.isArray(txJson?.transactions) ? txJson.transactions : [];
  } catch (e) {
    console.error(`${LOG} store-credit tx fetch threw order=${shopifyOrderId}: ${(e as Error).message}`);
    return 0;
  }

  // Accept BOTH "sale" and "authorization" kinds. A successful store-credit
  // AUTHORIZATION means Shopify has ALREADY debited the customer's balance (the
  // transaction carries receipt.debit_operation_id) even though the order is not
  // yet fully paid — e.g. store credit + a still-pending bank transfer. The Hub
  // must mirror that debit immediately, or the same credit can be spent twice
  // while the order awaits payment. On a fully-settled store-credit-only order the
  // same transaction appears as kind "sale". `status === "success"` is NOT relaxed
  // — a pending/failed transaction is not a debit.
  const creditAmount = txns
    .filter((t) =>
      (t?.kind === "sale" || t?.kind === "authorization") &&
      t?.status === "success" &&
      t?.gateway === "shopify_store_credit"
    )
    .reduce((sum, t) => sum + (Number(t?.amount ?? 0) || 0), 0);

  if (!(creditAmount > 0)) return 0;

  // Idempotency, primary defence: check for an existing non-voided payment with this
  // reference before inserting. orders/create and orders/paid both call this helper,
  // so without the check the same store-credit payment would be recorded twice (and
  // the lot drawn down twice). scRef is used for BOTH the lookup and the insert so
  // they can never disagree.
  const scRef = `SHOPIFY-SC-${shopifyOrderId}`;
  const { data: existing } = await supabase
    .from("cash_payments")
    .select("id")
    .eq("reference_number", scRef)
    .is("voided_at", null)
    .maybeSingle();
  if (existing) {
    console.log(`${LOG} store-credit payment already recorded order=${shopifyOrderId} (ref ${scRef}) — skipping insert and drawdown`);
    return creditAmount;
  }

  // Second line of defence: a concurrent delivery could slip between the check above
  // and this insert. The partial unique index idx_cash_payments_reference_unique then
  // raises 23505 — treat that as success (the other delivery is doing the drawdown).
  const { error: scErr } = await supabase.from("cash_payments").insert({
    cash_order_id: cashOrder.id,
    amount_paid: creditAmount,
    currency: (order?.currency ?? "JPY"),
    payment_method: "store_credit",
    date_paid: phtToday(),
    reference_number: scRef,
    remarks: "Paid with Shopify store credit (consumed at checkout)",
  });
  if (scErr) {
    if ((scErr as any)?.code === "23505") {
      console.log(`${LOG} store-credit payment already recorded order=${shopifyOrderId} (ref ${scRef}, concurrent) — skipping drawdown`);
      return creditAmount;   // another delivery inserted it and is drawing down
    }
    console.error(`${LOG} store-credit payment insert failed order=${shopifyOrderId}: ${scErr.message}`);
    return 0;
  }

  // Draw down the Hub's lots to match what Shopify consumed.
  if (cashOrder.customer_id) {
    const { data: consumed, error: consumeErr } = await supabase.rpc(
      "consume_store_credit_for_shopify_atomic",
      {
        p_customer_id: cashOrder.customer_id,
        p_currency: order?.currency ?? "JPY",
        p_amount: creditAmount,
        p_cash_order_id: cashOrder.id,
        p_shopify_reference: scRef,
        p_source: "shopify_webhook",
      },
    );
    if (consumeErr) {
      console.error(`${LOG} store-credit drawdown FAILED order=${shopifyOrderId}:`, consumeErr);
    } else {
      console.log(`${LOG} store-credit drawdown order=${shopifyOrderId} ` + JSON.stringify(consumed));
      if (Number((consumed as any)?.shortfall ?? 0) > 0) {
        console.warn(`${LOG} SHORTFALL order=${shopifyOrderId}: Shopify consumed more store credit than the Hub had issued. ` + JSON.stringify(consumed));
      }
    }
  }

  return creditAmount;
}

// Recomputes a cash order's totals from its non-voided payments. Never guesses.
async function recomputeCashOrderTotals(supabase: any, cashOrderId: string, totalAmount: number) {
  const { data: rows } = await supabase
    .from("cash_payments")
    .select("amount_paid")
    .eq("cash_order_id", cashOrderId)
    .is("voided_at", null);
  const paid = (rows ?? []).reduce((s: number, r: any) => s + (Number(r?.amount_paid) || 0), 0);
  const remaining = Math.max(0, totalAmount - paid);
  await supabase.from("cash_orders").update({
    total_paid: paid,
    remaining_balance: remaining,
    status: remaining <= 0 ? "completed" : "pending",
    completed_at: remaining <= 0 ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  }).eq("id", cashOrderId)
    // No recompute may ever resurrect a cancelled order (concurrent
    // orders/cancelled can commit between fetch and write). A zero-row
    // match is not an error.
    .neq("status", "cancelled");
  return { paid, remaining };
}

// Mirror a Hub store-credit movement into Shopify (single source of truth = Hub).
// Same shape as cancel-cash-order's helper. Never throws; a sync failure must
// never block the webhook — sync-store-credit-to-shopify records its own retry row.
async function syncToShopify(body: Record<string, unknown>): Promise<unknown> {
  try {
    const res = await fetch(
      `${Deno.env.get("SUPABASE_URL")}/functions/v1/sync-store-credit-to-shopify`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify(body),
      },
    );
    const out = await res.json().catch(() => null);
    console.log(`${LOG} [sync-to-shopify]`, JSON.stringify(out));
    return out;
  } catch (e) {
    console.warn(`${LOG} [sync-to-shopify] failed (non-blocking):`, e);
    return { success: false, error: String((e as Error)?.message ?? e) };
  }
}

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

  // orders/create + orders/paid + orders/cancelled + orders/updated are handled.
  // Everything else is acknowledged and ignored.
  if (topic !== "orders/create" && topic !== "orders/paid" &&
      topic !== "orders/cancelled" && topic !== "orders/updated") {
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
    // Only status='processed' rows block reprocessing. Rows written by recordError
    // (status 'error') must NOT block: the function returns 500 on error precisely
    // so Shopify retries, and the retry must actually be allowed to run. Previously
    // one recorded error permanently blocked all future events of that topic for
    // that order (proven in production on orders/updated).
    const { data: existingEvent } = await supabase
      .from("shopify_webhook_events")
      .select("id")
      .eq("shopify_order_id", shopifyOrderId)
      .eq("topic", topic)
      .eq("status", "processed")
      .maybeSingle();
    if (existingEvent) {
      console.log(`${LOG} already processed topic=${topic} order=${shopifyOrderId}`);
      return json({ skipped: "already_processed" }, 200);
    }

    // ════════════════════════════════════════════════════════════
    // orders/create
    // ════════════════════════════════════════════════════════════
    if (topic === "orders/create") {
      // §6 customer matching: shopify_customer_id → email → phone → create-and-flag.
      // The Shopify customer ID is the most stable key (email can change; the
      // Shopify ID cannot) and is required to push store credit into Shopify.
      let customerId: string | null = null;

      const shopifyCustomerId: string | null =
        order.customer?.id != null ? String(order.customer.id) : null;

      if (shopifyCustomerId) {
        const { data: byShopifyId } = await supabase
          .from("customers")
          .select("id")
          .eq("shopify_customer_id", shopifyCustomerId)
          .limit(1);
        if (byShopifyId && byShopifyId.length > 0) customerId = byShopifyId[0].id;
      }

      const email: string | null = order.email ?? order.customer?.email ?? null;
      if (!customerId && email) {
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
            shopify_customer_id: shopifyCustomerId,
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

      // Backfill the stable Shopify key onto customers matched by email/phone (or
      // already linked). Only fills when empty — never overwrites an existing link;
      // a unique-violation (this Shopify ID already links a DIFFERENT Hub customer)
      // is logged but never blocks the order.
      if (customerId && shopifyCustomerId) {
        const { error: linkErr } = await supabase
          .from("customers")
          .update({ shopify_customer_id: shopifyCustomerId })
          .eq("id", customerId)
          .is("shopify_customer_id", null);
        if (linkErr) {
          console.warn(`${LOG} shopify_customer_id link failed for customer ${customerId}: ${linkErr.message}`);
        }
      }

      // Build the cash_order (mirrors create-cash-order's insert shape).
      // total_price is CUMULATIVE — the sum of everything ever added to the order; it NEVER
      // decreases when a line is edited out. current_total_price is what the customer actually
      // owes now. Fall back to total_price only when the current value is absent.
      const currentTotal = Number(order?.current_total_price ?? order?.total_price) || 0;
      const totalAmount = currentTotal;
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
      const liveLines = (Array.isArray(order.line_items) ? order.line_items : []).filter((l: any) => {
        // current_quantity is 0 for a line that was edited out of the order. It REMAINS in the
        // line_items array — Shopify never deletes it — so we must filter it out ourselves.
        const cq = l?.current_quantity;
        return cq === undefined || cq === null ? true : Number(cq) > 0;
      });
      console.log(`${LOG} orders/create line_items count=${liveLines.length} for ${shopifyOrderId}`);
      if (cashOrderId && liveLines.length > 0) {
        try {
          // Product images from the products cache — cosmetic; NEVER fail or skip
          // item insertion because the image lookup failed.
          let imageMap = new Map<string, string | null>();
          try {
            const productIds = [...new Set(liveLines.map((l: any) => l?.product_id).filter(Boolean).map(String))];
            if (productIds.length > 0) {
              const { data: prodRows } = await supabase
                .from("products")
                .select("shopify_product_id, image_url")
                .in("shopify_product_id", productIds.map((id) => `gid://shopify/Product/${id}`));
              // products.shopify_product_id stores GIDs ("gid://shopify/Product/12345")
              // while payload line.product_id is numeric — key the map on the numeric
              // tail so the row-mapper's String(line.product_id) lookup matches.
              imageMap = new Map((prodRows ?? []).map((p: any) => [String(p.shopify_product_id).split("/").pop() ?? "", p.image_url ?? null]));
            }
          } catch (e) {
            console.warn(`${LOG} product image lookup failed (non-blocking):`, e);
          }
          const rows = liveLines.map((line: any) => {
            const unit = Number(line.price) || 0;
            const qty = Number(line.current_quantity ?? line.quantity) || 1;
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
              image_url: imageMap.get(String(line.product_id)) ?? null,
            };
          });
          // Plain insert — cash_order_items.shopify_line_item_id has a PARTIAL
          // unique index (WHERE NOT NULL), which ON CONFLICT cannot target
          // without its predicate. A 23505 on retry means items already exist.
          const { error: itemsErr } = await supabase.from("cash_order_items").insert(rows);
          if (itemsErr && itemsErr.code !== UNIQUE_VIOLATION) {
            console.warn(`${LOG} line items insert failed for ${shopifyOrderId}: ${itemsErr.message}`);
          }
        } catch (e) {
          console.warn(`${LOG} line items exception for ${shopifyOrderId}: ${(e as Error).message}`);
        }
      }

      // Loyalty opt-in — enroll ONLY on the explicit consent signal. Shopify
      // carries cart/checkout attributes in order.note_attributes (array of
      // { name, value }); some payloads use order.attributes. We look for
      // 'loyalty_opt_in' (case-insensitive) with a truthy value. join-loyalty-
      // program is idempotent (already_enrolled) and respects the loyalty_enabled
      // toggle (403). Best-effort — never fails the webhook.
      const optInTruthy = (v: unknown): boolean => {
        if (v === true) return true;
        if (typeof v === "string") {
          return ["true", "1", "yes", "on"].includes(v.trim().toLowerCase());
        }
        return false;
      };
      const attrSources = [order.note_attributes, order.attributes];
      let loyaltyOptIn = false;
      for (const src of attrSources) {
        if (!Array.isArray(src)) continue;
        const hit = src.find((a: any) => String(a?.name ?? "").toLowerCase() === "loyalty_opt_in");
        if (hit && optInTruthy(hit.value)) { loyaltyOptIn = true; break; }
        // note_attributes is primary; only consult order.attributes when the
        // primary array was absent (not merely missing the key).
        if (Array.isArray(order.note_attributes)) break;
      }

      if (loyaltyOptIn && customerId) {
        try {
          const enrollRes = await fetch(
            `${Deno.env.get("SUPABASE_URL")}/functions/v1/join-loyalty-program`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
                "x-internal-secret": Deno.env.get("INTERNAL_FUNCTION_SECRET") ?? "",
              },
              body: JSON.stringify({ internal: true, customer_id: customerId }),
            },
          );
          if (enrollRes.ok) {
            console.log(`${LOG} loyalty opt-in enrolled customer=${customerId} order=${shopifyOrderId}`);
          } else {
            const body = await enrollRes.text().catch(() => "<no body>");
            console.warn(`${LOG} loyalty enrollment failed for customer=${customerId} order=${shopifyOrderId}: ${enrollRes.status} ${body}`);
          }
        } catch (e) {
          console.warn(`${LOG} loyalty enrollment failed for customer=${customerId} order=${shopifyOrderId}: ${(e as Error).message}`);
        }
      }

      // Shopify consumes store credit at CHECKOUT, so record + draw it down as soon as
      // orders/create lands — closing the double-spend window (seconds for PayPal, DAYS for
      // bank transfer / Konbini, forever if payment is never completed). If the store-credit
      // transaction is not there yet, this returns 0 and orders/paid catches it. Idempotent.
      if (cashOrderId) {
        const creditNow = await applyShopifyStoreCredit(supabase, shopifyOrderId, order, {
          id: cashOrderId,
          customer_id: customerId,
        });
        if (creditNow > 0) {
          await recomputeCashOrderTotals(supabase, cashOrderId, totalAmount);
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
    // orders/cancelled
    // ════════════════════════════════════════════════════════════
    // Shopify cancellation is NOT a cash refund: money actually received comes back as
    // STORE CREDIT. cancel_cash_order_atomic owns all of that logic (credit issuance,
    // earned-points revocation, notifications). We only locate the Hub order and call it.
    // Placed ahead of the orders/paid fall-through so a cancelled event never runs the
    // paid path (which is intentionally left unchanged).
    if (topic === "orders/cancelled") {
      const { data: cashOrder } = await supabase
        .from("cash_orders")
        .select("id, status, invoice_number")
        .eq("shopify_order_id", shopifyOrderId)
        .maybeSingle();

      // Order never synced to the Hub (e.g. created before the integration) — acknowledge,
      // do nothing. Do NOT record a webhook_events row so a later retry can still succeed.
      if (!cashOrder) {
        console.log(`${LOG} orders/cancelled no hub cash_order for ${shopifyOrderId}, ignoring`);
        return json({ ignored: "no_hub_order", shopify_order_id: shopifyOrderId }, 200);
      }

      const cancelReason =
        (typeof order?.cancel_reason === "string" && order.cancel_reason.trim())
          ? `Cancelled in Shopify (${order.cancel_reason.trim()})`
          : "Cancelled in Shopify";

      const { data: cancelResult, error: cancelError } = await supabase.rpc(
        "cancel_cash_order_atomic",
        {
          p_cash_order_id: cashOrder.id,
          p_reason: cancelReason,
          p_user_id: null,          // webhook has no user
          p_user_email: null,
          p_preview: false,
          p_source: "shopify_webhook",
        },
      );

      if (cancelError) {
        console.error(`${LOG} orders/cancelled rpc error for ${shopifyOrderId}:`, cancelError);
        // Return 500 so Shopify RETRIES — do not swallow a failed cancellation.
        return json({ error: cancelError.message ?? "cancel_cash_order_atomic failed" }, 500);
      }

      console.log(
        `${LOG} orders/cancelled done order=${shopifyOrderId} cash_order=${cashOrder.id} ` +
        `invoice=${cashOrder.invoice_number} result=${JSON.stringify(cancelResult)}`,
      );

      // Mirror the minted credit into Shopify. cancel_cash_order_atomic issues the
      // Hub lot but the Shopify push lives in the EDGE FUNCTIONS — the cancel-cash-order
      // function does this, and this branch must too, or Hub-minted credit from a
      // Shopify-side cancellation never reaches Shopify (ledger drift). Non-blocking:
      // a sync failure must NEVER fail the webhook (the sync records its own retry row).
      const sc = (cancelResult as any)?.store_credit;
      if (sc?.lot_id) {
        try {
          await syncToShopify({
            customer_id: sc.customer_id,
            direction: "credit",
            amount: Number(sc.amount),
            currency: sc.currency,
            lot_id: sc.lot_id,
            expires_at: sc.expires_at,
            reason: "cancelled_cash",
          });
        } catch (e) {
          console.warn(`${LOG} orders/cancelled shopify sync failed (non-blocking):`, e);
        }
      }

      // Record the processed event (idempotency ledger) — same shape/columns the
      // other branches use, so Shopify retries short-circuit at the idempotency check.
      const { error: evtErr } = await supabase.from("shopify_webhook_events").insert({
        shopify_order_id: shopifyOrderId,
        topic,
        webhook_id: webhookId,
        status: "processed",
      });
      if (evtErr && evtErr.code !== UNIQUE_VIOLATION) {
        console.warn(`${LOG} event record failed for ${shopifyOrderId}: ${evtErr.message}`);
      }

      return json({ ok: true, topic, cash_order_id: cashOrder.id, result: cancelResult }, 200);
    }

    // ── orders/updated ──
    // The order was edited in Shopify (items added/removed/changed, totals changed).
    // Re-sync the Hub order to match. Shopify is the source of truth for what was ORDERED;
    // the Hub remains the source of truth for what was PAID.
    if (topic === "orders/updated") {
      const { data: cashOrder } = await supabase
        .from("cash_orders")
        .select("id, status, invoice_number, total_amount, total_paid, customer_id, currency")
        .eq("shopify_order_id", shopifyOrderId)
        .maybeSingle();

      // Never synced (e.g. pre-integration order) — acknowledge and ignore.
      if (!cashOrder) {
        console.log(`${LOG} orders/updated no hub cash_order for ${shopifyOrderId}, ignoring`);
        return json({ ignored: "no_hub_order", shopify_order_id: shopifyOrderId }, 200);
      }

      // A cancelled order must not be resurrected by an update.
      if (cashOrder.status === "cancelled") {
        console.log(`${LOG} orders/updated order ${shopifyOrderId} is cancelled in the Hub — ignoring`);
        return json({ ignored: "order_cancelled" }, 200);
      }

      // total_price is CUMULATIVE — the sum of everything ever added to the order; it NEVER
      // decreases when a line is edited out. current_total_price is what the customer owes now.
      // Fall back to total_price only when the current value is absent.
      const newTotal = Number(order?.current_total_price ?? order?.total_price) || 0;
      const oldTotal = Number(cashOrder.total_amount) || 0;
      const paid = Number(cashOrder.total_paid) || 0;

      // ── Zero-total guard ──
      // The cash_orders total_amount CHECK constraint forbids zero/negative totals,
      // and an order edited down to ¥0 is an anomaly a human should resolve — usually
      // by cancelling in Shopify, which the orders/cancelled flow handles with full
      // store-credit math. Keep the Hub's last valid state: no totals write, no item
      // rewrite, no minting on a zeroed pass.
      if (newTotal <= 0) {
        console.warn(
          `${LOG} orders/updated order=${shopifyOrderId} invoice=${cashOrder.invoice_number} ` +
          `paid=${paid} was reduced to zero in Shopify — skipping re-sync`,
        );
        try {
          await supabase.from("staff_notifications").insert({
            type: "shopify_order_zeroed",
            title: "Shopify order reduced to zero",
            body: `Order #${cashOrder.invoice_number} was edited in Shopify and its total is now ¥0; the Hub keeps the last valid state. ¥${Number(paid).toLocaleString("en-US")} has been paid. Review whether this order should be cancelled instead.`,
            invoice_number: cashOrder.invoice_number,
            metadata: { shopify_order_id: shopifyOrderId, paid },
          });
        } catch (e) {
          console.warn(`${LOG} zeroed-order notification failed:`, e);
        }
        return json({ ok: true, topic, skipped: "zero_total" }, 200);
      }

      // ── Line items: replace the Hub's set with Shopify's current set ──
      // Shopify is authoritative for what was ordered. Delete and re-insert is simplest and
      // correct: cash_order_items carries no payment or allocation state.
      if (Array.isArray(order.line_items)) {
        const liveLines = order.line_items.filter((l: any) => {
          // current_quantity is 0 for a line that was edited out of the order. It REMAINS in the
          // line_items array — Shopify never deletes it — so we must filter it out ourselves.
          const cq = l?.current_quantity;
          return cq === undefined || cq === null ? true : Number(cq) > 0;
        });

        const { error: delErr } = await supabase
          .from("cash_order_items")
          .delete()
          .eq("cash_order_id", cashOrder.id);
        if (delErr) {
          return await recordError(`orders/updated: could not clear line items: ${delErr.message}`);
        }

        if (liveLines.length > 0) {
          // Product images from the products cache — cosmetic; NEVER fail or skip
          // item insertion because the image lookup failed.
          let imageMap = new Map<string, string | null>();
          try {
            const productIds = [...new Set(liveLines.map((l: any) => l?.product_id).filter(Boolean).map(String))];
            if (productIds.length > 0) {
              const { data: prodRows } = await supabase
                .from("products")
                .select("shopify_product_id, image_url")
                .in("shopify_product_id", productIds.map((id) => `gid://shopify/Product/${id}`));
              // products.shopify_product_id stores GIDs ("gid://shopify/Product/12345")
              // while payload line.product_id is numeric — key the map on the numeric
              // tail so the row-mapper's String(line.product_id) lookup matches.
              imageMap = new Map((prodRows ?? []).map((p: any) => [String(p.shopify_product_id).split("/").pop() ?? "", p.image_url ?? null]));
            }
          } catch (e) {
            console.warn(`${LOG} product image lookup failed (non-blocking):`, e);
          }
          const rows = liveLines.map((line: any) => {
            const unit = Number(line.price) || 0;
            const qty = Number(line.current_quantity ?? line.quantity) || 1;
            const title = line.variant_title ? `${line.title} (${line.variant_title})` : line.title;
            return {
              cash_order_id: cashOrder.id,
              shopify_line_item_id: String(line.id),
              title,
              sku: line.sku ?? null,
              quantity: qty,
              unit_price_jpy: unit,
              line_total_jpy: unit * qty,
              product_id: null,
              image_url: imageMap.get(String(line.product_id)) ?? null,
            };
          });
          const { error: itemsErr } = await supabase.from("cash_order_items").insert(rows);
          if (itemsErr) {
            return await recordError(`orders/updated: line item insert failed: ${itemsErr.message}`);
          }
        }
      }

      // ── Totals ──
      // total_amount follows Shopify. total_paid is the HUB'S and must NEVER be changed here —
      // it is derived from the payment rows and is the Hub's own source of truth.
      const newRemaining = Math.max(0, newTotal - paid);
      const { error: updErr } = await supabase
        .from("cash_orders")
        .update({
          total_amount: newTotal,
          remaining_balance: newRemaining,
          loyalty_jpy_amount: newTotal,
          status: newRemaining <= 0 && paid > 0 ? "completed" : cashOrder.status,
          updated_at: new Date().toISOString(),
        })
        .eq("id", cashOrder.id)
        // The early cancelled-guard above is a fast path but RACY — Shopify fires
        // orders/cancelled and orders/updated concurrently on a cancel, and the cancel
        // may commit between our fetch and this write (proven on SH-1017, where this
        // update resurrected a cancelled order back to "completed"). This filter makes
        // resurrection impossible at the DB level. A zero-row match is NOT an error.
        .neq("status", "cancelled");
      if (updErr) {
        return await recordError(`orders/updated: cash_order update failed: ${updErr.message}`);
      }

      // ── Overpayment warning ──
      // The order was reduced BELOW what has already been paid. The customer has paid more than
      // the order is now worth. This needs a human — the Hub does NOT auto-refund or auto-issue
      // store credit here, because the correct remedy depends on why the order changed.
      if (paid > newTotal) {
        console.warn(
          `${LOG} OVERPAID order=${shopifyOrderId} invoice=${cashOrder.invoice_number} ` +
          `paid=${paid} new_total=${newTotal} overpaid_by=${paid - newTotal} — needs review`,
        );
        try {
          await supabase.from("staff_notifications").insert({
            type: "shopify_order_overpaid",
            title: "Shopify order reduced below amount paid",
            body: `Order #${cashOrder.invoice_number} was edited in Shopify and its total is now ¥${Number(newTotal).toLocaleString("en-US")}, but ¥${Number(paid).toLocaleString("en-US")} has already been paid. Overpaid by ¥${Number(paid - newTotal).toLocaleString("en-US")}. This needs review.`,
            invoice_number: cashOrder.invoice_number,
            metadata: { shopify_order_id: shopifyOrderId, paid, new_total: newTotal, old_total: oldTotal },
          });
        } catch (e) {
          console.warn(`${LOG} overpaid notification failed:`, e);
        }
      }

      // ── Refunds → store credit ──
      // Business policy: ALL reversals become Hub store credit; there are no cash
      // refunds. A Shopify partial refund (line edited out of a PAID order) mints a
      // Hub lot for the refunded value, capped at what the customer actually overpaid.
      // Idempotent two ways: issue_store_credit_atomic's double-issue guard is keyed
      // on source_refund_id, and the headroom math subtracts credit already issued —
      // so orders/updated re-fires mint nothing extra.
      const refunds = Array.isArray(order?.refunds) ? order.refunds : [];
      if (refunds.length > 0) {
        // Paid-side headroom: what was paid beyond the CURRENT total, minus credit
        // already minted for this order's refunds. Unpaid orders have zero headroom
        // (removing an unpaid line owes the customer nothing).
        // cancelled_cash counts too: in the cancel race, cancel_cash_order_atomic may
        // have already minted the full remaining credit — this refund pass must never
        // mint on top of it. Invariant: total credit per order <= money received.
        const { data: priorLots } = await supabase
          .from("store_credit_lots")
          .select("original_amount")
          .eq("source_cash_order_id", cashOrder.id)
          .in("source_type", ["shopify_partial_refund", "cancelled_cash"])
          .neq("status", "voided");
        const alreadyIssued = (priorLots ?? []).reduce(
          (s: number, l: any) => s + (Number(l?.original_amount) || 0), 0,
        );
        let headroom = Math.max(0, paid - newTotal - alreadyIssued);

        for (const r of refunds) {
          if (r?.id == null) continue;
          const refundId = String(r.id);

          // REAL-MONEY GATE: a refund transaction with a positive successful amount
          // means real cash left via Shopify — a policy violation (store credit only).
          // Do NOT mint on top of it; a human must review.
          const cashOut = (Array.isArray(r.transactions) ? r.transactions : []).some(
            (t: any) => Number(t?.amount) > 0 && t?.status === "success",
          );
          if (cashOut) {
            const cashAmount = (Array.isArray(r.transactions) ? r.transactions : []).reduce(
              (s: number, t: any) =>
                s + (Number(t?.amount) > 0 && t?.status === "success" ? Number(t.amount) : 0), 0,
            );
            console.warn(
              `${LOG} orders/updated CASH REFUND detected order=${shopifyOrderId} ` +
              `invoice=${cashOrder.invoice_number} refund=${refundId} amount=${cashAmount} — not minting`,
            );
            try {
              await supabase.from("staff_notifications").insert({
                type: "shopify_cash_refund_detected",
                title: "Real cash refund detected in Shopify",
                body: `Order #${cashOrder.invoice_number}: refund ${refundId} moved ¥${Number(cashAmount).toLocaleString("en-US")} of real money out via Shopify. Policy requires store credit only — review immediately.`,
                invoice_number: cashOrder.invoice_number,
                metadata: { shopify_order_id: shopifyOrderId, refund_id: refundId, amount: cashAmount },
              });
            } catch (e) {
              console.warn(`${LOG} cash-refund notification failed:`, e);
            }
            continue;
          }

          const refundAmount = (Array.isArray(r.refund_line_items) ? r.refund_line_items : [])
            .reduce((s: number, rl: any) => s + (Number(rl?.subtotal) || 0), 0);
          const mintAmount = Math.min(refundAmount, headroom);
          // Unpaid orders and already-credited refunds fall out here naturally.
          if (mintAmount <= 0) continue;

          const { data: issueResult, error: issueErr } = await supabase.rpc(
            "issue_store_credit_atomic",
            {
              p_customer_id: cashOrder.customer_id,
              p_currency: cashOrder.currency,
              p_amount: mintAmount,
              p_source_type: "shopify_partial_refund",
              p_source_account_id: null,
              p_source_cash_order_id: cashOrder.id,
              p_user_id: null,
              p_user_email: null,
              p_notes: `Auto-issued for Shopify partial refund ${refundId} on ${cashOrder.invoice_number}`,
              p_source: "shopify_webhook",
              p_source_refund_id: refundId,
            },
          );

          if (issueErr) {
            // The RPC's double-issue guard is keyed on source_refund_id — a repeat
            // orders/updated delivery for an already-credited refund is NOT an error.
            if (String(issueErr.message ?? "").includes("store_credit_already_issued_for_refund")) {
              console.log(`${LOG} refund ${refundId} already credited — skipping (idempotent re-fire)`);
            } else {
              // Do not fail the webhook: the totals re-sync above already succeeded,
              // and orders/updated will re-fire so the mint can be retried.
              console.error(`${LOG} issue_store_credit_atomic failed for refund ${refundId}:`, issueErr);
            }
            continue;
          }

          headroom -= mintAmount;
          const lotId = (issueResult as any)?.lot_id ?? null;
          console.log(
            `${LOG} orders/updated minted store credit order=${shopifyOrderId} ` +
            `invoice=${cashOrder.invoice_number} refund=${refundId} amount=${mintAmount} lot=${lotId}`,
          );

          // Mirror the minted credit into Shopify + notify staff. Non-blocking —
          // a failure here never fails the webhook (the sync records its own retry row).
          try {
            await syncToShopify({
              customer_id: cashOrder.customer_id,
              direction: "credit",
              amount: mintAmount,
              currency: cashOrder.currency,
              lot_id: lotId,
              reason: `Store credit issued for Shopify partial refund ${refundId} on ${cashOrder.invoice_number}`,
            });

            // Loyalty points were awarded on the OLD order total — proportionally
            // adjust them for the refunded spend. Non-blocking: the RPC no-ops when
            // nothing was awarded (no_member / no_active_lot); on error, fall back to
            // the manual-review line rather than failing the webhook.
            let loyaltyLine = "";
            let pointsDelta: number | null = null;
            try {
              const { data: revokeResult, error: revokeErr } = await supabase.rpc(
                "revoke_loyalty_points_partial",
                {
                  p_customer_id: cashOrder.customer_id,
                  p_source_reference: cashOrder.invoice_number,
                  p_refund_spend_jpy: mintAmount,
                  p_cash_order_id: cashOrder.id,
                  p_refund_id: refundId,
                  p_notes: null,
                  p_created_by_user_id: null,
                },
              );
              if (revokeErr) throw revokeErr;
              const rr = revokeResult as any;
              if (rr?.noop) {
                // Nothing was awarded, nothing to adjust — no loyalty line.
                console.log(`${LOG} loyalty partial revoke noop=${rr.noop} refund=${refundId} invoice=${cashOrder.invoice_number}`);
              } else if (Number(rr?.points_delta) > 0) {
                pointsDelta = Number(rr.points_delta);
                console.log(
                  `${LOG} loyalty partial revoke refund=${refundId} invoice=${cashOrder.invoice_number} ` +
                  `points_delta=-${pointsDelta} new_basis=${rr?.new_basis} tier_changed=${rr?.tier_changed === true}`,
                );
                loyaltyLine =
                  ` Loyalty points auto-adjusted: -${pointsDelta} points (spend basis ¥${Number(rr?.old_basis ?? 0).toLocaleString("en-US")} -> ¥${Number(rr?.new_basis ?? 0).toLocaleString("en-US")}).` +
                  (rr?.tier_changed === true ? " Tier changed — review member." : "");
              } else {
                console.log(`${LOG} loyalty partial revoke refund=${refundId} invoice=${cashOrder.invoice_number} points_delta=0`);
              }
            } catch (revokeE) {
              console.error(`${LOG} revoke_loyalty_points_partial failed for refund ${refundId}:`, revokeE);
              loyaltyLine = " Loyalty points were awarded on the old order total — auto-adjust FAILED; review and adjust via Loyalty admin.";
            }

            await supabase.from("staff_notifications").insert({
              type: "shopify_partial_refund_credit",
              title: "Store credit issued for Shopify partial refund",
              body:
                `Order #${cashOrder.invoice_number}: ¥${Number(mintAmount).toLocaleString("en-US")} store credit auto-issued for Shopify refund ${refundId}.` +
                loyaltyLine,
              invoice_number: cashOrder.invoice_number,
              metadata: {
                shopify_order_id: shopifyOrderId,
                refund_id: refundId,
                amount: mintAmount,
                lot_id: lotId,
                ...(pointsDelta != null ? { points_delta: pointsDelta } : {}),
              },
            });
          } catch (e) {
            console.warn(`${LOG} refund-credit post-mint steps failed (non-blocking):`, e);
          }
        }
      }

      console.log(
        `${LOG} orders/updated done order=${shopifyOrderId} invoice=${cashOrder.invoice_number} ` +
        `total ${oldTotal} -> ${newTotal} paid=${paid} remaining=${newRemaining}`,
      );

      // NOTE: deliberately do NOT record a shopify_webhook_events row here. orders/updated can fire
      // MANY times for one order, and the existing idempotency check is keyed on
      // (shopify_order_id, topic) — recording it would cause every subsequent update to be skipped
      // as "already processed".

      return json({ ok: true, topic, cash_order_id: cashOrder.id, total: newTotal }, 200);
    }

    // ════════════════════════════════════════════════════════════
    // orders/paid
    // ════════════════════════════════════════════════════════════
    // orders/create + orders/paid normally arrive together; if paid lands
    // before create finishes (order not yet in the DB), we return a 500 so
    // Shopify RETRIES the orders/paid webhook. By the retry, orders/create has
    // completed and the order is found. We do NOT create the order here and do
    // NOT record a shopify_webhook_events row for the not-found case — the
    // event is only recorded once paid actually succeeds, so idempotency lets
    // the retry through.
    const { data: cashOrder } = await supabase
      .from("cash_orders")
      .select("id, customer_id, total_amount, total_paid, status")
      .eq("shopify_order_id", shopifyOrderId)
      .maybeSingle();

    if (!cashOrder) {
      console.log(`${LOG} orders/paid: order ${shopifyOrderId} not found — returning 500 for Shopify retry`);
      return json({ error: "order_not_found_yet" }, 500);
    }

    if ((cashOrder as any).status === "cancelled") {
      // Real money arrived for an order the Hub has already cancelled (inverted
      // webhook delivery or Shopify mark-as-paid after cancel). Money decisions
      // in race windows are manual by policy: book NOTHING, change NOTHING,
      // alert staff loudly. (Proven on SH-1018.)
      const paidAmount = Number(order?.total_price) || 0;
      console.warn(
        `${LOG} orders/paid: order ${shopifyOrderId} is CANCELLED in the Hub — ` +
        `payment of ${paidAmount} NOT booked; staff notified`,
      );
      try {
        await supabase.from("staff_notifications").insert({
          type: "shopify_paid_after_cancel",
          title: "Payment received for CANCELLED order",
          body: `Shopify order ${shopifyOrderId} was marked paid (¥${paidAmount.toLocaleString("en-US")}) but the Hub order is already cancelled. Verify in Shopify. If money was truly received, book the payment and issue store credit manually via the Hub UI.`,
          metadata: { shopify_order_id: shopifyOrderId, amount: paidAmount },
        });
      } catch (e) {
        console.warn(`${LOG} paid-after-cancel notification failed:`, e);
      }
      // Record the processed event (idempotency ledger) — this event is handled;
      // the follow-up is a manual staff decision, not a webhook retry.
      const { error: evtErr } = await supabase.from("shopify_webhook_events").insert({
        shopify_order_id: shopifyOrderId,
        topic,
        webhook_id: webhookId,
        status: "processed",
      });
      if (evtErr && evtErr.code !== UNIQUE_VIOLATION) {
        console.warn(`${LOG} event record failed for ${shopifyOrderId}: ${evtErr.message}`);
      }
      return json({ ok: true, skipped: "order_cancelled" }, 200);
    }

    const totalAmount = Number(cashOrder.total_amount) || 0;
    const alreadyPaid = Number(cashOrder.total_paid) || 0;

    if (alreadyPaid < totalAmount) {
      // Store credit is consumed at CHECKOUT — record + draw it down via the shared helper
      // (idempotent), whether or not orders/create already handled it.
      await applyShopifyStoreCredit(supabase, shopifyOrderId, order, {
        id: cashOrder.id,
        customer_id: (cashOrder as any).customer_id ?? null,
      });

      // Real-money transactions (anything that is NOT store credit).
      const gateways: string[] = Array.isArray(order?.payment_gateway_names)
        ? order.payment_gateway_names.map((g: unknown) => String(g))
        : [];
      const usedStoreCredit = gateways.includes("shopify_store_credit");

      if (!usedStoreCredit) {
        // UNCHANGED behaviour: no store credit — book the full total as cash.
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
      } else {
        // Store credit already handled by the helper above. Here we insert only the
        // NON-store-credit (real-money) transactions, one row per gateway.
        let txns: any[] = [];
        try {
          const token = await mintAccessToken();
          const txUrl = `https://${Deno.env.get("SHOPIFY_STORE_DOMAIN")}/admin/api/${SHOPIFY_API_VERSION}/orders/${shopifyOrderId}/transactions.json`;
          const txRes = await fetch(txUrl, {
            headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
          });
          const txJson = await txRes.json().catch(() => null);
          txns = Array.isArray(txJson?.transactions) ? txJson.transactions : [];
          if (!txRes.ok) {
            console.error(`${LOG} orders/paid transactions fetch failed order=${shopifyOrderId} status=${txRes.status}: ${JSON.stringify(txJson)}`);
          }
        } catch (e) {
          console.error(`${LOG} orders/paid transactions fetch threw order=${shopifyOrderId}: ${(e as Error).message}`);
        }

        // Never book the full total as cash on a store-credit order — that is the
        // phantom-revenue bug. If we could not read the split, retry rather than guess.
        if (txns.length === 0) {
          console.error(`${LOG} orders/paid: no transactions for store-credit order ${shopifyOrderId} — returning 500 for Shopify retry (refusing to book phantom cash)`);
          return json({ error: "transactions_unavailable" }, 500);
        }

        const otherPayments = txns
          .filter((t) => t?.kind === "sale" && t?.status === "success" && t?.gateway !== "shopify_store_credit")
          .map((t) => ({ gateway: String(t?.gateway ?? "unknown"), amount: Number(t?.amount ?? 0) || 0, id: String(t?.id ?? "") }))
          .filter((p) => p.amount > 0);

        for (const p of otherPayments) {
          const { error: rmErr } = await supabase.from("cash_payments").insert({
            cash_order_id: cashOrder.id,
            amount_paid: p.amount,
            currency: "JPY",
            payment_method: p.gateway,
            date_paid: phtToday(),
            reference_number: `SHOPIFY-${shopifyOrderId}-${p.id}`,
            remarks: `Paid via ${p.gateway}`,
          });
          // A duplicate reference (23505) means a retry already recorded it — success.
          if (rmErr && (rmErr as any).code !== UNIQUE_VIOLATION) {
            return await recordError(`cash_payment insert failed (${p.gateway}): ${rmErr.message}`);
          }
        }
      }

      // Recompute the order's totals from its payment rows — never assume. A partially-paid
      // order (store credit at checkout, bank transfer not yet received) correctly stays
      // "pending" with the right remaining_balance.
      await recomputeCashOrderTotals(supabase, cashOrder.id, totalAmount);

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
