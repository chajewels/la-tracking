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
 * PRICE_TOTAL IS AFTER THE DISCOUNT. Page365 discounts the INVOICE, not the
 * lines: `price_subtotal` and every item `subtotal` stay at full price, and
 * `price_total` = subtotal + shipping − `price_discount` − `campaign_discount`.
 * Both discount fields are read and both are subtracted, so the reconcile below
 * is the real identity rather than the discount-free one it used to be. The
 * draft carries `discount_jpy` and its breakdown, plus `promotion_code` and
 * `discount_campaign_name` — the last two are shown to the CSR and are never
 * written to the order.
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
import {
  firstWord, previewPage365Stock, readStockMode, type Page365StockMatch,
} from "../_shared/page365-stock.ts";
import {
  STOREFRONT_ORIGIN, USER_AGENT, findListing, mainGalleryPhoto, readCatalogueList,
} from "../_shared/page365-inventory.ts";

/** The only hosts a link may point at. A URL anywhere else is refused. */
const ALLOWED_HOSTS = ["chajewelsjapan.com", "www.chajewelsjapan.com"];

/** Photos land beside the website catalogue's own images — same public bucket,
 *  own folder. website_product_media already stores absolute URLs from
 *  `promotions/website/<uuid>.<ext>`; this is that convention, one folder over. */
const PHOTO_BUCKET = "promotions";
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** WEBSTORE PHOTO FALLBACK. Invoice 19768 carried no photo key on its line at
 *  all (source_photo_url null, photo_failures empty), so the copy step had
 *  nothing to copy. The same catalogue is public on the webstore, keyed by the
 *  product_id the invoice line already carries, so look there before giving up.
 *  Two steps, in order, each bounded — a slow or unreachable webstore must
 *  never hold an import open:
 *    a) the product endpoint, by product_id: the MAIN photo, i.e. the first of
 *       photos[] in Page365's display order (the PR 1 reader, orderPhotos)
 *    b) no product id: the catalogue list, read ONCE per fetch the PR 1 way
 *       (F1, 2026-09-28): the list is cumulative ("load more" — page N holds the
 *       first 16*N products and never runs out), so one request for the count
 *       and one for page ceil(count/16) is the whole catalogue. The old walk
 *       assumed disjoint pages ending in an empty one, re-downloaded ever
 *       larger pages and ran into its 20 s budget. The line's code (first
 *       word, F2) must match exactly ONE listing; then (a) on that product.
 *  NEITHER IS TRUSTED BLINDLY. Every response must parse as JSON and yield a
 *  usable URL, or the step is recorded as failed and the photo stays null. A
 *  guessed URL is never stored. */
const PHOTO_LOOKUP_TIMEOUT_MS = 6_000;
const CATALOGUE_TIMEOUT_MS = 12_000;

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
  /** What happened while looking for this line's picture, in words the CSR can
   *  act on. Null once a photo is in hand. Surfaced in the review screen's
   *  placeholder tooltip so the owner can tell us what the webstore answered
   *  rather than reporting "it is still blank". */
  photo_note: string | null;
  /** Read-only stock preview (migration 20260926120000_page365_stock_sync):
   *  what the line's first word matches in the website catalogue, the stock
   *  seen at fetch time, and (PR 2) the matched variant and its "Don't sync
   *  with Page365" switch. NOTHING is taken here. Since PR 2
   *  (page365_stock_mode inventory_sync) the import itself only records the
   *  match too; stock follows the Page365 inventory fetch. Null = not checked
   *  (the matcher was unavailable); the review screen says so. */
  stock_match: Page365StockMatch | null;
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
 *  The code is the FIRST WORD, upper-cased — the same rule as the stock match
 *  (SQL page365_first_word) and the inventory fetch (F2, 2026-09-28). The old
 *  code-shaped regex missed real codes such as R13R6, E8JS and 12M17. */
const naturalSku = (name: string): string | null => firstWord(name);

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/[, ]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Pull an image URL off a Page365 line.
 *
 * The original read exactly `product.photo` and nothing else. Invoice 19768
 * (the first real import) produced `source_photo_url: null` with an EMPTY
 * `photo_failures` -- proof that the copy step never ran, because no URL was
 * ever found to copy. The ?sig= capability is deliberately not stored, so that
 * invoice cannot be re-fetched to confirm which key it actually used.
 *
 * So this widens the search across the shapes Page365 plausibly emits rather
 * than guessing one: singular and plural keys, on the product and on the line
 * itself, each holding a string, an object with url/src/path, or an array of
 * either. It can only find MORE than before -- a line that yielded a URL
 * yields the same one. Absence is now reported (see `photo_failures`) instead
 * of arriving as a silent blank box.
 */
const PHOTO_KEYS = [
  "photo", "photos", "photo_url", "photo_urls",
  "image", "images", "image_url", "image_urls",
  "thumbnail", "thumb", "picture", "pictures", "cover",
] as const;

function asUrlString(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    // `normal` first: the webstore's product photo object is {normal, thumb, …}
    // and `normal` is the full-size one. Without it every webstore lookup would
    // find the object, fail to read a URL out of it, and report "no photo".
    for (const k of ["url", "src", "path", "href", "normal", "large", "original", "medium", "small", "thumb"]) {
      const hit = asUrlString(o[k]);
      if (hit) return hit;
    }
  }
  if (Array.isArray(v)) {
    for (const el of v) {
      const hit = asUrlString(el);
      if (hit) return hit;
    }
  }
  return null;
}

function pickPhotoUrl(...sources: Record<string, unknown>[]): string | null {
  for (const src of sources) {
    for (const key of PHOTO_KEYS) {
      const hit = asUrlString(src[key]);
      if (hit) return hit;
    }
  }
  return null;
}

/** JSON over HTTP with a hard timeout, and no exceptions escaping. Every
 *  failure comes back as prose because that prose is what the CSR is shown. */
type JsonResult = { ok: true; json: unknown } | { ok: false; why: string };

async function getJson(url: string, timeoutMs = PHOTO_LOOKUP_TIMEOUT_MS): Promise<JsonResult> {
  try {
    const res = await fetchWithRetryOnRateLimit(url, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    const text = await res.text();
    try {
      return { ok: true, json: JSON.parse(text) };
    } catch {
      // An HTML error page or a login redirect lands here. Say which, because
      // "not JSON" and "404" mean very different things about the webstore.
      const head = text.trim().slice(0, 40).replace(/\s+/g, " ");
      return { ok: false, why: `response was not JSON (starts "${head}")` };
    }
  } catch (e) {
    const name = (e as Error)?.name;
    return { ok: false, why: name === "TimeoutError" ? `no answer within ${timeoutMs / 1000}s` : String((e as Error)?.message ?? e) };
  }
}

/** Page365's own timestamps, normalised to ISO or dropped. An unparseable date
 *  is NOT passed through as a raw string: the review screen turns these into
 *  the order date and the deposit deadline, and a value it cannot parse would
 *  silently become "today" with a "from Page365" label next to it — a wrong
 *  date wearing a badge that says it is right. */
function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** The MAIN photo of a /products/<id> response (shared mainGalleryPhoto: the
 *  first of photos[] in Page365's display order), else the loose key search. An
 *  order line records what was sold, so it keeps this ONE photo; the full
 *  gallery belongs to the catalogue product (Website -> Page365 stock). */
function mainPhotoOf(json: unknown): string | null {
  const hit = mainGalleryPhoto(json);
  if (hit) return hit;
  const body = isObj(json) && isObj(json["product"]) ? json["product"] : json;
  return isObj(body) ? pickPhotoUrl(body) : null;
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
    /** product_id per line, parallel to `items`. The webstore's product
     *  endpoint is keyed on it, so it is what step (a) of the photo fallback
     *  needs. Kept out of the stored draft — it is a lookup key, not order data. */
    const productIds: (string | null)[] = [];
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
      // Product first, then the line itself -- a line-level override should not
      // beat the product's own catalogue image when both are present.
      const photo = pickPhotoUrl(product, it as Record<string, unknown>);

      const pid = product["product_id"] ?? product["id"];
      productIds.push(
        typeof pid === "string" || typeof pid === "number" ? String(pid) : null,
      );

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
        photo_note: null,
        stock_match: null,
      });
    }

    // ── Stock preview (read-only) ────────────────────────────────────────────
    // Shows the CSR which lines will reduce website stock and which will be
    // flagged, before anything is taken. Never blocks the fetch.
    const stockPreview = await previewPage365Stock(supabase, items);
    stockPreview.forEach((m, n) => { items[n].stock_match = m; });
    // inventory_sync (PR 2): the import records these lines and never moves
    // website stock; the review screen words its chips from this.
    const stockMode = await readStockMode(supabase);

    const shippingJpy = Math.round(toNumber(raw["price_shipping"]) ?? 0);
    const subtotalJpy = Math.round(toNumber(raw["price_subtotal"]) ?? items.reduce((s, i) => s + i.line_total_jpy, 0));
    const totalJpy = toNumber(raw["price_total"]);
    if (totalJpy === null) return jsonResponse({ error: "Page365 invoice is missing its total (`price_total`)." }, 422);

    // THE DISCOUNT. Page365 carries it in two independent fields and applies
    // BOTH to price_total, leaving the item lines and price_subtotal at full
    // price. Verified on invoice 19787: subtotal 29,980 + shipping 4,400 −
    // price_discount 2,998 − campaign_discount 0 = price_total 31,382, with the
    // single line still reading 29,980. Reading neither is what made every
    // discounted invoice fail the reconcile below with a 422.
    const priceDiscountJpy = Math.round(toNumber(raw["price_discount"]) ?? 0);
    const campaignDiscountJpy = Math.round(toNumber(raw["campaign_discount"]) ?? 0);
    if (priceDiscountJpy < 0) {
      return jsonResponse({ error: `Page365 invoice reports a negative \`price_discount\` (¥${priceDiscountJpy.toLocaleString()}). Refusing to import it.` }, 422);
    }
    if (campaignDiscountJpy < 0) {
      return jsonResponse({ error: `Page365 invoice reports a negative \`campaign_discount\` (¥${campaignDiscountJpy.toLocaleString()}). Refusing to import it.` }, 422);
    }
    const discountJpy = priceDiscountJpy + campaignDiscountJpy;

    // Reconcile. If the parts do not add up, something was read wrong and the
    // CSR must not be shown a plausible-looking draft built on it. Summing the
    // two discount fields is deliberate: should Page365 ever report ONE
    // discount in BOTH, the total will not reconcile and the import is refused
    // — which is the right outcome, because the alternative is silently halving
    // a customer's total.
    const lineSum = items.reduce((s, i) => s + i.line_total_jpy, 0);
    if (Math.abs(lineSum - subtotalJpy) > RECONCILE_TOLERANCE_JPY) {
      return jsonResponse({
        error: `Item lines total ¥${lineSum.toLocaleString()} but the invoice subtotal is ¥${subtotalJpy.toLocaleString()}. Refusing to import a draft that does not reconcile.`,
      }, 422);
    }
    const expectedTotal = subtotalJpy + shippingJpy - discountJpy;
    if (Math.abs(expectedTotal - Math.round(totalJpy)) > RECONCILE_TOLERANCE_JPY) {
      return jsonResponse({
        error: `Subtotal ¥${subtotalJpy.toLocaleString()} + shipping ¥${shippingJpy.toLocaleString()} − discount ¥${discountJpy.toLocaleString()} = ¥${expectedTotal.toLocaleString()}, but the invoice total is ¥${Math.round(totalJpy).toLocaleString()}. Refusing to import a draft that does not reconcile.`,
      }, 422);
    }

    // ── Copy the photos into Hub storage ────────────────────────────────────
    // An order outlives the external system it came from. A hotlink to Page365
    // is a photo that disappears the day they rotate a URL, on an order the Hub
    // keeps forever. A photo that cannot be copied is left null — a missing
    // picture is cosmetic, and is not worth refusing an otherwise sound import.
    const photoFailures: string[] = [];

    // ── No duplicate files: reuse the catalogue's own copy ──────────────────
    // A line that matched a website variant whose Page365 gallery is already
    // copied (Website -> Page365 stock) takes that stored main photo. Nothing is
    // downloaded or uploaded again.
    const reuseVariants = [...new Set(items
      .map((it) => (it.kind === "product" && it.stock_match?.result === "matched" ? it.stock_match.variant_id : null))
      .filter((v): v is string => !!v))];
    if (reuseVariants.length) {
      const { data: media } = await supabase.from("website_product_media")
        .select("variant_id, url, sort").in("variant_id", reuseVariants)
        .not("page365_photo_id", "is", null).order("sort", { ascending: true });
      const mainOf = new Map<string, string>();
      for (const m of (media ?? []) as { variant_id: string; url: string }[]) {
        if (!mainOf.has(m.variant_id)) mainOf.set(m.variant_id, m.url);
      }
      for (const it of items) {
        const hit = it.stock_match?.variant_id ? mainOf.get(it.stock_match.variant_id) : undefined;
        if (it.kind === "product" && hit) {
          it.photo_url = hit;
          it.photo_note = "main photo reused from the website catalogue (no second copy)";
        }
      }
    }

    // ── Fallback: ask the webstore for the photos the invoice did not carry ──
    // The catalogue list is read at most once per fetch and shared by every line.
    let catalogue: ReturnType<typeof readCatalogueList> | null = null;
    const getCatalogue = (url: string) => getJson(url, CATALOGUE_TIMEOUT_MS);

    for (let n = 0; n < items.length; n++) {
      if (items[n].photo_url || items[n].source_photo_url || items[n].kind !== "product") continue;

      const tried: string[] = [];
      const sku = items[n].sku;
      let pid = productIds[n];

      // (b) first when there is no product id: find it by the code, exactly.
      if (!pid) {
        tried.push("the Page365 line carried no product id");
        if (!sku) {
          tried.push("no code could be read from the line name, so the catalogue could not be searched");
        } else {
          catalogue ??= readCatalogueList(getCatalogue);
          const list = await catalogue;
          if (!list.ok) {
            tried.push(`catalogue could not be read (${list.why})`);
          } else {
            const hit = findListing(list.items, sku);
            if ("why" in hit) tried.push(hit.why);
            else pid = String(hit.id);
          }
        }
      }

      // (a) The product page: its main photo.
      if (pid) {
        const r = await getJson(`${STOREFRONT_ORIGIN}/products/${encodeURIComponent(pid)}`);
        if (!r.ok) {
          tried.push(`product ${pid}: ${r.why}`);
        } else {
          const hit = mainPhotoOf(r.json);
          if (hit) {
            items[n].source_photo_url = hit;
            items[n].photo_note = productIds[n]
              ? `photo found on the webstore product page (${pid})`
              : `photo found by the code ${sku} on the webstore catalogue (product ${pid})`;
            continue;
          }
          tried.push(`product ${pid}: returned JSON with no usable photo field`);
        }
      }

      // Nothing worked. Record exactly what was attempted and why each failed —
      // this text is what the owner reads in the placeholder tooltip.
      items[n].photo_note = `No photo. Tried: ${tried.join("; ")}.`;
      photoFailures.push(`${items[n].name}: ${tried.join("; ")}`);
    }

    for (let n = 0; n < items.length; n++) {
      const src = items[n].source_photo_url;
      if (!src || items[n].photo_url) continue;
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
        const why = (e as Error).message;
        items[n].photo_note = `A photo URL was found but could not be copied into Hub storage: ${why}`;
        photoFailures.push(`${items[n].name}: could not copy the photo (${why})`);
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
      // subtotal + shipping − discount = total. The discount is carried so the
      // review screen can pre-fill it and so the loyalty basis can exclude it;
      // the promo code and campaign name are for the CSR's eyes only and are
      // never written to the order.
      discount_jpy: discountJpy,
      discount_breakdown: {
        price_discount_jpy: priceDiscountJpy,
        campaign_discount_jpy: campaignDiscountJpy,
      },
      promotion_code: typeof raw["promotion_code"] === "string" && raw["promotion_code"].trim()
        ? String(raw["promotion_code"]).trim() : null,
      discount_campaign_name: typeof raw["discount_campaign_name"] === "string" && raw["discount_campaign_name"].trim()
        ? String(raw["discount_campaign_name"]).trim() : null,
      total_jpy: Math.round(totalJpy),
      fx: { php_jpy_rate: phpJpyRate, source: "system_settings.php_jpy_rate", read_at: new Date().toISOString() },
      page365_stage: typeof raw["stage"] === "string" ? raw["stage"] : null,
      // When the customer's invoice was raised, and when Page365 says it lapses.
      // The review screen prefers these over "today" for the order date and the
      // deposit deadline — an import entered days later must not be dated today.
      page365_created_at: isoOrNull(raw["created_at"]),
      page365_expires_on: isoOrNull(raw["expires_on"]),
      shipping_option: raw["shipping_option"] ?? null,
      fetched_at: new Date().toISOString(),
      photo_failures: photoFailures,
      stock_mode: stockMode,
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
