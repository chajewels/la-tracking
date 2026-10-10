/**
 * Paidy reassessment F2 (owner 2026-10-10, option A): the "Paidy payment
 * recorded" bell is built in one place, and the hourly sweep rings it late
 * when the first ring never happened. Pure rules + wiring on comment-stripped
 * code.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type MissingRecordedBell, PAIDY_RECORDED_BELL_GRACE_MINUTES, PAIDY_RECORDED_BELL_PAGE, PAIDY_RECORDED_BELL_SINCE,
  PAIDY_RECORDED_BELL_TYPE, paidyRecordedBell, paidyRecordedBellSince, paidyRecordedBellUntil, type RingOutcome,
  type SweepDeps, sweepMissingRecordedBells,
} from "../supabase/functions/_shared/paidy-recorded-bell.ts";

const root = new URL("../", import.meta.url);
const code = (p: string) => Deno.readTextFileSync(new URL(p, root)).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*|--)/.test(l)).join("\n");

Deno.test("bell text: completed order, automatic", () => {
  const b = paidyRecordedBell({ reference: "CJ-W-000123", amountJpy: 50000, senderName: "Test Customer", automatic: true, fullyPaid: true, remainingJpy: 0 });
  assertEquals(b.type, PAIDY_RECORDED_BELL_TYPE);
  assertEquals(b.title, "Paidy payment recorded — order completed, ready to ship");
  assertEquals(b.body, "CJ-W-000123 · ¥50,000 · Test Customer · recorded automatically after the capture in the Paidy dashboard · the order is completed and ready to ship");
});

Deno.test("bell text: part paid by a staff Confirm, rung late", () => {
  const b = paidyRecordedBell({ reference: "20123", amountJpy: 1000.4, senderName: null, automatic: false, fullyPaid: false, remainingJpy: 2500, late: true });
  assertEquals(b.title, "Paidy payment recorded");
  assertEquals(b.body, "20123 · ¥1,000 ·  · recorded by a staff Confirm · ¥2,500 still due · this bell was sent late by the hourly Paidy check");
});

Deno.test("window: never before the feature shipped, never inside the grace period", () => {
  const ship = Date.parse(PAIDY_RECORDED_BELL_SINCE);
  assertEquals(paidyRecordedBellSince(ship + 3_600_000), PAIDY_RECORDED_BELL_SINCE.replace("Z", ".000Z"));
  const later = ship + 30 * 86_400_000;
  assertEquals(paidyRecordedBellSince(later), new Date(later - 7 * 86_400_000).toISOString());
  assertEquals(paidyRecordedBellUntil(later), new Date(later - PAIDY_RECORDED_BELL_GRACE_MINUTES * 60_000).toISOString());
});

Deno.test("wiring: the recording path uses the shared builder", () => {
  const rps = code("supabase/functions/review-payment-submission/index.ts");
  assert(rps.includes("const bell = paidyRecordedBell({"));
  assert(rps.includes("await paidyBell(supabase, bell.type, bell.title, bell.body,"));
  assert(!rps.includes('"Paidy payment recorded — order completed, ready to ship"'), "no second copy of the wording");
});

// ── QA reopen (2026-10-10 23:21): >50 recordings and overlapping workers ──
// A model of the two database functions with their exact contract:
//   missing(after, limit) = recordings with NO bell, ordered (created_at, id),
//                           strictly after the keyset cursor, at most limit;
//   ring(...)             = INSERT … ON CONFLICT DO NOTHING on the unique
//                           cash_payment_id — atomic: one winner per payment.
// Every await yields, so concurrent sweeps genuinely interleave.
const tick = () => new Promise((r) => setTimeout(r, 0));
function world(n: number, belled: (i: number) => boolean) {
  const recs = Array.from({ length: n }, (_, i) => ({
    cash_payment_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    payment_created_at: new Date(Date.UTC(2026, 9, 11, 0, 0, i)).toISOString(),
    amount_paid: 1000 + i, cash_order_id: `o${i}`, submission_id: `s${i}`, sender_name: "Test", reviewer_user_id: null,
  } satisfies MissingRecordedBell));
  const bells = new Map<string, number>();
  recs.forEach((r, i) => { if (belled(i)) bells.set(r.cash_payment_id, 1); });
  let inserts = 0;
  const deps: SweepDeps = {
    missing: async (after, limit) => {
      await tick();
      return recs.filter((r) => !bells.has(r.cash_payment_id))
        .filter((r) => !after || r.payment_created_at > after.at || (r.payment_created_at === after.at && r.cash_payment_id > after.id))
        .slice(0, limit);
    },
    order: async (id) => { await tick(); return { id, status: "completed", remaining_balance: 0, reference: id }; },
    ring: async (_b, meta): Promise<RingOutcome> => {
      await tick();
      const k = String(meta.cash_payment_id);
      if (bells.has(k)) return "exists";
      bells.set(k, 1); inserts++;
      return "rung";
    },
  };
  return { recs, bells, deps, inserts: () => inserts };
}

Deno.test("QA reopen 1: a missing bell beyond the first 50 (and beyond a full page) is rung", async () => {
  const n = PAIDY_RECORDED_BELL_PAGE * 2 + 37;
  const missingAt = new Set([3, 51, 99, 100, 150, n - 1]);
  const w = world(n, (i) => !missingAt.has(i));
  const r = await sweepMissingRecordedBells(w.deps);
  assertEquals(r.rung, missingAt.size);
  assertEquals(r.failed, 0);
  for (const i of missingAt) assert(w.bells.has(w.recs[i].cash_payment_id), `recording #${i + 1} still has no bell`);
  assertEquals(w.bells.size, n);
});

Deno.test("QA reopen 1b: more missing bells than one page are all rung in one run", async () => {
  const n = PAIDY_RECORDED_BELL_PAGE * 3 + 5;
  const w = world(n, () => false);
  const r = await sweepMissingRecordedBells(w.deps);
  assertEquals(r.rung, n);
  assertEquals(w.inserts(), n);
});

Deno.test("QA reopen 2: overlapping sweeps and the normal ring give exactly one bell per payment", async () => {
  const n = 180;
  const w = world(n, (i) => i % 3 !== 0);
  const missing = w.recs.filter((_, i) => i % 3 === 0);
  const normal = missing.slice(0, 10).map((m) => w.deps.ring({ title: "t", body: "b" }, { cash_payment_id: m.cash_payment_id }));
  const [a, b, c] = await Promise.all([
    sweepMissingRecordedBells(w.deps), sweepMissingRecordedBells(w.deps), sweepMissingRecordedBells(w.deps),
  ]);
  const normalRung = (await Promise.all(normal)).filter((x) => x === "rung").length;
  assertEquals(w.inserts(), missing.length, "one insert per missing payment, no duplicates");
  assertEquals(a.rung + b.rung + c.rung + normalRung, missing.length);
  assertEquals(w.bells.size, n);
});

Deno.test("an order that cannot be read is counted, and the next row is still rung", async () => {
  const w = world(5, () => false);
  const deps: SweepDeps = { ...w.deps, order: async (id) => (id === "o2" ? null : { id, status: "pending", remaining_balance: 500, reference: id }) };
  const r = await sweepMissingRecordedBells(deps);
  assertEquals(r.rung, 4);
  assertEquals(r.failed, 1);
});

Deno.test("wiring: both paths write through the one atomic function; no direct insert of this bell", () => {
  const rps = code("supabase/functions/review-payment-submission/index.ts");
  assert(rps.includes("await ringPaidyRecordedBell(supabase, bell, { ...bellMeta, cash_payment_id: String(cashPayment.id) });"));
  const rec = code("supabase/functions/paidy-reconcile/index.ts");
  assert(rec.includes('supabase.rpc("paidy_recorded_bell_missing", {'));
  assert(rec.includes("ring: (bell, metadata) => ringPaidyRecordedBell(supabase, bell, metadata),"));
  assert(rec.includes("report.recorded_bells_late += sweep.rung;"));
  assert(!rec.includes('.select("id, cash_order_id, sender_name, reviewer_user_id, confirmed_payment_id")'), "the old first-50-only read is gone");
  const shared = code("supabase/functions/_shared/paidy-recorded-bell.ts");
  assert(shared.includes('supabase.rpc("ring_paidy_payment_recorded_bell", {'));
  // No path writes this bell type except through the database function.
  const all = [rps, rec, shared].join("\n");
  assert(!/paidyBell\(supabase, bell\.type, bell\.title, bell\.body,\s*\{ cash_order_id/.test(rps), "old direct ring");
  assertEquals((rps.match(/paidyBell\(supabase, bell\.type/g) ?? []).length, 1, "only the no-cash-payment fallback");
});

Deno.test("migration: unique index + ON CONFLICT writer + missing-only lister, service_role only", () => {
  const sql = Deno.readTextFileSync(new URL("supabase/migrations/20261208150000_paidy_recorded_bell_once.sql", root))
    .split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
  assert(sql.includes("CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_notifications_paidy_recorded"));
  assert(sql.includes("ON CONFLICT ((metadata->>'cash_payment_id')) WHERE type = 'paidy_payment_recorded'"));
  assert(sql.includes("AND NOT EXISTS ("));
  assert(sql.includes("AND (p_after_at IS NULL OR (cp.created_at, cp.id) > (p_after_at, p_after_id))"));
  assertEquals((sql.match(/FROM PUBLIC, anon, authenticated;/g) ?? []).length, 2);
  assertEquals((sql.match(/TO service_role;/g) ?? []).length, 2);
});
