// media-cutout-worker — automatic background removal for website product
// photos (docs/MEDIA-CUTOUTS.md). PR 1 of 3.
//
// pg_cron 'media-cutout-worker' every minute (Vault service key; migration
// 20261006100000_media_cutouts.sql, cadence 20261007100000_media_cutout_photoroom.sql). Callers: the cron
// (service role, action "tick"), staff with manage_website_catalog ("Run now"
// on Website → Photos, action "tick"), and ITSELF (service role, action
// "process", one job per invocation).
//
// THE SWITCH (system_settings.media_cutout_mode) FAILS TO OFF: anything but
// "test" / "on" and the tick returns at once — no provider call, no download,
// nothing written. "test" submits only photos in a named test batch.
//
// A tick, under one lease (media_cutout_lease — ticks never overlap):
//   1. housekeeping  a photo no product uses any more is kept 30 days, then
//                    its derived files are removed here
//   2. poll          jobs at a QUEUE provider (fal / Replicate; GET status;
//                    never billed)
//   3. submit        up to TICK.submit queued photos, mains of active products
//                    first, never past the monthly cap
//                    (media_cutout_submit_batch). The provider is the one
//                    system_settings.media_cutout_provider names (Photoroom
//                    by default). Photoroom answers with the cut-out at once:
//                    it is stored under derived/ and the job is READY in the
//                    same tick (media_cutout_sync_result).
//   4. process       each ready job in ITS OWN invocation of this function,
//                    so each gets the full 2 s CPU (decode → checks → cut-out
//                    → ivory → WebP; cutout-pipeline.ts), TICK.processParallel
//                    at a time. A job whose invocation was killed is retried
//                    as cut-out only (D10 path B); a second kill fails it.
// Every decision about WHICH row and WHETHER is SQL; this function moves bytes.
//
// It never touches an original photo, never blocks anything else: the only
// synchronous cost anywhere is the enqueue trigger's one-row insert.
//
// SECRETS: PHOTOROOM_API_KEY (and, only if selected, FAL_KEY or
// REPLICATE_API_TOKEN + REPLICATE_BIREFNET_VERSION) are edge secrets. Never
// logged, never stored.

import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { type AuthContext, requireAuth, requirePermission } from "../_shared/handler.ts";
import { sniff } from "../_shared/cutout-codecs.ts";
import { CUTOUT_SIZES_PATH_A, runPipeline } from "../_shared/cutout-pipeline.ts";
import {
  falProvider, pickProvider, PROVIDER_SECRET, PROVIDER_TIMEOUT_MS, ProviderError, type QueueProvider, readProviderSetting,
  replicateProvider, type SyncProvider,
} from "../_shared/cutout-provider.ts";
import { BUCKET, derivedPaths, isOwnDerivedUrl, readCutoutMode, storagePathOf, syncResultPath, TICK } from "../_shared/media-cutout-rules.ts";

type AnyRec = Record<string, unknown>;
type Client = AuthContext["supabase"];

const MAX_ORIGINAL_BYTES = 15 * 1024 * 1024;
const MAX_RESULT_BYTES = 40 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const PROCESS_CALL_TIMEOUT_MS = 60_000;

const env = (k: string) => Deno.env.get(k);

async function download(url: string, max: number): Promise<Uint8Array> {
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new ProviderError(`download ${res.status}`, res.status, res.status >= 500 || res.status === 429);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > max) throw new ProviderError(`download too large (${bytes.length} bytes)`, 413, false);
  return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Queue providers, for polling jobs already at them (polling is never billed). */
function providersByName(): Record<string, QueueProvider> {
  const out: Record<string, QueueProvider> = {};
  const fal = env("FAL_KEY")?.trim();
  if (fal) out.fal = falProvider(fal);
  const tok = env("REPLICATE_API_TOKEN")?.trim(), ver = env("REPLICATE_BIREFNET_VERSION")?.trim();
  if (tok && ver) out.replicate = replicateProvider(tok, ver);
  return out;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const retryable = (e: unknown) => (e instanceof ProviderError ? e.retryable : true);

/** Run `fn` over `items`, at most `n` at a time; results in order. */
async function inParallel<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

const contentTypeOf = (bytes: Uint8Array) => {
  const k = sniff(bytes);
  return k === "png" ? "image/png" : k === "webp" ? "image/webp" : "image/jpeg";
};

// ---------------------------------------------------------------------------
// One photo through a SYNC provider (Photoroom): original → provider → the
// cut-out stored under derived/ → ready. Runs inside the tick; the CPU here is
// a hash and a multipart copy — the pixel work stays in its own invocation.
// ---------------------------------------------------------------------------
async function submitSync(supabase: Client, provider: SyncProvider, row: AnyRec): Promise<"ready" | ProviderError | Error> {
  const url = String(row.source_url);
  try {
    const original = await download(url, MAX_ORIGINAL_BYTES);
    const result = await provider.remove(original, { highDetail: row.high_detail === true, contentType: contentTypeOf(original) });
    const requestId = crypto.randomUUID();
    const path = syncResultPath(await sha256Hex(original), provider.name, requestId);
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, result.bytes, { contentType: "image/png", upsert: false });
    if (upErr) throw new ProviderError(`storage upload: ${upErr.message ?? upErr}`, 503, true);
    const resultUrl = supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
    const { error } = await supabase.rpc("media_cutout_sync_result", {
      p_source_url: url, p_provider: provider.name, p_model: result.model, p_request_id: requestId,
      p_result_url: resultUrl, p_uncertainty: result.uncertainty,
    });
    if (error) throw error;
    return "ready";
  } catch (e) {
    await supabase.rpc("media_cutout_error", { p_source_url: url, p_stage: "submit", p_error: errText(e), p_retryable: retryable(e) });
    return e instanceof Error ? e : new Error(String(e));
  }
}

// ---------------------------------------------------------------------------
// One job (self-invoked, service role only).
// ---------------------------------------------------------------------------
async function processOne(supabase: Client, sourceUrl: string): Promise<AnyRec> {
  const { data: claim, error: claimErr } = await supabase.rpc("media_cutout_claim_process", { p_source_url: sourceUrl });
  if (claimErr) throw claimErr;
  if (!claim) return { source_url: sourceUrl, outcome: "not_ready" };
  const c = claim as AnyRec;
  const own = typeof c.own_cutout_url === "string" && c.own_cutout_url !== "";
  // A sync provider's result is already stored under derived/ — it IS the
  // master; never upload it twice.
  const storedMaster = !own && isOwnDerivedUrl(String(c.result_url)) ? storagePathOf(String(c.result_url)) : null;
  // Photoroom's x-uncertainty-score, stored by media_cutout_sync_result. Only
  // trusted when this result came from a sync call (a later fal run would
  // not overwrite it).
  const { data: extra } = await supabase.from("website_media_cutouts")
    .select("provider, provider_uncertainty").eq("source_url", sourceUrl).maybeSingle();
  const doubt = storedMaster && (extra as AnyRec | null)?.provider === "photoroom"
    ? (extra as AnyRec).provider_uncertainty : null;

  try {
    const t0 = performance.now();
    const [result, original] = await Promise.all([
      download(String(c.result_url), MAX_RESULT_BYTES),
      download(sourceUrl, MAX_ORIGINAL_BYTES),
    ]);
    const downloadMs = Math.round(performance.now() - t0);
    const sha = await sha256Hex(original);

    const out = await runPipeline(result, original, {
      allowPairs: c.allow_pairs === true,
      output: c.cpu_fallback === true ? "cutout_only" : "baked",
      sizes: CUTOUT_SIZES_PATH_A,
      providerUncertainty: doubt == null ? null : Number(doubt),
    });

    const paths = derivedPaths(sha, Number(c.run));
    const t1 = performance.now();
    const store = async (path: string, bytes: Uint8Array, type: string) => {
      const { error } = await supabase.storage.from(BUCKET).upload(path, bytes, { contentType: type, upsert: false });
      if (error) throw new ProviderError(`storage upload: ${error.message ?? error}`, 503, true);
      return path;
    };
    const kind = sniff(result);
    const master = own ? null : storedMaster ?? await store(paths.master.replace(/\.png$/, kind === "webp" ? ".webp" : ".png"), result,
                                            kind === "webp" ? "image/webp" : "image/png");
    const cutoutPath = out.cutout ? await store(paths.cutout, out.cutout.bytes, "image/webp") : null;
    const catalogPath = out.catalog ? await store(paths.catalog, out.catalog.bytes, "image/webp") : null;
    const smallPath = out.catalogSmall ? await store(paths.catalogSmall, out.catalogSmall.bytes, "image/webp") : null;
    const uploadMs = Math.round(performance.now() - t1);

    let status: string = out.qa.status;
    const flags = [...out.qa.flags];
    if (!out.cutout) {
      status = "needs_review";
      flags.push("coverage:0.000");
    }
    if (own) {
      // Staff's own cut-out lands approved — unless it has no transparency.
      const opaque = out.qa.coverage > 0.97;
      if (opaque) flags.push("own_cutout_opaque");
      status = opaque || !out.cutout ? "needs_review" : "approved";
    }

    const payload = {
      status, flags, edges: out.qa.edges, coverage: Number(out.qa.coverage.toFixed(4)),
      detail_kept: out.qa.detailKept === null ? null : Number(out.qa.detailKept.toFixed(4)),
      hero_usable: status !== "needs_review" && out.qa.heroUsable,
      source_sha256: sha, source_w: out.sourceWidth, source_h: out.sourceHeight,
      output_kind: out.catalog ? "baked" : "cutout_only",
      master_path: master,
      cutout_path: cutoutPath, cutout_w: out.cutout?.width ?? null, cutout_h: out.cutout?.height ?? null,
      catalog_path: catalogPath, catalog_w: out.catalog?.width ?? null, catalog_h: out.catalog?.height ?? null,
      catalog_small_path: smallPath, catalog_small_w: out.catalogSmall?.width ?? null, catalog_small_h: out.catalogSmall?.height ?? null,
      timings: { ...out.timingsMs, download_ms: downloadMs, upload_ms: uploadMs, cpu_fallback: c.cpu_fallback === true },
    };
    const { data: fin, error: finErr } = await supabase.rpc("media_cutout_finish", { p_source_url: sourceUrl, p_result: payload });
    if (finErr) throw finErr;
    return { source_url: sourceUrl, outcome: fin, status, flags, total_ms: out.timingsMs.total };
  } catch (e) {
    const { data } = await supabase.rpc("media_cutout_error", {
      p_source_url: sourceUrl, p_stage: "process", p_error: errText(e), p_retryable: retryable(e),
    });
    return { source_url: sourceUrl, outcome: `error_${data ?? "unrecorded"}`, error: errText(e) };
  }
}

// ---------------------------------------------------------------------------
// The tick.
// ---------------------------------------------------------------------------
async function tick(supabase: Client): Promise<AnyRec> {
  const started = Date.now();
  const inBudget = () => Date.now() - started < TICK.budgetMs;

  const { data: modeRow, error: modeErr } = await supabase
    .from("system_settings").select("value").eq("key", "media_cutout_mode").maybeSingle();
  const mode = modeErr ? "off" : readCutoutMode((modeRow as AnyRec | null)?.value);
  if (mode === "off") return { ok: true, mode, note: modeErr ? "switch unreadable — treated as off" : undefined };

  const holder = crypto.randomUUID();
  const { data: leased, error: leaseErr } = await supabase.rpc("media_cutout_lease", { p_holder: holder, p_seconds: TICK.leaseSeconds });
  if (leaseErr) throw leaseErr;
  if (!leased) return { ok: true, mode, skipped: "another tick is running" };

  const { data: provRow } = await supabase
    .from("system_settings").select("value").eq("key", "media_cutout_provider").maybeSingle();
  const providerName = readProviderSetting(((provRow as AnyRec | null)?.value as unknown) ?? "photoroom");

  const summary: AnyRec = { mode, provider: providerName, removed: 0, polled: 0, ready: 0, processed: [] as AnyRec[], submitted: 0, errors: 0 };
  try {
    // 1. Housekeeping.
    const { data: due } = await supabase.rpc("media_cutout_housekeeping", { p_limit: TICK.housekeeping });
    for (const d of (due ?? []) as AnyRec[]) {
      const paths = (d.paths as string[] | null) ?? [];
      if (paths.length) {
        const { error } = await supabase.storage.from(BUCKET).remove(paths);
        if (error) { summary.errors = Number(summary.errors) + 1; continue; }
      }
      await supabase.rpc("media_cutout_forget", { p_source_url: d.source_url });
      summary.removed = Number(summary.removed) + 1;
    }

    // 2. Poll.
    const providers = providersByName();
    const { data: polling } = await supabase.rpc("media_cutout_poll_batch", { p_limit: TICK.poll });
    for (const j of (polling ?? []) as AnyRec[]) {
      if (!inBudget()) break;
      const url = String(j.source_url);
      const p = providers[String(j.provider)];
      if (!p) {
        await supabase.rpc("media_cutout_error", { p_source_url: url, p_stage: "poll", p_error: `provider ${j.provider} not configured`, p_retryable: false });
        summary.errors = Number(summary.errors) + 1;
        continue;
      }
      if (j.submitted_at && Date.now() - Date.parse(String(j.submitted_at)) > PROVIDER_TIMEOUT_MS) {
        await supabase.rpc("media_cutout_error", { p_source_url: url, p_stage: "submit", p_error: "provider timeout (30 min)", p_retryable: true });
        summary.errors = Number(summary.errors) + 1;
        continue;
      }
      summary.polled = Number(summary.polled) + 1;
      const r = await p.poll({ requestId: String(j.request_id), statusUrl: String(j.status_url), responseUrl: String(j.response_url) })
        .catch((e) => ({ state: "error" as const, error: errText(e), retryable: true }));
      if (r.state === "done") {
        await supabase.rpc("media_cutout_result_ready", { p_source_url: url, p_result_url: r.resultUrl });
        summary.ready = Number(summary.ready) + 1;
      } else if (r.state === "error") {
        // Stays at the poll step: a status hiccup never re-buys the job.
        await supabase.rpc("media_cutout_error", { p_source_url: url, p_stage: "poll", p_error: r.error, p_retryable: r.retryable });
        summary.errors = Number(summary.errors) + 1;
      }
    }

    // 3. Submit — obeys the switch and the monthly cap (SQL).
    const provider = pickProvider(env, providerName);
    if (!provider) {
      summary.note = `no provider configured (${PROVIDER_SECRET[providerName]} not set for ${providerName}) — nothing submitted`;
    } else if (inBudget()) {
      const { data: batch, error: batchErr } = await supabase.rpc("media_cutout_submit_batch", { p_limit: TICK.submit });
      if (batchErr) throw batchErr;
      summary.cap_left = (batch as AnyRec | null)?.cap_left ?? null;
      const rows = ((batch as AnyRec | null)?.rows ?? []) as AnyRec[];
      if (provider.kind === "sync") {
        // A few at a time (Photoroom allows 60 a minute). An ACCOUNT problem
        // (429 / 402 / key) stops the rest; the rows not reached keep their
        // place in the queue (next_attempt_at +10 min from the batch).
        let halted = false;
        await inParallel(rows, TICK.submitParallel, async (row) => {
          if (halted || !inBudget()) return;
          const r = await submitSync(supabase, provider, row);
          if (r === "ready") summary.submitted = Number(summary.submitted) + 1;
          else {
            summary.errors = Number(summary.errors) + 1;
            if (r instanceof ProviderError && r.haltTick) { halted = true; summary.note = `provider refused (${r.status}) — backing off`; }
          }
        });
      } else {
        for (const row of rows) {
          const url = String(row.source_url);
          try {
            const job = await provider.submit(url, { highDetail: row.high_detail === true });
            await supabase.rpc("media_cutout_submitted", {
              p_source_url: url, p_provider: job.provider, p_model: job.model, p_request_id: job.requestId,
              p_status_url: job.statusUrl, p_response_url: job.responseUrl,
            });
            summary.submitted = Number(summary.submitted) + 1;
          } catch (e) {
            await supabase.rpc("media_cutout_error", { p_source_url: url, p_stage: "submit", p_error: errText(e), p_retryable: retryable(e) });
            summary.errors = Number(summary.errors) + 1;
            if (e instanceof ProviderError && e.status === 429) { summary.note = "provider rate limit — backing off"; break; }
          }
        }
      }
    }

    // 4. Process — each job in its own invocation (its own 2 s of CPU),
    //    TICK.processParallel at a time. Runs after submit so a Photoroom
    //    result is processed in the tick that bought it.
    const { data: ready } = await supabase.rpc("media_cutout_process_batch", { p_limit: TICK.process });
    await inParallel((ready ?? []) as string[], TICK.processParallel, async (url) => {
      if (!inBudget()) return;
      const res = await fetch(`${env("SUPABASE_URL")}/functions/v1/media-cutout-worker`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env("SUPABASE_SERVICE_ROLE_KEY")}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "process", source_url: url }),
        signal: AbortSignal.timeout(PROCESS_CALL_TIMEOUT_MS),
      }).catch((e) => new Response(JSON.stringify({ error: errText(e) }), { status: 599 }));
      const body = await res.json().catch(() => ({})) as AnyRec;
      // A killed invocation (CPU limit) answers 5xx or not at all; the row is
      // still 'processing' and media_cutout_process_batch reroutes it later.
      (summary.processed as AnyRec[]).push({ source_url: url, http: res.status, ...(body.result as AnyRec ?? { error: body.error }) });
    });
  } finally {
    summary.ms = Date.now() - started;
    await supabase.rpc("media_cutout_release", { p_holder: holder, p_summary: summary });
  }
  return { ok: true, ...summary };
}

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;

  const ctx = await requireAuth(req, { allowServiceRole: true });
  if (ctx instanceof Response) return ctx;
  const denied = await requirePermission(ctx, "manage_website_catalog");
  if (denied) return denied;
  const { supabase } = ctx;

  let body: AnyRec = {};
  try { body = await req.json(); } catch { /* empty body = tick */ }
  const action = String(body.action ?? "tick");

  try {
    if (action === "process") {
      // One job per invocation, and only from the worker itself.
      if (!ctx.isService) return jsonResponse({ error: "Access denied" }, 403);
      const url = typeof body.source_url === "string" ? body.source_url : "";
      if (!url) return jsonResponse({ error: "source_url_required" }, 400);
      const result = await processOne(supabase, url);
      console.log(JSON.stringify({ media_cutout_process: result }));
      return jsonResponse({ ok: true, result });
    }
    if (action !== "tick") return jsonResponse({ error: "unknown_action" }, 400);
    const summary = await tick(supabase);
    console.log(JSON.stringify({ media_cutout_tick: summary }));
    return jsonResponse(summary);
  } catch (err) {
    console.error("[media-cutout-worker] failed:", errText(err));
    return jsonResponse({ error: errText(err) }, 500);
  }
});
