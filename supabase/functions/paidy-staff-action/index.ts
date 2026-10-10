// paidy-staff-action — the two Paidy staff actions that must talk to Paidy
// before the database is changed (Paidy QC PR-A, owner go 2026-10-09).
//
// POST { action: "end_window", cash_order_id, reason }
//   H1: the customer's Paidy window is stuck (timed out, but a payment id
//   noted on it cannot be verified — e.g. a made-up id Paidy answers 404 to).
//   Paidy is asked first: an authorisation it still holds is filed on its
//   order (or released when that order cannot take it), a capture opens the
//   locking capture case; only then does staff_end_paidy_checkout_window end
//   the window (confirm_payment, written reason, audited, timed-out windows
//   only). Paidy unreachable → nothing changes (fail closed).
//
// POST { action: "close_authorization", case_id }
//   M2: before "End its submission" on a Paidy case whose payment Paidy still
//   holds AUTHORISED, the authorisation is closed at Paidy (the classifying
//   release helper: only Paidy's own answer counts). resolve_paidy_case then
//   refuses end_submission until the row is no longer authorised.
//
// POST { action: "record_orphan_capture", case_id, reason }
//   QC PR-B DB M-3 (owner 2026-10-10, recommended A): Paidy took money the Hub
//   never filed (an orphan capture case). ADMIN ONLY. Paidy is read first
//   (nothing is ever sent to Paidy here); paidyOrphanCaptureProblem checks the
//   read-back; adopt_paidy_orphan_capture_atomic writes the Hub's receipt and
//   queues it; the ONE recording path (paidy_auto Confirm →
//   finalize_cash_submission_atomic) then records it. Paidy unreachable →
//   nothing changes.
//
// Person only (no service-role path): the audit row names who did it.
// Permission confirm_payment (the same people who resolve Paidy cases).

import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";
import { PaidyError, paidy, paidySecretIsTest, type PaidyPayment } from "../_shared/paidy.ts";
import { adoptOrphanAuthorization, orderForPaidyRef, paidyReleased, releasePaidyAuthorization } from "../_shared/paidy-filing.ts";
import { openPaidyCase } from "../_shared/paidy-sync.ts";
import { paidyApprovalHasWindow, paidyCapturedAmount, paidyLatestCapture, paidyMetadataAttemptId, paidyOrphanCaptureProblem, paidyProviderOutcome, paidyYen } from "../_shared/paidy-rules.ts";
import { paidyAutoRecord } from "../_shared/paidy-autorecord.ts";
import { customerReference } from "../_shared/order-reference.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUS: Record<string, number> = {
  forbidden: 403, reason_required: 400, not_found: 404, window_still_open: 409,
  user_identity_required: 401, paidy_unavailable: 502, paidy_holds_authorization: 409,
  not_authorized: 409, release_not_confirmed: 502, captured: 409, window_changed: 409,
  forbidden_admin_only: 403, case_not_found: 404, case_not_open: 409, case_not_orphan: 409,
  order_missing: 409, order_cannot_take_payment: 409, amount_differs_from_balance: 409,
  order_part_paid: 409, not_yen: 409, paidy_not_captured: 409, paidy_refunded: 409,
  paidy_capture_mismatch: 409, paidy_order_mismatch: 409, paidy_environment_mismatch: 409,
  payment_in_progress: 409, already_recorded: 409, bad_amount: 409, paidy_not_tied_to_order: 409,
};

const ORPHAN_MESSAGES: Record<string, string> = {
  forbidden_admin_only: "Only an admin can record a Paidy payment from a case.",
  reason_required: "Write a reason of at least 10 characters.",
  case_not_found: "This Paidy case was not found.",
  case_not_open: "This Paidy case is already resolved.",
  case_not_orphan: "This case already has a Hub record of the payment — use the case's own actions.",
  order_missing: "Paidy's payment does not name a Hub order this case knows. Check the Paidy dashboard.",
  order_cannot_take_payment: "The order can no longer take a payment (it is not pending). Refund it in the Paidy dashboard instead.",
  amount_differs_from_balance: "Paidy's amount is not the order's balance. Nothing was recorded.",
  order_part_paid: "Something is already paid on this order. Nothing was recorded.",
  not_yen: "The order is not in yen. Nothing was recorded.",
  paidy_not_captured: "Paidy does not report this payment as captured. Nothing was recorded.",
  paidy_refunded: "Paidy reports a refund on this payment. Nothing was recorded.",
  paidy_capture_mismatch: "Paidy's capture does not equal the whole payment in yen. Nothing was recorded.",
  paidy_order_mismatch: "Paidy's payment names a different order. Nothing was recorded.",
  paidy_environment_mismatch: "Test and live do not match (Paidy mode or a test customer). Nothing was recorded.",
  payment_in_progress: "Another payment is waiting on this order. Decide that one first.",
  already_recorded: "The Hub already has a record of this Paidy payment.",
  bad_amount: "Paidy's amount could not be read as whole yen. Nothing was recorded.",
  paidy_not_tied_to_order: "This order never opened Paidy for this payment, so the Hub will not record it here. Refund it in the Paidy dashboard and check with the customer.",
};

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  const ctx = await requireAuth(req);
  if (ctx instanceof Response) return ctx;
  const denied = await requirePermission(ctx, "confirm_payment");
  if (denied) return denied;
  const supabase = ctx.supabase;
  const userId = ctx.user!.id;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return jsonResponse({ error: "bad_json" }, 400); }
  const fail = (error: string, extra: Record<string, unknown> = {}) => jsonResponse({ ok: false, error, ...extra }, STATUS[error] ?? 400);

  try {
    if (body.action === "end_window") {
      const orderId = typeof body.cash_order_id === "string" && UUID_RE.test(body.cash_order_id) ? body.cash_order_id : null;
      const reason = String(body.reason ?? "").trim();
      if (!orderId) return fail("not_found");
      if (reason.length < 10) return fail("reason_required");

      const { data: win, error: winErr } = await supabase.from("paidy_checkout_attempts")
        .select("id, paidy_payment_id, expires_at").eq("cash_order_id", orderId).eq("status", "open").maybeSingle();
      if (winErr) throw winErr;
      if (!win) return jsonResponse({ ok: true, ended: 0 });
      if (Date.parse(String(win.expires_at)) > Date.now()) return fail("window_still_open", { expires_at: win.expires_at });

      // Ask Paidy what the window's payment holds (if it named one the Hub
      // has no record of). The answer goes into the audit row.
      // staff_end_paidy_checkout_window refuses if the window's id changed
      // after this check (window_changed) — the answer below is about THIS id.
      let check: Record<string, unknown> = { paidy_payment_id: win.paidy_payment_id ?? null };
      const pid = win.paidy_payment_id ? String(win.paidy_payment_id) : null;
      if (pid) {
        const { data: row, error: rowErr } = await supabase.from("paidy_payments").select("id").eq("paidy_payment_id", pid).maybeSingle();
        if (rowErr) throw rowErr;
        if (row) {
          check = { ...check, hub_record: true };
        } else {
          let live: PaidyPayment | null = null;
          try {
            live = await paidy.get(pid);
          } catch (e) {
            if (e instanceof PaidyError && e.status === 404) {
              let family = "unknown";
              try { family = paidySecretIsTest() ? "test" : "live"; } catch { /* reported below */ }
              check = { ...check, paidy: "not_found", key: family };
            } else {
              console.error("[paidy-staff-action] paidy.get failed:", e);
              return fail("paidy_unavailable", { message: "Could not check the window's payment with Paidy. Nothing was changed; try again in a few minutes." });
            }
          }
          if (live) {
            const outcome = paidyProviderOutcome(live);
            check = { ...check, paidy: outcome, test: live.test };
            if (outcome === "authorized") {
              // The money is with Paidy (owner Q3): file it on the order its
              // order_ref names, or release it when that order cannot take it.
              const routed = await adoptOrphanAuthorization(supabase, live, "paidy_reconcile");
              check = { ...check, routed };
              if (!routed.startsWith("released") && !routed.startsWith("filed")) {
                return fail("paidy_holds_authorization", { routed, message: `Paidy still holds an authorisation for ${pid} (${routed}). Nothing was ended — see Payment Submissions → Paidy cases.` });
              }
            } else if (outcome === "captured") {
              const order = await orderForPaidyRef(supabase, live.order?.order_ref);
              await openPaidyCase(supabase, {
                kind: "captured_no_submission", paidy_payment_id: pid, cash_order_id: order?.id ?? orderId,
                detail: { order_ref: live.order?.order_ref ?? null, captured_jpy: paidyCapturedAmount(live), no_hub_record: true, from_window: win.id, staff_check: true },
                bell: { title: "Paidy took a payment the Hub has no record of", body: `${pid} · ¥${Math.round(Number(live.amount) || 0).toLocaleString("en-US")} · found when staff ended a Paidy window — Payment Submissions → Paidy cases.` },
              });
            } else if (outcome === "unknown") {
              return fail("paidy_unavailable", { message: "Paidy's answer could not be read. Nothing was changed; try again in a few minutes." });
            }
          }
        }
      }

      const { data, error } = await supabase.rpc("staff_end_paidy_checkout_window", {
        p_cash_order_id: orderId, p_user_id: userId, p_reason: reason, p_check: check,
      });
      if (error) throw error;
      const r = (data ?? {}) as Record<string, unknown>;
      if (!r.ok) return fail(String(r.error ?? "end_failed"), r);
      return jsonResponse({ ok: true, ended: r.ended, lock_after: r.lock_after ?? null, check });
    }

    if (body.action === "close_authorization") {
      const caseId = typeof body.case_id === "string" && UUID_RE.test(body.case_id) ? body.case_id : null;
      if (!caseId) return fail("not_found");
      const { data: c, error: cErr } = await supabase.from("paidy_cases")
        .select("id, status, cash_order_id, paidy_payment_row, paidy_payment_id").eq("id", caseId).maybeSingle();
      if (cErr) throw cErr;
      if (!c || c.status !== "open" || !c.paidy_payment_row) return fail("not_found");
      const { data: row, error: rowErr } = await supabase.from("paidy_payments")
        .select("id, status, paidy_payment_id, cash_order_id").eq("id", c.paidy_payment_row).maybeSingle();
      if (rowErr) throw rowErr;
      if (!row) return fail("not_found");
      if (row.status !== "authorized") return jsonResponse({ ok: true, closed: false, status: row.status });

      let live: PaidyPayment;
      try {
        live = await paidy.get(String(row.paidy_payment_id));
      } catch (e) {
        console.error("[paidy-staff-action] paidy.get before close failed:", e);
        return fail("paidy_unavailable", { message: "Could not reach Paidy. Nothing was changed; try again in a few minutes." });
      }
      const release = await releasePaidyAuthorization(supabase, live, {
        cash_order_id: row.cash_order_id, paidy_payment_row: row.id, why: `staff ending its submission (case ${caseId})`,
      });
      await supabase.from("audit_logs").insert({
        entity_type: "paidy_case", entity_id: caseId, action: "paidy_authorization_close_requested",
        performed_by_user_id: userId,
        new_value_json: { paidy_payment_id: row.paidy_payment_id, release, actor: "staff" },
      });
      if (release === "captured") return fail("captured", { message: "Paidy reports this payment CAPTURED — it was not closed. Record the capture instead." });
      if (!paidyReleased(release)) {
        return fail("release_not_confirmed", { release, message: "Paidy did not confirm the close. A 'Release pending' case was opened and the hourly check retries; the submission was not ended." });
      }
      return jsonResponse({ ok: true, closed: true });
    }

    if (body.action === "record_orphan_capture") {
      const caseId = typeof body.case_id === "string" && UUID_RE.test(body.case_id) ? body.case_id : null;
      const reason = String(body.reason ?? "").trim();
      const orphanFail = (code: string, extra: Record<string, unknown> = {}) =>
        fail(code, { message: ORPHAN_MESSAGES[code] ?? code, ...extra });
      // Admin only (the database checks it again).
      const { data: adminRow, error: adminErr } = await supabase.from("user_roles")
        .select("role").eq("user_id", userId).eq("role", "admin").maybeSingle();
      if (adminErr) throw adminErr;
      if (!adminRow) return orphanFail("forbidden_admin_only");
      if (!caseId) return orphanFail("case_not_found");
      if (reason.length < 10) return orphanFail("reason_required");
      const { data: c, error: cErr } = await supabase.from("paidy_cases")
        .select("id, kind, status, cash_order_id, paidy_payment_row, paidy_payment_id").eq("id", caseId).maybeSingle();
      if (cErr) throw cErr;
      if (!c) return orphanFail("case_not_found");
      if (c.status !== "open") return orphanFail("case_not_open");
      if (c.paidy_payment_row || !["captured_unrecorded", "captured_no_submission", "record_failed"].includes(String(c.kind))) return orphanFail("case_not_orphan");
      if (!c.cash_order_id) return orphanFail("order_missing");
      const { data: order, error: oErr } = await supabase.from("cash_orders")
        .select("id, invoice_number, web_reference, source_channel").eq("id", c.cash_order_id).maybeSingle();
      if (oErr) throw oErr;
      if (!order) return orphanFail("order_missing");

      let live: PaidyPayment;
      try {
        live = await paidy.get(String(c.paidy_payment_id));
      } catch (e) {
        console.error("[paidy-staff-action] paidy.get for orphan capture failed:", e);
        return fail("paidy_unavailable", { message: "Could not reach Paidy. Nothing was changed; try again in a few minutes." });
      }
      let expectTest: boolean;
      try { expectTest = paidySecretIsTest(); } catch { return fail("paidy_unavailable", { message: "Paidy is not configured on the Hub. Nothing was changed." }); }
      const problem = paidyOrphanCaptureProblem(live, { id: String(order.id), ref: customerReference(order as never) }, expectTest);
      if (problem) return orphanFail(problem);
      // Review LOW-3: the same binding adoption uses — this order opened Paidy for it.
      const { data: wins, error: wErr } = await supabase.from("paidy_checkout_attempts")
        .select("id, started_at").eq("cash_order_id", order.id).order("started_at", { ascending: false }).limit(50);
      if (wErr) throw wErr;
      if (!paidyApprovalHasWindow(live.created_at, (wins ?? []) as Array<{ id: unknown; started_at: unknown }>, paidyMetadataAttemptId(live))) {
        return orphanFail("paidy_not_tied_to_order");
      }
      const capture = paidyLatestCapture(live);
      const { data: adopted, error: aErr } = await supabase.rpc("adopt_paidy_orphan_capture_atomic", {
        p_case_id: caseId, p_user_id: userId, p_reason: reason,
        p_amount_jpy: paidyYen(live.amount), p_test: live.test === true,
        p_authorized_at: live.created_at ?? null, p_captured_at: capture?.created_at ?? null,
        p_capture_id: capture?.id ?? null, p_payload: live,
      });
      if (aErr) throw aErr;
      const a = (adopted ?? {}) as Record<string, unknown>;
      if (a.ok !== true) return orphanFail(String(a.error ?? "adopt_failed"), a);
      // The ONE recording path: the same paidy_auto Confirm a dashboard capture gets.
      const rec = await paidyAutoRecord(String(a.submission_id));
      return jsonResponse({
        ok: true, outcome: rec.ok ? "recorded" : "queued", submission_id: a.submission_id,
        message: rec.ok
          ? "Recorded. The order is updated and staff were notified."
          : "Filed. The Hub records it within the hour, or press Confirm on it in Payment Submissions now.",
      });
    }

    return jsonResponse({ error: "bad_action" }, 400);
  } catch (e) {
    console.error("[paidy-staff-action] failed:", e);
    return jsonResponse({ error: "internal_error" }, 500);
  }
});
