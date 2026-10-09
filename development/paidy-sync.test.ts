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
      neq: (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return b; },
      // PostgREST or("a.is.null,a.lt.5"): any one clause matching keeps the row.
      or: (expr: string) => {
        const clauses = expr.split(",").map((s) => {
          const [col, opr, ...rest] = s.split(".");
          const val = rest.join(".");
          return (r: Row) => {
            const x = r[col];
            if (opr === "is" && val === "null") return x === null || x === undefined;
            if (opr === "lt") return x !== null && x !== undefined && Number(x) < Number(val);
            if (opr === "eq") return String(x) === val;
            throw new Error(`fakeDb.or: unsupported operator ${opr}`);
          };
        });
        filters.push((r) => clauses.some((f) => f(r)));
        return b;
      },
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
    if (fn === "record_paidy_refund") {
      // PA02: the SQL writer, modelled — idempotent by refund id, monotonic
      // refund_jpy, a bell when the order already holds a cancellation lot.
      tables.paidy_refunds ??= [];
      tables.store_credit_lots ??= [];
      const rec = (tables.paidy_payments ?? []).find((r) => r.id === args.p_paidy_payment_row);
      if (!rec) return Promise.resolve({ data: { ok: false, error: "unknown_payment" }, error: null });
      if (rec.status !== "captured") return Promise.resolve({ data: { ok: false, error: "not_captured", status: rec.status }, error: null });
      const inserted = !tables.paidy_refunds.some((r) => r.refund_id === args.p_refund_id);
      if (inserted) tables.paidy_refunds.push({ id: `row-${++seq}`, paidy_payment_row: args.p_paidy_payment_row, cash_order_id: rec.cash_order_id, refund_id: args.p_refund_id, amount_jpy: args.p_amount_jpy, refunded_at: args.p_refunded_at, payload: args.p_payload });
      const total = tables.paidy_refunds.filter((r) => r.paidy_payment_row === args.p_paidy_payment_row).reduce((a, r) => a + Number(r.amount_jpy), 0);
      if (total > Number(rec.amount_jpy)) return Promise.resolve({ data: { ok: false, error: "refund_exceeds_capture", inserted }, error: null });
      if (rec.refund_jpy === null || rec.refund_jpy === undefined || Number(rec.refund_jpy) < total) rec.refund_jpy = total;
      const credit = tables.store_credit_lots.filter((l) => l.source_cash_order_id === rec.cash_order_id && l.source_type === "cancelled_cash" && l.status !== "voided").reduce((a, l) => a + Number(l.original_amount), 0);
      let bell = false;
      if (inserted && credit > 0) { tables.staff_notifications ??= []; tables.staff_notifications.push({ type: "paidy_refund_after_credit", metadata: { refund_id: args.p_refund_id } }); bell = true; }
      return Promise.resolve({ data: { ok: true, inserted, refunded_total_jpy: total, captured_jpy: rec.amount_jpy, remaining_jpy: Number(rec.amount_jpy) - total, credit_already_issued_jpy: credit, bell }, error: null });
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
    if (fn === "end_paidy_submission_provider_ended_atomic") {
      // M4 (Paidy QC 2026-10-09): the SQL writer, modelled — ONE transaction:
      // row status (from authorized), submission rejected, one audit row, one
      // email intent; a repeat is already_rejected and adds nothing.
      tables.payment_submissions ??= []; tables.audit_logs ??= []; tables.payment_submission_followups ??= [];
      const sub = tables.payment_submissions.find((x) => x.id === args.p_submission_id);
      if (!sub) return Promise.resolve({ data: { ok: false, error: "not_found" }, error: null });
      if (sub.status === "rejected") return Promise.resolve({ data: { ok: true, rejected: false, already_rejected: true }, error: null });
      if (!["submitted", "under_review"].includes(String(sub.status))) return Promise.resolve({ data: { ok: false, error: "conflict", status: sub.status }, error: null });
      const rec = (tables.paidy_payments ?? []).find((r) => r.id === args.p_paidy_row);
      if (!rec) return Promise.resolve({ data: { ok: false, error: "paidy_row_missing" }, error: null });
      if (rec.status === "captured") return Promise.resolve({ data: { ok: false, error: "paidy_captured" }, error: null });
      if (rec.status === "authorized") rec.status = args.p_end_status;
      sub.status = "rejected"; sub.reviewer_notes = args.p_reviewer_notes; sub.processing_started_at = null;
      tables.audit_logs.push({ entity_type: "cash_payment_submission", entity_id: sub.id, action: "submission_rejected", new_value_json: { reason: `paidy_${args.p_end_status}`, ...(args.p_audit as Row ?? {}) } });
      const key = `payment-rejected-${sub.id}`;
      if (!tables.payment_submission_followups.some((f) => f.idempotency_key === key)) {
        tables.payment_submission_followups.push({ id: `fu-${++seq}`, kind: "paidy_rejected_email", idempotency_key: key, status: "pending", payload: { kind: "provider_ended" } });
      }
      return Promise.resolve({ data: { ok: true, rejected: true, followup_key: key }, error: null });
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

Deno.test("R06 (PA02 order): a write fails mid-pass → nothing half-recorded; the retry records the refund once, total repaired", async () => {
  const t = world();
  t.paidy_payments[0].status = "captured";
  t.payment_submissions[0].status = "confirmed";
  t.payment_submissions[0].confirmed_payment_id = "cp1";
  const p = captured({ refunds: [{ id: "ref_1", amount: 2000, created_at: "2026-10-05T01:00:00Z" }] });
  // PA02: the refund is recorded AFTER the capture status write (a refund only
  // exists on a capture) and ONLY through record_paidy_refund. The first
  // paidy_payments write failing stops the pass before any refund row exists.
  await assertRejects(() => syncPaidyPayment(fakeDb(t, { table: "paidy_payments", op: "update", times: 1 }), t.paidy_payments[0], p, "webhook"));
  assertEquals(t.paidy_refunds.length, 0);
  assertEquals(t.paidy_payments[0].refund_jpy, 0);
  await syncPaidyPayment(fakeDb(t), t.paidy_payments[0], p, "reconcile");
  assertEquals(t.paidy_payments[0].refund_jpy, 2000);
  assertEquals(t.paidy_refunds.length, 1);
  assertEquals(t.paidy_cases.filter((c) => c.kind === "refund_after_record").length, 1);
  // A third pass with the same refund inserts nothing and keeps the total.
  const r3 = await syncPaidyPayment(fakeDb(t), t.paidy_payments[0], p, "reconcile");
  assertEquals(r3.new_refunds, 0);
  assertEquals(t.paidy_refunds.length, 1);
  assertEquals(t.paidy_payments[0].refund_jpy, 2000);
});

Deno.test("PA02: a refund landing on an order that already holds cancellation credit rings paidy_refund_after_credit once", async () => {
  const t = world();
  t.paidy_payments[0].status = "captured";
  t.payment_submissions[0].status = "confirmed";
  t.payment_submissions[0].confirmed_payment_id = "cp1";
  (t as Record<string, Row[]>).store_credit_lots = [{ id: "lot1", source_cash_order_id: t.paidy_payments[0].cash_order_id, source_type: "cancelled_cash", status: "active", original_amount: 7000 }];
  const p = captured({ refunds: [{ id: "ref_1", amount: 10000, created_at: "2026-10-05T01:00:00Z" }] });
  const r = await syncPaidyPayment(fakeDb(t), t.paidy_payments[0], p, "reconcile");
  assert(r.flagged.includes("refund_after_credit"));
  assertEquals(((t as Record<string, Row[]>).staff_notifications ?? []).filter((n) => n.type === "paidy_refund_after_credit").length, 1);
  await syncPaidyPayment(fakeDb(t), t.paidy_payments[0], p, "reconcile");
  assertEquals(((t as Record<string, Row[]>).staff_notifications ?? []).filter((n) => n.type === "paidy_refund_after_credit").length, 1);
});

Deno.test("PA02: a read-back from the other environment never records a refund (flagged refund_unverified)", async () => {
  const t = world();
  t.paidy_payments[0].status = "captured";
  t.paidy_payments[0].test = true;
  t.payment_submissions[0].status = "confirmed";
  t.payment_submissions[0].confirmed_payment_id = "cp1";
  const p = captured({ test: false, refunds: [{ id: "ref_1", amount: 2000, created_at: "2026-10-05T01:00:00Z" }] });
  const r = await syncPaidyPayment(fakeDb(t), t.paidy_payments[0], p, "reconcile");
  assert(r.flagged.includes("refund_unverified"));
  assertEquals(t.paidy_refunds.length, 0);
  assertEquals(r.new_refunds, 0);
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

Deno.test("R05 / M4: closed on Paidy, the atomic end write fails → nothing half-done; the retry rejects it once", async () => {
  const t = world();
  const p = base({ status: "CLOSED" });
  await assertRejects(() => syncPaidyPayment(fakeDb(t, { table: "rpc", op: "end_paidy_submission_provider_ended_atomic", times: 1 }), t.paidy_payments[0], p, "webhook", "close_success"));
  assertEquals(t.paidy_payments[0].status, "closed");
  assertEquals(t.payment_submissions[0].status, "submitted"); // the reproduced defect state
  assertEquals((t.audit_logs ?? []).length, 0); // M4: no audit row without the rejection
  await syncPaidyPayment(fakeDb(t), t.paidy_payments[0], p, "webhook", "close_success");
  assertEquals(t.payment_submissions[0].status, "rejected");
  assertEquals(t.audit_logs.length, 1);
  assertEquals(t.payment_submission_followups.filter((f) => (f.payload as Row | undefined)?.kind === "provider_ended").length, 1);
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

// --- Reassessment P02: a late or stale Paidy message never undoes a capture ---
Deno.test("P02: stale CLOSED payload after the row is captured → row stays captured, submission untouched", async () => {
  const t = world();
  t.paidy_payments[0].status = "captured";
  t.paidy_payments[0].capture_id = "cap_1";
  t.payment_submissions[0].status = "confirmed";
  t.payment_submissions[0].confirmed_payment_id = "cp1";
  const rec = recorder(t);
  await syncPaidyPayment(fakeDb(t), t.paidy_payments[0], base({ status: "CLOSED" }), "webhook", "close", { record: rec.fn });
  assertEquals(t.paidy_payments[0].status, "captured");
  assertEquals(t.paidy_payments[0].capture_id, "cap_1");
  assertEquals(t.payment_submissions[0].status, "confirmed");
  assertEquals(rec.calls.length, 0);
});

Deno.test("P02: an older payload with a smaller refund total never lowers refund_jpy", async () => {
  const t = world();
  t.paidy_payments[0].status = "captured";
  t.paidy_payments[0].refund_jpy = 5000;
  t.payment_submissions[0].status = "confirmed";
  t.payment_submissions[0].confirmed_payment_id = "cp1";
  await syncPaidyPayment(fakeDb(t), t.paidy_payments[0],
    captured({ refunds: [{ id: "ref_1", amount: 2000, created_at: "2026-10-05T01:00:00Z" }] }), "reconcile");
  assertEquals(t.paidy_payments[0].refund_jpy, 5000);
});

Deno.test("P02: row captured by another pass while this one saw CLOSED → no rejection of the submission", async () => {
  const t = world();
  const db = fakeDb(t);
  // The webhook read CLOSED, but a capture landed first in the database.
  t.paidy_payments[0].status = "captured";
  const stale = { ...t.paidy_payments[0], status: "authorized" };
  await syncPaidyPayment(db, stale, base({ status: "CLOSED" }), "webhook", "close");
  assertEquals(t.paidy_payments[0].status, "captured");
  assertEquals(t.payment_submissions[0].status, "submitted");
});
