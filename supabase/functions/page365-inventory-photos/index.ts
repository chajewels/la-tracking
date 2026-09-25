/**
 * page365-inventory-photos — copy every Page365 photo of the ticked, MATCHED
 * products into Hub storage and onto their website variant.
 *
 * Body: { run_id, item_ids: uuid[], skip?: string[] }  (skip = "<item>:<photo>"
 * pairs that already failed in this session, so a broken file is not retried
 * forever). The browser calls again while `remaining > 0`.
 *
 *   * Only a 'ready' run, only matched items, only https files on
 *     assets.page365.net, only image/* up to 10 MB.
 *   * Stored at promotions/website/page365/<page365 product>/<photo>-<version>.<ext>
 *     with upsert:false — the same version is never uploaded twice, and two Hub
 *     variants under one Page365 listing (E1053 / E2057) share one file.
 *   * The row is written by page365_inventory_record_photo: once per
 *     (variant, Page365 photo id); a new version refreshes it in place; a
 *     spreadsheet hotlink to the same file is replaced in place; staff photos
 *     are never touched or reordered; Page365's first photo is the main one
 *     when there are no staff photos.
 *   * <= 4 downloads/s, 3 at a time, a bounded number per call.
 *   * A product switched to "Don't sync with Page365" is skipped BEFORE any
 *     download, read live (the switch may be flipped after the fetch);
 *     page365_inventory_record_photo refuses it too ('sync_disabled').
 */
import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";
import { fetchWithRetryOnRateLimit } from "../_shared/fetch-retry.ts";
import {
  USER_AGENT, createRateLimiter, isPhotoUrl, photoStoragePath, type Page365Photo,
} from "../_shared/page365-inventory.ts";

const BUCKET = "promotions";
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const PHOTOS_PER_CALL = 12;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Job { itemId: string; variantId: string; pid: number; photo: Page365Photo; index: number }

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const ctx = await requireAuth(req);
  if (ctx instanceof Response) return ctx;
  const denied = await requirePermission(ctx, "manage_website_catalog");
  if (denied) return denied;
  const supabase = ctx.supabase;
  const userId = ctx.user?.id ?? null;

  try {
    const body = await req.json().catch(() => ({}));
    const runId = typeof body?.run_id === "string" && UUID_RE.test(body.run_id) ? body.run_id : null;
    const itemIds: string[] = Array.isArray(body?.item_ids)
      ? [...new Set((body.item_ids as unknown[]).filter((x): x is string => typeof x === "string" && UUID_RE.test(x)))]
      : [];
    const skip = new Set<string>(Array.isArray(body?.skip) ? (body.skip as unknown[]).map(String).slice(0, 2000) : []);
    if (!runId || itemIds.length === 0) return jsonResponse({ error: "run_id and item_ids are required" }, 400);
    if (itemIds.length > 600) return jsonResponse({ error: "At most 600 products per request" }, 400);

    const { data: run } = await supabase.from("page365_inventory_runs").select("status").eq("id", runId).maybeSingle();
    if (!run) return jsonResponse({ error: "Run not found" }, 404);
    if (run.status !== "ready") {
      return jsonResponse({ error: `This fetch is ${run.status}; photos are copied only from a complete fetch.` }, 409);
    }

    const { data: items, error: itemsErr } = await supabase
      .from("page365_inventory_items")
      .select("id, variant_id, website_product_id, category, page365_product_id, match_result, page365_inventory_products(photos)")
      .eq("run_id", runId).eq("match_result", "matched").in("id", itemIds);
    if (itemsErr) return jsonResponse({ error: itemsErr.message }, 500);

    // "Don't sync with Page365": never copied. Read live, before any download.
    type ItemRow = {
      id: string; variant_id: string | null; website_product_id: string | null; category: string;
      page365_product_id: number; page365_inventory_products: { photos: Page365Photo[] } | null;
    };
    const rows = (items ?? []) as ItemRow[];
    const productIds = [...new Set(rows.map(i => i.website_product_id).filter((x): x is string => !!x))];
    const syncOff = new Set<string>();
    if (productIds.length) {
      const { data: products, error: prodErr } = await supabase.from("website_products")
        .select("id, page365_sync_disabled").in("id", productIds);
      if (prodErr) return jsonResponse({ error: prodErr.message }, 500);
      for (const p of (products ?? []) as { id: string; page365_sync_disabled: boolean }[]) {
        if (p.page365_sync_disabled === true) syncOff.add(p.id);
      }
    }
    const notSynced = (it: Pick<ItemRow, "website_product_id" | "category">) =>
      it.category === "not_synced" || (!!it.website_product_id && syncOff.has(it.website_product_id));
    const skippedNotSynced = rows.filter(notSynced).length;

    const variantIds = [...new Set(rows.filter(i => !notSynced(i)).map(i => i.variant_id).filter((x): x is string => !!x))];
    const have = new Set<string>();
    if (variantIds.length) {
      const { data: media } = await supabase.from("website_product_media")
        .select("variant_id, page365_photo_id, page365_photo_version")
        .in("variant_id", variantIds).not("page365_photo_id", "is", null);
      for (const m of (media ?? []) as { variant_id: string; page365_photo_id: number; page365_photo_version: string }[]) {
        have.add(`${m.variant_id}:${m.page365_photo_id}:${m.page365_photo_version}`);
      }
    }

    const jobs: Job[] = [];
    for (const it of rows) {
      if (!it.variant_id || notSynced(it)) continue;
      (it.page365_inventory_products?.photos ?? []).forEach((photo, index) => {
        if (have.has(`${it.variant_id}:${photo.id}:${photo.version}`)) return;
        if (skip.has(`${it.id}:${photo.id}`)) return;
        jobs.push({ itemId: it.id, variantId: it.variant_id!, pid: Number(it.page365_product_id), photo, index });
      });
    }

    const batch = jobs.slice(0, PHOTOS_PER_CALL);
    const outcome: Record<string, number> = { inserted: 0, replaced: 0, replaced_hotlink: 0, exists: 0 };
    const failed: { item_id: string; photo_id: number; reason: string }[] = [];
    const limit = createRateLimiter(4, 3);

    await Promise.all(batch.map(job => limit(async () => {
      try {
        if (!isPhotoUrl(job.photo.url)) throw new Error("not a Page365 photo URL");
        const path = photoStoragePath(job.pid, job.photo);
        const exists = await supabase.storage.from(BUCKET).list(path.slice(0, path.lastIndexOf("/")), {
          search: path.slice(path.lastIndexOf("/") + 1),
        });
        let finalPath = path;
        if (!exists.data?.some((f: { name: string }) => f.name === path.slice(path.lastIndexOf("/") + 1))) {
          const res = await fetchWithRetryOnRateLimit(job.photo.url, {
            method: "GET", headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
          if (!type.startsWith("image/")) throw new Error(`not an image (${type || "no type"})`);
          const buf = new Uint8Array(await res.arrayBuffer());
          if (buf.byteLength === 0) throw new Error("empty file");
          if (buf.byteLength > MAX_PHOTO_BYTES) throw new Error(`${buf.byteLength} bytes exceeds 10 MB`);
          finalPath = photoStoragePath(job.pid, job.photo, type);
          const { error: upErr } = await supabase.storage.from(BUCKET).upload(finalPath, buf, {
            contentType: type, upsert: false,
          });
          // Already there (a second variant of the same listing, or a retry): reuse it.
          if (upErr && !/exist|duplicate/i.test(upErr.message)) throw new Error(upErr.message);
        }
        const url = supabase.storage.from(BUCKET).getPublicUrl(finalPath).data.publicUrl as string;
        const { data: out, error: recErr } = await supabase.rpc("page365_inventory_record_photo", {
          p_item_id: job.itemId, p_photo_id: job.photo.id, p_version: job.photo.version,
          p_url: url, p_source_url: job.photo.url, p_index: job.index, p_actor: userId,
        });
        if (recErr) throw new Error(recErr.message);
        if (typeof out === "string" && out in outcome) outcome[out]++;
        else throw new Error(`not recorded (${String(out)})`);
      } catch (e) {
        failed.push({ item_id: job.itemId, photo_id: job.photo.id, reason: (e as Error).message });
      }
    })));

    return jsonResponse({
      copied: outcome.inserted,
      replaced: outcome.replaced + outcome.replaced_hotlink,
      already: outcome.exists,
      not_synced: skippedNotSynced,
      failed,
      remaining: Math.max(0, jobs.length - batch.length),
    });
  } catch (error: unknown) {
    console.error("page365-inventory-photos error:", error);
    return jsonResponse({ error: (error as Error).message || "Internal server error" }, 500);
  }
});
