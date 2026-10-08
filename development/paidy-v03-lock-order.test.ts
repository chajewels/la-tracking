/**
 * Paidy sign-off V03, finding F1 (owner go 2026-10-09 02:42 JST).
 * Evidence: project doc claude/paidy-v02-v03-evidence-2026-10-09.md.
 *
 * The Hub's payment writers take their row locks in ONE order — the
 * submission, then the order, then the provider row. Reject used to take the
 * order first and could deadlock against a Confirm (V03 race R3). These
 * guards keep the migration that fixed it honest.
 */
import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const read = (p: string) => Deno.readTextFile(new URL(p, import.meta.url));
const MIG = "../supabase/migrations/20261130120000_paidy_v03_f1_reject_lock_order.sql";

Deno.test("F1: the patch is md5-guarded from live and targets reject_paidy_submission_atomic only", async () => {
  const sql = await read(MIG);
  assertStringIncludes(sql, "SELECT pg_temp.cj_patch('public.reject_paidy_submission_atomic(uuid,uuid,text,uuid,text,text,jsonb)', '35539cd1f11b891abb5b9c1a7272f201',");
  assert(!/cj_patch\('public\.finalize_cash_submission_atomic/.test(sql), "finalize keeps the shared order — it is not patched");
  assertStringIncludes(sql, "GRANT EXECUTE ON FUNCTION public.reject_paidy_submission_atomic(uuid,uuid,text,uuid,text,text,jsonb) TO service_role;");
});

Deno.test("F1: the new opening locks the submission before the order", async () => {
  const sql = await read(MIG);
  const at = sql.indexOf("'new', E'");
  assert(at > 0, "new body text present");
  const newText = sql.slice(at, sql.indexOf("'\n", at + 10));
  const sub = newText.indexOf("SELECT * INTO v_sub FROM public.payment_submissions WHERE id = p_submission_id FOR UPDATE;");
  const ord = newText.indexOf("PERFORM 1 FROM public.cash_orders o WHERE o.id = v_order_id FOR UPDATE;");
  assert(sub > 0 && ord > sub, "submission lock comes first, order lock second");
});

Deno.test("F1: the migration's own self-check refuses an order-first body", async () => {
  const sql = await read(MIG);
  assertStringIncludes(sql, "RAISE EXCEPTION 'self-check: reject_paidy_submission_atomic still locks the order before the submission';");
});
