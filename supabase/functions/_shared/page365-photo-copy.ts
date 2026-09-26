/**
 * Copy Page365 photos of MATCHED inventory items into Hub storage and onto
 * their website variant. Shared by page365-inventory-photos (staff, per run)
 * and page365-inventory-fetch (the scheduled photo backlog of products that
 * landed in the Catalog by themselves, page365_landings).
 *
 *   * Only matched items, only https files on assets.page365.net, only
 *     image/* up to 10 MB.
 *   * Stored at promotions/website/page365/<page365 product>/<photo>-<version>.<ext>
 *     with upsert:false — the same version is never uploaded twice, and two Hub
 *     variants under one Page365 listing (E1053 / E2057) share one file.
 *   * The row is written by page365_inventory_record_photo (ready run only;
 *     once per (variant, Page365 photo id); staff photos never touched).
 *   * A product switched to "Don't sync with Page365" is skipped BEFORE any
 *     download, read live.
 *   * <= the caller's limiter (4 downloads/s), at most maxPhotos per call.
 */
import { fetchWithRetryOnRateLimit } from "./fetch-retry.ts";
import type { AuthContext } from "./handler.ts";
import { USER_AGENT, isPhotoUrl, photoStoragePath, type Page365Photo, type createRateLimiter } from "./page365-inventory.ts";

const BUCKET = "promotions";
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;

interface Job { itemId: string; variantId: string; pid: number; photo: Page365Photo; index: number }

export interface CopyResult {
  copied: number;
  replaced: number;
  already: number;
  not_synced: number;
  failed: { item_id: string; photo_id: number; reason: string }[];
  /** Photos still to copy after this call, in total and per item (skipped keys excluded). */
  remaining: number;
  remainingByItem: Map<string, number>;
}

type Supabase = AuthContext["supabase"];

export async function copyItemPhotos(
  supabase: Supabase,
  itemIds: string[],
  opts: { runId?: string; skip: Set<string>; actor: string | null; maxPhotos: number;
          limit: ReturnType<typeof createRateLimiter> },
): Promise<CopyResult> {
  let q = supabase
    .from("page365_inventory_items")
    .select("id, variant_id, website_product_id, category, page365_product_id, match_result, page365_inventory_products(photos)")
    .eq("match_result", "matched").in("id", itemIds);
  if (opts.runId) q = q.eq("run_id", opts.runId);
  const { data: items, error: itemsErr } = await q;
  if (itemsErr) throw new Error(itemsErr.message);

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
    if (prodErr) throw new Error(prodErr.message);
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
      if (opts.skip.has(`${it.id}:${photo.id}`)) return;
      jobs.push({ itemId: it.id, variantId: it.variant_id!, pid: Number(it.page365_product_id), photo, index });
    });
  }

  const batch = jobs.slice(0, opts.maxPhotos);
  const outcome: Record<string, number> = { inserted: 0, replaced: 0, replaced_hotlink: 0, exists: 0 };
  const failed: CopyResult["failed"] = [];

  await Promise.all(batch.map(job => opts.limit(async () => {
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
        p_url: url, p_source_url: job.photo.url, p_index: job.index, p_actor: opts.actor,
      });
      if (recErr) throw new Error(recErr.message);
      if (typeof out === "string" && out in outcome) outcome[out]++;
      else throw new Error(`not recorded (${String(out)})`);
    } catch (e) {
      failed.push({ item_id: job.itemId, photo_id: job.photo.id, reason: (e as Error).message });
    }
  })));

  const remainingByItem = new Map<string, number>();
  for (const id of itemIds) remainingByItem.set(id, 0);
  for (const job of jobs.slice(batch.length)) remainingByItem.set(job.itemId, (remainingByItem.get(job.itemId) ?? 0) + 1);

  return {
    copied: outcome.inserted,
    replaced: outcome.replaced + outcome.replaced_hotlink,
    already: outcome.exists,
    not_synced: skippedNotSynced,
    failed,
    remaining: Math.max(0, jobs.length - batch.length),
    remainingByItem,
  };
}
