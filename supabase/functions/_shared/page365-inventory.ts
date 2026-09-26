/**
 * page365-inventory — read the Page365 storefront catalogue, strictly.
 *
 * Pure functions shared by page365-inventory-fetch (the chunked reader) and
 * page365-inventory-photos (the photo copier), and pinned by
 * src/test/page365-inventory.test.ts. Nothing here touches the database.
 *
 * The storefront is the shop's own public Rails app; the same URLs that serve
 * HTML answer JSON when asked (docs/PAGE365-IMPORT.md "INVENTORY"):
 *   GET /products?page=N      cumulative "load more" list: page N holds the
 *                             first 16*N products, so ONE request for
 *                             page = ceil(count / 16) returns the whole list.
 *   GET /products/<id>        variants (with an integer `available`), the full
 *                             photo gallery, and customer reviews. Reviews carry
 *                             customer names and are NEVER read past this parser.
 *
 * STRICT. A list or detail that does not look exactly as expected is an error
 * for that request, never a guess: a missing `available` is not 0, and a
 * listing without a code is flagged, not matched on something else.
 */

/** The only storefront hosts (same list as page365-fetch-order). */
export const STOREFRONT_ORIGIN = "https://www.chajewelsjapan.com";
/** Photos are only ever downloaded from here. */
export const PHOTO_HOST = "assets.page365.net";
/** Page365's list page size. */
export const LIST_PAGE_SIZE = 16;
/** Identifies the Hub to the shop's own storefront. */
export const USER_AGENT = "ChaJewelsHub-Page365Inventory/1.0";

export interface ListItem {
  id: number;
  name: string;
}

export interface Page365Photo {
  id: number;
  version: string;
  url: string;
  position: number;
}

export interface Page365Variant {
  id: number;
  name: string | null;
  code: string | null;
  price_jpy: number | null;
  full_price_jpy: number | null;
  available: number;
}

export interface Page365Detail {
  name: string;
  price_jpy: number | null;
  full_price_jpy: number | null;
  photos: Page365Photo[];
  variants: Page365Variant[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Twin of SQL public.page365_first_word (and _shared/page365-stock.ts
 *  firstWord): first whitespace-delimited word, upper-cased. JS `\s` covers
 *  U+3000 and NBSP. Null when blank. */
export function firstWord(name: string | null | undefined): string | null {
  const m = String(name ?? "").match(/^\s*(\S+)/);
  return m ? m[1].toUpperCase() : null;
}

/** Whole, non-negative yen, or null when absent. A value that is present but
 *  not a number is an error (thrown), not a null. */
function yen(v: unknown, field: string): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0) throw new Error(`${field} is not a price`);
  return Math.round(n);
}

function wholeId(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) throw new Error(`${field} is not an id`);
  return v;
}

/** The page that holds the whole cumulative list. */
export function lastListPage(count: number): number {
  return Math.max(1, Math.ceil(count / LIST_PAGE_SIZE));
}

/** `{"items":[...], "count":N}`. Returns the count and the items; throws when
 *  the envelope is not that shape. */
export function parseListEnvelope(json: unknown): { count: number; items: ListItem[] } {
  if (!isObj(json) || !Array.isArray(json["items"])) throw new Error("list: no items array");
  const count = json["count"];
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error("list: no count");
  const items = (json["items"] as unknown[]).map((raw, i) => {
    if (!isObj(raw)) throw new Error(`list item ${i}: not an object`);
    const name = raw["name"];
    if (typeof name !== "string") throw new Error(`list item ${i}: no name`);
    return { id: wholeId(raw["id"], `list item ${i} id`), name };
  });
  return { count, items };
}

/** What the LIST says about each product beyond id and name (PR 4): its
 *  Page365 category and description. The list carries no customer reviews.
 *  Lenient by design: the list was already checked strictly by
 *  parseListEnvelope, and a missing or odd category/description is null —
 *  it only means the draft is uncategorised or has no description. */
export interface ListExtras {
  category_id: number | null;
  category: string | null;
  description: string | null;
}

export function parseListExtras(json: unknown): Map<number, ListExtras> {
  const out = new Map<number, ListExtras>();
  if (!isObj(json) || !Array.isArray(json["items"])) return out;
  for (const raw of json["items"] as unknown[]) {
    if (!isObj(raw) || typeof raw["id"] !== "number") continue;
    const cat = isObj(raw["category"]) ? raw["category"] : null;
    const catName = cat && typeof cat["name"] === "string" && cat["name"].trim() ? cat["name"].trim() : null;
    const catId = cat && typeof cat["id"] === "number" && Number.isSafeInteger(cat["id"]) ? cat["id"] : null;
    const desc = typeof raw["description"] === "string" && raw["description"].trim()
      ? raw["description"].slice(0, 4000) : null;
    out.set(raw["id"], { category_id: catId, category: catName ? catName.slice(0, 200) : null, description: desc });
  }
  return out;
}

/** A complete list: exactly `count` items, no id twice. */
export function checkCompleteList(env: { count: number; items: ListItem[] }): ListItem[] {
  if (env.items.length !== env.count) {
    throw new Error(`list: ${env.items.length} items for a count of ${env.count}`);
  }
  const seen = new Set<number>();
  for (const it of env.items) {
    if (seen.has(it.id)) throw new Error(`list: product ${it.id} twice`);
    seen.add(it.id);
  }
  return env.items;
}

/** The ?1789114828 stamp on a Page365 photo URL. Different stamp = replaced
 *  photo. "0" when the URL carries none. */
export function photoVersion(url: string): string {
  const q = url.split("?")[1] ?? "";
  const m = q.match(/^(\d{1,20})\b/) ?? q.match(/(?:^|&)v=(\d{1,20})/);
  return m ? m[1] : "0";
}

/** Only https URLs on the Page365 asset host are ever fetched. */
export function isPhotoUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === PHOTO_HOST;
  } catch {
    return false;
  }
}

/** Photos in Page365's display order: by position, ties broken by the order
 *  the storefront listed them (14 live products have tied positions). */
export function orderPhotos(raw: unknown): Page365Photo[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("photos is not a list");
  const out: (Page365Photo & { idx: number })[] = [];
  raw.forEach((p, idx) => {
    if (!isObj(p)) throw new Error(`photo ${idx}: not an object`);
    const url = typeof p["normal"] === "string" ? p["normal"] : null;
    if (!url || !isPhotoUrl(url)) throw new Error(`photo ${idx}: no usable original URL`);
    const pos = typeof p["position"] === "number" && Number.isFinite(p["position"]) ? p["position"] : idx;
    out.push({ id: wholeId(p["id"], `photo ${idx} id`), version: photoVersion(url), url, position: pos, idx });
  });
  out.sort((a, b) => a.position - b.position || a.idx - b.idx);
  const ids = new Set<number>();
  return out
    .filter(p => (ids.has(p.id) ? false : (ids.add(p.id), true)))
    .map(({ id, version, url, position }) => ({ id, version, url, position }));
}

/**
 * The product code of each variant (owner rule, per VARIANT):
 *   one variant  -> first word of the PRODUCT name (variant names are null);
 *   2+ variants  -> first word of each VARIANT name (E1053 / E2057 live under
 *                   one listing; product-level would lose E2057).
 * A variant whose name is blank in a multi-variant listing has no code.
 */
export function variantCode(productName: string, variantName: string | null, variantCount: number): string | null {
  return variantCount === 1 ? firstWord(productName) : firstWord(variantName);
}

/**
 * Parse one /products/<id> response. Returns ONLY whitelisted fields: the
 * `review` block (customer names and words), descriptions, categories and
 * everything else are dropped here. Throws on anything not exactly as
 * expected — the caller records that product as an error.
 */
export function parseProductDetail(json: unknown, expectedId: number): Page365Detail {
  const body = isObj(json) && isObj(json["product"]) ? json["product"] : json;
  if (!isObj(body)) throw new Error("detail: not an object");
  if (body["id"] !== undefined && body["id"] !== expectedId) {
    throw new Error(`detail: asked for ${expectedId}, got ${String(body["id"])}`);
  }
  const name = body["name"];
  if (typeof name !== "string" || !name.trim()) throw new Error("detail: no name");
  const rawVariants = body["variants"];
  if (!Array.isArray(rawVariants) || rawVariants.length === 0) throw new Error("detail: no variants");

  const variants = rawVariants.map((v, i): Page365Variant => {
    if (!isObj(v)) throw new Error(`variant ${i}: not an object`);
    const available = v["available"];
    if (typeof available !== "number" || !Number.isSafeInteger(available) || available < 0) {
      throw new Error(`variant ${i}: available is not a whole number`);
    }
    const vName = typeof v["name"] === "string" && v["name"].trim() ? v["name"].trim() : null;
    return {
      id: wholeId(v["id"], `variant ${i} id`),
      name: vName,
      code: variantCode(name, vName, rawVariants.length),
      price_jpy: yen(v["price"], `variant ${i} price`),
      full_price_jpy: yen(v["full_price"], `variant ${i} full_price`),
      available,
    };
  });

  return {
    name: name.trim(),
    price_jpy: yen(body["price"], "price"),
    full_price_jpy: yen(body["full_price"], "full_price"),
    photos: orderPhotos(body["photos"]),
    variants,
  };
}

/** The MAIN photo of a /products/<id> response: the first of photos[] in
 *  Page365's display order. Null when there is no gallery the strict reader
 *  accepts (the caller may then fall back to a looser search). */
export function mainGalleryPhoto(json: unknown): string | null {
  const body = isObj(json) && isObj(json["product"]) ? json["product"] : json;
  if (!isObj(body)) return null;
  try {
    return orderPhotos(body["photos"])[0]?.url ?? null;
  } catch {
    return null;
  }
}

export type GetJson = (url: string) => Promise<{ ok: true; json: unknown } | { ok: false; why: string }>;

/**
 * The whole catalogue list in at most TWO requests: page 1 for the count, then
 * page ceil(count/16) — the list is cumulative, so that page is everything.
 * Strict: a list that is not complete is an error, never a partial search.
 * (F1, 2026-09-28: page365-fetch-order used to walk pages 1..60 expecting an
 * empty page at the end, which never comes, and ran into its 20 s budget.)
 */
export async function readCatalogueList(get: GetJson): Promise<{ ok: true; items: ListItem[] } | { ok: false; why: string }> {
  const first = await get(`${STOREFRONT_ORIGIN}/products?page=1`);
  if (!first.ok) return { ok: false, why: `catalogue count: ${first.why}` };
  try {
    const { count } = parseListEnvelope(first.json);
    const page = lastListPage(count);
    const full = page === 1 ? first : await get(`${STOREFRONT_ORIGIN}/products?page=${page}`);
    if (!full.ok) return { ok: false, why: `catalogue page ${page}: ${full.why}` };
    return { ok: true, items: checkCompleteList(parseListEnvelope(full.json)) };
  } catch (e) {
    return { ok: false, why: (e as Error).message };
  }
}

/** Exactly one listing whose code (first word, F2) is `code`; otherwise why
 *  not. Never a prefix match, never a guess between two. */
export function findListing(items: ListItem[], code: string): { id: number } | { why: string } {
  const want = firstWord(code);
  const hits = items.filter(it => want !== null && firstWord(it.name) === want);
  if (hits.length === 1) return { id: hits[0].id };
  return hits.length === 0
    ? { why: `no webstore listing has the code ${code}` }
    : { why: `${hits.length} webstore listings share the code ${code}, so none was guessed` };
}

/** Where a copied photo lives: promotions/website/page365/<pid>/<photo>-<version>.<ext>.
 *  Deterministic, so a second copy of the same version is recognised. */
export function photoStoragePath(page365ProductId: number, photo: Pick<Page365Photo, "id" | "version" | "url">,
  contentType?: string | null): string {
  const byType: Record<string, string> = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
  const t = (contentType ?? "").split(";")[0].trim().toLowerCase();
  const fromUrl = (photo.url.split("?")[0].match(/\.([a-z0-9]{3,4})$/i)?.[1] ?? "").toLowerCase();
  const ext = byType[t] ?? (["jpg", "jpeg", "png", "webp", "gif"].includes(fromUrl) ? fromUrl : "jpeg");
  const version = photo.version.replace(/[^0-9A-Za-z]/g, "") || "0";
  return `website/page365/${page365ProductId}/${photo.id}-${version}.${ext}`;
}

/**
 * At most `perSecond` request STARTS per second, across every caller that
 * shares the limiter, and at most `concurrency` in flight. The owner's rule
 * for the storefront is <= 4 requests/s.
 */
export function createRateLimiter(perSecond: number, concurrency: number,
  now: () => number = Date.now, sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))) {
  const spacing = 1000 / perSecond;
  let nextSlot = 0;
  let inFlight = 0;
  const waiters: (() => void)[] = [];
  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (inFlight >= concurrency) await new Promise<void>(r => waiters.push(r));
    inFlight++;
    try {
      const t = now();
      const slot = Math.max(t, nextSlot);
      nextSlot = slot + spacing;
      if (slot > t) await sleep(slot - t);
      return await fn();
    } finally {
      inFlight--;
      waiters.shift()?.();
    }
  };
}

/**
 * PR 3d — the scheduled-read interval staff choose in the Hub
 * (system_settings.page365_inventory_interval_minutes; only 5, 10, 20 or 30).
 * Anything else — including "not readable yet" before the migration — is 30,
 * the pre-PR 3d cadence.
 */
export const SCHEDULE_INTERVALS = [5, 10, 20, 30] as const;
export type ScheduleInterval = typeof SCHEDULE_INTERVALS[number];
export const DEFAULT_SCHEDULE_INTERVAL: ScheduleInterval = 30;

export function normalizeIntervalMinutes(v: unknown): ScheduleInterval {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return (SCHEDULE_INTERVALS as readonly unknown[]).includes(n) ? n as ScheduleInterval : DEFAULT_SCHEDULE_INTERVAL;
}

/** The cron wakes every 5 minutes (2-59/5) and a read starts a few seconds
 *  after its tick. A read is due once (interval − 2.5 min) has passed since the
 *  last scheduled START: the tick one interval later always qualifies, the tick
 *  before it never does — on time, never early. (At 30 this is 27.5 min; PR 3
 *  used 27.) get_page365_inventory_interval() mirrors this for "next check". */
export const SCHEDULE_SLACK_MS = 150_000;
export const scheduleEveryMs = (minutes: ScheduleInterval): number => minutes * 60_000 - SCHEDULE_SLACK_MS;

/**
 * PR 3 — what one scheduled tick (every 5 minutes) does, given the run that
 * is reading now (if any) and when the last SCHEDULED run began:
 *   skip    a staff (manual) fetch is reading — never overlap it
 *   resume  the scheduled run is still reading — read more of it
 *   wait    the last scheduled run began less than everyMs ago
 *           (scheduleEveryMs(interval), PR 3d)
 *   start   begin a new scheduled run (an abandoned reader is closed by start)
 */
export type ScheduleAct =
  | { act: "skip"; reason: "manual_fetch_in_progress" }
  | { act: "resume" }
  | { act: "wait"; reason: "not_due" }
  | { act: "start" };

export function scheduleDecision(
  open: { source: string; updated_at: string } | null,
  lastScheduledAt: string | null,
  now: number,
  abandonedAfterMs: number,
  everyMs: number,
): ScheduleAct {
  if (open && now - new Date(open.updated_at).getTime() < abandonedAfterMs) {
    return open.source === "schedule" ? { act: "resume" } : { act: "skip", reason: "manual_fetch_in_progress" };
  }
  if (lastScheduledAt && now - new Date(lastScheduledAt).getTime() < everyMs) return { act: "wait", reason: "not_due" };
  return { act: "start" };
}
