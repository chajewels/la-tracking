/**
 * Paidy QC PR-B (owner go 2026-10-10 17:10 JST, "proceed with the plan and
 * recommended"). The database behaviour (partial refund refused, a noted
 * window kept, environment binding, reject guard, refund-over-capture, the
 * Hub-order cancel guard, the orphan-capture adoption end to end through
 * finalize, the staff lock reader and every grant) was proved on a scratch
 * replay whose Paidy bodies are byte-identical to live (docs/PAIDY.md "QC
 * PR-B"). These tests pin the pure rules and keep the wiring and the migration
 * honest in CI. Wiring greps run on comment-stripped code.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { paidyApprovalHasWindow, paidyNotOfferedReason, paidyOrphanCaptureProblem } from "../supabase/functions/_shared/paidy-rules.ts";

const root = new URL("../", import.meta.url);
const raw = (p: string) => Deno.readTextFileSync(new URL(p, root));
const code = (p: string) => raw(p).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*|--)/.test(l)).join("\n");
const MIG = "supabase/migrations/20261206100000_paidy_qc_pr_b.sql";

Deno.test("M3: an approval is tied to an order only by a window that order opened around then", () => {
  const created = "2026-10-10T08:00:00Z";
  assertEquals(paidyApprovalHasWindow(created, ["2026-10-10T07:50:00Z"]), true);
  assertEquals(paidyApprovalHasWindow(created, ["2026-10-10T06:01:00Z"]), true); // within 2 h before
  assertEquals(paidyApprovalHasWindow(created, ["2026-10-10T05:59:00Z"]), false); // more than 2 h before
  assertEquals(paidyApprovalHasWindow(created, ["2026-10-10T08:09:00Z"]), true); // 9 min after (clock skew)
  assertEquals(paidyApprovalHasWindow(created, ["2026-10-10T08:11:00Z"]), false);
  assertEquals(paidyApprovalHasWindow(created, []), false);
  assertEquals(paidyApprovalHasWindow("not a date", ["2026-10-10T07:50:00Z"]), false);
});

Deno.test("L1: the secret key's family is checked before she can approve", () => {
  const base = {
    mode: "on" as const, publicKey: "pk_live_abcdefabcdef", customerIsTest: false,
    order: { currency: "JPY", status: "pending", payment_status: "pending_transfer", remaining_balance: 10000, source_channel: "hub_manual" },
    address: { country: "JP", line1: "1-1", city: "Katsushika", region: "Tokyo", postal_code: "1240012" },
    pendingSubmissions: 0,
  };
  assertEquals(paidyNotOfferedReason({ ...base, secretTest: null }), "secret_not_configured");
  assertEquals(paidyNotOfferedReason({ ...base, secretTest: true }), "secret_mode_mismatch");
  assertEquals(paidyNotOfferedReason({ ...base, secretTest: false }), null);
  assertEquals(paidyNotOfferedReason({ ...base }), null, "older callers (no secretTest) unchanged");
  assertEquals(paidyNotOfferedReason({ ...base, mode: "test", publicKey: "pk_test_abcdefabcdef", customerIsTest: true, secretTest: false }), "secret_mode_mismatch");
});

Deno.test("DB M-3: an orphan capture is recorded only from a clean Paidy read-back", () => {
  const order = { id: "o-1", ref: "CJ-W-000123" };
  const ok = {
    status: "CLOSED", amount: 50000, currency: "JPY", test: false,
    captures: [{ id: "cap_1", amount: 50000, created_at: "2026-10-10T08:00:00Z" }], refunds: [],
    order: { order_ref: "CJ-W-000123" },
  };
  assertEquals(paidyOrphanCaptureProblem(ok, order, false), null);
  assertEquals(paidyOrphanCaptureProblem({ ...ok, captures: [] }, order, false), "paidy_not_captured");
  assertEquals(paidyOrphanCaptureProblem({ ...ok, refunds: [{ id: "ref_1", amount: 1000 }] }, order, false), "paidy_refunded");
  assertEquals(paidyOrphanCaptureProblem({ ...ok, captures: [{ id: "c", amount: 40000 }] }, order, false), "paidy_capture_mismatch");
  assertEquals(paidyOrphanCaptureProblem({ ...ok, captures: [{ id: "a", amount: 25000 }, { id: "b", amount: 25000 }] }, order, false), "paidy_capture_mismatch");
  assertEquals(paidyOrphanCaptureProblem({ ...ok, currency: "USD" }, order, false), "paidy_capture_mismatch");
  assertEquals(paidyOrphanCaptureProblem({ ...ok, order: { order_ref: "CJ-W-000999" } }, order, false), "paidy_order_mismatch");
  assertEquals(paidyOrphanCaptureProblem({ ...ok, order: null, metadata: { cash_order_id: "o-1" } }, order, false), null);
  assertEquals(paidyOrphanCaptureProblem(ok, order, true), "paidy_environment_mismatch");
});

Deno.test("edge M1: a later approval behind another waiting payment is released (first payment wins)", () => {
  const c = code("supabase/functions/_shared/paidy-filing.ts");
  assert(/if \(err === "submission_pending"\) \{\n\s+const lock = /.test(c), "filing releases on submission_pending");
  assert(c.includes('why: `another payment was already waiting (${lock})`'));
  assert(!c.includes('"Paidy authorisation waiting behind another payment"'), "the old wait-and-see bell is gone");
  assert(c.includes('if (result.error === "submission_pending") {\n    return result.released ? "released_first_payment_wins"'));
});

Deno.test("edge M2: the webhook notes an early approval on her window", () => {
  const c = code("supabase/functions/_shared/paidy-events.ts");
  const grace = c.indexOf('outcome === "authorized" && ageMs < ORPHAN_GRACE_MS');
  const note = c.indexOf('rpc("note_paidy_window_authorization"', grace);
  const park = c.indexOf('last_error: "callback_window"', grace);
  assert(grace > 0 && note > grace && park > note, `order grace=${grace} note=${note} park=${park}`);
});

Deno.test("edge M3: an approval is never filed on another customer's order", () => {
  const web = code("supabase/functions/website/index.ts");
  assert(web.includes('if (named && String(named.customer_id) !== String(customer.id)) {'));
  assert(web.includes('why: "names another customer\'s order"'));
  const fil = code("supabase/functions/_shared/paidy-filing.ts");
  const bind = fil.indexOf("if (!paidyApprovalHasWindow(payment.created_at,");
  const file = fil.indexOf("const result = await filePaidyAuthorization(supabase, {");
  assert(bind > 0 && file > bind, "adoption checks the window binding before filing");
});

Deno.test("web M1: a window holding an approval shows as processing, not 'open Paidy again'", () => {
  const web = code("supabase/functions/website/index.ts");
  assert(web.includes('.not("authorization_noted_at", "is", null).is("verified_empty_at", null);'));
  assert(web.includes('const windowOnly = lock === "paidy_checkout_open" && !windowHoldsApproval'));
});

Deno.test("L1 wiring + orphan action + recorded bell", () => {
  const web = code("supabase/functions/website/index.ts");
  assert(web.includes("secretTest: (() => { try { return paidySecretIsTest(); } catch { return null; } })(),"));
  const act = code("supabase/functions/paidy-staff-action/index.ts");
  assert(act.includes('if (body.action === "record_orphan_capture") {'));
  assert(act.includes('.select("role").eq("user_id", userId).eq("role", "admin").maybeSingle();'), "admin only");
  const get = act.indexOf('live = await paidy.get(String(c.paidy_payment_id));');
  const rule = act.indexOf("const problem = paidyOrphanCaptureProblem(live,");
  const adopt = act.indexOf('supabase.rpc("adopt_paidy_orphan_capture_atomic"');
  const record = act.indexOf("const rec = await paidyAutoRecord(String(a.submission_id));");
  assert(get > 0 && rule > get && adopt > rule && record > adopt, `order get=${get} rule=${rule} adopt=${adopt} record=${record}`);
  const rps = code("supabase/functions/review-payment-submission/index.ts");
  assert(rps.includes('await paidyBell(supabase, "paidy_payment_recorded",'));
  const mri = code("supabase/functions/mark-refund-issued/index.ts");
  assert(mri.includes("paidy_paid_jpy: r.paidy_paid_jpy ?? null, paidy_refunded_jpy: r.paidy_refunded_jpy ?? null,"), "partial-refund figures reach the dialog");
  const rec = code("supabase/functions/paidy-reconcile/index.ts");
  assert(rec.includes("If Paidy reports the capture, the next check finishes it."), "L2 bell text");
});

Deno.test("migration: md5-guarded patches, new functions guarded and granted", () => {
  const m = raw(MIG);
  for (const md5 of ["3e770287adf43a82728d426d3e786bac", "fdece38f899856663b73f4533cf5e286", "07ac74de7588a55abe0a6ba19f9c240a", "b74650c77ac470c8fcf9043dba26a6f8", "79832d1661493102dde99658eff479eb"]) {
    assert(m.includes(`'${md5}'`), md5);
  }
  assert(m.includes("''paidy_refund_incomplete''"), "M-1");
  assert(m.includes("AND paidy_payment_id IS DISTINCT FROM p_paidy_payment_id);"), "M-2");
  assert(m.includes("''paidy_environment_mismatch''"), "L-3");
  assert(m.includes("PERFORM public.assert_staff_caller(NULL);"), "staff reader checks its caller");
  assert(m.includes("IF p_user_id IS NULL OR NOT public.has_role(p_user_id, 'admin') THEN"), "adopt is admin only");
  assert(m.includes("REVOKE ALL ON FUNCTION public.adopt_paidy_orphan_capture_atomic(uuid, uuid, text, numeric, boolean, timestamp with time zone, timestamp with time zone, text, jsonb) FROM PUBLIC, anon, authenticated;"));
  assert(m.includes("GRANT EXECUTE ON FUNCTION public.adopt_paidy_orphan_capture_atomic(uuid, uuid, text, numeric, boolean, timestamp with time zone, timestamp with time zone, text, jsonb) TO service_role;"));
  assert(m.includes("REVOKE ALL ON FUNCTION public.cash_order_payment_lock_for_staff(uuid) FROM PUBLIC, anon;"));
});
