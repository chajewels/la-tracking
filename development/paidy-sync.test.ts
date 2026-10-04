/**
 * paidy-sync (P05/P11/P12, 2026-10-04): the webhook / hourly-sweep sync of one
 * Paidy payment, run against an in-memory stand-in for the Supabase client.
 * Proves: a capture the Hub has not recorded rings a bell and writes NO money;
 * refunds are recorded once (idempotent) and never touch the order; a queued
 * submission is rejected when Paidy closed the authorisation; a failed write
 * throws (so the webhook answers 5xx and Paidy retries).
 */
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { syncPaidyPayment } from "../supabase/functions/_shared/paidy-sync.ts";
import type { PaidyPayment } from "../supabase/functions/_shared/paidy.ts";

type Row = Record<string, unknown>;

/** Minimal chainable fake of the supabase-js query builder (only what paidy-sync uses). */
function fakeDb(tables: Record<string, Row[]>, failOn?: { table: string; op: string }) {
  let seq = 0;
  const from = (table: string) => {
    tables[table] ??= [];
    const filters: ((r: Row) => boolean)[] = [];
    let op = "select";
    let payload: Row | null = null;
    let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
    let limitN = Infinity;
    const b: Record<string, unknown> = {};
    const run = () => {
      if (failOn && failOn.table === table && failOn.op === op) return { data: null, error: { message: `injected ${op} failure` } };
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
      // upsert with ignoreDuplicates on a unique column
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
  return { from };
}

const base = (over: Partial<PaidyPayment> = {}): PaidyPayment => ({
  id: "pay_TESTabcdef", status: "AUTHORIZED", amount: 52000, currency: "JPY", test: true,
  created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(),
  order: { order_ref: "CJ-W-900011" }, captures: [], refunds: [], ...over,
});

function world() {
  return {
    paidy_payments: [{ id: "pp1", cash_order_id: "o1", status: "authorized", paidy_payment_id: "pay_TESTabcdef", amount_jpy: 52000, refund_jpy: 0 }],
    payment_submissions: [{ id: "s1", paidy_payment_id: "pp1", status: "submitted", confirmed_payment_id: null, processing_started_at: null }],
    paidy_refunds: [] as Row[],
    staff_notifications: [] as Row[],
    audit_logs: [] as Row[],
    cash_payments: [] as Row[],
    cash_orders: [{ id: "o1", total_paid: 0, remaining_balance: 52000, status: "pending" }],
  } as Record<string, Row[]>;
}

Deno.test("captured on Paidy, not recorded → bell, record marked captured, NO money written", async () => {
  const t = world();
  const db = fakeDb(t);
  const p = base({ status: "CLOSED", captures: [{ id: "cap_1", amount: 52000, created_at: "2026-10-04T01:00:00Z" }] });
  const r = await syncPaidyPayment(db, t.paidy_payments[0], p, "webhook", "capture_success");
  assertEquals(r.outcome, "captured");
  assertEquals(t.paidy_payments[0].status, "captured");
  assertEquals(t.paidy_payments[0].capture_id, "cap_1");
  assertEquals(t.staff_notifications.filter((n) => n.type === "paidy_captured_unrecorded").length, 1);
  assertEquals(t.cash_payments.length, 0);
  assertEquals(t.cash_orders[0].total_paid, 0);
  assertEquals(t.payment_submissions[0].status, "submitted"); // never rejected: the money is taken
});

Deno.test("the hourly sweep does not repeat the captured-unrecorded bell within 24 h", async () => {
  const t = world();
  const db = fakeDb(t);
  const p = base({ status: "CLOSED", captures: [{ id: "cap_1", amount: 52000, created_at: "2026-10-04T01:00:00Z" }] });
  await syncPaidyPayment(db, t.paidy_payments[0], p, "reconcile");
  await syncPaidyPayment(db, t.paidy_payments[0], p, "reconcile");
  assertEquals(t.staff_notifications.filter((n) => n.type === "paidy_captured_unrecorded").length, 1);
});

Deno.test("captured and already recorded → no bell", async () => {
  const t = world();
  t.payment_submissions[0].status = "confirmed";
  t.payment_submissions[0].confirmed_payment_id = "cp1";
  t.paidy_payments[0].status = "captured";
  const db = fakeDb(t);
  const p = base({ status: "CLOSED", captures: [{ id: "cap_1", amount: 52000, created_at: "2026-10-04T01:00:00Z" }] });
  await syncPaidyPayment(db, t.paidy_payments[0], p, "webhook");
  assertEquals(t.staff_notifications.length, 0);
});

Deno.test("closed on Paidy with nothing captured → queued submission rejected + audit + bell", async () => {
  const t = world();
  const db = fakeDb(t);
  const r = await syncPaidyPayment(db, t.paidy_payments[0], base({ status: "CLOSED" }), "webhook", "close_success");
  assertEquals(r.status_after, "closed");
  assertEquals(t.payment_submissions[0].status, "rejected");
  assertEquals(t.audit_logs.length, 1);
  assertEquals(t.staff_notifications.filter((n) => n.type === "paidy_closed_externally").length, 1);
});

Deno.test("refunds: recorded once, refund_jpy totalled, order untouched", async () => {
  const t = world();
  t.paidy_payments[0].status = "captured";
  t.payment_submissions[0].confirmed_payment_id = "cp1";
  t.payment_submissions[0].status = "confirmed";
  const db = fakeDb(t);
  const p = base({
    status: "CLOSED",
    captures: [{ id: "cap_1", amount: 52000, created_at: "2026-10-04T01:00:00Z" }],
    refunds: [{ id: "ref_1", amount: 2000, created_at: "2026-10-05T01:00:00Z" }],
  });
  const r1 = await syncPaidyPayment(db, t.paidy_payments[0], p, "webhook", "refund_success");
  const r2 = await syncPaidyPayment(db, t.paidy_payments[0], p, "reconcile");
  assertEquals(r1.new_refunds, 1);
  assertEquals(r2.new_refunds, 0);
  assertEquals(t.paidy_refunds.length, 1);
  assertEquals(t.paidy_payments[0].refund_jpy, 2000);
  assertEquals(t.staff_notifications.filter((n) => n.type === "paidy_refund_recorded").length, 1);
  assertEquals(t.cash_orders[0].remaining_balance, 52000);
  assertEquals(t.cash_orders[0].total_paid, 0);
});

Deno.test("a failed write throws (the webhook answers 5xx and Paidy retries)", async () => {
  const t = world();
  const db = fakeDb(t, { table: "paidy_payments", op: "update" });
  await assertRejects(() => syncPaidyPayment(db, t.paidy_payments[0], base(), "webhook"));
});

Deno.test("still authorised → nothing but the payload refresh", async () => {
  const t = world();
  const db = fakeDb(t);
  const r = await syncPaidyPayment(db, t.paidy_payments[0], base(), "webhook", "authorize_success");
  assertEquals(r.outcome, "authorized");
  assertEquals(t.paidy_payments[0].status, "authorized");
  assert(t.paidy_payments[0].last_payload);
  assertEquals(t.payment_submissions[0].status, "submitted");
  assertEquals(t.staff_notifications.length, 0);
});
