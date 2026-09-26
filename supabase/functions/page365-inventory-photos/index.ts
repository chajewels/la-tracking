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
 *
 * The copy itself lives in _shared/page365-photo-copy.ts (2026-09-26), shared
 * with page365-inventory-fetch, which copies the photos of products that
 * landed in the Catalog by themselves.
 */
import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";
import { createRateLimiter } from "../_shared/page365-inventory.ts";
import { copyItemPhotos } from "../_shared/page365-photo-copy.ts";

const PHOTOS_PER_CALL = 12;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

    const r = await copyItemPhotos(supabase, itemIds, {
      runId, skip, actor: userId, maxPhotos: PHOTOS_PER_CALL, limit: createRateLimiter(4, 3),
    });
    return jsonResponse({
      copied: r.copied, replaced: r.replaced, already: r.already, not_synced: r.not_synced,
      failed: r.failed, remaining: r.remaining,
    });
  } catch (error: unknown) {
    console.error("page365-inventory-photos error:", error);
    return jsonResponse({ error: (error as Error).message || "Internal server error" }, 500);
  }
});
