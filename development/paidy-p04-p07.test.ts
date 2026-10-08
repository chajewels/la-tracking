/**
 * Paidy reassessment P04 / P07 (owner answers 2026-10-08).
 *   P07: an inbox event from the OTHER environment is kept and retried daily,
 *        never marked processed, until 30 days old.
 *   P04: the sweep ends a closed Paidy window ONLY through the SQL guard
 *        (expire_paidy_checkout_attempts) — never a plain timed update.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { OTHER_ENVIRONMENT_KEEP_DAYS, processPaidyEvent } from "../supabase/functions/_shared/paidy-events.ts";

type Row = Record<string, unknown>;
function fakeDb(payments: Row[], inbox: Row[]) {
  return {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      let op = "select"; let payload: Row | null = null;
      const b: Record<string, unknown> = {};
      const rows = () => (table === "paidy_payments" ? payments : table === "paidy_webhook_events" ? inbox : []);
      const run = () => {
        const hit = rows().filter((r) => filters.every((f) => f(r)));
        if (op === "update") hit.forEach((r) => Object.assign(r, payload));
        return { data: hit, error: null };
      };
      Object.assign(b, {
        select: () => b,
        update: (p: Row) => { op = "update"; payload = p; return b; },
        eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; },
        maybeSingle: () => Promise.resolve({ data: run().data[0] ?? null, error: null }),
        then: (res: (v: unknown) => unknown) => Promise.resolve(run()).then(res),
      });
      return b;
    },
  };
}

Deno.test("P07: other-environment event is kept, retried in 24h, counted as skipped", async () => {
  Deno.env.set("PAIDY_SECRET_KEY", "sk_test_unit");
  const inbox: Row[] = [{ id: "ev1", paidy_payment_id: "pay_live1", received_at: new Date().toISOString(), attempts: 0 }];
  const db = fakeDb([{ id: "r1", paidy_payment_id: "pay_live1", status: "authorized", test: false }], inbox);
  const r = await processPaidyEvent(db, "ev1", "pay_live1", "authorize_success", "reconcile", 0, { receivedAt: inbox[0].received_at as string });
  assertEquals(r.done, true);
  assertEquals(r.summary.skipped, "other_environment");
  assertEquals(inbox[0].processed_at, undefined);
  assertEquals(inbox[0].last_error, "other_environment");
  assertEquals(inbox[0].attempts, 1);
  const next = Date.parse(String(inbox[0].next_attempt_at));
  assert(next - Date.now() > 23 * 3600_000 && next - Date.now() <= 24 * 3600_000);
});

Deno.test("P07: other-environment event older than 30 days is dropped as expired", async () => {
  Deno.env.set("PAIDY_SECRET_KEY", "sk_test_unit");
  const old = new Date(Date.now() - (OTHER_ENVIRONMENT_KEEP_DAYS + 1) * 86_400_000).toISOString();
  const inbox: Row[] = [{ id: "ev1", paidy_payment_id: "pay_live1", received_at: old, attempts: 5 }];
  const db = fakeDb([{ id: "r1", paidy_payment_id: "pay_live1", status: "authorized", test: false }], inbox);
  const r = await processPaidyEvent(db, "ev1", "pay_live1", "authorize_success", "reconcile", 5, { receivedAt: old });
  assertEquals(r.summary.skipped, "other_environment_expired");
  assert(typeof inbox[0].processed_at === "string");
});

Deno.test("P04 + P07: the sweep source ends windows only through the SQL guard and reads one environment", async () => {
  const src = await Deno.readTextFile(new URL("../supabase/functions/paidy-reconcile/index.ts", import.meta.url));
  assert(src.includes('rpc("expire_paidy_checkout_attempts"'), "sweep must call the guarded SQL");
  assert(!src.includes('.update({ status: "expired"'), "no direct timed expiry of Paidy windows");
  assertEquals((src.match(/\.eq\("test", secretTest\)/g) ?? []).length, 2, "both watched-payment reads filter on the environment");
});

Deno.test("P04: the migration keeps the lock on an open window regardless of the clock, and notes a close", async () => {
  const sql = await Deno.readTextFile(new URL("../supabase/migrations/20261119100000_paidy_p04_p05.sql", import.meta.url));
  assert(sql.includes("WHERE a.cash_order_id = p_cash_order_id AND a.status = 'open')\n$n$"), "lock no longer keyed on expires_at");
  assert(sql.includes("SET customer_closed_at = coalesce(customer_closed_at, now()),"), "close is noted, not acted on");
  assert(sql.includes("CREATE OR REPLACE FUNCTION public.expire_paidy_checkout_attempts"), "one guarded expiry path");
  assert(sql.includes("coalesce(e.last_error, '') <> 'other_environment'"), "a waiting notification holds the window");
});
