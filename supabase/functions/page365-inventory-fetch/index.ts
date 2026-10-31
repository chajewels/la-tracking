/**
 * page365-inventory-fetch — read the whole Page365 catalogue into a review run.
 *
 * Staff press "Fetch Page365 inventory" (Website -> Page365 stock). The browser
 * then calls this function in a loop until the run is done:
 *
 *   { action: "start", kind? }      one list read (count, then the page that
 *                                   holds the whole cumulative list), one run
 *                                   row, one queue row per product. Resumes the
 *                                   run in progress instead of starting a second.
 *                                   PR 3c: kind "quick" (default) keeps only the
 *                                   listings that can hold a Hub product for
 *                                   reading (page365_inventory_plan_quick; the
 *                                   rest are 'listed'); kind "full" ("Full
 *                                   fetch") opens every product page.
 *   { action: "continue", run_id }  claims up to CHUNK products, reads each
 *                                   detail page (<= 4 requests/s), stores the
 *                                   whitelisted fields, and — once nothing is
 *                                   left — finishes the run (match, proposal,
 *                                   Hub-only list, ready | partial).
 *   { action: "schedule" }          PR 3, SERVICE ROLE ONLY (the pg_cron job
 *                                   page365-inventory-schedule, every 5 min).
 *                                   Skips while a manual fetch is reading;
 *                                   otherwise resumes the scheduled run (a
 *                                   read still running is never overlapped),
 *                                   or starts one once the chosen interval has
 *                                   passed since the last scheduled start
 *                                   (PR 3d: 5/10/20/30 min, read from SQL via
 *                                   page365_inventory_interval_minutes), and
 *                                   reads until done or out of time.
 *                                   PR 3c: SQL (page365_inventory_next_kind)
 *                                   makes the first run after 02:00 PHT
 *                                   (03:00 JST) full, every other one quick.
 *
 * NEW PRODUCTS LAND BY THEMSELVES (2026-09-26, replaces "Create drafts"):
 * page365_inventory_finish lands every new, in-stock code of a COMPLETE read
 * as an UNPUBLISHED Catalog product (page365_inventory_land_run). A quick read
 * also opens every listing it has never read before, so a new code lands
 * within one interval. The scheduled tick then copies the landed products'
 * photos (page365_landings, copyLandedPhotos) — only after its own read, never
 * while a staff fetch is reading, <= 4 downloads/s.
 *
 * Every chunk is read under the run's LEASE (page365_inventory_lease): a staff
 * "Fetch" that joins a scheduled read, and the schedule itself, take turns —
 * one reader, <= 4 requests/s to Page365. A caller that finds the lease taken
 * is answered { busy: true } and waits.
 *
 * IT NEVER MOVES STOCK. Stock moves through
 * page365_inventory_apply (a staff tick per row) and, for a SCHEDULED run only,
 * page365_inventory_auto_apply_run — decreases and (PR 3c) increases, and only
 * while system_settings.page365_inventory_auto_apply is true (checked in SQL). Photos
 * move through page365-inventory-photos (staff) and, for LANDED products only,
 * the scheduled photo backlog below. A Page365 outage leaves a
 * 'failed' or 'partial' run that both refuse — nothing on the website changes.
 *
 * Customer reviews on the detail pages are dropped by parseProductDetail and
 * again by page365_inventory_store_product's key whitelist.
 */
import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission, type AuthContext } from "../_shared/handler.ts";
import { fetchWithRetryOnRateLimit } from "../_shared/fetch-retry.ts";
import { copyItemPhotos } from "../_shared/page365-photo-copy.ts";
import {
  STOREFRONT_ORIGIN, USER_AGENT, checkCompleteList, createRateLimiter, lastListPage,
  normalizeIntervalMinutes, parseListEnvelope, parseListExtras, parseProductDetail, scheduleDecision,
  scheduleEveryMs,
} from "../_shared/page365-inventory.ts";

/** Products per continue call: at 4 requests/s about 10 s of reading, well
 *  inside one edge invocation. */
const CHUNK = 40;
const DETAIL_TIMEOUT_MS = 8_000;
const LIST_TIMEOUT_MS = 20_000;
/** A fetching run untouched this long was abandoned (tab closed); a new start
 *  marks it failed rather than waiting on it forever. */
const ABANDONED_AFTER_MS = 10 * 60_000;
/** PR 3. A reader holds the run's lease for one chunk; one that crashed lets
 *  go by itself after this long. */
const LEASE_SECONDS = 120;
/** One scheduled invocation reads for at most this long (well inside the
 *  edge wall-clock limit), and starts no chunk in the last CHUNK_RESERVE_MS. */
const SCHEDULE_BUDGET_MS = 100_000;
const CHUNK_RESERVE_MS = 30_000;
/** 2026-09-26: the landed-photo backlog. Photos per copy call, products per
 *  query, and tries before a photo that keeps failing is given up on. */
const LAND_PHOTOS_PER_CALL = 12;
const LAND_PRODUCTS_PER_QUERY = 10;
const LAND_PHOTO_MAX_ATTEMPTS = 3;
/** 2026-10-29: names to translate (name_ja) per tick, after a Hub name followed Page365. */
const JA_NAMES_PER_TICK = 5;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function getJson(url: string, timeoutMs: number): Promise<{ ok: true; json: unknown } | { ok: false; why: string }> {
  try {
    const res = await fetchWithRetryOnRateLimit(url, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    try {
      return { ok: true, json: await res.json() };
    } catch {
      return { ok: false, why: "not JSON" };
    }
  } catch (e) {
    return { ok: false, why: (e as Error).name === "TimeoutError" ? "timed out" : (e as Error).message };
  }
}

async function progress(supabase: AuthContext["supabase"], runId: string) {
  const { data: run } = await supabase
    .from("page365_inventory_runs").select("*")
    .eq("id", runId).maybeSingle();
  const { data: rows } = await supabase
    .from("page365_inventory_products").select("status").eq("run_id", runId);
  // PR 3c: 'listed' = on the list of a quick run, page not opened — never open.
  const counts = { fetched: 0, error: 0, open: 0, listed: 0 };
  for (const r of (rows ?? []) as { status: string }[]) {
    if (r.status === "fetched") counts.fetched++;
    else if (r.status === "error") counts.error++;
    else if (r.status === "listed") counts.listed++;
    else counts.open++;
  }
  return { run, ...counts };
}

type Supabase = AuthContext["supabase"];
type Limiter = ReturnType<typeof createRateLimiter>;

/** PR 3: close a finished SCHEDULED run — auto-apply decreases (only if the
 *  switch is on; SQL decides), record the outcome once, at most one bell. */
async function closeScheduledRun(supabase: Supabase, runId: string) {
  const { data, error } = await supabase.rpc("page365_inventory_auto_apply_run", { p_run_id: runId });
  if (error) console.error("page365-inventory-fetch auto-apply:", runId, error.message);
  return data ?? null;
}

export type RunKind = "quick" | "full";

/** Begin a run (manual or scheduled): one list read, one queue row per product.
 *  Resumes the run already reading instead of starting a second. PR 3c: a
 *  quick run then keeps only the listings that can hold a Hub product. */
async function startRun(supabase: Supabase, source: "manual" | "schedule", userId: string | null, kind: RunKind):
  Promise<{ run_id: string; resumed: boolean } | { response: Response }> {
  const { data: open } = await supabase
    .from("page365_inventory_runs").select("id, source, updated_at").eq("status", "fetching").maybeSingle();
  if (open) {
    if (Date.now() - new Date(open.updated_at).getTime() < ABANDONED_AFTER_MS) {
      return { run_id: open.id, resumed: true };
    }
    await supabase.from("page365_inventory_runs")
      .update({ status: "failed", error: "abandoned mid-read; a new fetch was started", finished_at: new Date().toISOString() })
      .eq("id", open.id).eq("status", "fetching");
    if (open.source === "schedule") await closeScheduledRun(supabase, open.id);
  }

  let { data: run, error: runErr } = await supabase
    .from("page365_inventory_runs").insert({ source, started_by: userId, kind }).select("id").single();
  if (runErr && /\bkind\b/.test(runErr.message)) {
    // Before the PR 3c migration there is no kind column: read everything.
    kind = "full";
    ({ data: run, error: runErr } = await supabase
      .from("page365_inventory_runs").insert({ source, started_by: userId }).select("id").single());
  }
  if (runErr || !run) {
    return { response: jsonResponse({ error: runErr?.message ?? "Could not start a run (is another fetch running?)" }, 409) };
  }
  const fail = async (why: string) => {
    await supabase.from("page365_inventory_runs")
      .update({ status: "failed", error: why, finished_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", run.id);
    if (source === "schedule") await closeScheduledRun(supabase, run.id);
    return { response: jsonResponse({ run_id: run.id, error: `Page365 catalogue could not be read: ${why}. Nothing was changed.` }, 502) };
  };

  // The list is cumulative: page 1 gives the count, page ceil(count/16)
  // gives every product. Two requests, whatever the catalogue size.
  const first = await getJson(`${STOREFRONT_ORIGIN}/products?page=1`, LIST_TIMEOUT_MS);
  if (!first.ok) return await fail(`list page 1: ${first.why}`);
  let items;
  let listJson: unknown = first.json;
  try {
    const env1 = parseListEnvelope(first.json);
    const last = lastListPage(env1.count);
    let env = env1;
    if (last > 1) {
      const full = await getJson(`${STOREFRONT_ORIGIN}/products?page=${last}`, LIST_TIMEOUT_MS);
      if (!full.ok) return await fail(`list page ${last}: ${full.why}`);
      env = parseListEnvelope(full.json);
      listJson = full.json;
      if (env.count !== env1.count) throw new Error(`count changed during the read (${env1.count} -> ${env.count})`);
    }
    items = checkCompleteList(env);
  } catch (e) {
    return await fail((e as Error).message);
  }

  // PR 4: the list's category and description ride along (the review
  // filter and the draft's category/text). Before the PR 4 migration those
  // columns do not exist: queue without them rather than fail the read.
  const extras = parseListExtras(listJson);
  const queued = items.map(it => ({ run_id: run.id, page365_product_id: it.id, list_name: it.name }));
  let { error: qErr } = await supabase.from("page365_inventory_products").insert(
    queued.map(q => {
      const x = extras.get(q.page365_product_id);
      return { ...q, list_category_id: x?.category_id ?? null, list_category: x?.category ?? null,
               list_description: x?.description ?? null };
    }),
  );
  if (qErr && /list_(category|description)/.test(qErr.message)) {
    ({ error: qErr } = await supabase.from("page365_inventory_products").insert(queued));
  }
  if (qErr) return await fail(`could not queue products: ${qErr.message}`);
  await supabase.from("page365_inventory_runs")
    .update({ page365_count: items.length, products_total: items.length, updated_at: new Date().toISOString() })
    .eq("id", run.id);
  if (kind === "quick") {
    // The LIST drives presence; only listings that can hold a Hub product are
    // opened. If the plan cannot be made, read everything (the safe side).
    const { error: planErr } = await supabase.rpc("page365_inventory_plan_quick", { p_run_id: run.id });
    if (planErr) {
      console.error("page365-inventory-fetch plan_quick:", run.id, planErr.message);
      await supabase.from("page365_inventory_runs").update({ kind: "full" }).eq("id", run.id);
    }
  }
  return { run_id: run.id, resumed: false };
}

/** Read one chunk under the run's lease, then finish the run if nothing is
 *  left (and close it, if it is a scheduled run). */
async function readChunk(supabase: Supabase, runId: string, holder: string, limit: Limiter) {
  const { data: leased, error: leaseErr } = await supabase.rpc("page365_inventory_lease", {
    p_run_id: runId, p_holder: holder, p_seconds: LEASE_SECONDS,
  });
  if (leaseErr) throw new Error(leaseErr.message);
  if (!leased) return { busy: true as const, finished: null, claimed: 0, ...(await progress(supabase, runId)) };

  let claimedCount = 0;
  try {
    const { data: claimed, error: claimErr } = await supabase.rpc("page365_inventory_claim", {
      p_run_id: runId, p_limit: CHUNK,
    });
    if (claimErr) throw new Error(claimErr.message);
    const rows = (claimed ?? []) as { o_id: string; o_page365_product_id: number }[];
    claimedCount = rows.length;
    await Promise.all(rows.map(c =>
      limit(async () => {
        const r = await getJson(`${STOREFRONT_ORIGIN}/products/${c.o_page365_product_id}`, DETAIL_TIMEOUT_MS);
        let detail: unknown = null;
        let why: string | null = null;
        if (!r.ok) {
          why = r.why;
        } else {
          try {
            detail = parseProductDetail(r.json, Number(c.o_page365_product_id));
          } catch (e) {
            why = (e as Error).message;
          }
        }
        const { error } = await supabase.rpc("page365_inventory_store_product", {
          p_product_row_id: c.o_id, p_detail: detail, p_error: why,
        });
        if (error) console.error("page365-inventory-fetch store:", c.o_page365_product_id, error.message);
      })
    ));
  } finally {
    await supabase.rpc("page365_inventory_release", { p_run_id: runId, p_holder: holder });
  }

  let finished: unknown = null;
  const after = await progress(supabase, runId);
  if (after.run?.status === "fetching" && after.open === 0) {
    const { data, error } = await supabase.rpc("page365_inventory_finish", { p_run_id: runId });
    if (error) throw new Error(error.message);
    finished = data;
  }
  const now = await progress(supabase, runId);
  if (now.run?.source === "schedule" && now.run.status !== "fetching") {
    finished = { ...(finished as Record<string, unknown> ?? {}), auto_apply: await closeScheduledRun(supabase, runId) };
  }
  return { busy: false as const, finished, claimed: claimedCount, ...now };
}

/**
 * 2026-09-26: copy the Page365 photos of products that LANDED in the Catalog
 * by themselves (page365_landings.photos_done_at IS NULL), oldest first, until
 * the deadline. Runs only when this tick is not reading (so Page365 sees one
 * reader at <= 4 requests/s). A product is done when nothing is left to copy;
 * a photo that fails is retried on later ticks, and given up on after
 * LAND_PHOTO_MAX_ATTEMPTS ticks (photo_failures records how many).
 */
export async function copyLandedPhotos(supabase: Supabase, deadline: number) {
  const out = { products: 0, copied: 0, failed: 0, done: 0 };
  const limit = createRateLimiter(4, 3);
  const skip = new Set<string>();
  const failedThisTick = new Map<string, number>();
  const handled = new Set<string>();
  while (Date.now() < deadline) {
    const { data, error } = await supabase.from("page365_landings")
      .select("product_id, item_id, photo_attempts").is("photos_done_at", null).not("item_id", "is", null)
      .order("landed_at", { ascending: true }).limit(LAND_PRODUCTS_PER_QUERY + handled.size);
    if (error) {
      // Before the 2026-09-26 migration there is no backlog table.
      if (!/page365_landings/.test(error.message)) console.error("page365-inventory-fetch landed photos:", error.message);
      break;
    }
    const pending = ((data ?? []) as { product_id: string; item_id: string; photo_attempts: number }[])
      .filter(p => !handled.has(p.product_id)).slice(0, LAND_PRODUCTS_PER_QUERY);
    if (pending.length === 0) break;
    const r = await copyItemPhotos(supabase, pending.map(p => p.item_id), {
      skip, actor: null, maxPhotos: LAND_PHOTOS_PER_CALL, limit,
    });
    out.copied += r.copied + r.replaced;
    out.failed += r.failed.length;
    for (const f of r.failed) {
      skip.add(`${f.item_id}:${f.photo_id}`);
      failedThisTick.set(f.item_id, (failedThisTick.get(f.item_id) ?? 0) + 1);
    }
    for (const p of pending) {
      if ((r.remainingByItem.get(p.item_id) ?? 0) > 0) continue; // more next call
      handled.add(p.product_id);
      out.products++;
      const fails = failedThisTick.get(p.item_id) ?? 0;
      const attempts = p.photo_attempts + (fails > 0 ? 1 : 0);
      const done = fails === 0 || attempts >= LAND_PHOTO_MAX_ATTEMPTS;
      const { error: upErr } = await supabase.from("page365_landings")
        .update({ photo_attempts: attempts, photo_failures: fails,
                  ...(done ? { photos_done_at: new Date().toISOString() } : {}) })
        .eq("product_id", p.product_id).is("photos_done_at", null);
      if (upErr) console.error("page365-inventory-fetch landed photos:", p.product_id, upErr.message);
      else if (done) out.done++;
    }
  }
  return out;
}

/**
 * 2026-10-29: photos FOLLOW Page365 for linked products. The SQL half
 * (page365_inventory_follow_listing, finish step h) already deleted removed
 * photos and re-sorted the copied ones; this copies the ones Page365 added or
 * replaced: matched, linked items of the latest ready run with photos_to_copy
 * > 0, at most 3 tries (page365_inventory_items.photo_attempts) per read, the
 * same copier and rate limit as the landed backlog. A "Don't sync with
 * Page365" product is never in it (and copyItemPhotos skips it too).
 */
export async function copyFollowedPhotos(supabase: Supabase, deadline: number) {
  const out = { items: 0, copied: 0, failed: 0 };
  const { data: run } = await supabase.from("page365_inventory_runs").select("id")
    .eq("status", "ready").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!run) return out;
  const limit = createRateLimiter(4, 3);
  const skip = new Set<string>();
  const handled = new Set<string>();
  while (Date.now() < deadline) {
    const { data, error } = await supabase.from("page365_inventory_items")
      .select("id, photo_attempts, website_products!inner(page365_product_id, page365_sync_disabled)")
      .eq("run_id", run.id).eq("kind", "page365").eq("match_result", "matched").gt("photos_to_copy", 0)
      .lt("photo_attempts", LAND_PHOTO_MAX_ATTEMPTS)
      .not("website_products.page365_product_id", "is", null).eq("website_products.page365_sync_disabled", false)
      .order("id", { ascending: true }).limit(LAND_PRODUCTS_PER_QUERY + handled.size);
    if (error) {
      // Before the 2026-10-29 migration there is no photo_attempts column.
      if (!/photo_attempts/.test(error.message)) console.error("page365-inventory-fetch followed photos:", error.message);
      break;
    }
    const pending = ((data ?? []) as { id: string; photo_attempts: number }[])
      .filter(p => !handled.has(p.id)).slice(0, LAND_PRODUCTS_PER_QUERY);
    if (pending.length === 0) break;
    const r = await copyItemPhotos(supabase, pending.map(p => p.id), {
      runId: run.id, skip, actor: null, maxPhotos: LAND_PHOTOS_PER_CALL, limit,
    });
    out.copied += r.copied + r.replaced;
    out.failed += r.failed.length;
    const failedItems = new Map<string, number>();
    for (const f of r.failed) {
      skip.add(`${f.item_id}:${f.photo_id}`);
      failedItems.set(f.item_id, (failedItems.get(f.item_id) ?? 0) + 1);
    }
    for (const p of pending) {
      const left = r.remainingByItem.get(p.id) ?? 0;
      if (left > 0) continue; // more next call
      handled.add(p.id);
      out.items++;
      const fails = failedItems.get(p.id) ?? 0;
      const { error: upErr } = await supabase.from("page365_inventory_items")
        .update(fails > 0 ? { photo_attempts: p.photo_attempts + 1 } : { photos_to_copy: 0 }).eq("id", p.id);
      if (upErr) console.error("page365-inventory-fetch followed photos:", p.id, upErr.message);
    }
  }
  return out;
}

/**
 * 2026-10-29: a Hub name that followed Page365 had its name_ja cleared
 * (page365_listing_names.ja_pending). Translate a few per tick through
 * translate-product-description (a service-role call is allowed there), write
 * name_ja, clear ja_pending. A failure leaves it pending; the storefront shows
 * the English name meanwhile.
 */
/**
 * 2026-10-31: supabase.functions.invoke() from this service client was refused
 * 401 by translate-product-description on live (R3694, 00:42 UTC), so pending
 * names were never translated. Call it the way the Hub's working
 * function-to-function calls do (media-cutout-worker, add-installment ->
 * reconcile-account): a plain fetch with Bearer SUPABASE_SERVICE_ROLE_KEY,
 * which translate-product-description accepts via requireAuth(allowServiceRole)
 * -> isServiceRole (Bug #168). One request, 20 s, no retry.
 */
export async function translateNameAsService(name: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const res = await fetchImpl(`${Deno.env.get("SUPABASE_URL")}/functions/v1/translate-product-description`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => null) as { name_ja?: unknown; error?: unknown } | null;
  if (!res.ok) throw new Error(`translate-product-description HTTP ${res.status}${body?.error ? `: ${String(body.error)}` : ""}`);
  const ja = String(body?.name_ja ?? "").trim();
  if (!ja) throw new Error("empty translation");
  return ja;
}

export async function translatePendingNames(supabase: Supabase) {
  const out = { translated: 0, failed: 0 };
  // Reads and writes go through service-role RPCs: this function touches only
  // its own page365_* tables directly (an outage changes nothing on the website).
  const { data, error } = await supabase.rpc("page365_pending_ja_names", { p_limit: JA_NAMES_PER_TICK });
  if (error) {
    if (!/page365_pending_ja_names/.test(error.message)) console.error("page365-inventory-fetch ja names:", error.message);
    return out;
  }
  for (const row of (data ?? []) as { o_product_id: string; o_name: string }[]) {
    const name = String(row.o_name ?? "").trim();
    if (!name) continue;
    try {
      const ja = await translateNameAsService(name);
      // Written only if the English name has not moved again since (SQL checks).
      const { error: setErr } = await supabase.rpc("page365_set_name_ja", {
        p_product_id: row.o_product_id, p_expected_name: name, p_name_ja: ja,
      });
      if (setErr) throw new Error(setErr.message);
      out.translated++;
    } catch (e) {
      out.failed++;
      console.error("page365-inventory-fetch ja name:", row.o_product_id, (e as Error).message);
    }
  }
  return out;
}

/** After the landed photos: followed photos, then pending Japanese names. */
async function followBacklogs(supabase: Supabase, deadline: number) {
  const followed = await copyFollowedPhotos(supabase, deadline);
  const names = await translatePendingNames(supabase);
  return { followed, names };
}

/** PR 3: one cron tick. */
async function scheduleTick(supabase: Supabase) {
  const t0 = Date.now();

  // Close any scheduled run that ended without being closed (a staff fetch
  // finished it, or it was marked abandoned). Idempotent in SQL.
  const { data: unclosed } = await supabase
    .from("page365_inventory_runs").select("id")
    .eq("source", "schedule").neq("status", "fetching").is("auto_apply_at", null)
    .gte("created_at", new Date(Date.now() - 6 * 3600_000).toISOString());
  for (const r of (unclosed ?? []) as { id: string }[]) await closeScheduledRun(supabase, r.id);

  const { data: open } = await supabase
    .from("page365_inventory_runs").select("id, source, updated_at").eq("status", "fetching").maybeSingle();
  const { data: last } = await supabase
    .from("page365_inventory_runs").select("created_at").eq("source", "schedule")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  // PR 3d: the interval staff chose (5/10/20/30). Before the migration the
  // RPC does not exist: 30, as before.
  const { data: minutesRaw, error: minutesErr } = await supabase.rpc("page365_inventory_interval_minutes");
  if (minutesErr) console.error("page365-inventory-fetch interval:", minutesErr.message);
  const intervalMinutes = normalizeIntervalMinutes(minutesErr ? null : minutesRaw);
  const decision = scheduleDecision(open ?? null, last?.created_at ?? null, Date.now(), ABANDONED_AFTER_MS,
                                    scheduleEveryMs(intervalMinutes));
  // Never overlap a staff fetch: it is theirs to finish.
  if (decision.act === "skip") return { skipped: decision.reason, run_id: open?.id };
  if (decision.act === "wait") {
    // Nothing to read this tick: copy landed products' photos instead.
    const photos = await copyLandedPhotos(supabase, t0 + SCHEDULE_BUDGET_MS - CHUNK_RESERVE_MS);
    const follow = await followBacklogs(supabase, t0 + SCHEDULE_BUDGET_MS - CHUNK_RESERVE_MS);
    return { skipped: decision.reason, last_scheduled_at: last?.created_at, interval_minutes: intervalMinutes, photos, follow };
  }

  let runId: string;
  if (decision.act === "resume") {
    runId = open!.id;
  } else {
    const { data: kept, error: keepErr } = await supabase.rpc("page365_inventory_retention", { p_keep_days: 14 });
    if (keepErr) console.error("page365-inventory-fetch retention:", keepErr.message);
    // PR 3c: the first scheduled read after 02:00 PHT is full, the rest quick.
    const { data: nextKind, error: kindErr } = await supabase.rpc("page365_inventory_next_kind");
    if (kindErr) console.error("page365-inventory-fetch next_kind:", kindErr.message);
    const kind: RunKind = nextKind === "quick" ? "quick" : "full";
    const started = await startRun(supabase, "schedule", null, kind);
    if ("response" in started) return { started: false, retention: kept ?? null, error: await started.response.json() };
    // A fetch began between the check above and the insert: leave it be.
    if (started.resumed) return { skipped: "another_fetch_started", run_id: started.run_id };
    runId = started.run_id;
  }

  // One limiter for the whole invocation: <= 4 requests/s across chunks.
  const limit = createRateLimiter(4, 4);
  const holder = `schedule:${crypto.randomUUID()}`;
  let step: Awaited<ReturnType<typeof readChunk>> | null = null;
  while (Date.now() - t0 < SCHEDULE_BUDGET_MS - CHUNK_RESERVE_MS) {
    step = await readChunk(supabase, runId, holder, limit);
    if (step.run?.status !== "fetching") break;
    // Someone else holds the lease (a staff fetch joined), or every open
    // product is claimed by another reader: wait, then try again.
    if (step.busy || step.claimed === 0) await sleep(2_000);
  }
  // The read is over (a run still reading has used the time): the time left
  // copies landed products' photos — after the read, never alongside it.
  const photos = step?.run?.status && step.run.status !== "fetching"
    ? await copyLandedPhotos(supabase, t0 + SCHEDULE_BUDGET_MS - CHUNK_RESERVE_MS)
    : null;
  const follow = photos ? await followBacklogs(supabase, t0 + SCHEDULE_BUDGET_MS - CHUNK_RESERVE_MS) : null;
  return { run_id: runId, interval_minutes: intervalMinutes, kind: step?.run?.kind, status: step?.run?.status ?? "fetching", fetched: step?.fetched,
           open: step?.open, listed: step?.listed, finished: step?.finished ?? null, photos, follow, elapsed_ms: Date.now() - t0 };
}

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  // PR 3: the cron job calls with the Vault service key (JWT claims, Bug #168);
  // it may only run the scheduled tick. Staff keep the permission gate.
  const ctx = await requireAuth(req, { allowServiceRole: true });
  if (ctx instanceof Response) return ctx;
  const denied = await requirePermission(ctx, "manage_website_catalog");
  if (denied) return denied;
  const supabase = ctx.supabase;
  const userId = ctx.user?.id ?? null;

  try {
    const body = await req.json().catch(() => ({}));
    const action = body?.action;

    if (ctx.isService) {
      if (action !== "schedule") return jsonResponse({ error: "The service role may only run the scheduled fetch" }, 400);
      return jsonResponse(await scheduleTick(supabase));
    }
    if (action === "schedule") return jsonResponse({ error: "The scheduled fetch runs from pg_cron only" }, 403);

    if (action === "start") {
      const kind: RunKind = body?.kind === "full" ? "full" : "quick";
      const started = await startRun(supabase, "manual", userId, kind);
      if ("response" in started) return started.response;
      return jsonResponse({ ...started, ...(await progress(supabase, started.run_id)) });
    }

    if (action === "continue") {
      const runId = typeof body?.run_id === "string" ? body.run_id : "";
      if (!/^[0-9a-f-]{36}$/i.test(runId)) return jsonResponse({ error: "run_id is required" }, 400);
      const r = await readChunk(supabase, runId, `manual:${crypto.randomUUID()}`, createRateLimiter(4, 4));
      return jsonResponse({ run_id: runId, ...r });
    }

    return jsonResponse({ error: "action must be start or continue" }, 400);
  } catch (error: unknown) {
    console.error("page365-inventory-fetch error:", error);
    return jsonResponse({ error: (error as Error).message || "Internal server error" }, 500);
  }
});
