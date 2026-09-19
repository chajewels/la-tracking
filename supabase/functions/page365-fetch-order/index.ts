/**
 * page365-fetch-order — a Page365 invoice link in, a parsed draft out.
 *
 * A CSR pastes the public Page365 invoice URL. This function fetches it ONCE,
 * parses it, copies the item photos into Hub storage, and parks the result in
 * public.page365_drafts for the confirmation screen. It NEVER creates an order,
 * a customer, or anything else — creation stays with create-cash-order and
 * create-layaway-account, so plan minimums, permissions, loyalty and the
 * is_test rules all still apply exactly as they do for a hand-typed order.
 *
 * THE ?sig= IS A CAPABILITY, NOT AN IDENTIFIER. It is the bearer credential
 * that makes a Page365 invoice readable by anyone holding the link. It is used
 * for the single outbound request and then dropped: it is not stored on the
 * draft, not stored on the order, not logged, and not returned to the caller.
 * Only the slug and the invoice number survive.
 *
 * REFUSE THE WHOLE THING OR NOTHING. Any parse gap — an item without a price, a
 * missing customer, totals that do not reconcile — refuses the import and names
 * the field. A half-parsed draft is worse than no draft, because the CSR cannot
 * see what is missing until the order is already wrong.
 *
 * EVERYTHING IS YEN. Page365 invoices are JPY (owner decision 2026-09-19). The
 * draft is therefore entirely in yen, and the account currency is the CSR's
 * choice on the confirmation screen. The server's php_jpy_rate travels with the
 * draft so that conversion is reproducible later — src/lib/currency-converter.ts
 * reads localStorage with a hardcoded 0.42 fallback, which is per-browser and
 * not auditable, and must not be what decides a customer's peso total.
 */
import { corsHeaders, corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/handler.ts";
import { fetchWithRetryOnRateLimit } from "../_shared/fetch-retry.ts";

/** The only hosts a link may point at. A URL anywhere else is refused. */
const ALLOWED_HOSTS = ["chajewelsjapan.com", "www.chajewelsjapan.com"];

/** Photos land beside the website catalogue's own images — same public bucket,
 *  own folder. website_product_media already stores absolute URLs from
 *  `promotions/website/<uuid>.<ext>`; this is that convention, one folder over. */
const PHOTO_BUCKET = "promotions";
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** Yen is integral. Totals must reconcile to the yen, not "about". */
const RECONCILE_TOLERANCE_JPY = 1;

interface DraftItem {
  kind: "product" | "service";
  name: string;
  sku: string | null;
  quantity: number;
  unit_price_jpy: number;
  line_total_jpy: number;
  note: string | null;
  photo_url: string | null;
  source_photo_url: string | null;
}

/** A RESIZE FEE is a SERVICE, never a product line. Services belong in
 *  account_services (already inside total_amount) and must never reach
 *  loyalty_jpy_amount, which is the product amount alone — booking one as a
 *  product inflates the customer's tier progress with a fee they paid for
 *  labour. Matched loosely because Page365 descriptions are hand-typed. */
function isServiceLine(name: string): boolean {
  return /resize|re-size|sizing\s*fee|service\s*fee/i.test(name);
}

/** Page365 item names lead with the product code: "EM378 Diamond Earrings".
 *  That leading token is the natural SKU and is how staff recognise the piece;
 *  there is no sku field in the JSON. Returns null rather than guessing when
 *  the name does not start with something code-shaped. */
function naturalSku(name: string): string | null {
  const m = name.trim().match(/^([A-Z]{1,4}-?\d{1,6}[A-Z]?)\b/);
  return m ? m[1] : null;
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/[, ]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function extFromUrl(url: string, contentType: string | null): string {
  const fromType = contentType?.split(";")[0].trim().toLowerCase();
  if (fromType === "image/jpeg") return "jpg";
  if (fromType === "image/png") return "png";
  if (fromType === "image/webp") return "webp";
  if (fromType === "image/gif") return "gif";
  const m = new URL(url, "https://example.invalid").pathname.match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : "jpg";
}

/**
 * Validate the pasted link and split it into { origin+path, slug }.
 * The sig is required — without it Page365 will not serve the invoice — but it
 * is deliberately NOT part of the return value beyond the URL we immediately
 * fetch and discard.
 */
function parseInvoiceUrl(raw: string): { fetchUrl: string; slug: string } | { error: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { error: "That is not a URL. Paste the full Page365 invoice link." };
  }
  if (u.protocol !== "https:") {
    return { error: "The Page365 link must be https." };
  }
  if (!ALLOWED_HOSTS.includes(u.hostname.toLowerCase())) {
    return { error: `Unexpected host "${u.hostname}". A Page365 invoice link points at chajewelsjapan.com.` };
  }
  const m = u.pathname.match(/^\/invoices\/([A-Za-z0-9._~-]+)\/?$/);
  if (!m) {
    return { error: "That link is not a Page365 invoice link (expected /invoices/<slug>)." };
  }
  if (!u.searchParams.get("sig")) {
    return { error: "The link is missing its ?sig= token — copy the full invoice link, not just the address." };
  }
  return { fetchUrl: u.toString(), slug: m[1] };
}

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  // Auth: a real user JWT, then one of the four internal roles. Importing an
  // order is an internal act; there is no service-role path and none is wanted.
  const ctx = await requireAuth(req);
  if (ctx instanceof Response) return ctx;
  const supabase = ctx.supabase;
  const userId = ctx.user?.id;
  if (!userId) return jsonResponse({ error: "Unauthorized" }, 401);

  const { data: roleRows } = await supabase
    .from("user_roles").select("role").eq("user_id", userId)
    .in("role", ["admin", "staff", "finance", "csr"]).limit(1);
  if (!roleRows || roleRows.length === 0) return jsonResponse({ error: "Forbidden" }, 403);

  try {
    const body = await req.json().catch(() => ({}));
    const rawUrl = typeof body?.url === "string" ? body.url : "";
    if (!rawUrl.trim()) return jsonResponse({ error: "url is required" }, 400);

    const parsed = parseInvoiceUrl(rawUrl);
    if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);
    const { fetchUrl, slug } = parsed;

    // ── Fetch the invoice, once ──────────────────────────────────────────────
    let res: Response;
    try {
      res = await fetchWithRetryOnRateLimit(fetchUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
    } catch (e) {
      return jsonResponse({ error: `Could not reach Page365: ${(e as Error).message}` }, 502);
    }
    if (!res.ok) {
      // 403/404 here almost always means an expired or truncated sig.
      return jsonResponse({
        error: `Page365 refused the link (HTTP ${res.status}). The ?sig= token may have expired — re-copy the link.`,
      }, 502);
    }

    let raw: Record<string, unknown>;
    try {
      raw = await res.json();
    } catch {
      return jsonResponse({ error: "Page365 did not return JSON for that link." }, 502);
    }

    // ── Parse. Every gap refuses the whole import, naming the field. ─────────
    const page365No = toNumber(raw["no"]);
    if (page365No === null) return jsonResponse({ error: "Page365 invoice is missing its invoice number (`no`)." }, 422);

    const cust = (raw["customer"] ?? {}) as Record<string, unknown>;
    const customerName = String(cust["name"] ?? "").trim();
    if (!customerName) return jsonResponse({ error: "Page365 invoice is missing the customer name." }, 422);

    const rawItems = Array.isArray(raw["items"]) ? (raw["items"] as Record<string, unknown>[]) : [];
    if (rawItems.length === 0) return jsonResponse({ error: "Page365 invoice has no item lines." }, 422);

    // ── Already imported? Check BEFORE doing any work or writing a draft. ────
    // invoice_numbers is the cross-table registry; page365_no is checked
    // against the order tables directly because the same Page365 invoice must
    // never become two Hub orders even if it was renumbered on the way in.
    const [{ data: byNumber }, { data: cashHit }, { data: layawayHit }] = await Promise.all([
      supabase.from("invoice_numbers").select("invoice_number, source, order_id")
        .eq("invoice_number", String(page365No)).maybeSingle(),
      supabase.from("cash_orders").select("id").eq("page365_no", page365No).maybeSingle(),
      supabase.from("layaway_accounts").select("id").eq("page365_no", page365No).maybeSingle(),
    ]);
    const already =
      cashHit ? { source: "cash_order", id: cashHit.id } :
      layawayHit ? { source: "layaway_account", id: layawayHit.id } :
      byNumber ? { source: byNumber.source, id: byNumber.order_id } : null;
    if (already) {
      return jsonResponse({
        already_imported: already,
        error: `Page365 invoice ${page365No} is already in the Hub as a ${already.source.replace("_", " ")}.`,
      }, 409);
    }

    const items: DraftItem[] = [];
    for (let i = 0; i < rawItems.length; i++) {
      const it = rawItems[i];
      const name = String(it["name"] ?? "").trim();
      if (!name) return jsonResponse({ error: `Item ${i + 1} has no name.` }, 422);

      const unit = toNumber(it["price"]);
      if (unit === null) return jsonResponse({ error: `Item "${name}" has no price.` }, 422);

      const qty = toNumber(it["quantity"]) ?? 1;
      if (!Number.isInteger(qty) || qty <= 0) {
        return jsonResponse({ error: `Item "${name}" has an unusable quantity (${it["quantity"]}).` }, 422);
      }

      // Trust the line subtotal when Page365 gives one; it is what the customer
      // was shown. Fall back to unit x qty only when it is absent.
      const sub = toNumber(it["subtotal"]);
      const lineTotal = sub ?? unit * qty;

      const product = (it["product"] ?? {}) as Record<string, unknown>;
      const photo = typeof product["photo"] === "string" && product["photo"].trim()
        ? String(product["photo"]).trim()
        : null;

      items.push({
        kind: isServiceLine(name) ? "service" : "product",
        name,
        sku: naturalSku(name),
        quantity: qty,
        unit_price_jpy: Math.round(unit),
        line_total_jpy: Math.round(lineTotal),
        note: typeof it["note"] === "string" && it["note"].trim() ? String(it["note"]).trim() : null,
        photo_url: null,
        source_photo_url: photo,
      });
    }

    const shippingJpy = Math.round(toNumber(raw["price_shipping"]) ?? 0);
    const subtotalJpy = Math.round(toNumber(raw["price_subtotal"]) ?? items.reduce((s, i) => s + i.line_total_jpy, 0));
    const totalJpy = toNumber(raw["price_total"]);
    if (totalJpy === null) return jsonResponse({ error: "Page365 invoice is missing its total (`price_total`)." }, 422);

    // Reconcile. If the parts do not add up, something was read wrong and the
    // CSR must not be shown a plausible-looking draft built on it.
    const lineSum = items.reduce((s, i) => s + i.line_total_jpy, 0);
    if (Math.abs(lineSum - subtotalJpy) > RECONCILE_TOLERANCE_JPY) {
      return jsonResponse({
        error: `Item lines total ¥${lineSum.toLocaleString()} but the invoice subtotal is ¥${subtotalJpy.toLocaleString()}. Refusing to import a draft that does not reconcile.`,
      }, 422);
    }
    const expectedTotal = subtotalJpy + shippingJpy;
    if (Math.abs(expectedTotal - Math.round(totalJpy)) > RECONCILE_TOLERANCE_JPY) {
      return jsonResponse({
        error: `Subtotal ¥${subtotalJpy.toLocaleString()} + shipping ¥${shippingJpy.toLocaleString()} = ¥${expectedTotal.toLocaleString()}, but the invoice total is ¥${Math.round(totalJpy).toLocaleString()}. Refusing to import a draft that does not reconcile.`,
      }, 422);
    }

    // ── Copy the photos into Hub storage ────────────────────────────────────
    // An order outlives the external system it came from. A hotlink to Page365
    // is a photo that disappears the day they rotate a URL, on an order the Hub
    // keeps forever. A photo that cannot be copied is left null — a missing
    // picture is cosmetic, and is not worth refusing an otherwise sound import.
    const photoFailures: string[] = [];
    for (let n = 0; n < items.length; n++) {
      const src = items[n].source_photo_url;
      if (!src) continue;
      try {
        const imgRes = await fetchWithRetryOnRateLimit(src, { method: "GET" });
        if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`);
        const buf = new Uint8Array(await imgRes.arrayBuffer());
        if (buf.byteLength === 0) throw new Error("empty response");
        if (buf.byteLength > MAX_PHOTO_BYTES) throw new Error(`${buf.byteLength} bytes exceeds the limit`);
        const contentType = imgRes.headers.get("content-type");
        const path = `page365/${page365No}/${n + 1}.${extFromUrl(src, contentType)}`;
        const { error: upErr } = await supabase.storage.from(PHOTO_BUCKET).upload(path, buf, {
          contentType: contentType?.split(";")[0] ?? "image/jpeg",
          upsert: true,
        });
        if (upErr) throw upErr;
        const { data: pub } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path);
        items[n].photo_url = pub.publicUrl;
      } catch (e) {
        photoFailures.push(`${items[n].name}: ${(e as Error).message}`);
      }
    }

    // ── The rate travels with the draft ─────────────────────────────────────
    // So the peso figures the CSR confirms can be reproduced later from the
    // draft alone, rather than from whatever was in that browser's localStorage.
    const { data: rateRow } = await supabase
      .from("system_settings").select("value").eq("key", "php_jpy_rate").maybeSingle();
    const phpJpyRate = rateRow ? Number(JSON.parse(String(rateRow.value))) : null;

    const draft = {
      page365_no: page365No,
      page365_slug: slug,
      currency: "JPY",
      customer: {
        name: customerName,
        phone: String(cust["phone"] ?? "").trim() || null,
        address: String(cust["address"] ?? "").trim() || null,
        structural_address: cust["structural_address"] ?? null,
      },
      items,
      shipping_jpy: shippingJpy,
      subtotal_jpy: subtotalJpy,
      total_jpy: Math.round(totalJpy),
      fx: { php_jpy_rate: phpJpyRate, source: "system_settings.php_jpy_rate", read_at: new Date().toISOString() },
      page365_stage: typeof raw["stage"] === "string" ? raw["stage"] : null,
      shipping_option: raw["shipping_option"] ?? null,
      fetched_at: new Date().toISOString(),
      photo_failures: photoFailures,
    };

    const { data: draftRow, error: draftErr } = await supabase
      .from("page365_drafts")
      .insert({
        created_by: userId,
        page365_no: page365No,
        page365_slug: slug,
        payload: draft,
      })
      .select("id, expires_at")
      .single();

    if (draftErr || !draftRow) {
      return jsonResponse({ error: draftErr?.message || "Could not save the draft" }, 500);
    }

    return new Response(
      JSON.stringify({ draft_id: draftRow.id, expires_at: draftRow.expires_at, draft }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: unknown) {
    console.error("page365-fetch-order error:", error);
    return jsonResponse({ error: (error as Error).message || "Internal server error" }, 500);
  }
});
