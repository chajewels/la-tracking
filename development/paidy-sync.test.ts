/**
 * paidy-sync (follow-up review 2026-10-04): the webhook / sweep sync of one
 * Paidy payment, run against an in-memory stand-in for the Supabase client.
 * Proves: a dashboard capture is RECORDED through the injected recorder
 * (owner D1) and never when it does not match or was refunded (D4); refunds
 * open a durable case before the ledger row, and the total is recomputed
 * every pass (R06); closes/expiries reject queued submissions whatever the
 * Hub thought before, so a retry after a failed write finishes the job
 * (R05/R07); a failed write throws.
 */
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { syncPaidyPayment, type RecordResult } from "../supabase/functions/_shared/paidy-sync.ts";
import type { PaidyPayment } from "../supabase/functions/_shared/paidy.ts";

type Row = Record<string, unknown>;

/** Minimal chainable fake of the supabase-js query builder (only what paidy-sync uses), plus the two case RPCs. */
function fakeDb(tables: Record<string, Row[]>, failOn?: { table: string; op: string; times?: number }) {
  let seq = 0;
  let failures = failOn?.times ?? Infinity;
  const from = (table: string) => {
    tables[table] ??= [];
    const filters: ((r: Row) => boolean)[] = [];
    let op = "select";
    let payload: Row | null = null;
    let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
    let limitN = Infinity;
    const b: Record<string, unknown> = {};
    const run = () => {
      if (failOn && failOn.table === table && failOn.op === op && failures > 0) {
        failures--;
        return { data: null, error: { message: `injected ${op} failure` } };
      }
      const rows = tables[table];
      if (op === "select") return { data: rows.filter((r) => filters.every((f) => f(r))).slice(0, limitN), error: null };
      if (op === "update") {
        const hit = rows.filter((r) => filters.every((f) => f(r)));
        hit.forEach((r) => Object.assign(r, payload));
        return { data: hit, error: null };
      }
      if (op === "insert") {
        const r = { id: `row-${++seq}`, created_at: new Date().toISOString(), ...payload };
        rows.push(r);
        return { data: [r], error: null };
      }
      const key = upsertOpts.onConflict!;
      if (rows.some((r) => r[key] === payload![key])) return { data: [], error: null };
      const r = { id: `row-${++seq}`, ...payload };
      rows.push(r);
      return { data: [r], error: null };
    };
    Object.assign(b, {
      select: () => b,
      update: (p: Row) => { op = "update"; payload = p; return b; },
      insert: (p: Row) => { op = "insert"; payload = p; return b; },
      upsert: (p: Row, o: typeof upsertOpts) => { op = "upsert"; payload = p; upsertOpts = o; return b; },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; },
      in: (c: string, v: unknown[]) => { filters.push((r) => v.includes(r[c])); return b; },
      gte: (c: string, v: string) => { filters.push((r) => String(r[c] ?? "") >= v); return b; },
      contains: (c: string, v: Row) => { filters.push((r) => Object.entries(v).every(([k, x]) => (r[c] as Row | undefined)?.[k] === x)); return b; },
      order: () => b,
      limit: (n: number) => { limitN = n; return b; },
      maybeSingle: () => { const r = run(); return Promise.resolve({ data: (r.data as Row[] | null)?.[0] ?? null, error: r.error }); },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    });
    return b;
  };
  const rpc = (fn: string, args: Row) => {
    tables.paidy_cases ??= [];
    if (failOn && failOn.table === "rpc" && failOn.op === fn && failures > 0) {
      failures--;
      return Promise.resolve({ data: null, error: { message: `injected ${fn} failure` } });
    }
    if (fn === "open_paidy_case") {
      const open = tables.paidy_cases.find((c) => c.paidy_payment_id === args.p_paidy_payment_id && c.kind === args.p_kind && c.status === "open");
      if (open) { open.attempts = Number(open.attempts ?? 0) + 1; return Promise.resolve({ data: { ok: true, case_id: open.id, new: false }, error: null }); }
      const resolved = tables.paidy_cases.some((c) => c.paidy_payment_id === args.p_paidy_payment_id && c.kind === args.p_kind && c.status === "resolved");
      if (resolved && !(args.p_detail as Row)?.reopen) return Promise.resolve({ data: { ok: true, skipped: "resolved_before", new: false }, error: null });
      const c = { id: `case-${++seq}`, kind: args.p_kind, paidy_payment_id: args.p_paidy_payment_id, status: "open", detail: args.p_detail, attempts: 0 };
      tables.paidy_cases.push(c);
      return Promise.resolve({ data: { ok: true, case_id: c.id, new: true }, error: null });
    }
    if (fn === "close_paidy_case_system") {
      const c = tables.paidy_cases.find((x) => x.id === args.p_case_id && x.status === "open");
      if (c) { c.status = "resolved"; c.resolution = args.p_resolution; }
      return Promise.resolve({ data: { ok: true, closed: !!c }, error: null });
    }
    return Promise.resolve({ data: null, error: { message: `unknown rpc ${fn}` } });
  };
  return { from, rpc };
}

const base = (over: Partial<PaidyPayment> = {}): PaidyPayment => ({
  id: "pay_TESTabcdef", status: "AUTHORIZED", amount: 52000, currency: "JPY", test: true,
  created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(),
  order: { order_ref: "CJ-W-900011" }, captures: [], refunds: [], ...over,
});
const captured = (over: Partial<PaidyPayment> = {}) => base({ status: "CLOSED", captures: [{ id: "cap_1", amount: 52000, created_at: "2026-10-04T01:00:00Z" }], ...over });

function world() {
  return {
    paidy_payments: [{ id: "pp1", cash_order_id: "o1", status: "authorized", paidy_payment_id: "pay_TESTabcdef", amount_jpy: 52000, refund_jpy: 0 }],
    payment_submissions: [{ id: "s1", paidy_payment_id: "pp1", status: "submitted", confirmed_payment_id: null, processing_started_at: null, submitted_amount: 52000 }],
    paidy_refunds: [] as Row[], paidy_cases: [] as Row[],
    staff_notifications: [] as Row[], audit_logs: [] as Row[], cash_payments: [] as Row[],
    cash_orders: [{ id: "o1", total_paid: 0, remaining_balance: 52000, status: "pending" }],
  } as Record<string, Row[]>;
}

/** A recorder that "records" by linking the submission, like review-payment-submission would. */
function recorder(t: Record<string, Row[]>, ok = true) {
  const calls: string[] = [];
  const fn = (id: string): Promise<RecordResult> => {
    calls.push(id);
    if (!ok) return Promise.resolve({ ok: false, status: 400, error: "order_closed", message: "cash_order is cancelled" });
    const s = t.payment_submissions.find((x) => x.id === id)!;
    s.status = "confirmed"; s.confirmed_payment_id = "cp1";
    return Promise.resolve({ ok: true, status: 200 });
  };
  return { fn, calls };
}

Deno.test("D1: a dashboard capture is recorded through the one recording path", async () => {
  const t = world();
  const rec = recorder(t);
  const r = await syncPaidyPayment(fakeDb(t), t.paidy_payments[0], captured(), "webhook", "capture_success", { record: rec.fn });
  assertEquals(rec.calls, ["s1"]);
  assert(r.flagged.includes("auto_recorded"));
  assertEquals(t.paidy_payments[0].status, "captured");
  assertEquals(t.paidy_payments[0].capture_id, "cap_1");
  assertEquals(t.paidy_cases.length, 0);
});

Deno.test("D1: a capture that cannot be recorded opens ONE durable case (and rings once)", async () => {
  const t = world();
  const db = fakeDb(t);
  const rec = recorder(t, false);
  await syncPaidyPayment(db, t.paidy_payments[0], captured(), "webhook", "capture_success", { record: rec.fn });
  await syncPaidyPayment(db, t.paidy_payments[0], captured(), "reconcile", "", { record: rec.fn });
  assertEquals(t.paidy_cases.filter((c) => c.kind === "record_failed" && c.status === "open").length, 1);
  assertEquals(t.staff_notifications.filter((n) => n.type === "paidy_case_record_failed").length, 1);
  assertEquals(t.cash_payments.length, 0);
});

Deno.test("R14: a capture of a different amount is never recorded", async () => {
  const t = world();
  const rec = recorder(t);
  await syncPaidyPayment(fakeDb(t), t.paidy_payments[0], captured({ captures: [{ id: "cap_1", amount: 51999, created_at: "2026-10-04T01:00:00Z" }] }), "webhook", "", { record: rec.fn });
  assertEquals(rec.calls.length, 0);
  assertEquals(t.paidy_cases[0].kind, "record_failed");
});

Deno.test("D4: a refund before recording → case, nothing recorded, order untouched", async () => {
  const t = world();
  const rec = recorder(t);
  await syncPaidyPayment(fakeDb(t), t.paidy_payments[0],
    captured({ refunds: [{ id: "ref_1", amount: 2000, created_at: "2026-10-05T01:00:00Z", capture_id: "cap_1" }] }), "webhook", "refund_success", { record: rec.fn });
  assertEquals(rec.calls.length, 0);
  assertEquals(t.paidy_cases.map((c) => c.kind), ["refund_before_record"]);
  assertEquals((t.paidy_refunds[0].payload as Row).capture_id, "cap_1"); // R17: full refund object kept
  assertEquals(t.cash_orders[0].remaining_balance, 52000);
});

Deno.test("R06: refund row written, total update fails → the retry repairs the total", async () => {
  const t = world();
  t.paidy_payments[0].status = "captured";
  t.payment_submissions[0].status = "confirmed";
  t.payment_submissions[0].confirmed_payment_id = "cp1";
  const p = captured({ refunds: [{ id: "ref_1", amount: 2000, created_at: "2026-10-05T01:00:00Z" }] });
  await assertRejects(() => syncPaidyPayment(fakeDb(t, { table: "paidy_payments", op: "update", times: 1 }), t.paidy_payments[0], p, "webhook"));
  assertEquals(t.paidy_refunds.length, 1);
  assertEquals(t.paidy_payments[0].refund_jpy, 0); // the reproduced defect state
  await syncPaidyPayment(fakeDb(t), t.paidy_payments[0], p, "reconcile");
  assertEquals(t.paidy_payments[0].refund_jpy, 2000);
  assertEquals(t.paidy_refunds.length, 1);
  assertEquals(t.paidy_cases.filter((c) => c.kind === "refund_after_record").length, 1);
});

Deno.test("R06/R08: case write fails → nothing acknowledged; the retry still opens the case", async () => {
  const t = world();
  t.paidy_payments[0].status = "captured";
  t.payment_submissions[0].confirmed_payment_id = "cp1";
  t.payment_submissions[0].status = "confirmed";
  const p = captured({ refunds: [{ id: "ref_1", amount: 2000, created_at: "2026-10-05T01:00:00Z" }] });
  await assertRejects(() => syncPaidyPayment(fakeDb(t, { table: "rpc", op: "open_paidy_case", times: 1 }), t.paidy_payments[0], p, "webhook"));
  assertEquals(t.paidy_refunds.length, 0); // case first, then the ledger row
  await syncPaidyPayment(fakeDb(t), t.paidy_payments[0], p, "reconcile");
  assertEquals(t.paidy_cases.length, 1);
  assertEquals(t.paidy_refunds.length, 1);
});

Deno.test("R05: closed on Paidy, submission reject fails → the retry still rejects it", async () => {
  const t = world();
  const p = base({ status: "CLOSED" });
  await assertRejects(() => syncPaidyPayment(fakeDb(t, { table: "payment_submissions", op: "update", times: 1 }), t.paidy_payments[0], p, "webhook", "close_success"));
  assertEquals(t.paidy_payments[0].status, "closed");
  assertEquals(t.payment_submissions[0].status, "submitted"); // the reproduced defect state
  await syncPaidyPayment(fakeDb(t), t.paidy_payments[0], p, "webhook", "close_success");
  assertEquals(t.payment_submissions[0].status, "rejected");
  assertEquals(t.audit_logs.length, 1);
});

Deno.test("R07: an expired authorisation is marked expired and its queued submission rejected", async () => {
  const t = world();
  const p = base({ expires_at: new Date(Date.now() - 60_000).toISOString() });
  const r = await syncPaidyPayment(fakeDb(t), t.paidy_payments[0], p, "reconcile");
  assertEquals(r.outcome, "expired");
  assertEquals(t.paidy_payments[0].status, "expired");
  assertEquals(t.payment_submissions[0].status, "rejected");
  assert(r.flagged.includes("expired"));
});

Deno.test("captured with no live submission → captured_no_submission case, not recorded", async () => {
  const t = world();
  t.payment_submissions[0].status = "rejected";
  const rec = recorder(t);
  await syncPaidyPayment(fakeDb(t), t.paidy_payments[0], captured(), "reconcile", "", { record: rec.fn });
  assertEquals(rec.calls.length, 0);
  assertEquals(t.paidy_cases[0].kind, "captured_no_submission");
});

Deno.test("a resolved case is not reopened by the next sweep", async () => {
  const t = world();
  t.payment_submissions[0].status = "rejected";
  t.paidy_cases.push({ id: "c0", kind: "captured_no_submission", paidy_payment_id: "pay_TESTabcdef", status: "resolved" });
  await syncPaidyPayment(fakeDb(t), t.paidy_payments[0], captured(), "reconcile");
  assertEquals(t.paidy_cases.length, 1);
});

Deno.test("a close that went through settles the close_failed case", async () => {
  const t = world();
  t.payment_submissions[0].status = "rejected";
  t.paidy_cases.push({ id: "c0", kind: "close_failed", paidy_payment_id: "pay_TESTabcdef", status: "open" });
  await syncPaidyPayment(fakeDb(t), t.paidy_payments[0], base({ status: "CLOSED" }), "reconcile");
  assertEquals(t.paidy_cases[0].status, "resolved");
  assertEquals(t.paidy_cases[0].resolution, "released");
});

Deno.test("still authorised → nothing but the payload refresh", async () => {
  const t = world();
  const r = await syncPaidyPayment(fakeDb(t), t.paidy_payments[0], base(), "webhook", "authorize_success");
  assertEquals(r.outcome, "authorized");
  assertEquals(t.paidy_payments[0].status, "authorized");
  assert(t.paidy_payments[0].last_payload);
  assertEquals(t.payment_submissions[0].status, "submitted");
  assertEquals(t.staff_notifications.length, 0);
});

Deno.test("auto-recorder signature: only the signer's own, fresh, for that submission", async () => {
  const { paidyAutoSignature, verifyPaidyAutoSignature } = await import("../supabase/functions/_shared/paidy-autorecord.ts");
  const key = "service-key-for-test";
  const ts = String(Date.now());
  const sig = await paidyAutoSignature("sub-1", ts, key);
  assert(await verifyPaidyAutoSignature("sub-1", ts, sig, key));
  assert(!(await verifyPaidyAutoSignature("sub-2", ts, sig, key)), "another submission");
  assert(!(await verifyPaidyAutoSignature("sub-1", ts, sig, "other-key")), "another key");
  assert(!(await verifyPaidyAutoSignature("sub-1", String(Date.now() - 10 * 60_000), sig, key)), "stale");
  assert(!(await verifyPaidyAutoSignature("sub-1", ts, null, key)), "missing");
  assert(!(await verifyPaidyAutoSignature("sub-1", ts, sig, undefined)), "no key configured");
});
