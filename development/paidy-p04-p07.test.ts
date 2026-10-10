/**
 * Paidy reassessment P04 / P07 (owner answers 2026-10-08).
 *   P07: an inbox event from the OTHER environment is kept and retried daily,
 *        never marked processed. PR 3 (PA10, owner 2026-10-08): it is PARKED
 *        (parked_reason) and NEVER dropped — the 30-day limit is gone.
 *   P04: the sweep ends a closed Paidy window ONLY through the SQL guard
 *        (expire_paidy_checkout_attempts) — never a plain timed update.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { PARKED_RETRY_MS, processPaidyEvent } from "../supabase/functions/_shared/paidy-events.ts";

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

Deno.test("P07 / PA10: other-environment event is parked, retried in 24h, counted as skipped", async () => {
  Deno.env.set("PAIDY_SECRET_KEY", "sk_test_unit");
  const inbox: Row[] = [{ id: "ev1", paidy_payment_id: "pay_live1", received_at: new Date().toISOString(), attempts: 0 }];
  const db = fakeDb([{ id: "r1", paidy_payment_id: "pay_live1", status: "authorized", test: false }], inbox);
  const r = await processPaidyEvent(db, "ev1", "pay_live1", "authorize_success", "reconcile", 0, { receivedAt: inbox[0].received_at as string });
  assertEquals(r.done, true);
  assertEquals(r.summary.skipped, "other_environment");
  assertEquals(inbox[0].processed_at, undefined);
  assertEquals(inbox[0].last_error, "other_environment");
  assertEquals(inbox[0].parked_reason, "other_environment");
  assertEquals(inbox[0].cash_order_id, undefined); // the row carried no order id in this fixture
  assertEquals(inbox[0].test, false); // classified from the Hub row
  assertEquals(inbox[0].attempts, 1);
  const next = Date.parse(String(inbox[0].next_attempt_at));
  assert(next - Date.now() > PARKED_RETRY_MS - 3600_000 && next - Date.now() <= PARKED_RETRY_MS);
});

Deno.test("PA10 (owner 2026-10-08): an other-environment event is NEVER dropped, however old", async () => {
  Deno.env.set("PAIDY_SECRET_KEY", "sk_test_unit");
  const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
  const inbox: Row[] = [{ id: "ev1", paidy_payment_id: "pay_live1", received_at: old, attempts: 5 }];
  const db = fakeDb([{ id: "r1", paidy_payment_id: "pay_live1", status: "authorized", test: false }], inbox);
  const r = await processPaidyEvent(db, "ev1", "pay_live1", "authorize_success", "reconcile", 5, { receivedAt: old });
  assertEquals(r.summary.skipped, "other_environment");
  assertEquals(inbox[0].processed_at, undefined);
  assertEquals(inbox[0].parked_reason, "other_environment");
  assertEquals(inbox[0].attempts, 6);
  const src = await Deno.readTextFile(new URL("../supabase/functions/_shared/paidy-events.ts", import.meta.url));
  assert(!src.includes("other_environment_expired"), "no expiry of parked recovery");
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

Deno.test("P04 QA (2026-10-08): her own open window offers Paidy again and is replaced on reopen; details-only refusals stay switchable", async () => {
  const web = await Deno.readTextFile(new URL("../supabase/functions/website/index.ts", import.meta.url));
  // GET /orders/:id — a window with nothing else holding the order is not a payment in progress.
  // QC PR-B (2026-10-10): a window that already holds a noted approval is processing, not "open Paidy again".
  assert(web.includes('lock === "paidy_checkout_open" && !windowHoldsApproval\n        && (await paymentLock(supabase, String(order.id), { ignoreAttempts: true })) === null'));
  assert(web.includes('windowOnly ? "paidy_window_open"'));
  assert(web.includes("windowOnly ? null : lock)"));
  // "Pay another way" lists Paidy when only her details are missing.
  assert(web.includes('PAIDY_DETAIL_REASONS = new Set(["no_buyer_name", "no_jp_mobile", "no_jp_billing_address"])'));
  assert(web.includes("return o.offered || PAIDY_DETAIL_REASONS.has(String(o.reason ?? \"\"))"));
  // The form can pre-fill her mobile.
  assert(web.includes("mobile_number: paidyBlock.mobile_number ?? null"));
  // The SQL: opening Paidy again replaces ANY open window of hers (not only a reported close).
  const sql = await Deno.readTextFile(new URL("../supabase/migrations/20261121100000_paidy_window_reopen.sql", import.meta.url));
  assert(sql.includes("'21e779750fff39c4ae64391fd78db569'"));
  assert(sql.includes("end_reason = coalesce(end_reason, 'replaced')"));
  assert(sql.includes("AND status = 'open';\n$n$"));
  assert(!sql.includes("$n$")  || !sql.split("$n$")[1]?.includes("customer_closed_at IS NOT NULL"));
});
