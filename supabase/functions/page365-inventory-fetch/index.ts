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
 *                                   otherwise resumes the scheduled run, or
 *                                   starts one when the last began >= 27 min
 *                                   ago, and reads until done or out of time.
 *                                   PR 3c: SQL (page365_inventory_next_kind)
 *                                   makes the first run after 02:00 PHT
 *                                   (03:00 JST) full, every other one quick.
 *   { action: "refresh", run_id, item_ids, skip? }
 *                                   PR 3c, Create drafts: re-reads the ticked
 *                                   "New in Page365" listings of a full run
 *                                   FRESH (page365_inventory_refresh_product),
 *                                   up to REFRESH_CHUNK per call, under the
 *                                   reader lease. The browser loops until
 *                                   remaining is 0, then creates the drafts.
 *
 * Every chunk is read under the run's LEASE (page365_inventory_lease): a staff
 * "Fetch" that joins a scheduled read, and the schedule itself, take turns —
 * one reader, <= 4 requests/s to Page365. A caller that finds the lease taken
 * is answered { busy: true } and waits.
 *
 * IT NEVER MOVES STOCK AND NEVER COPIES A PHOTO ITSELF. Stock moves through
 * page365_inventory_apply (a staff tick per row) and, for a SCHEDULED run only,
 * page365_inventory_auto_apply_run — decreases and (PR 3c) increases, and only
 * while system_settings.page365_inventory_auto_apply is true (checked in SQL). Photos
 * move only through page365-inventory-photos. A Page365 outage leaves a
 * 'failed' or 'partial' run that both refuse — nothing on the website changes.
 *
 * Customer reviews on the detail pages are dropped by parseProductDetail and
 * again by page365_inventory_store_product's key whitelist.
 */
import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission, type AuthContext } from "../_shared/handler.ts";
import { fetchWithRetryOnRateLimit } from "../_shared/fetch-retry.ts";
import {
  STOREFRONT_ORIGIN, USER_AGENT, checkCompleteList, createRateLimiter, lastListPage,
  parseListEnvelope, parseListExtras, parseProductDetail, scheduleDecision,
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
/** A scheduled read begins every 30 minutes; the 5-minute ticks in between
 *  only finish it. 27 leaves room for cron jitter. */
const SCHEDULE_EVERY_MS = 27 * 60_000;
/** One scheduled invocation reads for at most this long (well inside the
 *  edge wall-clock limit), and starts no chunk in the last CHUNK_RESERVE_MS. */
const SCHEDULE_BUDGET_MS = 100_000;
const CHUNK_RESERVE_MS = 30_000;
/** PR 3c, Create drafts: listings re-read per "refresh" call (~10 s at 4/s),
 *  and how recent a read must be to count as fresh here (SQL insists on 15 min). */
const REFRESH_CHUNK = 40;
const REFRESH_FRESH_MS = 5 * 60_000;
const REFRESH_LEASE_SECONDS = 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

/** PR 3c: a Create-drafts refresh holds the reader lease — one reader at a time. */
async function refreshHoldsReader(supabase: Supabase): Promise<boolean> {
  const { data, error } = await supabase
    .from("page365_inventory_reader").select("lease_holder, lease_until").maybeSingle();
  if (error) return false; // before the PR 3c migration: no such lease
  return !!data?.lease_holder && !!data.lease_until && new Date(data.lease_until).getTime() > Date.now();
}

/** Read one chunk under the run's lease, then finish the run if nothing is
 *  left (and close it, if it is a scheduled run). */
async function readChunk(supabase: Supabase, runId: string, holder: string, limit: Limiter) {
  const { data: leased, error: leaseErr } = await supabase.rpc("page365_inventory_lease", {
    p_run_id: runId, p_holder: holder, p_seconds: LEASE_SECONDS,
  });
  if (leaseErr) throw new Error(leaseErr.message);
  if (!leased) return { busy: true as const, finished: null, claimed: 0, ...(await progress(supabase, runId)) };
  // Checked AFTER taking the run lease (the refresh checks run leases before
  // taking its own), so the two can never both read.
  if (await refreshHoldsReader(supabase)) {
    await supabase.rpc("page365_inventory_release", { p_run_id: runId, p_holder: holder });
    return { busy: true as const, finished: null, claimed: 0, ...(await progress(supabase, runId)) };
  }

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
  const decision = scheduleDecision(open ?? null, last?.created_at ?? null, Date.now(), ABANDONED_AFTER_MS, SCHEDULE_EVERY_MS);
  // Never overlap a staff fetch: it is theirs to finish.
  if (decision.act === "skip") return { skipped: decision.reason, run_id: open?.id };
  if (decision.act === "wait") return { skipped: decision.reason, last_scheduled_at: last?.created_at };

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
  return { run_id: runId, kind: step?.run?.kind, status: step?.run?.status ?? "fetching", fetched: step?.fetched,
           open: step?.open, listed: step?.listed, finished: step?.finished ?? null, elapsed_ms: Date.now() - t0 };
}

/** PR 3c: Create drafts re-reads its ticked listings fresh. Returns what is
 *  left; the browser calls again until remaining is 0. */
async function refreshForDrafts(supabase: Supabase, runId: string, itemIds: string[], skip: Set<string>) {
  // The ticked NEW rows -> their listings (chunked .in: no URL-length risk).
  const productIds = new Set<string>();
  for (let i = 0; i < itemIds.length; i += 100) {
    const { data, error } = await supabase.from("page365_inventory_items").select("inventory_product_id")
      .eq("run_id", runId).eq("kind", "page365").eq("category", "new").in("id", itemIds.slice(i, i + 100));
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as { inventory_product_id: string | null }[]) {
      if (r.inventory_product_id && !skip.has(r.inventory_product_id)) productIds.add(r.inventory_product_id);
    }
  }
  const stale: { id: string; page365_product_id: number }[] = [];
  const ids = [...productIds];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase.from("page365_inventory_products")
      .select("id, page365_product_id, fetched_at").in("id", ids.slice(i, i + 100));
    if (error) throw new Error(error.message);
    for (const p of (data ?? []) as { id: string; page365_product_id: number; fetched_at: string | null }[]) {
      if (!p.fetched_at || Date.now() - new Date(p.fetched_at).getTime() > REFRESH_FRESH_MS) stale.push(p);
    }
  }
  if (stale.length === 0) return { busy: false, refreshed: 0, gone: 0, failed: [], remaining: 0 };

  const holder = `refresh:${crypto.randomUUID()}`;
  const { data: leased, error: leaseErr } = await supabase.rpc("page365_inventory_reader_lease", {
    p_holder: holder, p_seconds: REFRESH_LEASE_SECONDS,
  });
  if (leaseErr) throw new Error(leaseErr.message);
  // A run is being read right now (or another refresh): wait for it.
  if (!leased) return { busy: true, refreshed: 0, gone: 0, failed: [], remaining: stale.length };

  const batch = stale.slice(0, REFRESH_CHUNK);
  const limit = createRateLimiter(4, 4);
  let refreshed = 0;
  let gone = 0;
  const failed: { product_row_id: string; page365_product_id: number; reason: string }[] = [];
  try {
    await Promise.all(batch.map(p => limit(async () => {
      const r = await getJson(`${STOREFRONT_ORIGIN}/products/${p.page365_product_id}`, DETAIL_TIMEOUT_MS);
      let detail: unknown = null;
      let why: string | null = null;
      if (!r.ok) {
        why = r.why === "HTTP 404" ? "gone" : r.why;
      } else {
        try {
          detail = parseProductDetail(r.json, Number(p.page365_product_id));
        } catch (e) {
          why = (e as Error).message;
        }
      }
      const { data, error } = await supabase.rpc("page365_inventory_refresh_product", {
        p_product_row_id: p.id, p_detail: detail, p_error: why,
      });
      const result = (data as { result?: string; error?: string } | null)?.result;
      if (error || !result) {
        failed.push({ product_row_id: p.id, page365_product_id: p.page365_product_id, reason: error?.message ?? "no answer" });
      } else if (result === "refreshed") {
        refreshed++;
      } else if (result === "gone") {
        gone++;
      } else {
        failed.push({ product_row_id: p.id, page365_product_id: p.page365_product_id,
                      reason: (data as { error?: string }).error ?? result });
      }
    })));
  } finally {
    await supabase.rpc("page365_inventory_reader_release", { p_holder: holder });
  }
  return { busy: false, refreshed, gone, failed, remaining: stale.length - batch.length };
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

    if (action === "refresh") {
      const runId = typeof body?.run_id === "string" && UUID_RE.test(body.run_id) ? body.run_id : null;
      const itemIds: string[] = Array.isArray(body?.item_ids)
        ? (body.item_ids as unknown[]).filter((x): x is string => typeof x === "string" && UUID_RE.test(x))
        : [];
      const skip = new Set<string>(Array.isArray(body?.skip)
        ? (body.skip as unknown[]).filter((x): x is string => typeof x === "string" && UUID_RE.test(x)) : []);
      if (!runId || itemIds.length === 0) return jsonResponse({ error: "run_id and item_ids are required" }, 400);
      if (itemIds.length > 700) return jsonResponse({ error: "Too many rows at once (700 max)" }, 400);
      return jsonResponse({ run_id: runId, ...(await refreshForDrafts(supabase, runId, itemIds, skip)) });
    }

    return jsonResponse({ error: "action must be start, continue or refresh" }, 400);
  } catch (error: unknown) {
    console.error("page365-inventory-fetch error:", error);
    return jsonResponse({ error: (error as Error).message || "Internal server error" }, 500);
  }
});
