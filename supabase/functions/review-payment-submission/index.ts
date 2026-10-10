import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { checkPermission } from "../_shared/check-permission.ts";
import { appendManyReceipts, type CashReceiptSlot } from "../_shared/cash-receipt.ts";
import { sendTemplateEmail } from "../_shared/transactional-email-templates/send-email.ts";
import { refreshPaymentTracking } from "../_shared/payment-tracking.ts";
import { emailLang, sendStorefrontEmail, snapshotCountry, storefrontLayawayUrl, storefrontOrderUrl } from "../_shared/storefront-email.ts";
import { OrderPaymentReceivedEmail, orderPaymentReceivedSubject } from "../_shared/email-templates/order-payment-received.tsx";
import { LayawayPaymentReceivedEmail, layawayPaymentReceivedSubject } from "../_shared/email-templates/layaway-payment-received.tsx";
import * as React from "npm:react@18.3.1";
import { customerReference } from "../_shared/order-reference.ts";
import { firstUnconfirmedReservation, staffNotReadyForPaymentBody } from "../_shared/web-reservation-rules.ts";
import { maskEmail } from "../_shared/redact.ts";
import { PaidyError, paidy, type PaidyPayment } from "../_shared/paidy.ts";
import {
  PAIDY_CONFIRM_LEASE_MS, paidyCapturedAmount, paidyConfirmLeaseExpired,
  paidyJapanDate, paidyLatestCapture, paidyProviderOutcome, paidyRecordProblem, paidyRefundTotal,
} from "../_shared/paidy-rules.ts";
import { paidyBell } from "../_shared/paidy-filing.ts";
import { paidyRecordedBell, ringPaidyRecordedBell } from "../_shared/paidy-recorded-bell.ts";
import { openPaidyCase } from "../_shared/paidy-sync.ts";
import { PAIDY_AUTO_ACTOR, verifyPaidyAutoSignature } from "../_shared/paidy-autorecord.ts";
import { SquareError, paymentFacts, square, type SquarePayment } from "../_shared/square.ts";
import { cardCaptureOrderRefusal, isCanonicalYen, jstDate } from "../_shared/card-rules.ts";
import { applyPaymentState, syncSquareRefund } from "../_shared/square-sync.ts";
import { notAcceptedMethod, sendCashPaymentRejectedEmail } from "../_shared/payment-rejected-email.ts";
import { regionForCurrency } from "../_shared/transfer-methods.ts";
import { isWebEntity, reviewEmailKey, routeSubmissionEmail, sendOrderUpdateEmail } from "../_shared/order-update-email.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// award-loyalty-points skip reasons that surface as operator notifications.
// Benign skips (not_enrolled, below_minimum, already_awarded, no_loyalty_amount,
// missing_source) stay silent.
const ANOMALOUS_SKIP_REASONS = ["loyalty_disabled", "tier_not_found", "account_not_found", "cash_order_not_found"];

/**
 * Loyalty enrollment pre-check. Returns true iff a `loyalty_members` row
 * exists for the resolved customer. Used to gate award-loyalty-points
 * calls so non-enrolled customers never enter the loyalty pipeline (no
 * fetch, no push to loyaltyAwards / cashLoyaltyAward, no notification).
 *
 * Resolves the customer in this order:
 *   1. `customerId` arg if non-empty (cash path: cashOrder.customer_id;
 *      layaway paths: submission.customer_id).
 *   2. layaway_accounts.customer_id by `accountIdFallback` when the
 *      submission row didn't carry a customer_id.
 */
async function isCustomerLoyaltyEnrolled(
  supabase: any,
  customerId: string | null | undefined,
  accountIdFallback?: string | null,
): Promise<boolean> {
  let cid = customerId ?? null;
  if (!cid && accountIdFallback) {
    const { data: acct } = await supabase
      .from("layaway_accounts")
      .select("customer_id")
      .eq("id", accountIdFallback)
      .maybeSingle();
    cid = (acct as { customer_id?: string } | null)?.customer_id ?? null;
  }
  if (!cid) return false;
  const { data: member } = await supabase
    .from("loyalty_members")
    .select("id")
    .eq("customer_id", cid)
    .maybeSingle();
  return !!member;
}

/**
 * Resolve the display context (full_name, invoice) for a loyalty award
 * notification. Works for both layaway (account_id) and cash
 * (cash_order_id) sources. Lookup failures degrade gracefully — the
 * caller still gets a partial context rather than throwing, so the
 * notification insert is never blocked on this resolver.
 */
async function resolveAwardNotifyContext(
  supabase: any,
  src: {
    account_id?: string | null;
    cash_order_id?: string | null;
    customer_id?: string | null;
    invoice_number?: string | null;
  },
): Promise<{ fullName: string | null; invoice: string | null }> {
  if (src.cash_order_id) {
    try {
      let invoice = src.invoice_number ?? null;
      let custId = src.customer_id ?? null;
      if (!invoice || !custId) {
        const { data: order } = await supabase
          .from("cash_orders")
          .select("invoice_number, customer_id")
          .eq("id", src.cash_order_id)
          .maybeSingle();
        const row = order as { invoice_number?: string | null; customer_id?: string | null } | null;
        invoice = invoice ?? row?.invoice_number ?? null;
        custId = custId ?? row?.customer_id ?? null;
      }
      let fullName: string | null = null;
      if (custId) {
        const { data: cust } = await supabase
          .from("customers")
          .select("full_name")
          .eq("id", custId)
          .maybeSingle();
        fullName = (cust as { full_name?: string | null } | null)?.full_name ?? null;
      }
      return { fullName, invoice };
    } catch (_e) {
      return { fullName: null, invoice: src.invoice_number ?? null };
    }
  }
  if (src.account_id) {
    try {
      const { data: acct } = await supabase
        .from("layaway_accounts")
        .select("invoice_number, customers(full_name)")
        .eq("id", src.account_id)
        .maybeSingle();
      const row = acct as { invoice_number?: string | null; customers?: { full_name?: string | null } | null } | null;
      return {
        fullName: row?.customers?.full_name ?? null,
        invoice: row?.invoice_number ?? null,
      };
    } catch (_e) {
      return { fullName: null, invoice: null };
    }
  }
  return { fullName: null, invoice: null };
}

/** Number formatter for the loyalty notification — en-US comma grouping. */
function fmtLoyaltyNum(n: number | null | undefined): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n ?? 0);
  return v.toLocaleString("en-US");
}

/**
 * Compose the body of a successful loyalty award bell notification. Format:
 *   `+<pts>[ (+<bonus> bonus)] pts[ to <name>] · Inv #<inv|?> · balance <rem>[ · Tier upgraded: …]`
 * Mirrors the failing-notification customer-name policy and folds in the
 * existing tier-upgrade tail.
 */
function buildLoyaltyAwardBody(
  a: {
    points_earned?: number;
    bonus_points?: number;
    remaining_points?: number;
    tier_upgraded?: boolean;
    old_tier?: string;
    new_tier?: string;
  },
  ctx: { fullName: string | null; invoice: string | null },
): string {
  const bonus = a.bonus_points ? ` (+${fmtLoyaltyNum(a.bonus_points)} bonus)` : "";
  const who = ctx.fullName ? ` to ${ctx.fullName}` : "";
  const inv = ` · Inv #${ctx.invoice ?? "?"}`;
  const tier = a.tier_upgraded ? ` · Tier upgraded: ${a.old_tier} → ${a.new_tier}` : "";
  return `+${fmtLoyaltyNum(a.points_earned)}${bonus} pts${who}${inv} · balance ${fmtLoyaltyNum(a.remaining_points)}${tier}`;
}

async function allocatePaymentToAccount(
  supabase: any,
  accountId: string,
  amountPaid: number,
  paymentDate: string,
  paymentMethod: string,
  referenceNumber: string | null,
  remarks: string,
  userId: string,
  currency: string,
  isDownpayment: boolean = false,
  submittedByType: "customer" | "staff" = "staff",
  submittedByName: string | null = null
): Promise<{ paymentId: string; error?: string }> {
  const { data, error } = await supabase.rpc('allocate_payment_atomic', {
    p_account_id: accountId,
    p_amount_paid: amountPaid,
    p_payment_date: paymentDate,
    p_payment_method: paymentMethod,
    p_reference_number: referenceNumber,
    p_remarks: remarks,
    p_user_id: userId,
    p_currency: currency,
    p_is_downpayment: isDownpayment,
    p_submitted_by_type: submittedByType,
    p_submitted_by_name: submittedByName,
    p_preview: false,
  });
  if (error) return { paymentId: "", error: error.message };
  return { paymentId: data.payment_id as string };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const token = authHeader.replace("Bearer ", "");
    const body = await req.json().catch(() => ({}));
    const { submission_id, action, reviewer_notes } = body;

    // Owner 2026-10-04 (capture in the Paidy dashboard, the Hub records it):
    // the service role may call this ONLY as the automatic Paidy recorder
    // (_shared/paidy-autorecord.ts) — action "confirmed" on a Paidy
    // submission (checked once the submission is loaded). It acts with no
    // user (reviewer_user_id NULL; audit rows say actor paidy_auto).
    // verify_jwt is false for this function, so the recorder is recognised
    // by its HMAC signature (_shared/paidy-autorecord.ts), never by a token's
    // unverified claims.
    const isAutoRecorder = body.actor === PAIDY_AUTO_ACTOR;
    let user: { id: string | null };
    if (isAutoRecorder) {
      const signed = await verifyPaidyAutoSignature(submission_id, req.headers.get("x-paidy-auto-ts"), req.headers.get("x-paidy-auto-sig"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
      if (!signed || action !== "confirmed") {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      user = { id: null };
    } else {
      const { data: { user: authUser }, error: userErr } = await supabase.auth.getUser(token);
      if (userErr || !authUser) {
        return new Response(JSON.stringify({ error: "Invalid token" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      user = { id: authUser.id };
    }

    if (!submission_id || !action) {
      return new Response(JSON.stringify({ error: "Missing submission_id or action" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const validActions = ["under_review", "confirmed", "rejected", "needs_clarification", "restore"];
    if (!validActions.includes(action)) {
      return new Response(JSON.stringify({ error: "Invalid action" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const permissionByAction: Record<string, string> = {
      under_review: "review_submission",
      needs_clarification: "review_submission",
      rejected: "reject_submission",
      confirmed: "confirm_payment",
      restore: "reject_submission",
    };

    const requiredPermission = permissionByAction[action];
    const isAllowed = isAutoRecorder
      ? true // gated above to the Paidy auto-record and re-checked on the submission below
      : requiredPermission && user.id
        ? await checkPermission(supabase, user.id, requiredPermission)
        : false;

    if (!isAllowed) {
      return new Response(JSON.stringify({ error: "Access denied for this submission action." }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get the submission
    const { data: submission, error: subErr } = await supabase
      .from("payment_submissions")
      .select("*")
      .eq("id", submission_id)
      .maybeSingle();

    if (subErr || !submission) {
      return new Response(JSON.stringify({ error: "Submission not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // PROOF REQUIRED TO CONFIRM (2026-06-30): cannot confirm without non-empty proof_url.
    // Authoritative gate; covers both cash-order and layaway confirm branches.
    // PAIDY (PD1, 2026-10-03): a Paidy submission carries no proof file — its
    // proof is the authorisation the Hub read back from Paidy with the secret
    // key (paidy_payment_id set, payment_method 'paidy'). Every other method
    // keeps the rule.
    const isPaidySubmission = submission.payment_method === "paidy" && !!submission.paidy_payment_id;
    // SQUARE (S2, 2026-10-04, docs/SQUARE.md): the same exception — the proof
    // is the card authorisation the Hub read back from Square.
    const isSquareSubmission = submission.payment_method === "square" && !!submission.square_payment_id;
    if (isAutoRecorder && !(isPaidySubmission && submission.cash_order_id)) {
      return new Response(JSON.stringify({ error: "Service callers may only record a Paidy capture." }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    // F-01 (QC 2026-10-09): a card or Paidy submission ends by Confirm or Reject
    // only. "Needs clarification" would hide both buttons while the hold stays
    // on her card; the DB guard refuses it too (provider_submission_no_clarify).
    if (action === "needs_clarification" && (submission.square_payment_id || submission.paidy_payment_id)) {
      return new Response(JSON.stringify({
        error: "A card or Paidy payment cannot be sent for clarification — Confirm it or Reject it.",
        code: "provider_submission_no_clarify",
      }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (action === "confirmed" && !isPaidySubmission && !isSquareSubmission && (typeof submission.proof_url !== "string" || submission.proof_url.trim().length === 0)) {
      return new Response(JSON.stringify({ error: "Proof of payment is required to confirm this submission." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get allocations for this submission
    const { data: subAllocations } = await supabase
      .from("payment_submission_allocations")
      .select("*")
      .eq("submission_id", submission_id);

    const allocs = subAllocations || [];

    // RESERVE-FIRST: the payments table is written ONLY here, so this is the
    // last server-side stop for money against a web reservation staff have not
    // confirmed. Every submit path already refuses one; this catches a
    // submission that predates the guard, or one that slipped past it. Runs
    // BEFORE the CAS flip, so a refused confirm leaves the submission pending.
    if (action === "confirmed") {
      const isCashSubmission = !!submission.cash_order_id;
      const ids = isCashSubmission
        ? [submission.cash_order_id]
        : [...new Set([submission.account_id, ...allocs.map((a: { account_id?: string | null }) => a.account_id)]
            .filter((x): x is string => !!x))];
      const { data: orders, error: ordersErr } = ids.length === 0
        ? { data: [], error: null }
        : await supabase
            .from(isCashSubmission ? "cash_orders" : "layaway_accounts")
            .select("id, invoice_number, web_reference, source_channel, ready_confirmed_at")
            .in("id", ids);
      if (ordersErr) {
        return new Response(JSON.stringify({ error: "Could not check the order before confirming" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const reservation = firstUnconfirmedReservation(orders);
      if (reservation) {
        return new Response(JSON.stringify(staffNotReadyForPaymentBody(reservation)), {
          status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }
    let confirmedPaymentIds: string[] = [];

    // ── RESTORE PATH ──
    // Restoring a rejected submission flips status back to 'submitted' so
    // it re-enters the queue for proper validation. Preserves the original
    // reviewer_user_id and reviewer_notes as rejection history. The restorer
    // and optional restore reason are captured in audit_logs. Short-circuits
    // both the cash-order and layaway branches.
    if (action === "restore") {
      // R03 (2026-10-04): a rejected or cancelled Paidy submission is a
      // deliberate end — never re-queued (the database refuses it too). The
      // customer pays again, or staff resolve a Paidy case.
      if (isPaidySubmission) {
        return new Response(JSON.stringify({
          error: "paidy_submission_ended",
          message: "A rejected Paidy submission cannot be restored. If Paidy has taken the money, it appears under Paidy cases; otherwise the customer pays again.",
        }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      if (submission.status !== "rejected") {
        return new Response(JSON.stringify({
          error: `Cannot restore submission with status '${submission.status}'. Only rejected submissions can be restored.`,
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { error: restoreErr } = await supabase
        .from("payment_submissions")
        .update({
          status: "submitted",
          updated_at: new Date().toISOString(),
        })
        .eq("id", submission_id);

      if (restoreErr) {
        return new Response(JSON.stringify({
          error: "Failed to restore submission: " + restoreErr.message,
        }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      await supabase.from("audit_logs").insert({
        entity_type: "payment_submission",
        entity_id: submission_id,
        action: "restored_from_rejected",
        old_value_json: {
          status: "rejected",
          reviewer_user_id: submission.reviewer_user_id,
          reviewer_notes: submission.reviewer_notes,
        },
        new_value_json: {
          status: "submitted",
          restore_reason: reviewer_notes || null,
        },
        performed_by_user_id: user.id,
      });

      return new Response(JSON.stringify({
        success: true,
        status: "submitted",
        submission: { id: submission_id, status: "submitted" },
        restored: true,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── CASH ORDER CONFIRMATION PATH ──
    // Cash order submissions are identified by cash_order_id IS NOT NULL
    // (account_id IS NULL). Handled entirely separately from layaway with
    // an early return — does not touch payment_allocations, schedule, or
    // penalty engine.
    if (action === "confirmed" && submission.cash_order_id) {
      // Idempotency guard — a re-confirmed submission would create a duplicate cash_payment
      if (submission.status === "confirmed" && submission.confirmed_payment_id) {
        return new Response(JSON.stringify({
          error: "Submission already confirmed",
          confirmed_payment_id: submission.confirmed_payment_id,
        }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // P02 (2026-10-04): a PAIDY Confirm interrupted after its claim (status
      // 'confirmed', no payment linked) is RESUMED by "Finish recording" —
      // Paidy may already hold the money, so the submission is never put back
      // in the queue and never rejected on a guess. A claim younger than the
      // 5-minute lease belongs to a Confirm still running.
      const resumingPaidy = isPaidySubmission && submission.status === "confirmed" && !submission.confirmed_payment_id;
      // SQ07 (2026-10-04): the same resume for a CARD Confirm — Square may
      // already have captured, so a claimed card submission is finished, never
      // requeued. Same 5-minute lease.
      const resumingSquare = isSquareSubmission && submission.status === "confirmed" && !submission.confirmed_payment_id;
      const resuming = resumingPaidy || resumingSquare;
      if (resuming && !paidyConfirmLeaseExpired(submission.processing_started_at)) {
        return new Response(JSON.stringify({
          error: "confirm_in_progress",
          message: `Another Confirm of this ${resumingSquare ? "card" : "Paidy"} payment started less than 5 minutes ago. Wait a few minutes, refresh, then use Finish recording if it is still not recorded.`,
        }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // 1. Fetch cash order — must exist and be pending
      const { data: cashOrder, error: cashOrderErr } = await supabase
        .from("cash_orders")
        .select("id, customer_id, currency, invoice_number, status, total_paid, remaining_balance, completed_at, cash_receipt_sheet_id, source_channel, web_reference, customer_lang, ship_to_snapshot, shipping_fee, total_amount, transfer_due_at")
        .eq("id", submission.cash_order_id)
        .maybeSingle();
      if (cashOrderErr || !cashOrder) {
        return new Response(JSON.stringify({ error: "cash_order not found" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // A RESUMED Paidy Confirm skips the two checks below until Paidy has
      // been read: the money may already be taken, and a silent 400 here
      // would hide it (review 2026-10-04 #1). The Paidy block re-applies them
      // before any capture, and finalize re-checks on the locked order.
      if (!resuming && (cashOrder.status === "cancelled" || cashOrder.status === "expired")) {
        return new Response(JSON.stringify({ error: `cash_order is ${cashOrder.status}, cannot confirm payment` }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // 2. Re-validate ceiling at review time (other payments may have arrived between submission and review).
      //    finalize_cash_submission_atomic checks it again on the LOCKED balance.
      const submittedAmount = Number(submission.submitted_amount);
      const liveRemaining = Number(cashOrder.remaining_balance);
      if (!resuming && submittedAmount > liveRemaining + 0.005) {
        return new Response(JSON.stringify({
          error: `submitted_amount (${submittedAmount}) exceeds current remaining_balance (${liveRemaining})`,
        }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // 2c. Atomic claim of the submission (Bug #269). The layaway branch has
      //     had this compare-and-swap since the 19031 double award; the cash
      //     branch only had a read-then-check, so two confirms in flight both
      //     inserted a cash_payment and both reached award-loyalty-points.
      //     Zero rows flipped = someone else got here first: 409, write nothing.
      //     The claim stamps processing_started_at (P02 lease); a Paidy resume
      //     re-claims only a lease older than 5 minutes.
      const claimAt = new Date().toISOString();
      const claimQuery = resuming
        ? supabase
            .from("payment_submissions")
            .update({ reviewer_user_id: user.id, processing_started_at: claimAt, updated_at: claimAt })
            .eq("id", submission_id)
            .eq("status", "confirmed")
            .is("confirmed_payment_id", null)
            .or(`processing_started_at.is.null,processing_started_at.lt."${new Date(Date.now() - PAIDY_CONFIRM_LEASE_MS).toISOString()}"`)
            .select("id")
        : supabase
            .from("payment_submissions")
            .update({ status: "confirmed", reviewer_user_id: user.id, processing_started_at: claimAt, updated_at: claimAt })
            .eq("id", submission_id)
            .in("status", ["submitted", "under_review"])
            .select("id");
      const { data: cashFlipped, error: cashFlipErr } = await claimQuery;
      if (cashFlipErr) {
        console.error("[review-payment-submission] CAS flip failed for cash confirm:", cashFlipErr);
        return new Response(JSON.stringify({ error: "Failed to lock submission" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!cashFlipped || cashFlipped.length === 0) {
        return new Response(JSON.stringify({
          error: "Submission already processed",
          confirmed_payment_id: submission.confirmed_payment_id ?? null,
        }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      // Undo the claim if a later step fails before the payment exists. A
      // resumed Paidy claim stays 'confirmed' (the money may be with Paidy);
      // only its lease is released so "Finish recording" can run again.
      const revertCashClaim = async () => {
        const { error } = resuming
          ? await supabase
              .from("payment_submissions")
              .update({ processing_started_at: null })
              .eq("id", submission_id)
              .eq("processing_started_at", claimAt)
          : await supabase
              .from("payment_submissions")
              .update({ status: submission.status, reviewer_user_id: submission.reviewer_user_id ?? null, processing_started_at: null })
              .eq("id", submission_id)
              .eq("processing_started_at", claimAt);
        if (error) console.error("[review-payment-submission] cash claim revert failed:", error);
      };

      // 2d. PAIDY — RECORD, NEVER CAPTURE (owner 2026-10-04). Staff capture
      //     in Paidy's merchant dashboard; the Hub only records what Paidy's
      //     OWN read-back reports (docs/PAIDY.md "Follow-up"):
      //       captured   → record it: exact yen, nothing refunded, this order
      //       authorized → nothing changes: "capture it in the Paidy dashboard"
      //       expired / closed / rejected (no capture) → submission rejected;
      //                    the customer may pay again
      //       unknown / Paidy unreachable → claim released, nothing recorded
      //     date_paid is the capture day in JAPAN time (owner Q5).
      let paidyDatePaid: string | null = null;
      let paidyRecordId: string | null = null;
      let paidyPid: string | null = null;
      if (isPaidySubmission) {
        const json = (status: number, payload: Record<string, unknown>) => new Response(JSON.stringify(payload), {
          status, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
        const ref = customerReference(cashOrder as never) || String(cashOrder.invoice_number ?? "");
        const { data: pp, error: ppErr } = await supabase
          .from("paidy_payments").select("id, cash_order_id, customer_id, paidy_payment_id, status, authorized_at, expires_at, amount_jpy, refund_jpy, capture_id, captured_at")
          .eq("id", submission.paidy_payment_id).maybeSingle();
        if (ppErr || !pp) {
          await revertCashClaim();
          return json(500, { error: ppErr ? "Could not read the Paidy record for this submission." : "Paidy record missing for this submission." });
        }
        paidyRecordId = pp.id;
        paidyPid = pp.paidy_payment_id;
        if (pp.cash_order_id !== cashOrder.id || pp.customer_id !== cashOrder.customer_id || submission.customer_id !== cashOrder.customer_id) {
          // R02: a capture is recorded only on its own order and customer.
          await revertCashClaim();
          return json(409, { error: "paidy_binding_mismatch", message: "This Paidy payment does not belong to this order. Nothing was recorded." });
        }
        const unverified = async (why: string) => {
          await revertCashClaim();
          if (!isAutoRecorder) {
            await paidyBell(supabase, "paidy_capture_unverified", "Paidy payment could not be checked",
              `${ref} · ${pp.paidy_payment_id} · ${why} — nothing was recorded; try again later (the Hub reads Paidy first and never records twice)`,
              { cash_order_id: cashOrder.id, submission_id, paidy_payment_id: pp.paidy_payment_id, reason: why });
          }
          return json(502, { error: "paidy_unverified", message: `Could not check this payment with Paidy (${why}). Nothing was recorded. Try again in a few minutes.` });
        };
        const endSubmission = async (outcome: "expired" | "closed" | "rejected", detail: string) => {
          const why = outcome === "expired" ? "Paidy authorisation passed Paidy's expiry (its expires_at; 30 days after authorisation only when Paidy sent none) before it was captured"
            : outcome === "closed" ? "Paidy shows this authorisation as closed with nothing captured"
            : "Paidy declined this payment";
          // M4 (Paidy QC 2026-10-09): the Paidy row, the rejection (only while
          // THIS Confirm still holds its claim), the audit row and the
          // customer-email intent in ONE transaction — never three separate
          // writes that can stop half-way and lose her email.
          const { data: ended, error: endErr } = await supabase.rpc("end_paidy_submission_provider_ended_atomic", {
            p_submission_id: submission_id, p_paidy_row: pp.id, p_end_status: outcome, p_end_reason: detail,
            // Provider-ended, not a staff decision: the customer sees no staff
            // message (H5) — the reviewer_notes here are internal.
            p_reviewer_notes: `${why} — nothing was charged; the customer may pay again (Paidy or bank transfer). ${reviewer_notes ?? ""}`.trim(),
            p_user_id: user.id, p_claim_at: claimAt, p_payload: null,
            p_audit: { detail, actor: isAutoRecorder ? PAIDY_AUTO_ACTOR : "staff" },
          });
          const res = (ended ?? {}) as Record<string, unknown>;
          if (endErr || !res.ok) {
            if (!endErr && res.error === "conflict") {
              return json(409, { error: "confirm_in_progress", message: "Another Confirm took over this Paidy payment. Refresh the page." });
            }
            console.error("[review-payment-submission] Paidy end-of-authorisation write failed:", endErr ?? res.error);
            await revertCashClaim();
            return json(500, { error: "paidy_reject_write_failed", message: `Paidy says: ${why}. Recording that in the Hub failed — nothing was changed; press Confirm again in a few minutes.` });
          }
          // The customer hears it from us — Paidy never emails a cancellation.
          if (res.rejected === true) {
            await sendCashPaymentRejectedEmail(supabase, { submissionId: submission_id, kind: "provider_ended" });
            if (typeof res.followup_key === "string") {
              const { error: fuErr } = await supabase.from("payment_submission_followups")
                .update({ status: "done", done_at: new Date().toISOString(), attempts: 1 })
                .eq("idempotency_key", res.followup_key).eq("status", "pending");
              if (fuErr) console.warn("[review-payment-submission] followup mark-done failed (the sweep re-checks it):", fuErr);
            }
          }
          return json(409, { error: outcome === "expired" ? "paidy_authorization_expired" : `paidy_${outcome}`, message: `${why}. The submission was rejected; the customer may pay again.` });
        };

        let live: PaidyPayment;
        try {
          live = await paidy.get(pp.paidy_payment_id);
        } catch (e) {
          console.error("[review-payment-submission] paidy.get before recording failed:", e);
          return await unverified(e instanceof PaidyError ? `Paidy ${e.status} ${e.code}` : "Paidy unreachable");
        }
        const outcome = paidyProviderOutcome(live);
        if (outcome === "authorized") {
          await revertCashClaim();
          return json(409, {
            error: "paidy_not_captured_yet",
            message: "Paidy has not taken this payment yet. Capture it in the Paidy merchant dashboard — the Hub records it automatically once Paidy reports the capture (or press Confirm again afterwards).",
          });
        }
        if (outcome === "expired" || outcome === "closed" || outcome === "rejected") {
          return await endSubmission(outcome, `Paidy status ${String(live.status)} at Confirm`);
        }
        if (outcome !== "captured") {
          return await unverified(`Paidy status "${String(live.status)}"`);
        }

        // Captured in the Paidy dashboard. Record it only when it is exactly
        // this submission's yen and nothing has been refunded (owner D4: a
        // refund before recording is a staff decision, R14/R17).
        const capturedYen = paidyCapturedAmount(live);
        const refunded = Math.max(paidyRefundTotal(live), Number(pp.refund_jpy ?? 0) || 0);
        const problem = paidyRecordProblem({ capturedAmount: capturedYen, recordAmount: pp.amount_jpy, submittedAmount: submission.submitted_amount, refundedAmount: refunded });
        if (problem) {
          await revertCashClaim();
          const kind = problem === "refunded" ? "refund_before_record" : "record_failed";
          try {
            await openPaidyCase(supabase, {
              kind, paidy_payment_id: pp.paidy_payment_id, cash_order_id: cashOrder.id, paidy_payment_row: pp.id, submission_id,
              detail: { reason: problem, captured_jpy: capturedYen, authorized_jpy: pp.amount_jpy, submitted_jpy: submission.submitted_amount, refunded_jpy: refunded },
              bell: { title: problem === "refunded" ? "Paidy refund before the payment was recorded" : "Paidy capture does not match its submission",
                body: `${ref} · ${pp.paidy_payment_id} · captured ¥${Number.isFinite(capturedYen) ? capturedYen.toLocaleString("en-US") : "?"} · ${problem}. Nothing was recorded — Payment Submissions → Paidy cases.` },
            });
          } catch (e) { console.error("[review-payment-submission] open case failed:", e); }
          return json(409, {
            error: problem === "refunded" ? "paidy_refunded" : "paidy_capture_amount_mismatch",
            message: problem === "refunded"
              ? "Paidy shows a refund on this payment. Nothing was recorded — decide it under Paidy cases."
              : `Paidy's capture does not match this submission (${problem}). Nothing was recorded — check the Paidy dashboard; it is listed under Paidy cases.`,
          });
        }
        const latest = paidyLatestCapture(live);
        const capturedAt = latest?.created_at ?? pp.captured_at ?? new Date().toISOString();
        paidyDatePaid = paidyJapanDate(capturedAt);
        const { error: capRecErr } = await supabase.from("paidy_payments").update({
          status: "captured", captured_at: capturedAt, capture_id: latest?.id ?? pp.capture_id ?? null,
          expires_at: live.expires_at ?? pp.expires_at ?? null, last_payload: live, updated_at: new Date().toISOString(),
        }).eq("id", pp.id);
        if (capRecErr) {
          // finalize refuses a Paidy payment whose record is not captured; the
          // claim is released and the next sync records it.
          console.error("[review-payment-submission] paidy_payments captured update failed:", capRecErr);
          await revertCashClaim();
          return json(500, { error: "paidy_record_write_failed", message: "Could not save Paidy's capture. Nothing was recorded; it will be retried." });
        }
      }

      // 2e. SQUARE CAPTURE (integrity 2026-10-04, SQ06/SQ07/SQ09/SQ13;
      //     docs/SQUARE-INTEGRITY.md). Every decision is taken from Square's
      //     OWN read-back, never from an HTTP status:
      //       - the hold is CLAIMED for capture first (claim_square_action), so
      //         a Reject cannot void it while we capture, nor the reverse;
      //       - Square is read BEFORE the capture and again AFTER any doubt;
      //       - COMPLETED → record it (never ask the customer to pay again);
      //         APPROVED → exact integer amount, JPY, same order → capture with
      //         Square's version_token; CANCELED/FAILED (verified) → reject, the
      //         customer may pay again; unreachable/unknown → the claim stays,
      //         lease released, "Finish recording" later — nothing recorded and
      //         nothing promised;
      //       - date_paid = the capture day in JAPAN time (owner Q5, like Paidy).
      //     finalize_cash_submission_atomic re-checks captured / order /
      //     customer / JPY / exact amount / not already allocated under locks.
      let squareDatePaid: string | null = null;
      let squareCaptured = false;
      let squareRowId: string | null = null;
      const releaseSquareAction = async () => {
        if (!squareRowId) return;
        const { error } = await supabase.rpc("release_square_action", { p_square_row_id: squareRowId, p_action: "capture" });
        if (error) console.error("[review-payment-submission] release_square_action failed:", error);
      };
      // The claim stays 'confirmed' (money may be taken) — only the lease goes.
      const releaseLeaseKeepClaim = async () => {
        const { error } = await supabase.from("payment_submissions").update({ processing_started_at: null })
          .eq("id", submission_id).eq("processing_started_at", claimAt);
        if (error) console.error("[review-payment-submission] lease release failed:", error);
      };
      if (isSquareSubmission) {
        const json = (status: number, payload: Record<string, unknown>) => new Response(JSON.stringify(payload), {
          status, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
        const { data: sp, error: spErr } = await supabase
          .from("square_payments")
          .select("id, square_payment_id, status, environment, test, cash_order_id, customer_id, amount_jpy, cash_payment_id")
          .eq("id", submission.square_payment_id).maybeSingle();
        if (spErr || !sp) {
          await revertCashClaim();
          return json(500, { error: "Square record missing for this submission. Nothing was captured or recorded." });
        }
        squareRowId = sp.id;
        if (sp.cash_order_id !== submission.cash_order_id || sp.customer_id !== cashOrder.customer_id) {
          await revertCashClaim();
          return json(409, { error: "square_order_mismatch", message: "This card hold belongs to another order or customer. Nothing was captured." });
        }
        if (!isCanonicalYen(submission.submitted_amount)) {
          await revertCashClaim();
          return json(409, { error: "square_amount_mismatch", message: "A card payment must be a whole number of yen. Nothing was captured." });
        }
        const env = (sp.environment as "sandbox" | "production" | null) ?? (sp.test ? "sandbox" : "production");
        const { data: claimRes, error: claimErr } = await supabase.rpc("claim_square_action", { p_square_row_id: sp.id, p_action: "capture", p_user_id: user.id });
        if (claimErr || !(claimRes as Record<string, unknown> | null)?.ok) {
          if (resuming) await releaseLeaseKeepClaim(); else await revertCashClaim();
          return json(409, { error: "card_action_busy", message: "A Reject (void) of this card hold is in progress. Refresh in a minute." });
        }
        // Unverified outcome: nothing recorded, nothing promised. A resumed or
        // possibly-captured claim stays 'confirmed' for Finish recording.
        const unverified = async (why: string, mayBeCaptured: boolean) => {
          await releaseSquareAction();
          if (mayBeCaptured || resuming) await releaseLeaseKeepClaim(); else await revertCashClaim();
          if (mayBeCaptured) {
            await supabase.from("staff_notifications").insert({
              type: "card_capture_unverified", title: "Card capture not confirmed by Square",
              body: `${customerReference(cashOrder as never) || cashOrder.invoice_number} · ¥${Number(submission.submitted_amount).toLocaleString("en-US")} · ${why}. Nothing was recorded. Use "Finish recording" on the submission in a few minutes — the Hub reads Square first and never charges twice.`,
              customer_id: cashOrder.customer_id, invoice_number: cashOrder.invoice_number,
              metadata: { cash_order_id: cashOrder.id, submission_id, square_payment_id: sp.square_payment_id },
            });
          }
          return json(502, {
            error: "card_unverified",
            message: mayBeCaptured
              ? `Square did not confirm the capture (${why}). Nothing was recorded. Wait a few minutes, then press "Finish recording".`
              : `Could not check this card payment with Square (${why}). Nothing was captured or recorded; try again.`,
          });
        };
        const closedVerified = async (live: SquarePayment) => {
          // Square itself says the hold is gone: nothing was charged. Reject
          // (compare-and-set on our claim) so she can pay again (owner 3A).
          await releaseSquareAction();
          const { error: rejErr } = await supabase.from("payment_submissions").update({
            status: "rejected", reviewer_user_id: user.id, processing_started_at: null, updated_at: new Date().toISOString(),
            // Provider-ended, not a staff decision: no customer message (H5).
            customer_message: null,
            reviewer_notes: `Card hold ${live.status} at Square — nothing was charged; the customer can pay again (card or bank transfer). ${reviewer_notes ?? ""}`.trim(),
          }).eq("id", submission_id).eq("processing_started_at", claimAt);
          if (rejErr) console.error("[review-payment-submission] reject after closed hold failed:", rejErr);
          await supabase.from("audit_logs").insert({
            entity_type: "cash_payment_submission", entity_id: submission_id, action: "submission_rejected",
            new_value_json: { reason: "card_hold_closed", square_payment_id: sp.square_payment_id, square_status: live.status },
            performed_by_user_id: user.id,
          });
          if (!rejErr) await sendCashPaymentRejectedEmail(supabase, { submissionId: submission_id, kind: "provider_ended" });
          return json(409, { error: "card_hold_closed", message: `Square shows this card hold as ${live.status}: nothing was charged. The submission was rejected; the customer can pay again.` });
        };

        let live: SquarePayment;
        try {
          live = await square.get(env, sp.square_payment_id);
        } catch (e) {
          console.error("[review-payment-submission] square.get before capture failed:", e);
          return await unverified(e instanceof SquareError ? `${e.status} ${e.code}` : "Square unreachable", false);
        }
        try { await applyPaymentState(supabase, live, "review", user.id); }
        catch (e) { console.error("[review-payment-submission] apply before capture failed:", e); return await unverified("Hub could not store Square's answer", false); }

        // A net-after-refund recording (decide_square_case record_net_after_refund)
        // is for a capture Square has already partly refunded: never a live hold.
        const isNetAfterRefund = submission.submission_type === "card_net_after_refund";
        if (live.status === "APPROVED" && isNetAfterRefund) {
          await releaseSquareAction();
          await releaseLeaseKeepClaim();
          return json(409, { error: "square_not_captured", message: "Square shows this card payment as still held, not captured and refunded. Nothing was recorded." });
        }
        if (live.status === "APPROVED") {
          const f = paymentFacts(live);
          if (f.currency !== "JPY" || f.amountJpy === null || f.amountJpy !== Number(submission.submitted_amount)) {
            await releaseSquareAction();
            if (resuming) await releaseLeaseKeepClaim(); else await revertCashClaim();
            return json(409, { error: "square_amount_mismatch", message: `Square holds ¥${f.amountJpy ?? "?"} ${f.currency ?? ""} but the submission says ¥${Number(submission.submitted_amount).toLocaleString("en-US")}. Nothing was captured; reject it (the hold is voided).` });
          }
          // HUB-3 (2026-10-05): Square's risk can rise to HIGH after the hold
          // was filed (it was PENDING then). Never capture a payment Square now
          // rates HIGH; the reviewer rejects it (the hold is voided).
          if (String(live.risk_evaluation?.risk_level ?? "").toUpperCase() === "HIGH") {
            await releaseSquareAction();
            if (resuming) await releaseLeaseKeepClaim(); else await revertCashClaim();
            return json(409, {
              error: "risk_high",
              message: resuming
                ? "Square now rates this card payment HIGH risk. Nothing was captured. Void the hold in the Square Dashboard, then press \"Finish recording\": the Hub reads Square, sees the hold closed and rejects the submission."
                : "Square now rates this card payment HIGH risk. Nothing was captured. Reject it (the hold is voided, nothing is charged).",
            });
          }
          // L5 (2026-10-09, eighth release): the order is re-read and must still
          // take this money BEFORE Square captures it — on a first Confirm and on
          // a resumed "Finish recording" alike (the resume skipped step 2, so
          // the card could be charged for money the order can no longer record).
          const { data: freshOrder, error: freshErr } = await supabase
            .from("cash_orders").select("status, remaining_balance").eq("id", cashOrder.id).maybeSingle();
          const orderRefusal = freshErr ? null : cardCaptureOrderRefusal(freshOrder, submission.submitted_amount);
          if (freshErr || orderRefusal) {
            await releaseSquareAction();
            if (freshErr) {
              if (resuming) await releaseLeaseKeepClaim(); else await revertCashClaim();
              return json(500, { error: "card_order_unreadable", message: "Could not re-read the order before capturing. Nothing was captured; try again." });
            }
            if (resuming) {
              // Square shows the hold still APPROVED and this claim stops the
              // capture: nothing was taken, so the claim goes back to the queue
              // where a reviewer can Reject it (the hold is voided).
              const { error: backErr } = await supabase.from("payment_submissions")
                .update({ status: "submitted", processing_started_at: null, updated_at: new Date().toISOString() })
                .eq("id", submission_id).eq("status", "confirmed").is("confirmed_payment_id", null).eq("processing_started_at", claimAt);
              if (backErr) { console.error("[review-payment-submission] requeue after balance refusal failed:", backErr); await releaseLeaseKeepClaim(); }
            } else {
              await revertCashClaim();
            }
            return json(409, {
              error: orderRefusal,
              message: orderRefusal === "order_closed"
                ? `This order is ${String(freshOrder?.status ?? "closed")}. Nothing was captured on the card. Reject the card payment — the hold is voided and nothing is charged.`
                : `The order's balance is now ¥${Number(freshOrder?.remaining_balance ?? 0).toLocaleString("en-US")}, less than this card payment of ¥${Number(submission.submitted_amount).toLocaleString("en-US")}. Nothing was captured on the card. Reject the card payment — the hold is voided and nothing is charged.`,
            });
          }
          // M6 (Paidy QC 2026-10-09): never capture a card while Paidy holds
          // this order (a late Paidy authorisation): the Hub would refuse to
          // record the card money it just took. Nothing is captured.
          const { data: payLock, error: payLockErr } = await supabase.rpc("cash_order_payment_lock", { p_cash_order_id: cashOrder.id });
          if (payLockErr || String(payLock ?? "").startsWith("paidy")) {
            await releaseSquareAction();
            if (resuming) await releaseLeaseKeepClaim(); else await revertCashClaim();
            return json(409, {
              error: "paidy_lock",
              message: payLockErr
                ? "Could not check the order's payment lock. Nothing was captured; try again."
                : String(payLock) === "paidy_checkout_open"
                  ? "The customer's Paidy window is open on this order. Nothing was captured on the card — wait for it to close, or use \"End Paidy window\" on the order once it has timed out."
                  : "A Paidy payment is holding this order. Nothing was captured on the card — resolve the Paidy payment first (Payment Submissions → Paidy).",
            });
          }
          try {
            live = await square.complete(env, sp.square_payment_id, live.version_token ?? null);
          } catch (e) {
            console.error("[review-payment-submission] square.complete failed:", e);
            // Never conclude from the error: read Square again.
            try { live = await square.get(env, sp.square_payment_id); }
            catch { return await unverified(e instanceof SquareError ? `capture answered ${e.status} ${e.code}, read-back failed` : "capture answer lost", true); }
          }
          try { await applyPaymentState(supabase, live, "capture", user.id); }
          catch (e) { console.error("[review-payment-submission] apply after capture failed:", e); return await unverified("Hub could not store Square's capture", true); }
          if (live.status === "APPROVED") {
            // Verified: still held, nothing captured.
            await releaseSquareAction();
            if (resuming) await releaseLeaseKeepClaim(); else await revertCashClaim();
            return json(502, { error: "card_capture_failed", message: "Square did not capture the payment; it is still held and nothing was charged. Try Confirm again." });
          }
        }
        if (live.status === "CANCELED" || live.status === "FAILED") return await closedVerified(live);
        if (live.status !== "COMPLETED") return await unverified(`Square status ${live.status}`, false);

        // COMPLETED — captured now or before (a previous Confirm, or the Square Dashboard).
        const f = paymentFacts(live);
        // Square's amount_money stays the GROSS after a refund: a net recording
        // is for less than it (the exact net — gross minus COMPLETED refunds, no
        // pending refund — is enforced by the finalizer; review #1).
        const amountOk = isNetAfterRefund
          ? f.amountJpy !== null && f.amountJpy > Number(submission.submitted_amount)
          : f.amountJpy === Number(submission.submitted_amount);
        if (f.currency !== "JPY" || !amountOk) {
          // Captured money that does not match the submission: an exception
          // for a person (apply_square_payment_state flagged it), never a guess.
          await releaseSquareAction();
          await releaseLeaseKeepClaim();
          return json(409, { error: "square_amount_mismatch", message: `Square captured ¥${f.amountJpy ?? "?"} but the submission says ¥${Number(submission.submitted_amount).toLocaleString("en-US")}. Nothing was recorded — resolve it in Website → Card payments.` });
        }
        // QC01 (2026-10-05): Square may already have refunded part or all of
        // this capture (a Dashboard refund before the Hub recorded it). Its
        // refunds are recorded first; the finalizer then refuses to credit
        // refunded money in full (square_refunded → a tracked exception).
        if ((f.refundedJpy ?? 0) > 0 || (live.refund_ids ?? []).length > 0) {
          for (const rid of live.refund_ids ?? []) {
            let outcome = "failed";
            try { outcome = (await syncSquareRefund(supabase, env, await square.getRefund(env, rid))).outcome; }
            catch (e) {
              console.error("[review-payment-submission] refund read-back failed:", e);
              return await unverified(e instanceof SquareError ? `refund read answered ${e.status} ${e.code}` : "refund could not be read", true);
            }
            // Anything but "recorded" leaves the refund unknown to the finalizer (review #10).
            if (outcome !== "synced") return await unverified(`refund ${rid} could not be recorded (${outcome})`, true);
          }
        }
        squareCaptured = true;
        squareDatePaid = jstDate(f.capturedAt ?? live.updated_at ?? null);
      }

      // 3–6. Record the payment: cash_payments row, cash_orders totals/status,
      //      the submission linked to the payment and the audit row — ONE
      //      transaction under locks on the order and the submission
      //      (finalize_cash_submission_atomic; P02, owner Q1 c, every method).
      //      The old hand-rolled rollback is gone: a failure writes nothing.
      const submittedByType = submission.portal_token || isPaidySubmission || isSquareSubmission ? "customer" : "staff";
      const { data: fin, error: finErr } = await supabase.rpc("finalize_cash_submission_atomic", {
        p_submission_id: submission_id,
        p_reviewer_user_id: user.id,
        p_reviewer_notes: reviewer_notes ?? null,
        // Paidy: the capture day in Japan time (owner Q5). Others: the
        // submission's payment_date, as before.
        p_date_paid: isPaidySubmission ? paidyDatePaid : isSquareSubmission ? squareDatePaid : null,
        p_submitted_by_type: submittedByType,
      });
      const finRes = (fin ?? {}) as Record<string, any>;
      if (finErr || !finRes.ok) {
        const code = finErr ? "rpc_failed" : String(finRes.error ?? "unknown");
        console.error("[review-payment-submission] finalize_cash_submission_atomic failed:", finErr ?? finRes);
        if (isPaidySubmission) {
          // Paidy holds the money (staff captured it); the Hub could not
          // record it. Release the claim (the sweep retries) and keep a
          // durable case so it is never only a bell (R16/R18).
          try {
            await openPaidyCase(supabase, {
              kind: "record_failed", paidy_payment_id: paidyPid ?? String(submission.reference_number ?? ""),
              cash_order_id: cashOrder.id, paidy_payment_row: paidyRecordId, submission_id,
              detail: { reason: code, remaining_balance: finRes.remaining_balance ?? null, order_status: finRes.status ?? null },
              bell: { title: code === "order_closed" || code === "exceeds_remaining" ? "Paidy captured — the order can no longer take it" : "Paidy captured — recording in the Hub failed",
                body: `${customerReference(cashOrder as never) || cashOrder.invoice_number} · ¥${Math.round(submittedAmount).toLocaleString("en-US")} · ${code}. Nothing was recorded. Decide under Payment Submissions → Paidy cases (record it, or refund it in the Paidy dashboard).` },
            });
          } catch (e) { console.error("[review-payment-submission] open case failed:", e); }
        }
        if (isSquareSubmission && squareCaptured) {
          // Square has the money; the Hub has nothing written. Keep the claim
          // ('confirmed', no payment → "Finish recording"), release the lease.
          // An order that can no longer take it becomes a tracked exception.
          await releaseLeaseKeepClaim();
          await releaseSquareAction();
          const ref = customerReference(cashOrder as never) || String(cashOrder.invoice_number ?? "");
          const refunded = code === "square_refunded";
          const disputed = code === "card_disputed";
          const cannotTake = refunded || ["card_disputed", "order_closed", "exceeds_remaining", "square_order_mismatch", "square_currency_mismatch", "square_amount_mismatch", "square_already_allocated", "square_link_mismatch", "capture_already_recorded"].includes(code);
          // square_refunded: the finalizer already flagged refunded_before_record — keep that code.
          if (cannotTake && !refunded && squareRowId) {
            const { error: exErr } = await supabase.from("square_payments").update({
              exception: "captured_unallocated", exception_at: new Date().toISOString(), exception_note: `Recording refused: ${code}`, exception_resolved_at: null, updated_at: new Date().toISOString(),
            }).eq("id", squareRowId);
            if (exErr) console.error("[review-payment-submission] exception flag failed:", exErr);
          }
          await supabase.from("staff_notifications").insert({
            type: "card_recording_failed",
            title: refunded ? "Card captured — Square shows a refund" : disputed ? "Card captured — the customer's bank has a chargeback open" : cannotTake ? "Card captured — the order can no longer take it" : "Card captured — recording in the Hub failed",
            body: refunded
              ? `${ref} · ¥${Number(submittedAmount).toLocaleString("en-US")} · Square shows a refund on this card payment, so the Hub did not record it in full. Open Website → Card payments and decide (fully refunded, or record the net after the refund).`
              : disputed
              ? `${ref} · ¥${Number(submittedAmount).toLocaleString("en-US")} · A chargeback is holding or has taken this money, so the Hub did not record it. Do NOT refund it in the Square Dashboard (the bank may return it twice). Answer the dispute in Square; record the payment only once Square shows it WON.`
              : cannotTake
              ? `${ref} · ¥${Number(submittedAmount).toLocaleString("en-US")} · Square took the money but the Hub refused to record it (${code}). Open Website → Card payments: record it by hand or refund it in the Square Dashboard.`
              : `${ref} · ¥${Number(submittedAmount).toLocaleString("en-US")} · Square took the money but the Hub could not record it (${code}). Open Payments Hub and press "Finish recording".`,
            customer_id: cashOrder.customer_id, invoice_number: cashOrder.invoice_number,
            metadata: { cash_order_id: cashOrder.id, submission_id, square_row_id: squareRowId, error: code },
          });
          return new Response(JSON.stringify({
            error: "card_recording_failed",
            message: refunded
              ? "Square shows a refund on this card payment, so it was not recorded in full. Nothing was written. Decide it in Website → Card payments."
              : disputed
              ? "A chargeback is open on this card payment, so it was not recorded. Do not refund it; answer the dispute in Square and record it only once it is WON."
              : cannotTake
              ? `Square captured the payment but the Hub cannot record it on this order (${code}). Nothing was written. Resolve it in Website → Card payments.`
              : `Square captured the payment but recording it failed (${code}). Nothing was written. Use "Finish recording" on this submission.`,
          }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        await releaseSquareAction();
        await revertCashClaim();
        const status = code === "exceeds_remaining" || code === "order_closed" ? 400 : code === "not_claimed" ? 409 : 500;
        const message = code === "exceeds_remaining"
          ? `submitted_amount (${submittedAmount}) exceeds current remaining_balance (${finRes.remaining_balance ?? "?"})`
          : code === "order_closed" ? `cash_order is ${finRes.status ?? "closed"}, cannot confirm payment`
          : finErr ? `Failed to record confirmation: ${finErr.message}. Nothing was written; please retry.`
          : `Failed to record confirmation (${code}). Nothing was written; please retry.`;
        return new Response(JSON.stringify({ error: message, code }), {
          status, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      await releaseSquareAction();
      const cashPayment = finRes.cash_payment as Record<string, any>;
      const updatedOrder = finRes.cash_order as Record<string, any>;
      const newTotalPaid = Number(finRes.new_total_paid);
      const newRemaining = Number(finRes.new_remaining);
      const isFullyPaid = finRes.is_fully_paid === true;
      if (finRes.outcome === "already_recorded") {
        // A concurrent Confirm recorded it between our claim and the call;
        // nothing was written twice. Do not re-send emails or re-award.
        return new Response(JSON.stringify({
          success: true, status: "confirmed", already_recorded: true,
          submission: { id: submission_id, status: "confirmed", confirmed_payment_id: cashPayment?.id ?? null },
          cash_order: updatedOrder, cash_payment: cashPayment,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // QC PR-B (owner 2026-10-10): a Paidy payment just recorded rings ONE bell
      // so whoever ships sees it ("ready to ship" when it completed the order).
      // Emailed to Brenda + the admins when ticked in Website → Settings → Staff
      // bell emails (type paidy_payment_recorded). Never blocks the recording.
      if (isPaidySubmission) {
        // One bell per cash payment, written atomically by the same function the
        // hourly sweep uses; if this ring fails, paidy-reconcile rings it late
        // (reassessment F2 + QA reopen).
        const bell = paidyRecordedBell({
          reference: customerReference(cashOrder as never), amountJpy: Number(cashPayment?.amount_paid ?? 0),
          senderName: submission.sender_name, automatic: isAutoRecorder, fullyPaid: isFullyPaid, remainingJpy: newRemaining,
        });
        const bellMeta = { cash_order_id: cashOrder.id, submission_id, actor: isAutoRecorder ? PAIDY_AUTO_ACTOR : "staff", fully_paid: isFullyPaid };
        if (cashPayment?.id) {
          await ringPaidyRecordedBell(supabase, bell, { ...bellMeta, cash_payment_id: String(cashPayment.id) });
        } else {
          await paidyBell(supabase, bell.type, bell.title, bell.body, { ...bellMeta, cash_payment_id: null });
        }
      }

      // Fire-and-forget: archive the proof into payment_proofs (cash order).
      if (submission.proof_url) {
        await supabase.from("payment_proofs").insert({
          cash_order_id: cashOrder.id,
          cash_payment_id: cashPayment.id,
          submission_date: submission.payment_date,
          file_url: submission.proof_url,
          file_name: submission.proof_url?.split("/").pop() ?? null,
          uploaded_by_name: submission.sender_name ?? null,
        }).then(({ error }) => {
          if (error) console.warn("[review-payment-submission] payment_proofs insert (cash order) failed (non-blocking):", error);
        });
      }

      // Fire-and-forget: auto-flip matching sales_log row to Paid (cash order).
      // Matches by invoice_number. Silent no-op if no row exists or status is already Paid.
      await (supabase as any).from("sales_log")
        .update({ status: "Paid" })
        .eq("invoice_number", cashOrder.invoice_number)
        .neq("status", "Paid")
        .then(({ error }: { error: unknown }) => {
          if (error) console.warn("[review-payment-submission] sales_log auto-flip (cash order) failed (non-blocking):", error);
        });

      // Refresh the payment tracking sheet row for this cash order (awaited, non-blocking).
      await refreshPaymentTracking(cashOrder.invoice_number, "review-payment-submission/cash");

      // 7. Fire-and-forget: the customer's confirmation email.
      //    Web order → the Cha Jewels "payment received" email (storefront
      //    branding, customer's language), naming the method THIS payment used
      //    (payment lifecycle H3). Fully paid → the shipping note; partly paid
      //    → what is still to pay and by when (it used to send nothing).
      //    Anything else → the Hub's cash-payment-confirmed template as before.
      const isWebOrder = (cashOrder as any).source_channel === "web";
      try {
        const { data: customer } = await supabase
          .from("customers")
          .select("full_name, email, is_test")
          .eq("id", cashOrder.customer_id)
          .single();
        const customerEmail = customer?.email;
        if (isWebOrder) {
          const { data: lines } = await supabase
            .from("cash_order_items")
            .select("website_product_id, title, quantity, line_total_jpy")
            .eq("cash_order_id", cashOrder.id)
            .order("created_at");
          const ids = [...new Set(((lines ?? []) as any[]).map((l) => l.website_product_id).filter(Boolean))];
          const { data: prods } = ids.length
            ? await supabase.from("website_products").select("id, name, name_ja").in("id", ids)
            : { data: [] as any[] };
          const byId = new Map<string, any>(((prods ?? []) as any[]).map((p) => [String(p.id), p]));
          const items = ((lines ?? []) as any[]).map((l) => {
            const pr = l.website_product_id ? byId.get(String(l.website_product_id)) : undefined;
            const title = String(l.title ?? "");
            const title_ja = pr?.name && pr?.name_ja && title.startsWith(pr.name) ? pr.name_ja + title.slice(pr.name.length) : null;
            return { title, title_ja, qty: Number(l.quantity ?? 1), line_total_jpy: Number(l.line_total_jpy ?? 0) };
          });
          const reference = String((cashOrder as any).web_reference ?? cashOrder.invoice_number);
          const lang = emailLang((cashOrder as any).customer_lang, snapshotCountry(cashOrder as any));
          const orderCurrency = String(cashOrder.currency ?? "JPY") === "PHP" ? "PHP" : "JPY";
          // Points used at checkout: a loyalty DISCOUNT shown as its own line,
          // never as money received. Read failure → no line (non-blocking).
          const { data: ptsPaid } = await (supabase as any).rpc("cash_order_points_paid", { p_cash_order_id: cashOrder.id });
          await sendStorefrontEmail({
            to: { email: customerEmail, is_test: (customer as any)?.is_test === true },
            subject: orderPaymentReceivedSubject(reference, lang),
            label: "order-payment-received",
            reference,
            idempotencyKey: `order-payment-received-${cashPayment.id}`,
            element: React.createElement(OrderPaymentReceivedEmail, {
              lang,
              reference,
              items,
              shippingJpy: Number((cashOrder as any).shipping_fee ?? 0),
              totalJpy: Number((cashOrder as any).total_amount ?? newTotalPaid),
              amountReceivedJpy: Number(submittedAmount),
              currency: orderCurrency,
              orderUrl: storefrontOrderUrl(String(cashOrder.id)),
              method: notAcceptedMethod(submission.payment_method),
              pointsApplied: Number(ptsPaid ?? 0),
              // The balance AFTER this payment (finalize's new_remaining);
              // > 0 renders the partial variant.
              remaining: isFullyPaid ? null : newRemaining,
              transferDueAt: (cashOrder as any).transfer_due_at ?? null,
              region: regionForCurrency(orderCurrency),
            }),
          });
        } else if (customerEmail) {
          const result = await sendTemplateEmail(
            "cash-payment-confirmed",
            customerEmail,
            {
              templateData: {
                customerName: customer?.full_name || "Valued Customer",
                invoiceNumber: customerReference(cashOrder as any),
                amountPaid: Number(submittedAmount).toLocaleString("en-US"),
                currency: cashOrder.currency,
                remainingBalance: Number(newRemaining).toLocaleString("en-US"),
                totalPaid: Number(newTotalPaid).toLocaleString("en-US"),
                isFullyPaid,
                portalUrl: `https://portal.chajewelsjp.com/portal?invoice=${cashOrder.invoice_number}`,
              },
              idempotencyKey: `cash-payment-confirmed-${cashPayment.id}`,
            },
          );
          if (!result.sent) {
            console.log(`[review-payment-submission] "cash-payment-confirmed" suppressed for ${maskEmail(customerEmail)}`);
          }
        }
      } catch (emailErr) {
        console.warn("[review-payment-submission] cash-payment-confirmed email failed (non-blocking):", emailErr);
      }

      // 8. Capture-and-record: award-loyalty-points if order is now completed.
      // Failures here NEVER affect the confirmation outcome — they flow
      // through as data on cashLoyaltyAward.
      //
      // Membership pre-check: skip the entire loyalty pipeline (no fetch,
      // no failure notification) for non-enrolled customers. The skip is
      // now surfaced as a benign trace (`pre_check_not_enrolled`) instead
      // of silently leaving no record — see Bug #223 hardening. Reason
      // isn't in ANOMALOUS_SKIP_REASONS, so the notification loop treats
      // it as informational and emits nothing.
      let cashLoyaltyAward: Record<string, unknown> | null = null;
      if (isFullyPaid) {
        const enrolled = await isCustomerLoyaltyEnrolled(supabase, cashOrder.customer_id);
        if (enrolled) {
          try {
            const lpRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/award-loyalty-points`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
              },
              body: JSON.stringify({
                cash_order_id: cashOrder.id,
                customer_id: cashOrder.customer_id,
              }),
            });
            const lpJson = await lpRes.json().catch(() => null);
            if (!lpRes.ok) {
              // Explicit HTTP-status check — closes the gap that let the
              // 4-day 401 outage stay silent.
              const bodyErr = (lpJson as { error?: string } | null)?.error;
              cashLoyaltyAward = {
                cash_order_id: cashOrder.id,
                error: bodyErr ?? `http_${lpRes.status}`,
                status: lpRes.status,
                ...(lpJson ?? {}),
              };
            } else {
              cashLoyaltyAward = { cash_order_id: cashOrder.id, ...(lpJson ?? { error: "no_response" }) };
            }
          } catch (loyaltyErr) {
            console.warn("[review-payment-submission] award-loyalty-points failed (non-blocking):", loyaltyErr);
            cashLoyaltyAward = { cash_order_id: cashOrder.id, error: String(loyaltyErr) };
          }
        } else {
          cashLoyaltyAward = {
            cash_order_id: cashOrder.id,
            skipped: true,
            reason: "pre_check_not_enrolled",
          };
        }
      }

      if (cashLoyaltyAward) {
        try {
          const a: any = cashLoyaltyAward;
          if (a.awarded === true) {
            const ctx = await resolveAwardNotifyContext(supabase, {
              cash_order_id: cashOrder.id,
              customer_id: cashOrder.customer_id,
              invoice_number: cashOrder.invoice_number,
            });
            await supabase.from("staff_notifications").insert({
              type: "loyalty_award",
              title: "Loyalty points awarded",
              body: buildLoyaltyAwardBody(a, ctx),
              customer_id: cashOrder.customer_id,
              invoice_number: cashOrder.invoice_number,
              metadata: cashLoyaltyAward,
            });
          } else if (a.error) {
            // Resolve customer display name for the failure body. If the
            // lookup itself fails, fall back to the existing body — the
            // notification must NEVER be skipped because of a name miss.
            let cashFullName: string | null = null;
            try {
              const { data: cust } = await supabase
                .from("customers")
                .select("full_name")
                .eq("id", cashOrder.customer_id)
                .maybeSingle();
              cashFullName = (cust as { full_name?: string | null } | null)?.full_name ?? null;
            } catch (_lookupErr) {
              cashFullName = null;
            }
            const failBody = cashFullName
              ? `${cashFullName} · Inv #${cashOrder.invoice_number ?? "?"} — ${String(a.error)}`
              : String(a.error) + ` · Inv #${cashOrder.invoice_number}`;
            await supabase.from("staff_notifications").insert({
              type: "loyalty_award_failed",
              title: "Loyalty award FAILED — check wiring",
              body: failBody,
              customer_id: cashOrder.customer_id,
              invoice_number: cashOrder.invoice_number,
              metadata: cashLoyaltyAward,
            });
          } else if (a.skipped === true && ANOMALOUS_SKIP_REASONS.includes(String(a.reason))) {
            await supabase.from("staff_notifications").insert({
              type: "loyalty_award_failed",
              title: "Loyalty award SKIPPED — needs attention",
              body: `Award skipped: ${a.reason} · Inv #${cashOrder.invoice_number ?? '?'}`,
              customer_id: cashOrder.customer_id,
              invoice_number: cashOrder.invoice_number,
              metadata: cashLoyaltyAward,
            });
          }
          // benign skips (not_enrolled, below_minimum, already_awarded, no_loyalty_amount, missing_source): no notification
        } catch (nErr) {
          console.warn("[review-payment-submission] staff_notifications insert failed (non-blocking):", nErr);
        }
      }

      // 9. Rebuild ALL cash-receipt slots from DB truth (self-healing). Every
      //    confirmed receipt for this cash order is re-derived and re-written, so
      //    damaged sheets repair themselves on the next payment (Bug #251).
      if (cashOrder.cash_receipt_sheet_id) {
        try {
          const { data: receipts, error: receiptsErr } = await supabase
            .from("payment_submissions")
            .select("proof_url, payment_date, submitted_amount")
            .eq("cash_order_id", cashOrder.id)
            .eq("status", "confirmed")
            .not("proof_url", "is", null)
            .order("payment_date", { ascending: true })
            .order("created_at", { ascending: true });
          if (receiptsErr) throw receiptsErr;

          // PHP→JPY rate for amount conversion (JPY orders skip conversion).
          let phpJpyRate = 1.0;
          const { data: rateRow } = await supabase
            .from("system_settings")
            .select("value")
            .eq("key", "php_jpy_rate")
            .single();
          if (rateRow?.value) {
            const parsed = parseFloat(String(rateRow.value));
            if (!isNaN(parsed) && parsed > 0) phpJpyRate = parsed;
          }

          const slots: CashReceiptSlot[] = (receipts ?? []).map((r: any, idx: number) => ({
            slot_index: idx + 1,
            proof_url: r.proof_url as string,
            invoice_number: cashOrder.invoice_number,
            payment_date: r.payment_date,
            amount: cashOrder.currency === "JPY"
              ? r.submitted_amount
              : Math.round(r.submitted_amount / phpJpyRate),
          }));

          const rr = await appendManyReceipts(cashOrder.cash_receipt_sheet_id, slots);
          if (rr.overflow > 0) {
            console.error(
              `[review-payment-submission] cash-receipt overflow: cash_order_id=${cashOrder.id} ` +
              `capacity=${rr.capacity} overflow=${rr.overflow}`,
            );
          }
        } catch (cashReceiptErr) {
          console.warn(
            "[review-payment-submission] cash-receipt rebuild failed (non-blocking):",
            cashReceiptErr,
          );
        }
      }

      // 10. Early return — do NOT fall through to layaway logic below
      return new Response(JSON.stringify({
        success: true,
        status: "confirmed",
        submission: { id: submission_id, status: "confirmed", confirmed_payment_id: cashPayment.id },
        cash_order: updatedOrder,
        cash_payment: cashPayment,
        loyalty_awards: cashLoyaltyAward ? [cashLoyaltyAward] : [],
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    // ── END CASH ORDER PATH ──

    const loyaltyAwards: Array<Record<string, unknown>> = [];

    // If confirming, create actual payment records
    if (action === "confirmed") {
      // Idempotency guard — atomic verify-and-flip from a pre-confirm
      // state ('submitted' or 'under_review') to 'confirmed'. If zero
      // rows match, the submission was already processed concurrently;
      // return 409 and make NO payment insert and NO totals update.
      // Mirrors the cash confirm path's submission-status guard at L631.
      const { data: flipped, error: flipErr } = await supabase
        .from("payment_submissions")
        .update({ status: "confirmed", reviewer_user_id: user.id, reviewer_notes: reviewer_notes || null })
        .eq("id", submission_id)
        .in("status", ["submitted", "under_review"])
        .select("id");
      if (flipErr) {
        console.error("[review-payment-submission] CAS flip failed for layaway confirm:", flipErr);
        return new Response(JSON.stringify({ error: "Failed to lock submission" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!flipped || flipped.length === 0) {
        return new Response(JSON.stringify({
          error: "Submission already processed",
          confirmed_payment_id: submission.confirmed_payment_id ?? null,
        }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Detect DP submissions using the same heuristics as the payments table
      const subRef = String(submission.reference_number || '');
      const subNotes = String(submission.notes || '');
      const submissionIsDP =
        submission.submission_type === 'downpayment' ||
        subRef.toUpperCase().startsWith('DP-') ||
        /\bdown(payment)?\b|\bdp\b/i.test(subNotes);

      // Fetch customer name for submitted_by_name
      let customerName: string | null = null;
      if (submission.customer_id) {
        const { data: customer } = await supabase
          .from("customers")
          .select("full_name")
          .eq("id", submission.customer_id)
          .single();
        customerName = customer?.full_name || null;
      }

      // Single-account: either no allocations, or exactly one matching the submission account.
      // Always use submission.submitted_amount as the authoritative amount (handles edits correctly).
      const isSingleAccount =
        allocs.length === 0 ||
        (allocs.length === 1 && allocs[0].account_id === submission.account_id);

      if (isSingleAccount) {
        const { data: account } = await supabase
          .from("layaway_accounts")
          .select("currency")
          .eq("id", submission.account_id)
          .single();

        const result = await allocatePaymentToAccount(
          supabase,
          submission.account_id,
          Number(submission.submitted_amount),
          submission.payment_date,
          submission.payment_method,
          submission.reference_number,
          `Payment submitted${submission.notes ? ': ' + submission.notes : ''}. Submission #${submission.id.substring(0, 8)}`,
          user.id as string, // layaway path: never the service caller (gated to Paidy cash above)
          account?.currency || "PHP",
          submissionIsDP,
          "customer",
          customerName
        );

        if (result.error) {
          return new Response(JSON.stringify({ error: result.error }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        confirmedPaymentIds.push(result.paymentId);

        if (submissionIsDP) {
          // Membership pre-check: skip the entire loyalty pipeline (no
          // fetch, no push to loyaltyAwards, no notification) when the
          // customer is not enrolled. Only enrolled customers should
          // produce a loyalty record.
          const enrolled = await isCustomerLoyaltyEnrolled(
            supabase,
            (submission as { customer_id?: string | null }).customer_id ?? null,
            submission.account_id,
          );
          if (enrolled) {
            try {
              const lpRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/award-loyalty-points`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
                },
                body: JSON.stringify({ account_id: submission.account_id }),
              });
              const lpJson = await lpRes.json().catch(() => null);
              if (!lpRes.ok) {
                // Explicit HTTP-status check — closes the gap that let
                // the 4-day 401 outage stay silent.
                const bodyErr = (lpJson as { error?: string } | null)?.error;
                loyaltyAwards.push({
                  account_id: submission.account_id,
                  error: bodyErr ?? `http_${lpRes.status}`,
                  status: lpRes.status,
                  ...(lpJson ?? {}),
                });
              } else {
                loyaltyAwards.push({ account_id: submission.account_id, ...(lpJson ?? { error: "no_response" }) });
              }
            } catch (err) {
              console.warn("[review-payment-submission] award-loyalty-points failed (non-blocking):", err);
              loyaltyAwards.push({ account_id: submission.account_id, error: String(err) });
            }
          } else {
            // Benign skip trace — reason isn't in ANOMALOUS_SKIP_REASONS,
            // so the notification loop emits nothing, but the entry
            // appears in the response payload for diagnosability.
            loyaltyAwards.push({
              account_id: submission.account_id,
              skipped: true,
              reason: "pre_check_not_enrolled",
            });
          }
        }
      } else {
        // Multi-account split: process each allocation separately.
        // For these, alloc.allocated_amount is the per-account split amount.
        for (const alloc of allocs) {
          const { data: account } = await supabase
            .from("layaway_accounts")
            .select("currency")
            .eq("id", alloc.account_id)
            .single();

          const result = await allocatePaymentToAccount(
            supabase,
            alloc.account_id,
            Number(alloc.allocated_amount),
            submission.payment_date,
            submission.payment_method,
            submission.reference_number,
            `Payment submitted${submission.notes ? ': ' + submission.notes : ''}. Submission #${submission.id.substring(0, 8)} (${alloc.invoice_number})`,
            user.id as string, // layaway path: never the service caller
            account?.currency || "PHP",
            submissionIsDP,
            "customer",
            customerName
          );

          if (result.error) {
            console.error(`Failed to process allocation for ${alloc.invoice_number}:`, result.error);
            continue;
          }
          confirmedPaymentIds.push(result.paymentId);

          if (submissionIsDP) {
            // Membership pre-check: see comment on the single-submission
            // branch above. Skip the entire loyalty pipeline for
            // non-enrolled customers.
            const enrolled = await isCustomerLoyaltyEnrolled(
              supabase,
              (submission as { customer_id?: string | null }).customer_id ?? null,
              alloc.account_id,
            );
            if (enrolled) {
              try {
                const lpRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/award-loyalty-points`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
                  },
                  body: JSON.stringify({ account_id: alloc.account_id }),
                });
                const lpJson = await lpRes.json().catch(() => null);
                if (!lpRes.ok) {
                  // Explicit HTTP-status check — closes the gap that let
                  // the 4-day 401 outage stay silent.
                  const bodyErr = (lpJson as { error?: string } | null)?.error;
                  loyaltyAwards.push({
                    account_id: alloc.account_id,
                    error: bodyErr ?? `http_${lpRes.status}`,
                    status: lpRes.status,
                    ...(lpJson ?? {}),
                  });
                } else {
                  loyaltyAwards.push({ account_id: alloc.account_id, ...(lpJson ?? { error: "no_response" }) });
                }
              } catch (err) {
                console.warn("[review-payment-submission] award-loyalty-points failed (non-blocking):", err);
                loyaltyAwards.push({ account_id: alloc.account_id, error: String(err) });
              }
            } else {
              // Benign skip trace — see comment on the single-submission
              // branch. Informational only; no notification.
              loyaltyAwards.push({
                account_id: alloc.account_id,
                skipped: true,
                reason: "pre_check_not_enrolled",
              });
            }
          }
        }

        if (confirmedPaymentIds.length === 0) {
          return new Response(JSON.stringify({ error: "Failed to create any payment records" }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
    }

    // PAIDY: Reject releases the authorisation (no charge, no fee) — owner
    // 2026-10-04: this is the staff fallback; the order stays open and the
    // customer may then pay another way. Order of work (R04): read Paidy
    // (a payment Paidy has taken is never rejected), then the guarded status
    // authorisation is closed and read back BEFORE the rejection is written
    // (P03, 2026-10-06); a close Paidy refuses rejects nothing.
    let paidyCloseAfterReject: { id: string; paidy_payment_id: string; cash_order_id: string } | null = null;
    // PA06 (owner go 2026-10-08 23:16 JST): the Paidy Reject's Hub-side record
    // is written by reject_paidy_submission_atomic in ONE transaction under
    // the order lock — row end status, the submission, the audit row and the
    // customer-email intent. These two variables carry what Paidy established
    // to that single write; nothing below writes paidy_payments directly.
    let paidyRejectRow: string | null = null;
    let paidyEnd: { status: "closed" | "rejected" | "expired" | null; reason: string; payload: PaidyPayment | null } = { status: null, reason: "", payload: null };
    let paidyRejectFollowup: { id: string | null; key: string } | null = null;
    if (action === "rejected" && isPaidySubmission) {
      const json = (status: number, payload: Record<string, unknown>) => new Response(JSON.stringify(payload), {
        status, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      if (submission.status === "confirmed") {
        return json(409, { error: "paidy_confirm_in_progress", message: "This Paidy payment is being recorded. Refresh the page." });
      }
      const { data: pp, error: ppErr } = await supabase
        .from("paidy_payments").select("id, paidy_payment_id, status, cash_order_id").eq("id", submission.paidy_payment_id).maybeSingle();
      if (ppErr) return json(500, { error: "Could not read the Paidy record. Nothing was changed; try again." });
      if (pp) paidyRejectRow = String(pp.id);
      if (pp && (pp.status === "authorized" || pp.status === "captured")) {
        let live: PaidyPayment;
        try {
          live = await paidy.get(pp.paidy_payment_id);
        } catch (e) {
          console.error("[review-payment-submission] paidy.get before reject failed:", e);
          return json(502, { error: "paidy_unverified", message: "Could not check this payment with Paidy, so it was not rejected (Paidy may already have taken the money). Try again in a few minutes." });
        }
        const outcome = paidyProviderOutcome(live);
        if (outcome === "captured") {
          return json(409, { error: "paidy_already_captured", message: "Paidy has already taken this payment (captured in the Paidy dashboard). Do not reject it — press Confirm: the Hub records it and never charges twice." });
        }
        if (outcome === "authorized" || outcome === "expired") {
          paidyCloseAfterReject = { id: pp.id, paidy_payment_id: pp.paidy_payment_id, cash_order_id: pp.cash_order_id };
        } else if (outcome === "closed" || outcome === "rejected") {
          paidyEnd = { status: outcome, reason: `Paidy status ${String(live.status)} at reject`, payload: live };
        } else {
          // PA13 (owner brief 2026-10-08): an outcome that is none of the
          // above — a status the Hub does not know — is NOT a verified
          // release. Falling through here used to reject the submission and
          // unlock the order with Paidy's position unknown. Fail closed: the
          // submission stays queued and the order stays locked; the reviewer
          // retries once Paidy answers something the Hub understands.
          return json(502, {
            error: "paidy_unverified", reason: "paidy_unknown_outcome", paidy_status: String(live.status),
            message: `Paidy answered a status the Hub does not recognise ("${String(live.status)}"), so this payment was not rejected and the order stays locked. Try again in a few minutes; if it persists, check the payment in the Paidy dashboard and report it.`,
          });
        }
      }
    }

    // SQUARE: Reject voids the hold (integrity 2026-10-04, SQ10). The hold is
    // CLAIMED for the void first (a running Confirm wins and this answers
    // busy), Square is READ first, and the submission is rejected only once
    // Square shows nothing can be charged: a void Square did not accept leaves
    // the submission waiting (the hold is still on her card). A payment Square
    // has already COMPLETED is never rejected — Confirm records it.
    if (action === "rejected" && isSquareSubmission) {
      const json = (status: number, payload: Record<string, unknown>) => new Response(JSON.stringify(payload), {
        status, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      if (submission.status === "confirmed") {
        return json(409, { error: "card_confirm_in_progress", message: "A Confirm already claimed this card payment. Use \"Finish recording\" instead of Reject." });
      }
      const { data: sp, error: spErr } = await supabase
        .from("square_payments").select("id, square_payment_id, status, environment, test").eq("id", submission.square_payment_id).maybeSingle();
      if (spErr || !sp) return json(500, { error: "Could not read the card record. Nothing was changed; try again." });
      const env = (sp.environment as "sandbox" | "production" | null) ?? (sp.test ? "sandbox" : "production");
      const { data: claimRes, error: claimErr } = await supabase.rpc("claim_square_action", { p_square_row_id: sp.id, p_action: "void", p_user_id: user.id });
      if (claimErr || !(claimRes as Record<string, unknown> | null)?.ok) {
        return json(409, { error: "card_action_busy", message: "A Confirm (capture) of this card payment is in progress. Refresh in a minute." });
      }
      const release = async () => {
        const { error } = await supabase.rpc("release_square_action", { p_square_row_id: sp.id, p_action: "void" });
        if (error) console.error("[review-payment-submission] release_square_action (void) failed:", error);
      };
      let live: SquarePayment;
      try {
        live = await square.get(env, sp.square_payment_id);
      } catch (e) {
        await release();
        console.error("[review-payment-submission] square.get before reject failed:", e);
        return json(502, { error: "card_unverified", message: "Could not check this card payment with Square, so it was not rejected (the hold may still be on the card). Try again in a few minutes." });
      }
      if (live.status === "COMPLETED") {
        await applyPaymentState(supabase, live, "review", user.id).catch((e) => console.error("[review-payment-submission] apply (completed) failed:", e));
        await release();
        return json(409, { error: "card_already_captured", message: "Square has already taken this payment. Do not reject it — press Confirm: the Hub records the capture and does not charge the customer again." });
      }
      if (live.status === "APPROVED") {
        try {
          live = await square.cancel(env, sp.square_payment_id);
        } catch (e) {
          console.warn("[review-payment-submission] square.cancel on reject failed:", e);
          try { live = await square.get(env, sp.square_payment_id); } catch { /* handled below */ }
        }
      }
      // F-06 (QC 2026-10-09): the void is recorded on the card row BEFORE the
      // submission is rejected. If that write fails the submission is left
      // waiting (502) — the row would otherwise still read "authorized" and keep
      // the order locked; a second Reject or the hourly reconcile closes it.
      let voidApplied = true;
      try {
        const applied = await applyPaymentState(supabase, live, "void", user.id);
        if ((applied as Record<string, unknown> | null)?.ok === false) voidApplied = false;
      }
      catch (e) { voidApplied = false; console.error("[review-payment-submission] apply after void failed:", e); }
      await release();
      if (live.status === "PENDING") {
        // HUB-6 (2026-10-05): Square has not finished processing the payment,
        // so there is nothing it can void yet. Not a void failure — no bell.
        return json(409, { error: "card_pending", message: "Square is still processing this card payment, so it cannot be voided yet. Nothing was rejected. Try Reject again in a few minutes." });
      }
      if (live.status !== "CANCELED" && live.status !== "FAILED") {
        await supabase.from("staff_notifications").insert({
          type: "card_void_failed", title: "Card hold could not be voided",
          body: `Submission ${submission_id}: Square did not void the hold (status ${live.status}). The submission was NOT rejected — the hold is still on the customer's card. Try Reject again, or void it in the Square Dashboard.`,
          metadata: { submission_id, square_payment_id: sp.square_payment_id, square_status: live.status },
        });
        return json(502, { error: "card_void_failed", message: `Square did not void the hold (status ${live.status}). The submission was not rejected; try again.` });
      }
      if (!voidApplied) {
        return json(502, { error: "card_void_unrecorded", message: "Square voided the hold, but the Hub could not record it yet. The submission was not rejected; press Reject again in a minute (the hourly check also closes it)." });
      }
    }

    // Reassessment P03 (2026-10-06): the authorisation is released at Paidy and
    // READ BACK before the rejection is written — a local "rejected" never
    // re-opens the other payment methods while Paidy still holds the money.
    // A refused or lost close is read back; if Paidy still shows it authorised
    // nothing is rejected (staff press Reject again); a capture is never
    // rejected. A close that went through is final, so a Confirm racing this
    // Reject finds nothing Paidy can charge.
    if (paidyCloseAfterReject) {
      const pc = paidyCloseAfterReject;
      const json = (status: number, payload: Record<string, unknown>) => new Response(JSON.stringify(payload), {
        status, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      let after: PaidyPayment;
      try {
        after = await paidy.close(pc.paidy_payment_id);
      } catch (e) {
        console.warn("[review-payment-submission] paidy.close on reject failed — reading Paidy back:", e);
        try { after = await paidy.get(pc.paidy_payment_id); }
        catch { return json(502, { error: "paidy_unverified", message: "Paidy did not confirm the release and could not be checked, so nothing was rejected. Try Reject again in a few minutes." }); }
      }
      const endOutcome = paidyProviderOutcome(after);
      if (endOutcome === "captured") {
        return json(409, { error: "paidy_already_captured", message: "Paidy has already taken this payment (captured in the Paidy dashboard). Do not reject it — press Confirm: the Hub records it and never charges twice." });
      }
      if (endOutcome === "authorized" || endOutcome === "unknown") {
        return json(502, { error: "paidy_close_failed", message: "Paidy has not released this authorisation yet, so nothing was rejected and no other payment method was opened. Try Reject again in a few minutes." });
      }
      paidyEnd = {
        status: endOutcome === "expired" ? "expired" : endOutcome === "rejected" ? "rejected" : "closed",
        reason: "rejected by reviewer", payload: after,
      };
    }

    // PA06: the single Hub write for a Paidy Reject (order lock, compare-and-set
    // on the submission, row end status, audit, email intent). A Confirm that
    // claimed the submission in the meantime answers conflict → 409, exactly as
    // the generic compare-and-set did; nothing else is written in that case.
    let paidyRejectDone = false;
    if (action === "rejected" && isPaidySubmission && paidyRejectRow) {
      const json = (status: number, payload: Record<string, unknown>) => new Response(JSON.stringify(payload), {
        status, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      const { data: rj, error: rjErr } = await supabase.rpc("reject_paidy_submission_atomic", {
        p_submission_id: submission_id, p_user_id: user.id, p_notes: reviewer_notes || null,
        p_paidy_row: paidyRejectRow, p_end_status: paidyEnd.status, p_end_reason: paidyEnd.reason || null,
        p_payload: paidyEnd.payload,
      });
      if (rjErr) {
        console.error("[review-payment-submission] reject_paidy_submission_atomic failed:", rjErr);
        return json(500, { error: "paidy_reject_write_failed", message: "Paidy released the authorisation, but recording the rejection in the Hub failed. Refresh and press Reject again — nothing is charged." });
      }
      const r = (rj ?? {}) as Record<string, unknown>;
      if (r.ok !== true) {
        if (r.error === "conflict") {
          return json(409, { error: "This submission was confirmed by another reviewer in the meantime. Refresh the page." });
        }
        if (r.error === "paidy_captured") {
          return json(409, { error: "paidy_already_captured", message: "Paidy has already taken this payment (captured in the Paidy dashboard). Do not reject it — press Confirm: the Hub records it and never charges twice." });
        }
        return json(500, { error: "paidy_reject_write_failed", message: `Recording the rejection failed (${String(r.error ?? "unknown")}). Refresh and press Reject again.` });
      }
      paidyRejectDone = true;
      paidyRejectFollowup = { id: (r.followup_id as string | null) ?? null, key: String(r.followup_key ?? `payment-rejected-${submission_id}`) };
    }

    // Update submission status
    const updateData: Record<string, unknown> = {
      status: action,
      reviewer_user_id: user.id,
      reviewer_notes: reviewer_notes || null,
      // H1/H5: the reviewer's text the CUSTOMER sees (website order / plan
      // page), written only on a staff Reject or Needs clarification; every
      // other action leaves the column untouched (undefined is dropped).
      customer_message: (action === "rejected" || action === "needs_clarification") ? (reviewer_notes || null) : undefined,
      updated_at: new Date().toISOString(),
    };

    if (confirmedPaymentIds.length === 1) {
      updateData.confirmed_payment_id = confirmedPaymentIds[0];
    }

    // Review 2026-10-04 #2: Reject / under review / clarification never
    // overwrite a submission a Confirm has claimed or recorded (it may hold
    // money Paidy already took). Compare-and-set; 0 rows → 409.
    let updateQuery = supabase
      .from("payment_submissions")
      .update(updateData)
      .eq("id", submission_id);
    if (action !== "confirmed") updateQuery = updateQuery.neq("status", "confirmed");
    // R04: a Paidy Reject claims only a still-queued submission.
    if (isPaidySubmission && action === "rejected") updateQuery = updateQuery.in("status", ["submitted", "under_review"]);
    // PA06: a Paidy Reject already written atomically above skips the generic write.
    const { data: updatedRows, error: updateErr } = paidyRejectDone
      ? { data: [{ id: submission_id }], error: null }
      : await updateQuery.select("id");

    if (!updateErr && action !== "confirmed" && (!updatedRows || updatedRows.length === 0)) {
      return new Response(JSON.stringify({ error: "This submission was confirmed by another reviewer in the meantime. Refresh the page." }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (updateErr) {
      console.error("Update error:", updateErr);
      return new Response(JSON.stringify({ error: "Failed to update submission" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fire-and-forget: archive the proof into payment_proofs (layaway).
    if (confirmedPaymentIds.length === 1 && submission.proof_url && submission.account_id) {
      await supabase.from("payment_proofs").insert({
        account_id: submission.account_id,
        payment_id: confirmedPaymentIds[0],
        submission_date: submission.payment_date,
        file_url: submission.proof_url,
        file_name: submission.proof_url?.split("/").pop() ?? null,
        uploaded_by_name: submission.sender_name ?? null,
      }).then(({ error }) => {
        if (error) console.warn("[review-payment-submission] payment_proofs insert (layaway) failed (non-blocking):", error);
      });
    }

    // Fetch invoice_number for sales_log (non-blocking — failure just leaves item_code null)
    let layawayInvoiceNumber: string | null = null;
    if (confirmedPaymentIds.length === 1 && submission.account_id) {
      const { data: invRow } = await supabase
        .from("layaway_accounts")
        .select("invoice_number")
        .eq("id", submission.account_id)
        .single();
      layawayInvoiceNumber = invRow?.invoice_number ?? null;
    }

    // Fire-and-forget: auto-flip matching sales_log row to Paid (layaway).
    // Matches by invoice_number. Silent no-op if no row exists or status is already Paid.
    // Gated on the same condition as the layawayInvoiceNumber lookup above (single
    // payment with an account context — typically the DP confirmation).
    if (confirmedPaymentIds.length === 1 && submission.account_id && layawayInvoiceNumber) {
      await (supabase as any).from("sales_log")
        .update({ status: "Paid" })
        .eq("invoice_number", layawayInvoiceNumber)
        .neq("status", "Paid")
        .then(({ error }: { error: unknown }) => {
          if (error) console.warn("[review-payment-submission] sales_log auto-flip (layaway) failed (non-blocking):", error);
        });
    }

    // Refresh the payment tracking sheet row for EVERY confirmed invoice
    // (single or multi-invoice split). Awaited so the isolate does not shut
    // down mid-request; each call is isolated and never blocks the confirmation.
    if (confirmedPaymentIds.length > 0) {
      const trackingInvoices = new Set<string>();
      const isSingleForTracking = allocs.length === 0 ||
        (allocs.length === 1 && allocs[0].account_id === submission.account_id);
      if (isSingleForTracking) {
        if (layawayInvoiceNumber) trackingInvoices.add(layawayInvoiceNumber);
        else if (submission.account_id) {
          const { data: invRow2 } = await supabase.from("layaway_accounts").select("invoice_number").eq("id", submission.account_id).single();
          if (invRow2?.invoice_number) trackingInvoices.add(invRow2.invoice_number);
        }
      } else {
        for (const alloc of allocs) if (alloc.invoice_number) trackingInvoices.add(String(alloc.invoice_number));
      }
      for (const inv of trackingInvoices) {
        await refreshPaymentTracking(inv, "review-payment-submission/layaway");
      }
    }

    // Rebuild ALL cash-receipt slots for this layaway account from DB truth
    // (self-healing). Works for split / multi-allocation payments too — the
    // old `confirmedPaymentIds.length === 1` gate and per-submission proof_url
    // requirement are gone; we rebuild from every confirmed receipt (Bug #251).
    if (submission.account_id) {
      try {
        // Fetch parent account's cash_receipt_sheet_id + invoice_number
        const { data: account, error: acctErr } = await supabase
          .from("layaway_accounts")
          .select("invoice_number, cash_receipt_sheet_id, currency")
          .eq("id", submission.account_id)
          .single();

        if (acctErr || !account) {
          console.warn(
            "[review-payment-submission] cash-receipt: failed to fetch account (non-blocking):",
            acctErr,
          );
        } else if (!account.cash_receipt_sheet_id) {
          // Invoice not yet generated — skip silently (expected case)
          console.log(
            "[review-payment-submission] cash-receipt: no cash_receipt_sheet_id on account, skipping rebuild",
          );
        } else {
          const { data: receipts, error: receiptsErr } = await supabase
            .from("payment_submissions")
            .select("proof_url, payment_date, submitted_amount")
            .eq("account_id", submission.account_id)
            .eq("status", "confirmed")
            .not("proof_url", "is", null)
            .order("payment_date", { ascending: true })
            .order("created_at", { ascending: true });
          if (receiptsErr) throw receiptsErr;

          // PHP→JPY rate (JPY accounts skip conversion).
          let phpJpyRate = 1.0;
          const { data: rateRow } = await supabase
            .from("system_settings")
            .select("value")
            .eq("key", "php_jpy_rate")
            .single();
          if (rateRow?.value) {
            const parsed = parseFloat(String(rateRow.value));
            if (!isNaN(parsed) && parsed > 0) phpJpyRate = parsed;
          }

          const slots: CashReceiptSlot[] = (receipts ?? []).map((r: any, idx: number) => ({
            slot_index: idx + 1,
            proof_url: r.proof_url as string,
            invoice_number: account.invoice_number,
            payment_date: r.payment_date,
            amount: account.currency === "JPY"
              ? r.submitted_amount
              : Math.round(r.submitted_amount / phpJpyRate),
          }));

          const rr = await appendManyReceipts(account.cash_receipt_sheet_id, slots);
          if (rr.overflow > 0) {
            console.error(
              `[review-payment-submission] cash-receipt overflow: account_id=${submission.account_id} ` +
              `capacity=${rr.capacity} overflow=${rr.overflow}`,
            );
          }
        }
      } catch (cashReceiptErr) {
        console.warn(
          "[review-payment-submission] cash-receipt rebuild failed (non-blocking):",
          cashReceiptErr,
        );
      }
    }

    // Audit log (PA06: a Paidy Reject's audit row was written inside the RPC)
    if (!paidyRejectDone) await supabase.from("audit_logs").insert({
      entity_type: "payment_submission",
      entity_id: submission_id,
      action: `submission_${action}`,
      performed_by_user_id: user.id,
      new_value_json: {
        status: action,
        reviewer_notes,
        confirmed_payment_ids: confirmedPaymentIds,
        allocation_count: allocs.length,
      },
      old_value_json: { status: submission.status },
    });

    // Which customer email a Reject / Needs clarification sends (H5, spec §5
    // B and C) — one decision, routeSubmissionEmail, unit-tested in
    // development/web-order-senders.test.ts. Confirm keeps its own paths.
    const reviewAction = (action === "confirmed" || action === "rejected" || action === "needs_clarification")
      ? action as "confirmed" | "rejected" | "needs_clarification"
      : null;

    // A CASH-ORDER submission (web or Hub) rejected by a reviewer: the
    // customer's email, with the reviewer's message (owner 2026-10-05). The
    // block below reads layaway_accounts only, so before this a cash-order
    // Reject told the customer nothing. A WEB cash order's Needs clarification
    // sends the website "needs info" email (before H5 it sent nothing); a Hub
    // cash order's still sends nothing. Never throws.
    if (reviewAction && reviewAction !== "confirmed" && submission.cash_order_id) {
      try {
        let cashIsWeb = false;
        if (reviewAction === "needs_clarification") {
          const { data: co } = await supabase
            .from("cash_orders").select("source_channel").eq("id", submission.cash_order_id).maybeSingle();
          cashIsWeb = isWebEntity(co as { source_channel?: unknown } | null);
        }
        const route = routeSubmissionEmail({ action: reviewAction, isCashOrder: true, isWeb: cashIsWeb });
        if (route === "cash_rejected") {
          await sendCashPaymentRejectedEmail(supabase, { submissionId: submission_id, kind: "staff", reason: reviewer_notes ?? null });
          // PA06: the intent is done once the send was REACHED (the sender logs
          // its own outcome; a failed send is never replayed — owner rule).
          if (paidyRejectFollowup) {
            const { error: fuErr } = await supabase.from("payment_submission_followups")
              .update({ status: "done", done_at: new Date().toISOString(), attempts: 1 })
              .eq("idempotency_key", paidyRejectFollowup.key).eq("status", "pending");
            if (fuErr) console.warn("[review-payment-submission] followup mark-done failed (the sweep re-checks it):", fuErr);
          }
        } else if (route === "order_needs_info") {
          await sendOrderUpdateEmail(supabase, {
            entity: "cash_order",
            id: String(submission.cash_order_id),
            variant: "needs_info",
            message: reviewer_notes ?? null,
            idempotencyKey: reviewEmailKey("needs_info", String(submission_id), reviewer_notes),
          });
        }
      } catch (cashMailErr) {
        console.warn("[review-payment-submission] cash-order review email failed (non-blocking):", cashMailErr);
      }
    }

    // Send status-change email to customer (fire-and-forget)
    try {
      const { data: acctForEmail } = await supabase
        .from("layaway_accounts")
        .select("id, invoice_number, currency, remaining_balance, total_paid, source_channel, web_reference, customer_lang, customers(full_name, email, is_test)")
        .eq("id", submission.account_id)
        .single();
      const customerEmail = (acctForEmail as any)?.customers?.email;

      // A web layaway gets the Cha Jewels storefront email in the customer's own
      // language, not the Hub template: the customer knows this plan by its
      // CJ-W reference and reads it on the storefront, not the portal. The
      // deposit confirm is the moment the reservation becomes firm, so it says
      // so; every instalment after it reads as a receipt.
      const isWebLayaway = (acctForEmail as any)?.source_channel === "web";
      if (isWebLayaway && action === "confirmed") {
        try {
          const { data: rows } = await supabase
            .from("schedule_with_actuals")
            .select("installment_number, due_date, base_installment_amount, actual_remaining, computed_status")
            .eq("account_id", submission.account_id)
            .order("installment_number");
          const schedule = ((rows ?? []) as any[]).map((r) => ({
            installment_number: Number(r.installment_number),
            due_date: String(r.due_date),
            amount: Number(r.base_installment_amount ?? 0),
            paid: String(r.computed_status) === "paid",
          }));
          const next = ((rows ?? []) as any[]).find((r) => Number(r.actual_remaining ?? 0) > 0);
          // Recomputed here rather than reused: the same heuristic the payments
          // table uses, kept local so this block does not depend on where the
          // handler happens to have declared it.
          const isDeposit =
            submission.submission_type === "downpayment" ||
            String(submission.reference_number || "").toUpperCase().startsWith("DP-") ||
            /\bdown(payment)?\b|\bdp\b/i.test(String(submission.notes || ""));
          const reference = String((acctForEmail as any).web_reference ?? acctForEmail?.invoice_number);
          await sendStorefrontEmail({
            to: {
              email: customerEmail ?? null,
              is_test: (acctForEmail as any)?.customers?.is_test === true,
            },
            subject: layawayPaymentReceivedSubject(reference, isDeposit),
            label: "layaway-payment-received",
            reference,
            idempotencyKey: `layaway-payment-received-${submission_id}`,
            element: React.createElement(LayawayPaymentReceivedEmail, {
              reference,
              currency: String(acctForEmail?.currency ?? "JPY") as "JPY" | "PHP",
              isDeposit,
              amountReceived: Number(submission.submitted_amount ?? 0),
              remaining: Number(acctForEmail?.remaining_balance ?? 0),
              schedule,
              nextDueDate: next ? String(next.due_date) : null,
              nextDueAmount: next ? Number(next.actual_remaining ?? 0) : null,
              planUrl: storefrontLayawayUrl(String((acctForEmail as any).id)),
            }),
          });
        } catch (mailErr) {
          console.warn("[review-payment-submission] layaway-payment-received email failed (non-blocking):", mailErr);
        }
      } else if (
        reviewAction && !submission.cash_order_id &&
        routeSubmissionEmail({ action: reviewAction, isCashOrder: false, isWeb: isWebLayaway }) === "layaway_update"
      ) {
        // A WEB layaway's Reject / Needs clarification: the website layaway
        // update (English only, links to /account/layaway/:id) INSTEAD of the
        // Hub portal template (spec §5 C). Never throws.
        const variant = action === "rejected" ? "rejected" : "needs_info";
        await sendOrderUpdateEmail(supabase, {
          entity: "layaway",
          id: String((acctForEmail as any).id),
          variant,
          message: reviewer_notes ?? null,
          idempotencyKey: reviewEmailKey(variant, String(submission_id), reviewer_notes),
        });
      } else if (customerEmail) {
        let templateName = "";
        const baseData: Record<string, unknown> = {
          customerName: (acctForEmail as any)?.customers?.full_name || "Valued Customer",
          invoiceNumber: customerReference(acctForEmail as any),
          amountPaid: Number(submission.submitted_amount).toLocaleString("en-US"),
          currency: acctForEmail?.currency || "PHP",
          portalUrl: `https://portal.chajewelsjp.com/portal?invoice=${acctForEmail?.invoice_number || ""}`,
        };

        if (action === "confirmed") {
          templateName = "payment-confirmed";
          baseData.paymentDate = submission.payment_date;
          baseData.paymentMethod = submission.payment_method || "cash";
          baseData.remainingBalance = Number(acctForEmail?.remaining_balance ?? 0).toLocaleString("en-US");
        } else if (action === "rejected") {
          templateName = "payment-rejected";
          baseData.rejectionReason = reviewer_notes || "";
        } else if (action === "needs_clarification") {
          templateName = "payment-needs-clarification";
          baseData.clarificationNotes = reviewer_notes || "";
        }

        if (templateName) {
          const result = await sendTemplateEmail(
            templateName,
            customerEmail,
            {
              templateData: baseData,
              idempotencyKey: `${templateName}-${submission_id}`,
            },
          );
          if (!result.sent) {
            console.log(`[review-payment-submission] "${templateName}" suppressed for ${maskEmail(customerEmail)}`);
          }
        }
      }
    } catch (emailErr) {
      console.warn("[review-payment-submission] email send failed (non-blocking):", emailErr);
    }

    for (const award of loyaltyAwards) {
      try {
        if ((award as any).awarded) {
          const a: any = award;
          const ctx = await resolveAwardNotifyContext(supabase, {
            account_id: a.account_id ?? null,
          });
          await supabase.from("staff_notifications").insert({
            type: "loyalty_award",
            title: "Loyalty points awarded",
            body: buildLoyaltyAwardBody(a, ctx),
            account_id: a.account_id ?? null,
            metadata: a,
          });
        } else if ((award as any).error) {
          const a: any = award;
          // Resolve customer name + invoice via layaway_accounts join. If
          // the lookup itself fails, fall back to the original String(a.error)
          // body — the notification must never be skipped on a name miss.
          let layawayFullName: string | null = null;
          let layawayInvoice: string | null = null;
          if (a.account_id) {
            try {
              const { data: acct } = await supabase
                .from("layaway_accounts")
                .select("invoice_number, customers(full_name)")
                .eq("id", a.account_id)
                .maybeSingle();
              const row = acct as { invoice_number?: string | null; customers?: { full_name?: string | null } | null } | null;
              layawayFullName = row?.customers?.full_name ?? null;
              layawayInvoice = row?.invoice_number ?? null;
            } catch (_lookupErr) {
              layawayFullName = null;
              layawayInvoice = null;
            }
          }
          const failBody = (layawayFullName || layawayInvoice)
            ? `${layawayFullName ?? "Unknown"} · Inv #${layawayInvoice ?? "?"} — ${String(a.error)}`
            : String(a.error);
          await supabase.from("staff_notifications").insert({
            type: "loyalty_award_failed",
            title: "Loyalty award FAILED — check wiring",
            body: failBody,
            account_id: a.account_id ?? null,
            metadata: a,
          });
        } else if ((award as any).skipped === true && ANOMALOUS_SKIP_REASONS.includes(String((award as any).reason))) {
          const a: any = award;
          await supabase.from("staff_notifications").insert({
            type: "loyalty_award_failed",
            title: "Loyalty award SKIPPED — needs attention",
            body: `Award skipped: ${a.reason} · Inv #?`,
            account_id: a.account_id ?? null,
            metadata: a,
          });
        }
        // benign skips (not_enrolled, below_minimum, already_awarded, no_loyalty_amount, missing_source): no notification
      } catch (nErr) {
        console.warn("[review-payment-submission] staff_notifications insert failed (non-blocking):", nErr);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      status: action,
      confirmed_payment_ids: confirmedPaymentIds,
      loyalty_awards: loyaltyAwards,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
