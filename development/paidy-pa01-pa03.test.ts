/**
 * Paidy reassessment PA01 / PA02 / PA03 — the SQL side is applied by Lovable
 * from migration 20261123100000; these are the WIRING guards that keep the
 * edge functions and the migration honest in CI (the bodies themselves run
 * only on Postgres):
 *   PA02  paidy_refunds has ONE writer (record_paidy_refund); the sync never
 *         upserts the ledger itself; both cancel RPCs refuse credit after a
 *         Paidy refund (paidy_already_refunded).
 *   PA03  "refund issued" for Paidy is bound to verified refunds
 *         (no_verified_paidy_refund / paidy_refund_needs_dashboard) and the
 *         audit carries cumulative + remaining.
 *   PA01  an orphan capture case is never closed by a note
 *         (orphan_capture_unsettled); only the sweep's verified full refund
 *         closes it (resolve_orphan_paidy_case_verified).
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const read = (p: string) => Deno.readTextFile(new URL(p, import.meta.url));
const count = (s: string, needle: string) => s.split(needle).length - 1;

Deno.test("PA02: paidy-sync records refunds ONLY through record_paidy_refund, after the capture status write", async () => {
  const src = await read("../supabase/functions/_shared/paidy-sync.ts");
  assertEquals(count(src, 'from("paidy_refunds").upsert('), 0, "no direct ledger upsert remains");
  assertEquals(count(src, 'rpc("record_paidy_refund"'), 1);
  const capture = src.indexOf('must(capErr, "paidy_payments capture update")');
  const rpc = src.indexOf('rpc("record_paidy_refund"');
  assert(capture > 0 && rpc > capture, "the refund RPC runs after the capture status is written");
  assert(src.includes('flagged.push("refund_unverified")'), "an env/id mismatch records nothing and is flagged");
  assert(src.includes('if (res.bell) flagged.push("refund_after_credit")'));
});

Deno.test("PA01: paidy-reconcile sweeps open orphan capture cases and closes them only on a verified FULL refund", async () => {
  const src = await read("../supabase/functions/paidy-reconcile/index.ts");
  const sweep = src.slice(src.indexOf("// 4b. PA01"), src.indexOf("// 5. Cash-order Confirms"));
  assert(sweep.length > 500, "orphan sweep present");
  assert(sweep.includes('.is("paidy_payment_row", null)'), "orphans only (no payment row)");
  assert(sweep.includes('.in("kind", ["captured_unrecorded", "captured_no_submission", "record_failed"])'));
  assert(sweep.includes("refunded >= captured"), "full refund is the only verified close");
  assertEquals(count(sweep, 'rpc("resolve_orphan_paidy_case_verified"'), 1);
  assert(sweep.includes("if (live.test !== secretTest) continue;"), "the other environment's payment is left to its own run (PA10)");
  assert(!sweep.includes('from("paidy_cases").update({ status'), "the sweep never resolves a case by a direct table write");
});

Deno.test("Migration 20261123100000: four md5-guarded patches + the two new service-role writers, with the refusal codes", async () => {
  const m = await read("../supabase/migrations/20261123100000_paidy_pa01_pa02_pa03.sql");
  assertEquals(count(m, "SELECT pg_temp.cj_patch("), 4);
  for (const md5 of ["89b5dca234e0a4c8b8316f2f69268b8c", "0512fb205e097d5c1e2f34c964ab65bc", "3369f10e9db3ff83317df3e2e356d35a", "bd8ae39af2d8fd14fd7b328c58b05bfe"]) {
    assertEquals(count(m, `'${md5}'`), 1, `guard ${md5}`);
  }
  // PA02 — refuse, like R05; both cancel RPCs; the Square checks stay.
  assertEquals(count(m, "'reason', 'paidy_already_refunded'"), 1, "terminate_web_order_atomic reason");
  assertEquals(count(m, "RAISE EXCEPTION 'paidy_already_refunded:"), 1, "cancel_cash_order_atomic exception");
  assert(m.includes("RAISE EXCEPTION 'card_already_refunded:"), "R05 anchor preserved verbatim");
  assert(m.includes("'reason', 'card_already_refunded'"), "R05 (web) anchor preserved verbatim");
  // PA03
  assertEquals(count(m, "'reason', 'paidy_refund_needs_dashboard'"), 1);
  assertEquals(count(m, "'error', 'no_verified_paidy_refund'"), 1);
  assert(m.includes("'paidy_refunded_total_jpy', v_paidy_refunded,"), "cumulative recorded");
  assert(m.includes("'paidy_remaining_jpy', v_paidy_remaining"), "remaining obligation recorded");
  assert(m.includes("v_amount := LEAST(v_paidy_paid, v_paidy_refunded);"), "never the gross");
  assert(m.includes("'no_completed_card_refund'"), "B01 anchor preserved verbatim");
  // PA01
  assertEquals(count(m, "'orphan_capture_unsettled'"), 2, "refusal in resolve_paidy_case + self-check");
  assert(m.includes("CREATE OR REPLACE FUNCTION public.resolve_orphan_paidy_case_verified("));
  assert(m.includes("IF v_case.paidy_payment_row IS NOT NULL THEN RETURN jsonb_build_object('error', 'not_an_orphan'); END IF;"));
  assert(m.includes("p_refunded_jpy < p_captured_jpy THEN"), "only a FULL refund closes an orphan");
  // record_paidy_refund — the one writer: order lock first, idempotent, monotonic, bell once.
  assert(m.includes("CREATE OR REPLACE FUNCTION public.record_paidy_refund("));
  assert(m.includes("FOR UPDATE OF o;"), "order locked first");
  assert(m.includes("ON CONFLICT (refund_id) DO NOTHING;"));
  assert(m.includes("AND (refund_jpy IS NULL OR refund_jpy < v_total);"), "monotonic");
  assertEquals(count(m, "'paidy_refund_after_credit'"), 2, "bell type: dedupe check + insert");
  // Grants on every new function (CLAUDE.md: re-assert after CREATE).
  for (const sig of ["record_paidy_refund(text, uuid, numeric, text, timestamptz, jsonb)", "resolve_orphan_paidy_case_verified(uuid, numeric, numeric, jsonb)"]) {
    assert(m.includes(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`), `revoke ${sig}`);
    assert(m.includes(`GRANT EXECUTE ON FUNCTION public.${sig} TO service_role;`), `grant ${sig}`);
  }
  // Self-checks cover every patched function.
  for (const code of ["paidy_already_refunded", "paidy_refund_needs_dashboard", "no_verified_paidy_refund", "orphan_capture_unsettled"]) {
    assert(m.includes(`position('${code}' IN v) = 0`), `self-check ${code}`);
  }
});
