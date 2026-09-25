/**
 * page365-inventory-fetch — read the whole Page365 catalogue into a review run.
 *
 * Staff press "Fetch Page365 inventory" (Website -> Page365 stock). The browser
 * then calls this function in a loop until the run is done:
 *
 *   { action: "start" }             one list read (count, then the page that
 *                                   holds the whole cumulative list), one run
 *                                   row, one queue row per product. Resumes the
 *                                   run in progress instead of starting a second.
 *   { action: "continue", run_id }  claims up to CHUNK products, reads each
 *                                   detail page (<= 4 requests/s), stores the
 *                                   whitelisted fields, and — once nothing is
 *                                   left — finishes the run (match, proposal,
 *                                   Hub-only list, ready | partial).
 *
 * IT NEVER MOVES STOCK AND NEVER COPIES A PHOTO. It writes only its own run
 * tables. Stock moves only through page365_inventory_apply (a staff tick per
 * row); photos only through page365-inventory-photos. A Page365 outage leaves a
 * 'failed' or 'partial' run that apply refuses — nothing on the website changes.
 *
 * Customer reviews on the detail pages are dropped by parseProductDetail and
 * again by page365_inventory_store_product's key whitelist.
 */
import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission, type AuthContext } from "../_shared/handler.ts";
import { fetchWithRetryOnRateLimit } from "../_shared/fetch-retry.ts";
import {
  STOREFRONT_ORIGIN, USER_AGENT, checkCompleteList, createRateLimiter, lastListPage,
  parseListEnvelope, parseListExtras, parseProductDetail,
} from "../_shared/page365-inventory.ts";

/** Products per continue call: at 4 requests/s about 10 s of reading, well
 *  inside one edge invocation. */
const CHUNK = 40;
const DETAIL_TIMEOUT_MS = 8_000;
const LIST_TIMEOUT_MS = 20_000;
/** A fetching run untouched this long was abandoned (tab closed); a new start
 *  marks it failed rather than waiting on it forever. */
const ABANDONED_AFTER_MS = 10 * 60_000;

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
    .from("page365_inventory_runs").select("id, status, page365_count, products_total, error, created_at, finished_at")
    .eq("id", runId).maybeSingle();
  const { data: rows } = await supabase
    .from("page365_inventory_products").select("status").eq("run_id", runId);
  const counts = { fetched: 0, error: 0, open: 0 };
  for (const r of (rows ?? []) as { status: string }[]) {
    if (r.status === "fetched") counts.fetched++;
    else if (r.status === "error") counts.error++;
    else counts.open++;
  }
  return { run, ...counts };
}

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
    const action = body?.action;

    if (action === "start") {
      // Resume, never double-read: one fetching run at a time (also a unique
      // index). An abandoned one is closed so a new read can begin.
      const { data: open } = await supabase
        .from("page365_inventory_runs").select("id, updated_at").eq("status", "fetching").maybeSingle();
      if (open) {
        if (Date.now() - new Date(open.updated_at).getTime() < ABANDONED_AFTER_MS) {
          return jsonResponse({ run_id: open.id, resumed: true, ...(await progress(supabase, open.id)) });
        }
        await supabase.from("page365_inventory_runs")
          .update({ status: "failed", error: "abandoned mid-read; a new fetch was started", finished_at: new Date().toISOString() })
          .eq("id", open.id).eq("status", "fetching");
      }

      const { data: run, error: runErr } = await supabase
        .from("page365_inventory_runs").insert({ source: "manual", started_by: userId }).select("id").single();
      if (runErr || !run) {
        return jsonResponse({ error: runErr?.message ?? "Could not start a run (is another fetch running?)" }, 409);
      }
      const fail = async (why: string) => {
        await supabase.from("page365_inventory_runs")
          .update({ status: "failed", error: why, finished_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq("id", run.id);
        return jsonResponse({ run_id: run.id, error: `Page365 catalogue could not be read: ${why}. Nothing was changed.` }, 502);
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
      return jsonResponse({ run_id: run.id, resumed: false, ...(await progress(supabase, run.id)) });
    }

    if (action === "continue") {
      const runId = typeof body?.run_id === "string" ? body.run_id : "";
      if (!/^[0-9a-f-]{36}$/i.test(runId)) return jsonResponse({ error: "run_id is required" }, 400);

      const { data: claimed, error: claimErr } = await supabase.rpc("page365_inventory_claim", {
        p_run_id: runId, p_limit: CHUNK,
      });
      if (claimErr) return jsonResponse({ error: claimErr.message }, 500);

      const limit = createRateLimiter(4, 4);
      await Promise.all(((claimed ?? []) as { o_id: string; o_page365_product_id: number }[]).map(c =>
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

      let finished: unknown = null;
      const after = await progress(supabase, runId);
      if (after.run?.status === "fetching" && after.open === 0) {
        const { data, error } = await supabase.rpc("page365_inventory_finish", { p_run_id: runId });
        if (error) return jsonResponse({ error: error.message }, 500);
        finished = data;
      }
      return jsonResponse({ run_id: runId, finished, ...(await progress(supabase, runId)) });
    }

    return jsonResponse({ error: "action must be start or continue" }, 400);
  } catch (error: unknown) {
    console.error("page365-inventory-fetch error:", error);
    return jsonResponse({ error: (error as Error).message || "Internal server error" }, 500);
  }
});
