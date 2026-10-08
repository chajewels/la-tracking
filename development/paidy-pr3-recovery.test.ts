/**
 * Paidy reassessment PR 3 — recovery (PA05 / PA09 / PA04 / PA10), owner go
 * 2026-10-08 17:39 JST. Plan: claude/paidy-pr3-recovery-plan-2026-10-08.md.
 *
 *   PA05  releasePaidyAuthorization says what PAIDY established — released /
 *         captured / pending / unknown — never "released" on a 2xx; a failed
 *         release of an unfiled payment is retried by the sweep.
 *   PA09  inbox bookkeeping failures are counted; events are claimed (lease);
 *         duplicates are completed only after the first event is done.
 *   PA04  the window expiry guard is order-correlated; a window that knows
 *         its payment id is verified with Paidy first; the launch carries the
 *         attempt id; the storefront's rejected/closed callback hands the id over.
 *   PA10  other-environment and unknown-id events are PARKED and never dropped;
 *         an unknown id is closed only after BOTH keys answered 404; unrecorded
 *         captures are watched whatever their age.
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { releasePaidyAuthorization } from "../supabase/functions/_shared/paidy-filing.ts";
import { processPaidyEvent } from "../supabase/functions/_shared/paidy-events.ts";
import type { PaidyPayment } from "../supabase/functions/_shared/paidy.ts";

type Row = Record<string, unknown>;
const read = (p: string) => Deno.readTextFile(new URL(p, import.meta.url));

/** A minimal PostgREST-shaped fake: tables as arrays, rpc calls recorded. */
function fakeDb(tables: Record<string, Row[]>, opts: { failUpdate?: Set<string>; rpc?: Record<string, (args: Row) => unknown> } = {}) {
  const rpcCalls: { fn: string; args: Row }[] = [];
  const db = {
    rpcCalls,
    rpc(fn: string, args: Row) {
      rpcCalls.push({ fn, args });
      const h = opts.rpc?.[fn];
      return Promise.resolve({ data: h ? h(args) : { ok: true, new: true, case_id: `case_${rpcCalls.length}` }, error: null });
    },
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      let op = "select"; let payload: Row | null = null;
      const b: Record<string, unknown> = {};
      const rows = () => (tables[table] ??= []);
      const run = () => {
        if (op === "insert") { rows().push(payload!); return { data: [payload], error: null }; }
        const hit = rows().filter((r) => filters.every((f) => f(r)));
        if (op === "update") {
          if (opts.failUpdate?.has(table)) return { data: null, error: { message: `update of ${table} refused (test)` } };
          hit.forEach((r) => Object.assign(r, payload));
        }
        return { data: hit, error: null, count: hit.length };
      };
      Object.assign(b, {
        select: () => b,
        insert: (p: Row) => { op = "insert"; payload = p; return b; },
        update: (p: Row) => { op = "update"; payload = p; return b; },
        eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; },
        neq: (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return b; },
        is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return b; },
        in: (c: string, v: unknown[]) => { filters.push((r) => v.includes(r[c])); return b; },
        not: () => b, or: () => b, gte: () => b, lte: () => b, order: () => b, limit: () => b, contains: () => b,
        maybeSingle: () => Promise.resolve({ data: run().data?.[0] ?? null, error: run().error }),
        then: (res: (v: unknown) => unknown) => Promise.resolve(run()).then(res),
      });
      return b;
    },
  };
  return db;
}

const AUTH: PaidyPayment = { id: "pay_unit0001", status: "AUTHORIZED", amount: 20000, currency: "JPY", test: true, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 864e5).toISOString(), captures: [], refunds: [] } as unknown as PaidyPayment;
const answer = (over: Row) => ({ ...AUTH, ...over });

/** Stubs fetch for the Paidy client: a queue of answers (status + body or a thrown error). */
function stubPaidy(answers: ({ status?: number; body: unknown } | { throw: Error })[]) {
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(url).replace("https://api.paidy.com", "")}`);
    const a = answers.shift();
    if (!a) throw new Error("no stubbed Paidy answer left");
    if ("throw" in a) return Promise.reject(a.throw);
    return Promise.resolve(new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

Deno.test("PA05: a close Paidy answers CLOSED is released and the row is ended", async () => {
  Deno.env.set("PAIDY_SECRET_KEY", "sk_test_unit");
  const payments: Row[] = [{ id: "r1", paidy_payment_id: "pay_unit0001", status: "authorized" }];
  const db = fakeDb({ paidy_payments: payments });
  const s = stubPaidy([{ body: answer({ status: "CLOSED" }) }]);
  try {
    const r = await releasePaidyAuthorization(db, AUTH, { cash_order_id: "o1", paidy_payment_row: "r1", why: "unit" });
    assertEquals(r, "released");
    assertEquals(payments[0].status, "closed");
    assertEquals(s.calls, ["POST /payments/pay_unit0001/close"]);
    assertEquals(db.rpcCalls.length, 0);
  } finally { s.restore(); }
});

Deno.test("PA05: a 2xx close that still reports AUTHORIZED is NOT released — pending, durable case, row untouched", async () => {
  Deno.env.set("PAIDY_SECRET_KEY", "sk_test_unit");
  const payments: Row[] = [{ id: "r1", paidy_payment_id: "pay_unit0001", status: "authorized" }];
  const db = fakeDb({ paidy_payments: payments });
  const s = stubPaidy([{ body: answer({ status: "AUTHORIZED" }) }]);
  try {
    const r = await releasePaidyAuthorization(db, AUTH, { cash_order_id: "o1", paidy_payment_row: "r1", why: "unit" });
    assertEquals(r, "pending");
    assertEquals(payments[0].status, "authorized");
    assertEquals(db.rpcCalls[0]?.fn, "open_paidy_case");
    assertEquals(db.rpcCalls[0]?.args.p_kind, "close_failed");
  } finally { s.restore(); }
});

Deno.test("PA05: a refused close is re-read; Paidy reporting CLOSED on the read-back counts as released", async () => {
  Deno.env.set("PAIDY_SECRET_KEY", "sk_test_unit");
  const payments: Row[] = [{ id: "r1", paidy_payment_id: "pay_unit0001", status: "authorized" }];
  const db = fakeDb({ paidy_payments: payments });
  const s = stubPaidy([{ status: 500, body: { code: "server_error" } }, { body: answer({ status: "CLOSED" }) }]);
  try {
    const r = await releasePaidyAuthorization(db, AUTH, { cash_order_id: "o1", paidy_payment_row: "r1", why: "unit" });
    assertEquals(r, "released");
    assertEquals(s.calls, ["POST /payments/pay_unit0001/close", "GET /payments/pay_unit0001"]);
  } finally { s.restore(); }
});

Deno.test("PA05: a close that reveals a CAPTURE is never written as closed — captured, locking case opened", async () => {
  Deno.env.set("PAIDY_SECRET_KEY", "sk_test_unit");
  const payments: Row[] = [{ id: "r1", paidy_payment_id: "pay_unit0001", status: "authorized" }];
  const db = fakeDb({ paidy_payments: payments });
  const s = stubPaidy([{ body: answer({ status: "CLOSED", captures: [{ id: "cap_unit1", amount: 20000, created_at: new Date().toISOString() }] }) }]);
  try {
    const r = await releasePaidyAuthorization(db, AUTH, { cash_order_id: "o1", paidy_payment_row: "r1", why: "unit" });
    assertEquals(r, "captured");
    assertEquals(payments[0].status, "captured");
    assertEquals(payments[0].capture_id, "cap_unit1");
    assertEquals(db.rpcCalls[0]?.args.p_kind, "captured_unrecorded");
  } finally { s.restore(); }
});

Deno.test("PA05: an unreadable answer after a refused close is unknown — case opened, nothing released", async () => {
  Deno.env.set("PAIDY_SECRET_KEY", "sk_test_unit");
  const payments: Row[] = [{ id: "r1", paidy_payment_id: "pay_unit0001", status: "authorized" }];
  const db = fakeDb({ paidy_payments: payments });
  const s = stubPaidy([{ throw: new Error("network") }, { throw: new Error("network") }]);
  try {
    const r = await releasePaidyAuthorization(db, AUTH, { cash_order_id: "o1", paidy_payment_row: "r1", why: "unit" });
    assertEquals(r, "unknown");
    assertEquals(payments[0].status, "authorized");
    assertEquals(db.rpcCalls[0]?.args.p_kind, "close_failed");
  } finally { s.restore(); }
});

Deno.test("PA05: a payment Paidy already reports ended is released without a call", async () => {
  Deno.env.set("PAIDY_SECRET_KEY", "sk_test_unit");
  const db = fakeDb({ paidy_payments: [] });
  const s = stubPaidy([]);
  try {
    assertEquals(await releasePaidyAuthorization(db, answer({ status: "REJECTED" }) as PaidyPayment, { why: "unit" }), "released");
    assertEquals(s.calls.length, 0);
  } finally { s.restore(); }
});

Deno.test("PA05: adoption and filing report release_<outcome>_… instead of released_… when the close was not confirmed", async () => {
  const src = await read("../supabase/functions/_shared/paidy-filing.ts");
  assertStringIncludes(src, 'return result.released ? `released_${result.error}` : `release_${result.release ?? "unknown"}_${result.error}`;');
  assertStringIncludes(src, "return released ? \"released\" : `release_${release}`;");
  assert(!src.includes("Promise<boolean> {\n  if (payment.status !== \"AUTHORIZED\") return true;"), "the 2xx-means-released helper is gone");
});

Deno.test("PA09: a failed inbox bookkeeping write is reported, not swallowed", async () => {
  Deno.env.set("PAIDY_SECRET_KEY", "sk_test_unit");
  const inbox: Row[] = [{ id: "ev1", paidy_payment_id: "pay_live0001", attempts: 0 }];
  const db = fakeDb({ paidy_payments: [{ id: "r1", paidy_payment_id: "pay_live0001", status: "authorized", test: false }], paidy_webhook_events: inbox }, { failUpdate: new Set(["paidy_webhook_events"]) });
  const r = await processPaidyEvent(db, "ev1", "pay_live0001", "authorize_success", "reconcile", 0, {});
  assertEquals(r.done, true);
  assertEquals(r.writes_failed, 1);
  assertEquals(inbox[0].parked_reason, undefined);
});

Deno.test("PA10: a 404 for an id with no Hub row is PARKED for the other key and a case opened; closed only after BOTH keys answered 404", async () => {
  const inbox: Row[] = [{ id: "ev1", paidy_payment_id: "pay_unknown01", attempts: 0 }];
  const db = fakeDb({ paidy_payments: [], paidy_webhook_events: inbox });
  // First the live key answers 404.
  Deno.env.set("PAIDY_SECRET_KEY", "sk_live_unit");
  let s = stubPaidy([{ status: 404, body: { code: "not_found" } }]);
  try {
    const r = await processPaidyEvent(db, "ev1", "pay_unknown01", "authorize_success", "webhook", 0, { recognisedSource: true });
    assertEquals(r.done, true);
    assertEquals(r.summary.parked, "unknown_to_this_key");
    assertEquals(inbox[0].parked_reason, "unknown_to_this_key");
    assertEquals(inbox[0].tried_live, true);
    assertEquals(inbox[0].tried_test, false);
    assertEquals(inbox[0].processed_at, undefined);
    assertEquals(db.rpcCalls[0]?.args.p_kind, "provider_unreadable");
  } finally { s.restore(); }
  // Then the test key answers 404 too: only now is the event closed.
  Deno.env.set("PAIDY_SECRET_KEY", "sk_test_unit");
  s = stubPaidy([{ status: 404, body: { code: "not_found" } }]);
  try {
    const r = await processPaidyEvent(db, "ev1", "pay_unknown01", "authorize_success", "reconcile", 1, { recognisedSource: true, tried: { live: true } });
    assertEquals(r.summary.quarantined, "provider_unreadable");
    assertEquals(r.summary.both_keys, true);
    assert(typeof inbox[0].processed_at === "string");
    assertEquals(inbox[0].parked_reason, null);
    assertEquals(inbox[0].tried_test, true);
  } finally { s.restore(); }
});

Deno.test("PA10: a 404 from an unrecognised source is still only noted (no case, no parking)", async () => {
  Deno.env.set("PAIDY_SECRET_KEY", "sk_live_unit");
  const inbox: Row[] = [{ id: "ev1", paidy_payment_id: "pay_unknown02", attempts: 0 }];
  const db = fakeDb({ paidy_payments: [], paidy_webhook_events: inbox });
  const s = stubPaidy([{ status: 404, body: { code: "not_found" } }]);
  try {
    const r = await processPaidyEvent(db, "ev1", "pay_unknown02", "authorize_success", "webhook", 0, { recognisedSource: false });
    assertEquals(r.summary.ignored, "provider_unreadable_unrecognised_source");
    assert(typeof inbox[0].processed_at === "string");
    assertEquals(db.rpcCalls.length, 0);
  } finally { s.restore(); }
});

Deno.test("PA09 / PA10: the sweep claims each event, partitions by environment, completes duplicates only after the first is done, watches unrecorded captures of any age", async () => {
  const src = await read("../supabase/functions/paidy-reconcile/index.ts");
  assertStringIncludes(src, 'await claimPaidyEvent(supabase, String(ev.id), "reconcile")');
  assertStringIncludes(src, ".or(`test.is.null,test.eq.${secretTest}`)");
  assertStringIncludes(src, 'q = parked ? q.not("parked_reason", "is", null) : q.is("parked_reason", null);');
  assertStringIncludes(src, "if (first.get(String(ev.paidy_payment_id)) !== true) continue;");
  assertStringIncludes(src, 'rpc("paidy_unrecorded_captures", { p_test: secretTest, p_limit: 50 })');
  assertStringIncludes(src, ".or(`captured_at.gte.${since},captured_at.is.null`)");
  assertStringIncludes(src, "report.inbox_write_errors += r.writes_failed ?? 0;");
  assert(!src.includes("other_environment_expired"));
});

Deno.test("PA05 / PA04: the sweep retries unfiled releases from Paidy's read-back and verifies a window's payment id before it expires", async () => {
  const src = await read("../supabase/functions/paidy-reconcile/index.ts");
  assertStringIncludes(src, "if (c.paidy_payment_row) continue;\n        report.orphan_releases_retried++;");
  assertStringIncludes(src, 'if (release === "released" || release === "captured") {');
  assertStringIncludes(src, '.eq("status", "open").lte("expires_at", nowIso()).not("paidy_payment_id", "is", null).is("verified_empty_at", null)');
  assertStringIncludes(src, 'if (outcome === "authorized") {\n          report.windows_recovered++;\n          await adoptOrphanAuthorization(supabase, live, "paidy_reconcile");');
  assertStringIncludes(src, '.update({ verified_empty_at: nowIso() }).eq("id", w.id).eq("status", "open")');
  // The expiry itself is still ONLY the guarded SQL.
  assertStringIncludes(src, 'rpc("expire_paidy_checkout_attempts", { p_cash_order_id: null })');
  assert(!src.includes('.update({ status: "expired"'));
});

Deno.test("PA09: the webhook claims its row before processing and answers 500 on a failed bookkeeping write", async () => {
  const src = await read("../supabase/functions/paidy-webhook/index.ts");
  assertStringIncludes(src, 'if (!(await claimPaidyEvent(supabase, String(inbox.id), "webhook")))');
  assertStringIncludes(src, 'if ((result.writes_failed ?? 0) > 0) return jsonResponse({ error: "inbox_write_failed", ...result.summary }, 500);');
});

Deno.test("PA04: the launch carries the attempt id; the abandon route notes Paidy's payment id for the sweep to verify", async () => {
  const src = await read("../supabase/functions/website/index.ts");
  assertStringIncludes(src, "metadata: { ...(checkout.metadata ?? {}), attempt_id: String(st.attempt_id) }");
  assertStringIncludes(src, 'rpc("note_paidy_checkout_attempt_payment", {');
  assertStringIncludes(src, "if (isPaidyPaymentId(body.paidy_payment_id)) {");
});

Deno.test("PR 3 migration: md5-guarded in-place patch, order-correlated guard, verified_empty, parked columns, lease, grants, record-only body matches", async () => {
  const sql = await read("../supabase/migrations/20261125100000_paidy_pr3_recovery.sql");
  assertStringIncludes(sql, "'81d31a6f2ed85907e5732ed2e6dcae27'");
  assertStringIncludes(sql, "AND (e.cash_order_id = a.cash_order_id OR e.cash_order_id IS NULL));");
  assertStringIncludes(sql, "WHERE e.processed_at IS NULL AND e.parked_reason IS NULL");
  assertStringIncludes(sql, "AND (a.paidy_payment_id IS NULL OR a.verified_empty_at IS NOT NULL)");
  assertStringIncludes(sql, "CHECK (parked_reason IS NULL OR parked_reason IN ('other_environment', 'unknown_to_this_key'))");
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.claim_paidy_webhook_event(p_id uuid, p_by text, p_lease_seconds integer DEFAULT 300)");
  assertStringIncludes(sql, "GRANT EXECUTE ON FUNCTION public.claim_paidy_webhook_event(uuid, text, integer) TO service_role;");
  assertStringIncludes(sql, "GRANT EXECUTE ON FUNCTION public.note_paidy_checkout_attempt_payment(uuid, uuid, text) TO service_role;");
  assertStringIncludes(sql, "GRANT EXECUTE ON FUNCTION public.paidy_unrecorded_captures(boolean, integer) TO service_role;");
  assertStringIncludes(sql, "AND NOT EXISTS (SELECT 1 FROM public.payment_submissions s\n                      WHERE s.paidy_payment_id = pp.id AND s.confirmed_payment_id IS NOT NULL)");
  // The record-only body carries every edit the patch applies (its md5,
  // b6d33a3a3c60760c0ce040f18ae727f8, is what the patch migration self-checks
  // on live — Web Crypto has no MD5, so the byte-for-byte check is the
  // migration's own).
  assertStringIncludes(sql, "IF md5(v) <> 'b6d33a3a3c60760c0ce040f18ae727f8' THEN");
  const rec = await read("../supabase/migrations/20261126100000_record_live_paidy_pr3_body.sql");
  for (const frag of [
    "verification = CASE WHEN a.verified_empty_at IS NOT NULL THEN 'verified_empty' ELSE 'unverified_no_id' END",
    "AND (a.paidy_payment_id IS NULL OR a.verified_empty_at IS NOT NULL)",
    "AND (e.cash_order_id = a.cash_order_id OR e.cash_order_id IS NULL));",
  ]) assertStringIncludes(rec, frag);
  assert(!rec.includes("coalesce(e.last_error, '') <> 'other_environment'"), "the global guard is gone from the recorded body");
});
