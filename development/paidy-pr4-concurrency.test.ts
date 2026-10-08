/**
 * Paidy reassessment PR 4 — money concurrency (PA06 / PA14 / PA07), owner go
 * 2026-10-08 23:16 JST. Plan: claude/paidy-pr4-concurrency-plan-2026-10-08.md.
 *
 *   PA06  the Paidy Reject's Hub record is ONE atomic write under the order
 *         lock (reject_paidy_submission_atomic): no direct paidy_payments /
 *         payment_submissions UPDATE and no unchecked audit insert remain in
 *         the Paidy reject branches; the customer email is an intent.
 *   PA14  the webhook budget is measured from receipt; a staff cancel writes
 *         its intent BEFORE the Paidy release and advances it per stage; the
 *         sweep finishes only from paidy_released on, never from started;
 *         follow-up emails are sent only when never attempted.
 *   PA07  every case kind has a bell text; the sweep rings unrung bells once.
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { PAIDY_CASE_KINDS, paidyCaseBell } from "../supabase/functions/_shared/paidy-case-bell.ts";
import type { PaidyCaseKind } from "../supabase/functions/_shared/paidy-sync.ts";

const read = (p: string) => Deno.readTextFile(new URL(p, import.meta.url));

Deno.test("PA06: the Paidy reject branches write through reject_paidy_submission_atomic only", async () => {
  const src = await read("../supabase/functions/review-payment-submission/index.ts");
  const start = src.indexOf("// PAIDY: Reject releases the authorisation");
  const end = src.indexOf("// Update submission status");
  assert(start > 0 && end > start, "reject section found");
  const section = src.slice(start, end);
  assertEquals((section.match(/from\("paidy_payments"\)\.update\(/g) ?? []).length, 0, "no direct paidy_payments update in the reject section");
  assertStringIncludes(section, 'rpc("reject_paidy_submission_atomic", {');
  assertStringIncludes(section, 'if (r.error === "conflict") {');
  assertStringIncludes(section, 'if (r.error === "paidy_captured") {');
  // The generic write and audit are skipped once the atomic write happened.
  assertStringIncludes(src, "const { data: updatedRows, error: updateErr } = paidyRejectDone\n      ? { data: [{ id: submission_id }], error: null }");
  assertStringIncludes(src, 'if (!paidyRejectDone) await supabase.from("audit_logs").insert({');
  // The email intent is closed only after the send was reached.
  assertStringIncludes(src, '.from("payment_submission_followups")\n              .update({ status: "done"');
});

Deno.test("PA06 migration: order lock first, compare-and-set, audit + intent in one transaction, service_role only", async () => {
  const sql = await read("../supabase/migrations/20261128100000_paidy_pr4_concurrency.sql");
  assertStringIncludes(sql, "PERFORM 1 FROM public.cash_orders o WHERE o.id = v_order_id FOR UPDATE;");
  assertStringIncludes(sql, "IF v_sub.status NOT IN ('submitted', 'under_review') THEN\n    RETURN jsonb_build_object('ok', false, 'error', 'conflict', 'status', v_sub.status);");
  assertStringIncludes(sql, "IF v_row.status = 'captured' THEN RETURN jsonb_build_object('ok', false, 'error', 'paidy_captured'); END IF;");
  assertStringIncludes(sql, "WHERE id = p_paidy_row AND status = 'authorized';");
  assertStringIncludes(sql, "INSERT INTO public.payment_submission_followups (kind, submission_id, cash_order_id, idempotency_key, payload)");
  assertStringIncludes(sql, "v_key := 'payment-rejected-' || p_submission_id::text;");
  assertStringIncludes(sql, "GRANT EXECUTE ON FUNCTION public.reject_paidy_submission_atomic(uuid, uuid, text, uuid, text, text, jsonb) TO service_role;");
  assertStringIncludes(sql, "REVOKE ALL ON FUNCTION public.reject_paidy_submission_atomic(uuid, uuid, text, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;");
  for (const tbl of ["payment_submission_followups", "cash_order_cancel_intents"]) {
    assertStringIncludes(sql, `ALTER TABLE public.${tbl} ENABLE ROW LEVEL SECURITY;`);
    assertStringIncludes(sql, `GRANT ALL ON public.${tbl} TO service_role;`);
    assertStringIncludes(sql, `REVOKE ALL ON public.${tbl} FROM anon;`);
  }
  assertStringIncludes(sql, "ALTER TABLE public.paidy_cases ADD COLUMN IF NOT EXISTS bell_rung_at timestamptz;");
  assertStringIncludes(sql, "CHECK (stage IN ('started', 'paidy_released', 'terminated', 'notified', 'done', 'abandoned'))");
});

Deno.test("PA06 key: the follow-up intent uses the sender's own idempotency key", async () => {
  const sender = await read("../supabase/functions/_shared/payment-rejected-email.ts");
  assertStringIncludes(sender, "const idempotencyKey = `payment-rejected-${sub.id}`;");
});

Deno.test("PA14: the webhook's budget is measured from request receipt, with a floor", async () => {
  const src = await read("../supabase/functions/paidy-webhook/index.ts");
  const recv = src.indexOf("const receivedAt = Date.now();");
  const pre = src.indexOf("const pre = corsPreflight(req);");
  const insert = src.indexOf('.from("paidy_webhook_events").insert(');
  assert(recv > 0 && recv < pre && pre < insert, "receipt time is taken before anything else");
  assertStringIncludes(src, "const budgetMs = Math.max(MIN_PROCESS_BUDGET_MS, PROCESS_DEADLINE_MS - (Date.now() - receivedAt));");
  assertStringIncludes(src, "setTimeout(() => resolve(\"deadline\"), budgetMs)");
  assertStringIncludes(src, "const MIN_PROCESS_BUDGET_MS = 1500;");
});

Deno.test("PA14: cancel-cash-order writes its intent before the Paidy release and advances it per stage", async () => {
  const src = await read("../supabase/functions/cancel-cash-order/index.ts");
  const open = src.indexOf("intentId = await openCancelIntent(supabase, {");
  const release = src.indexOf("const rel = await releasePaidyForCancel(supabase, cash_order_id, user.id);");
  const terminate = src.indexOf('? await supabase.rpc("terminate_web_order_atomic", {');
  assert(open > 0 && open < release && release < terminate, "intent → release → terminate");
  assertStringIncludes(src, 'await advanceCancelIntent(supabase, intentId, "paidy_released");');
  assertStringIncludes(src, 'await advanceCancelIntent(supabase, intentId, "terminated");');
  assertStringIncludes(src, 'await advanceCancelIntent(supabase, intentId, "notified");');
  assertStringIncludes(src, 'await advanceCancelIntent(supabase, intentId, "done");');
  assertStringIncludes(src, 'await advanceCancelIntent(supabase, intentId, releaseDone ? "paidy_released" : "abandoned", msg.split(":")[0]);');
  // The follow-ups are the shared module (used by the sweep too); no inline bell inserts remain.
  assertStringIncludes(src, "await emitCancellationFollowups(supabase, { cash_order_id, isWeb, c, orderRow, reason, refundStatus, refundNote });");
  assertEquals((src.match(/from\("staff_notifications"\)\.insert\(/g) ?? []).length, 0);
});

Deno.test("PA14: the sweep finishes an interrupted cancel only from paidy_released on; started only rings a bell", async () => {
  const src = await read("../supabase/functions/paidy-reconcile/index.ts");
  assertStringIncludes(src, '.in("stage", ["started", "paidy_released", "terminated", "notified"]).lte("updated_at", cut)');
  assertStringIncludes(src, 'if (it.stage === "started") {\n          if (it.bell_rung_at) continue;');
  assertStringIncludes(src, 'if (it.stage === "paidy_released") {\n            const { data, error } = await supabase.rpc("terminate_web_order_atomic", {');
  // A refusal when finishing goes back to staff, never forced.
  assertStringIncludes(src, 'if (d.ok === false && d.reason !== "already_terminal") {');
  assertStringIncludes(src, 'await advanceCancelIntent(supabase, it.id, "abandoned", String(d.reason ?? "refused"));');
});

Deno.test("PA06 / owner rule: the sweep sends a follow-up email only when the Hub never reached the send", async () => {
  const src = await read("../supabase/functions/paidy-reconcile/index.ts");
  assertStringIncludes(src, '.contains("metadata", { idempotency_key: fu.idempotency_key }).limit(1);');
  assertStringIncludes(src, "const attempted = (logged ?? []).length > 0;");
  assertStringIncludes(src, "if (!attempted) {");
  assertStringIncludes(src, 'last_error: attempted ? "already_attempted" : null');
  assertStringIncludes(src, "if (Number(fu.attempts ?? 0) >= 3) {");
});

Deno.test("PA07: every case kind has a bell; the sweep rings unrung bells once and stamps the case", async () => {
  const kinds: PaidyCaseKind[] = [
    "close_failed", "captured_unrecorded", "captured_no_submission", "refund_before_record",
    "refund_after_record", "record_failed", "unmatched_authorization", "provider_unreadable", "stale_authorization",
  ];
  assertEquals([...PAIDY_CASE_KINDS].sort(), [...kinds].sort());
  for (const kind of kinds) {
    const b = paidyCaseBell({ kind, paidy_payment_id: "pay_unit0001", detail: { captured_jpy: 20000, why: "unit" }, reference: "CJ-W-000001" });
    assertEquals(b.type, `paidy_case_${kind}`);
    assert(b.title.length > 0 && b.body.includes("pay_unit0001") && b.body.includes("CJ-W-000001"));
  }
  const sync = await read("../supabase/functions/_shared/paidy-sync.ts");
  assertStringIncludes(sync, 'await supabase.from("paidy_cases").update({ bell_rung_at: new Date().toISOString() }).eq("id", r.case_id);');
  const sweep = await read("../supabase/functions/paidy-reconcile/index.ts");
  assertStringIncludes(sweep, '.eq("status", "open").is("bell_rung_at", null)');
  assertStringIncludes(sweep, '.contains("metadata", { case_id: c.id }).limit(1);');
  assertStringIncludes(sweep, 'metadata: { case_id: c.id, cash_order_id: c.cash_order_id ?? null, paidy_payment_id: c.paidy_payment_id, kind: c.kind, late: true }');
});
