import { jsonResponse } from "./cors.ts";

/**
 * HERO CUT-OUTS in the `website` edge function (hero auto cut-out PR 3 of 5).
 * Docs: docs/HERO-CUTOUTS.md. SQL: migration 20261009100000_hero_cutouts.sql.
 *
 * The hero-only record, made by the original tool (BiRefNet via the storefront
 * workflow). Separate from Photoroom: nothing here reads or writes the
 * Photoroom record, the `cutout` field or any _shared/cutout-* code.
 *
 * The SQL functions used, all service role:
 *   hero_cutouts_for_site(text[])  read side: hero_cutout on every product_media
 *   hero_cutouts_known()           GET  /hero-cutouts (workflow)
 *   hero_cutout_record(jsonb)      POST /hero-cutouts (workflow)
 *   hero_photo_source()            read side: which source the hero uses
 *   hero_lineup_rows(text[])       read side: hero_place per product (category route)
 *
 * HERO PICKS / HERO ORDER (docs/HERO-PICKS.md, migrations 20261013100000 and
 * 20261016100000): once system_settings.hero_photo_source = product_ticks,
 * hero_cutouts_for_site answers with the owner-ticked PRODUCT cut-out instead
 * of the hero record — its file lives under the product cut-out paths and the
 * row carries picked_at (the tick time the hero orders pieces by). On
 * hero_record the rows, and so this payload, are exactly as before: a product
 * cut-out path is accepted ONLY on a row that carries picked_at, which only
 * the product_ticks branch sends.
 * Nothing here approves or rejects: that is review_hero_cutout, the owner's,
 * from the Hub.
 *
 * Kept free of Deno globals so the Hub's vitest suite can import it
 * (src/test/hero-cutouts-edge.test.ts).
 */

export const HERO_BUCKET = "promotions";
export const HERO_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const HERO_MAX_DIM = 4000;
/** meta is a small JSON object; 16 KB is ample for flags + toolchain. */
export const HERO_MAX_META_BYTES = 16 * 1024;
/** The whole multipart body: the file plus meta plus boundaries. */
export const HERO_MAX_BODY_BYTES = HERO_MAX_FILE_BYTES + 64 * 1024;
const MAX_SOURCE_DIM = 30000;
const MAX_URL_LEN = 2048;
const MAX_FLAGS = 50;
const MAX_FLAG_LEN = 200;
const MAX_MODEL_LEN = 100;

const QA_STATUSES = new Set(["ok", "auto_fixed", "needs_review", "failed"]);
const SHA256_RE = /^[0-9a-f]{64}$/;
/** The table's cutout_path CHECK, verbatim. */
export const HERO_PATH_RE = /^website\/derived\/hero\/[0-9a-f]{32}\/[0-9a-f]{8}\/cutout\.webp$/;
/**
 * A product cut-out (website_media_cutouts.cutout_path, _shared/media-cutout-rules.ts
 * derivedPaths): website/derived/<32 hex>/r<run>-<8 hex>/cutout.webp. Runs from
 * before 2026-09-27 have no -<8 hex>. Only ever accepted on a ticked row (picked_at).
 */
export const PRODUCT_CUTOUT_PATH_RE = /^website\/derived\/[0-9a-f]{32}\/r[0-9]{1,4}(?:-[0-9a-f]{8})?\/cutout\.webp$/;

type AnyRec = Record<string, unknown>;

/** The client surface this module needs (the service-role supabase-js client). */
export interface HeroClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc: (fn: string, args?: any) => PromiseLike<{ data: any; error: any }>;
  storage: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from: (bucket: string) => any;
  };
}

// ---------------------------------------------------------------------------
// Hero order (20261016100000): hero_place on /catalog/categories/:slug
// ---------------------------------------------------------------------------

/**
 * Sets `hero_place` on every product of ONE category's response — only while
 * the hero uses ticked product cut-outs. hero_lineup_rows is THE running order
 * (docs/HERO-PICKS.md "Running order"): per category, the ticked pieces that
 * can show (published, a usable ticked photo, a variant in stock), oldest tick
 * first, ties in the Hub's category order. `hero_place` = 1..n for those
 * pieces (1–3 are on the slide, the rest wait), `null` for every other product.
 *
 * On hero_record (or when the switch cannot be read) the field is NOT added:
 * the response stays exactly as before. Never throws; if the switch says
 * product_ticks but the order cannot be read, every product gets null (logged)
 * and the storefront orders by hero_cutout.picked_at instead.
 */
export async function attachHeroPlaces(supabase: HeroClient, products: (AnyRec | null)[], categoryId: unknown): Promise<void> {
  const list = products.filter((p): p is AnyRec => !!p);
  if (!list.length || typeof categoryId !== "string") return;
  try {
    const { data: source, error: sErr } = await supabase.rpc("hero_photo_source");
    if (sErr || source !== "product_ticks") return;
  } catch {
    return;
  }
  for (const p of list) p.hero_place = null;
  try {
    const { data, error } = await supabase.rpc("hero_lineup_rows", { p_extra: null });
    if (error) {
      console.error("[website] hero_lineup_rows failed; hero_place = null", error.code ?? "", error.message ?? "");
      return;
    }
    const byProduct = new Map<string, number>();
    for (const r of (Array.isArray(data) ? data : []) as AnyRec[]) {
      if (r?.category_id === categoryId && typeof r.product_id === "string" && posInt(r.place)) byProduct.set(r.product_id, r.place);
    }
    for (const p of list) p.hero_place = byProduct.get(p.id as string) ?? null;
  } catch (e) {
    for (const p of list) p.hero_place = null;
    console.error("[website] hero_lineup_rows threw; hero_place = null", (e as Error)?.message ?? String(e));
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Constant-time comparison — accumulate all differences, never early-return. */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/** Fail closed: an unset secret refuses every request. */
export function heroKeyOk(provided: string | null, expected: string | undefined | null): boolean {
  if (!expected) return false;
  return timingSafeEqual(provided ?? "", expected);
}

// ---------------------------------------------------------------------------
// Read side
// ---------------------------------------------------------------------------

export type HeroCutoutOut =
  | { status: "approved"; url: string; width: number; height: number }
  | { status: "approved"; url: string; width: number; height: number; picked_at: string }
  | { status: "held" }
  | { status: "rejected" }
  | null;

const posInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** An ISO timestamp as Postgres sends it in jsonb (timestamptz). */
const isTimestamp = (v: unknown): v is string =>
  typeof v === "string" && v.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v));

/**
 * One hero_cutouts_for_site row → the payload. A file URL for approved only.
 * With picked_at (hero_photo_source = product_ticks): the ticked product
 * cut-out, and picked_at passed through. Without it: the hero record, as before.
 */
export function heroCutoutFor(row: unknown, publicUrl: (path: string) => string): HeroCutoutOut {
  const h = row as AnyRec | null | undefined;
  if (!h || typeof h !== "object") return null;
  if (h.status === "approved") {
    const path = h.path;
    if (typeof path !== "string" || !posInt(h.width) || !posInt(h.height)) return null;
    if ("picked_at" in h) {
      if (!isTimestamp(h.picked_at) || !PRODUCT_CUTOUT_PATH_RE.test(path)) return null;
      return { status: "approved", url: publicUrl(path), width: h.width, height: h.height, picked_at: h.picked_at };
    }
    if (!HERO_PATH_RE.test(path)) return null;
    return { status: "approved", url: publicUrl(path), width: h.width, height: h.height };
  }
  if (h.status === "held") return { status: "held" };
  if (h.status === "rejected") return { status: "rejected" };
  return null;
}

function mediaOf(products: (AnyRec | null)[]): AnyRec[] {
  const out: AnyRec[] = [];
  for (const p of products) {
    if (!p) continue;
    for (const v of (p.product_variants as AnyRec[] | undefined) ?? []) {
      for (const m of (v.product_media as AnyRec[] | undefined) ?? []) out.push(m);
    }
  }
  return out;
}

/**
 * Sets `hero_cutout` on every product_media entry of already-shaped products,
 * with ONE hero_cutouts_for_site call. Never throws: on any failure every entry
 * gets null and the catalogue read goes on.
 */
export async function attachHeroCutouts(supabase: HeroClient, products: (AnyRec | null)[]): Promise<void> {
  const media = mediaOf(products);
  if (!media.length) return;
  for (const m of media) m.hero_cutout = null;
  const urls = [...new Set(media.map((m) => m.url).filter((u): u is string => typeof u === "string" && u !== ""))];
  if (!urls.length) return;
  try {
    const { data, error } = await supabase.rpc("hero_cutouts_for_site", { p_urls: urls });
    if (error) {
      console.error("[website] hero_cutouts_for_site failed; hero_cutout = null", error.code ?? "", error.message ?? "");
      return;
    }
    const bucket = supabase.storage.from(HERO_BUCKET);
    const publicUrl = (path: string) => String(bucket.getPublicUrl(path).data.publicUrl);
    const byUrl = new Map<string, HeroCutoutOut>();
    for (const r of (Array.isArray(data) ? data : []) as AnyRec[]) {
      if (typeof r?.source_url === "string") byUrl.set(r.source_url, heroCutoutFor(r.hero_cutout, publicUrl));
    }
    for (const m of media) m.hero_cutout = byUrl.get(m.url as string) ?? null;
  } catch (e) {
    for (const m of media) m.hero_cutout = null;
    console.error("[website] hero_cutouts_for_site threw; hero_cutout = null", (e as Error)?.message ?? String(e));
  }
}

// ---------------------------------------------------------------------------
// Workflow side: validation
// ---------------------------------------------------------------------------

/** hero_cutout_source_ok(), mirrored so a bad URL is a 422, not an SQL 500. */
export function heroSourceOk(url: string): boolean {
  return url.length <= MAX_URL_LEN
    && /^https:\/\/[^/]+\/storage\/v1\/object\/public\/promotions\/website\//.test(url)
    && !/\/promotions\/website\/derived\//.test(url);
}

/** The record the RPC receives, built key by key (nothing passes through). */
export interface HeroMeta {
  source_url: string;
  source_sha256: string;
  source_width: number;
  source_height: number;
  status: "ok" | "auto_fixed" | "needs_review" | "failed";
  flags: string[];
  coverage: number | null;
  width: number | null;
  height: number | null;
  model: string;
  toolchain: AnyRec;
}

export type MetaCheck =
  | { ok: true; meta: HeroMeta }
  | { ok: false; error: "invalid" | "invalid_status"; detail: string };

const bad = (detail: string): MetaCheck => ({ ok: false, error: "invalid", detail });
const intIn = (v: unknown, max: number): v is number => posInt(v) && v <= max;

/** Validates `meta` against whether a file came with it. */
export function validateHeroMeta(raw: unknown, hasFile: boolean): MetaCheck {
  if (typeof raw !== "string") return bad("meta");
  if (new TextEncoder().encode(raw).length > HERO_MAX_META_BYTES) return bad("meta_too_large");
  let m: AnyRec;
  try {
    m = JSON.parse(raw);
  } catch {
    return bad("meta_json");
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) return bad("meta");

  if (typeof m.status !== "string" || !QA_STATUSES.has(m.status)) {
    // approved / rejected are the owner's, never the workflow's.
    return { ok: false, error: "invalid_status", detail: "status" };
  }
  const status = m.status as HeroMeta["status"];
  if (typeof m.source_url !== "string" || !heroSourceOk(m.source_url)) return bad("source_url");
  if (typeof m.source_sha256 !== "string" || !SHA256_RE.test(m.source_sha256)) return bad("source_sha256");
  if (!intIn(m.source_width, MAX_SOURCE_DIM) || !intIn(m.source_height, MAX_SOURCE_DIM)) return bad("source_size");

  const flags = m.flags ?? [];
  if (!Array.isArray(flags) || flags.length > MAX_FLAGS
    || !flags.every((f) => typeof f === "string" && f.length > 0 && f.length <= MAX_FLAG_LEN)) return bad("flags");

  const coverage = m.coverage ?? null;
  if (coverage !== null && !(typeof coverage === "number" && Number.isFinite(coverage) && coverage >= 0 && coverage <= 1)) {
    return bad("coverage");
  }

  if (typeof m.model !== "string" || !m.model.trim() || m.model.length > MAX_MODEL_LEN) return bad("model");
  const toolchain = m.toolchain ?? {};
  if (!toolchain || typeof toolchain !== "object" || Array.isArray(toolchain)) return bad("toolchain");

  // A file exactly when the status is not failed (the table's CHECK).
  if (status === "failed") {
    if (hasFile) return bad("file_forbidden_when_failed");
    if ((m.width ?? null) !== null || (m.height ?? null) !== null) return bad("size_without_file");
  } else {
    if (!hasFile) return bad("file_required");
    if (!intIn(m.width, HERO_MAX_DIM) || !intIn(m.height, HERO_MAX_DIM)) return bad("size");
  }

  return {
    ok: true,
    meta: {
      source_url: m.source_url,
      source_sha256: m.source_sha256,
      source_width: m.source_width as number,
      source_height: m.source_height as number,
      status,
      flags: flags as string[],
      coverage: coverage as number | null,
      width: status === "failed" ? null : (m.width as number),
      height: status === "failed" ? null : (m.height as number),
      model: m.model,
      toolchain: toolchain as AnyRec,
    },
  };
}

/** RIFF....WEBP in the first 12 bytes. */
export function isWebp(b: Uint8Array): boolean {
  if (b.length < 12) return false;
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** website/derived/hero/<32 hex of sha256(file)>/<8 hex of sha256(source_url)>/cutout.webp */
export async function heroCutoutPath(file: Uint8Array, sourceUrl: string): Promise<string> {
  const f = await sha256Hex(file);
  const s = await sha256Hex(new TextEncoder().encode(sourceUrl));
  return `website/derived/hero/${f.slice(0, 32)}/${s.slice(0, 8)}/cutout.webp`;
}

/** Storage's answer when upsert:false meets an existing object. */
export function isAlreadyExists(err: unknown): boolean {
  const e = err as AnyRec | null;
  if (!e) return false;
  return /already exists/i.test(String(e.message ?? ""))
    || Number(e.status) === 409 || String(e.statusCode ?? "") === "409" || e.error === "Duplicate";
}

// ---------------------------------------------------------------------------
// Workflow side: the two routes
// ---------------------------------------------------------------------------

const noStore = (res: Response): Response => {
  res.headers.set("Cache-Control", "no-store");
  return res;
};
const invalid = (error: string, detail: string) => noStore(jsonResponse({ error, detail }, 422));

/**
 * /hero-cutouts. The caller has ALREADY passed the global x-api-key check;
 * this adds x-hero-cutout-key (HERO_CUTOUT_KEY). Request headers are never logged.
 */
export async function handleHeroCutouts(
  req: Request,
  supabase: HeroClient,
  heroKey: string | undefined | null,
  requestId: string,
): Promise<Response> {
  if (!heroKeyOk(req.headers.get("x-hero-cutout-key"), heroKey)) {
    return noStore(jsonResponse({ error: "unauthorized" }, 401));
  }

  if (req.method === "GET") {
    const { data, error } = await supabase.rpc("hero_cutouts_known");
    if (error) {
      console.error("[website] hero_cutouts_known failed", requestId, error.code ?? "", error.message ?? "");
      return noStore(jsonResponse({ error: "server_error", request_id: requestId }, 500));
    }
    return noStore(jsonResponse({ items: Array.isArray(data) ? data : [] }));
  }

  if (req.method !== "POST") return noStore(jsonResponse({ error: "method_not_allowed" }, 405));

  // Size first, before anything reads the body.
  const len = Number(req.headers.get("content-length") ?? "");
  if (!req.headers.get("content-length") || !Number.isFinite(len) || len < 0) return invalid("invalid", "content_length_required");
  if (len > HERO_MAX_BODY_BYTES) return invalid("invalid", "body_too_large");
  if (!/^multipart\/form-data;/i.test(req.headers.get("content-type") ?? "")) return invalid("invalid", "multipart_required");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return invalid("invalid", "multipart");
  }
  const metas = form.getAll("meta");
  const files = form.getAll("file");
  if (metas.length !== 1 || files.length > 1) return invalid("invalid", "fields");
  const fileEntry = files[0];
  if (fileEntry !== undefined && typeof fileEntry === "string") return invalid("invalid", "file");

  const check = validateHeroMeta(metas[0], fileEntry !== undefined);
  if (!check.ok) return invalid(check.error, check.detail);
  const meta = check.meta;

  let path: string | null = null;
  let uploadedNow = false;
  if (fileEntry !== undefined) {
    const blob = fileEntry as Blob;
    if (blob.size > HERO_MAX_FILE_BYTES) return invalid("invalid", "file_too_large");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length > HERO_MAX_FILE_BYTES) return invalid("invalid", "file_too_large");
    if (!isWebp(bytes)) return invalid("invalid", "file_not_webp");

    path = await heroCutoutPath(bytes, meta.source_url);
    const { error: upErr } = await supabase.storage.from(HERO_BUCKET).upload(path, bytes, {
      contentType: "image/webp",
      cacheControl: "31536000",
      upsert: false, // a new file is a new path; nothing is ever overwritten
    });
    if (upErr) {
      if (!isAlreadyExists(upErr)) {
        console.error("[website] hero cut-out upload failed", requestId, upErr.message ?? "");
        return noStore(jsonResponse({ error: "upload_failed", request_id: requestId }, 500));
      }
      // Same path = same bytes: already stored. Not ours to delete later.
    } else {
      uploadedNow = true;
    }
  }

  const cleanup = async () => {
    if (!uploadedNow || !path) return;
    try {
      await supabase.storage.from(HERO_BUCKET).remove([path]);
    } catch { /* best-effort */ }
  };

  let answer: AnyRec | null;
  try {
    const { data, error } = await supabase.rpc("hero_cutout_record", { p: { ...meta, cutout_path: path } });
    if (error) {
      console.error("[website] hero_cutout_record failed", requestId, error.code ?? "", error.message ?? "");
      await cleanup();
      return noStore(jsonResponse({ error: "record_failed", request_id: requestId }, 500));
    }
    answer = data as AnyRec | null;
  } catch (e) {
    console.error("[website] hero_cutout_record threw", requestId, (e as Error)?.message ?? String(e));
    await cleanup();
    return noStore(jsonResponse({ error: "record_failed", request_id: requestId }, 500));
  }

  if (answer?.error === "unknown_photo") {
    await cleanup();
    return invalid("unknown_photo", "source_url");
  }
  const result = answer?.result;
  if (result !== "inserted" && result !== "replaced" && result !== "unchanged") {
    console.error("[website] hero_cutout_record unexpected answer", requestId, JSON.stringify(answer)?.slice(0, 200));
    await cleanup();
    return noStore(jsonResponse({ error: "record_failed", request_id: requestId }, 500));
  }
  // Unchanged: the record kept its old file; the one just uploaded is unused.
  if (result === "unchanged") await cleanup();
  return noStore(jsonResponse({ result, status: answer?.status }));
}
