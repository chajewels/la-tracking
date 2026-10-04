import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { checkPermission } from "../_shared/check-permission.ts";
import { appendManyReceipts, type CashReceiptSlot } from "../_shared/cash-receipt.ts";
import { sendTemplateEmail } from "../_shared/transactional-email-templates/send-email.ts";
import { refreshPaymentTracking } from "../_shared/payment-tracking.ts";
import { pickLang, sendStorefrontEmail, storefrontLayawayUrl, storefrontOrderUrl } from "../_shared/storefront-email.ts";
import { OrderPaymentReceivedEmail, orderPaymentReceivedSubject } from "../_shared/email-templates/order-payment-received.tsx";
import { LayawayPaymentReceivedEmail, layawayPaymentReceivedSubject } from "../_shared/email-templates/layaway-payment-received.tsx";
import * as React from "npm:react@18.3.1";
import { customerReference } from "../_shared/order-reference.ts";
import { firstUnconfirmedReservation, staffNotReadyForPaymentBody } from "../_shared/web-reservation-rules.ts";
import { maskEmail } from "../_shared/redact.ts";
import { PaidyError, paidy, type PaidyPayment } from "../_shared/paidy.ts";
import {
  PAIDY_CONFIRM_LEASE_MS, paidyCaptureAmountProblem, paidyCapturedAmount, paidyConfirmLeaseExpired,
  paidyJapanDate, paidyLatestCapture, paidyProviderOutcome,
} from "../_shared/paidy-rules.ts";
import { paidyBell } from "../_shared/paidy-filing.ts";
import { SquareError, square } from "../_shared/square.ts";
import { cardHoldExpired } from "../_shared/card-rules.ts";

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
    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { submission_id, action, reviewer_notes } = body;

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
    const isAllowed = requiredPermission
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
      if (resumingPaidy && !paidyConfirmLeaseExpired(submission.processing_started_at)) {
        return new Response(JSON.stringify({
          error: "confirm_in_progress",
          message: "Another Confirm of this Paidy payment started less than 5 minutes ago. Wait a few minutes, refresh, then use Finish recording if it is still not recorded.",
        }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // 1. Fetch cash order — must exist and be pending
      const { data: cashOrder, error: cashOrderErr } = await supabase
        .from("cash_orders")
        .select("id, customer_id, currency, invoice_number, status, total_paid, remaining_balance, completed_at, cash_receipt_sheet_id, source_channel, web_reference, customer_lang, shipping_fee, total_amount")
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
      if (!resumingPaidy && (cashOrder.status === "cancelled" || cashOrder.status === "expired")) {
        return new Response(JSON.stringify({ error: `cash_order is ${cashOrder.status}, cannot confirm payment` }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // 2. Re-validate ceiling at review time (other payments may have arrived between submission and review).
      //    finalize_cash_submission_atomic checks it again on the LOCKED balance.
      const submittedAmount = Number(submission.submitted_amount);
      const liveRemaining = Number(cashOrder.remaining_balance);
      if (!resumingPaidy && submittedAmount > liveRemaining + 0.005) {
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
      const claimQuery = resumingPaidy
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
        const { error } = resumingPaidy
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

      // 2d. PAIDY CAPTURE (2026-10-03; integrity rework 2026-10-04, P03/P07/
      //     P08/P09, docs/PAIDY.md "Integrity"). Every decision is taken from
      //     Paidy's OWN read-back, never from an HTTP status: Paidy is read
      //     BEFORE the capture and again AFTER any capture error.
      //       captured   → record it (never ask the customer to pay again)
      //       authorized → amounts must agree, then capture
      //       expired / closed / rejected (no capture) → reject; customer pays again
      //       unknown / Paidy unreachable → claim released, bell, nothing recorded
      //     date_paid is the capture day in JAPAN time (owner Q5).
      let paidyCaptureId: string | null = null;
      let paidyDatePaid: string | null = null;
      let paidyCaptured = false;
      if (isPaidySubmission) {
        const json = (status: number, payload: Record<string, unknown>) => new Response(JSON.stringify(payload), {
          status, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
        const ref = customerReference(cashOrder as never) || String(cashOrder.invoice_number ?? "");
        const { data: pp, error: ppErr } = await supabase
          .from("paidy_payments").select("id, paidy_payment_id, status, authorized_at, expires_at, amount_jpy, capture_id, captured_at")
          .eq("id", submission.paidy_payment_id).maybeSingle();
        if (ppErr || !pp) {
          await revertCashClaim();
          return json(500, { error: ppErr ? "Could not read the Paidy record for this submission." : "Paidy record missing for this submission." });
        }
        const unverified = async (why: string) => {
          await revertCashClaim();
          await paidyBell(supabase, "paidy_capture_unverified", "Paidy Confirm could not be verified",
            `${ref} · ${pp.paidy_payment_id} · ${why} — nothing was recorded; Confirm again later (the Hub reads Paidy first, so a capture that did happen is recorded, never repeated)`,
            { cash_order_id: cashOrder.id, submission_id, paidy_payment_id: pp.paidy_payment_id, reason: why });
          return json(502, { error: "paidy_unverified", message: `Could not confirm with Paidy (${why}). Nothing was recorded. Try Confirm again in a few minutes.` });
        };
        const endSubmission = async (outcome: "expired" | "closed" | "rejected", detail: string) => {
          const at = new Date().toISOString();
          const recStatus = outcome === "rejected" ? "rejected" : outcome === "closed" ? "closed" : "expired";
          const { error: recErr } = await supabase.from("paidy_payments")
            .update({ status: recStatus, closed_at: at, closed_reason: detail, updated_at: at }).eq("id", pp.id);
          const why = outcome === "expired" ? "Paidy authorisation expired (30 days)"
            : outcome === "closed" ? "Paidy shows this authorisation as closed with nothing captured"
            : "Paidy declined this payment";
          const { error: subErr } = await supabase.from("payment_submissions").update({
            status: "rejected", reviewer_user_id: user.id, processing_started_at: null, updated_at: at,
            reviewer_notes: `${why} — the customer must pay again (Paidy or bank transfer). ${reviewer_notes ?? ""}`.trim(),
          }).eq("id", submission_id).eq("processing_started_at", claimAt);
          const { error: audErr } = await supabase.from("audit_logs").insert({
            entity_type: "cash_payment_submission", entity_id: submission_id, action: "submission_rejected",
            new_value_json: { reason: `paidy_${outcome}`, paidy_payment_id: pp.paidy_payment_id, detail },
            performed_by_user_id: user.id,
          });
          if (recErr || subErr || audErr) {
            console.error("[review-payment-submission] Paidy end-of-authorisation writes failed:", recErr, subErr, audErr);
            return json(500, { error: "paidy_reject_write_failed", message: `Paidy says: ${why}. Recording that in the Hub failed — refresh and Reject this submission.` });
          }
          return json(409, { error: outcome === "expired" ? "paidy_authorization_expired" : `paidy_${outcome}`, message: `${why}. The submission was rejected; ask the customer to pay again.` });
        };

        let live: PaidyPayment;
        try {
          live = await paidy.get(pp.paidy_payment_id);
        } catch (e) {
          console.error("[review-payment-submission] paidy.get before capture failed:", e);
          return await unverified(e instanceof PaidyError ? `Paidy ${e.status} ${e.code}` : "Paidy unreachable");
        }
        let outcome = paidyProviderOutcome(live);

        if (outcome === "authorized" && (cashOrder.status === "cancelled" || cashOrder.status === "expired")) {
          // Not captured yet and the order is closed: never take the money.
          await revertCashClaim();
          return json(400, { error: `cash_order is ${cashOrder.status}, cannot confirm payment. Nothing was captured — Reject this submission to release the Paidy authorisation.` });
        }
        if (outcome === "authorized") {
          // P08: what Paidy holds, what the Hub recorded, what the submission
          // says and what the order still owes must all agree before money moves.
          const problem = paidyCaptureAmountProblem({
            providerAmount: live.amount, recordAmount: pp.amount_jpy,
            submittedAmount: submission.submitted_amount, remainingBalance: cashOrder.remaining_balance,
          });
          if (problem) {
            await revertCashClaim();
            return json(409, { error: "amount_mismatch", detail: problem, message: `Paidy holds ¥${Math.round(Number(live.amount)).toLocaleString("en-US")}, the submission says ¥${Math.round(submittedAmount).toLocaleString("en-US")} and the order owes ¥${Math.round(liveRemaining).toLocaleString("en-US")} (${problem}). Nothing was captured. Reject it and ask the customer to pay again.` });
          }
          const { error: stampErr } = await supabase.from("paidy_payments")
            .update({ capture_started_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", pp.id);
          if (stampErr) {
            await revertCashClaim();
            return json(500, { error: "Could not prepare the Paidy capture. Nothing was captured; try again." });
          }
          try {
            live = await paidy.capture(pp.paidy_payment_id, { invoice: String(cashOrder.invoice_number ?? ""), submission_id });
          } catch (e) {
            console.error("[review-payment-submission] paidy.capture failed — reading Paidy back:", e);
            try {
              live = await paidy.get(pp.paidy_payment_id);
            } catch (e2) {
              console.error("[review-payment-submission] paidy.get after capture error failed:", e2);
              return await unverified(e instanceof PaidyError ? `capture answered ${e.status} ${e.code}; Paidy then unreachable` : "capture and read-back failed");
            }
          }
          outcome = paidyProviderOutcome(live);
          if (outcome === "authorized") {
            // Paidy still holds it uncaptured after our request: not taken.
            return await unverified("Paidy did not capture the payment");
          }
        }

        if (outcome === "expired" || outcome === "closed" || outcome === "rejected") {
          return await endSubmission(outcome, `Paidy status ${String(live.status)} at Confirm`);
        }
        if (outcome !== "captured") {
          return await unverified(`Paidy status "${String(live.status)}"`);
        }

        // Captured: the money is taken. From here the submission is never
        // reverted to the queue; any failure leaves it for "Finish recording".
        paidyCaptured = true;
        const latest = paidyLatestCapture(live);
        const capturedYen = paidyCapturedAmount(live);
        paidyCaptureId = latest?.id ?? (pp.capture_id ?? null);
        const capturedAt = latest?.created_at ?? pp.captured_at ?? new Date().toISOString();
        paidyDatePaid = paidyJapanDate(capturedAt);
        const { error: capRecErr } = await supabase.from("paidy_payments").update({
          status: "captured", captured_at: capturedAt, capture_id: paidyCaptureId,
          expires_at: live.expires_at ?? pp.expires_at ?? null, last_payload: live, updated_at: new Date().toISOString(),
        }).eq("id", pp.id);
        if (capRecErr) {
          // finalize_cash_submission_atomic refuses a Paidy payment whose
          // record is not 'captured' (paidy_not_captured), so this ends in the
          // "Finish recording" bell below; the resume reads Paidy again and
          // re-writes the record. Never money in the books without it.
          console.error("[review-payment-submission] paidy_payments captured update failed:", capRecErr);
        }
        if (capturedYen !== Math.round(submittedAmount)) {
          const { error: leaseErr } = await supabase.from("payment_submissions").update({ processing_started_at: null }).eq("id", submission_id).eq("processing_started_at", claimAt);
          if (leaseErr) console.error("[review-payment-submission] lease release failed:", leaseErr);
          await paidyBell(supabase, "paidy_recording_failed", "Paidy captured an amount that does not match",
            `${ref} · Paidy captured ¥${capturedYen.toLocaleString("en-US")} but the submission is ¥${Math.round(submittedAmount).toLocaleString("en-US")} — nothing recorded; check the Paidy dashboard and record it by hand`,
            { cash_order_id: cashOrder.id, submission_id, paidy_payment_id: pp.paidy_payment_id, captured_jpy: capturedYen, submitted_jpy: submittedAmount });
          return json(409, { error: "paidy_capture_amount_mismatch", message: `Paidy captured ¥${capturedYen.toLocaleString("en-US")}, which does not match this submission. Nothing was recorded in the Hub; check the Paidy dashboard.` });
        }
      }

      // 2e. SQUARE CAPTURE (S2, 2026-10-04, docs/SQUARE.md). Same place and
      //     same rules as 2d: after the claim, before any money is written.
      //     CompletePayment takes the held amount; a hold Square no longer
      //     honours (past its 7-day window, cancelled, failed) rejects the
      //     submission with the note; any other failure reverts the claim.
      if (isSquareSubmission) {
        const { data: sp } = await supabase
          .from("square_payments").select("id, square_payment_id, status, authorized_at, capture_by, amount_jpy, test")
          .eq("id", submission.square_payment_id).maybeSingle();
        if (!sp) {
          await revertCashClaim();
          return new Response(JSON.stringify({ error: "Square record missing for this submission." }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const expireCard = async (why: string) => {
          await supabase.from("square_payments").update({ status: "expired", voided_at: new Date().toISOString(), voided_reason: why, updated_at: new Date().toISOString() }).eq("id", sp.id);
          await supabase.from("payment_submissions").update({
            status: "rejected", reviewer_user_id: user.id, updated_at: new Date().toISOString(),
            reviewer_notes: `Card hold expired or was cancelled — the customer must pay again (card or bank transfer). ${reviewer_notes ?? ""}`.trim(),
          }).eq("id", submission_id);
          await supabase.from("audit_logs").insert({
            entity_type: "cash_payment_submission", entity_id: submission_id, action: "submission_rejected",
            new_value_json: { reason: "card_hold_expired", square_payment_id: sp.square_payment_id, detail: why },
            performed_by_user_id: user.id,
          });
        };
        if (sp.status === "captured") {
          // Already taken (a retried Confirm after a crash between capture and
          // the insert): carry on with the books, do not capture twice.
        } else if (sp.status !== "authorized") {
          await revertCashClaim();
          return new Response(JSON.stringify({ error: `Card payment is ${sp.status}; nothing to capture. Reject this submission.` }), {
            status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } else if (Math.round(Number(sp.amount_jpy)) !== Math.round(Number(submission.submitted_amount))) {
          // The books would be written with the submission's amount while
          // Square captures the whole hold (review S4): never.
          await revertCashClaim();
          return new Response(JSON.stringify({ error: "amount_mismatch", message: `The card hold is ¥${Math.round(Number(sp.amount_jpy)).toLocaleString("en-US")} but the submission says ¥${Math.round(Number(submission.submitted_amount)).toLocaleString("en-US")}. Reject it and ask the customer to pay again.` }), {
            status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } else if (cardHoldExpired(String(sp.authorized_at), new Date(), sp.capture_by)) {
          await expireCard("past the hold window (capture_by) at Confirm");
          return new Response(JSON.stringify({ error: "card_hold_expired", message: "The card hold expired (7 days). The submission was rejected; ask the customer to pay again." }), {
            status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } else {
          try {
            const captured = await square.complete(sp.test === true, sp.square_payment_id);
            if (captured.status !== "COMPLETED") {
              console.error(`[review-payment-submission] square.complete answered ${captured.status} for ${sp.square_payment_id}`);
              throw new SquareError(502, "not_completed", `Square answered ${captured.status} to the capture of ${sp.square_payment_id}`);
            }
            await supabase.from("square_payments").update({
              status: "captured", captured_at: new Date().toISOString(), receipt_url: captured.receipt_url ?? null, last_payload: captured, updated_at: new Date().toISOString(),
            }).eq("id", sp.id);
          } catch (e) {
            const se = e instanceof SquareError ? e : null;
            console.error("[review-payment-submission] square.complete failed:", e);
            if (se && (se.status === 404 || se.code === "PAYMENT_NOT_FOUND" || se.code === "INVALID_PAYMENT_STATUS" || se.code === "PAYMENT_EXPIRED" || /CANCEL/i.test(se.code))) {
              // Square no longer holds it: expired, cancelled or failed on
              // Square's side. Reject with the note (Paidy PD4 pattern).
              await expireCard(`Square ${se.status} ${se.code}: ${se.message}`);
              return new Response(JSON.stringify({ error: "card_hold_expired", message: `Square could not capture this payment (${se.message}). The submission was rejected; ask the customer to pay again.` }), {
                status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            }
            await revertCashClaim();
            return new Response(JSON.stringify({ error: "card_capture_failed", message: se ? `${se.code}: ${se.message}` : String(e) }), {
              status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        }
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
        p_date_paid: isPaidySubmission ? paidyDatePaid : null,
        p_submitted_by_type: submittedByType,
      });
      const finRes = (fin ?? {}) as Record<string, any>;
      if (finErr || !finRes.ok) {
        const code = finErr ? "rpc_failed" : String(finRes.error ?? "unknown");
        console.error("[review-payment-submission] finalize_cash_submission_atomic failed:", finErr ?? finRes);
        if (isPaidySubmission && paidyCaptured) {
          // Paidy has the money; the Hub has nothing written. Keep the claim
          // (status 'confirmed', no payment) so it shows "Finish recording",
          // release the lease, and tell staff (owner Q4 a).
          const { error: leaseErr } = await supabase.from("payment_submissions").update({ processing_started_at: null }).eq("id", submission_id).eq("processing_started_at", claimAt);
          if (leaseErr) console.error("[review-payment-submission] lease release failed:", leaseErr);
          const ref = customerReference(cashOrder as never) || String(cashOrder.invoice_number ?? "");
          const cannotTake = code === "order_closed" || code === "exceeds_remaining";
          await paidyBell(supabase, "paidy_recording_failed", cannotTake ? "Paidy captured — the order can no longer take it" : "Paidy captured — recording in the Hub failed",
            cannotTake
              ? `${ref} · ¥${Math.round(submittedAmount).toLocaleString("en-US")} · Paidy took the money but the order is closed or already paid (${code}). Nothing was recorded. Decide with the owner: record it by hand or refund it in the Paidy dashboard.`
              : `${ref} · ¥${Math.round(submittedAmount).toLocaleString("en-US")} · Paidy took the money but the Hub could not record it (${code}). Open Payment Submissions and press "Finish recording".`,
            { cash_order_id: cashOrder.id, submission_id, capture_id: paidyCaptureId, error: code });
          return new Response(JSON.stringify({
            error: "paidy_recording_failed",
            message: `Paidy captured the payment but recording it failed (${code}). Nothing was written. Use "Finish recording" on this submission.`,
          }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
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
      //    Web order, fully paid → the Cha Jewels "payment received" email
      //    (storefront branding, customer's language, shipping note).
      //    Anything else → the Hub's cash-payment-confirmed template as before.
      const isWebOrder = (cashOrder as any).source_channel === "web";
      try {
        const { data: customer } = await supabase
          .from("customers")
          .select("full_name, email, is_test")
          .eq("id", cashOrder.customer_id)
          .single();
        const customerEmail = customer?.email;
        if (isWebOrder && isFullyPaid) {
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
          await sendStorefrontEmail({
            to: { email: customerEmail, is_test: (customer as any)?.is_test === true },
            subject: orderPaymentReceivedSubject(reference),
            label: "order-payment-received",
            reference,
            idempotencyKey: `order-payment-received-${cashPayment.id}`,
            element: React.createElement(OrderPaymentReceivedEmail, {
              lang: pickLang((cashOrder as any).customer_lang),
              reference,
              items,
              shippingJpy: Number((cashOrder as any).shipping_fee ?? 0),
              totalJpy: Number((cashOrder as any).total_amount ?? newTotalPaid),
              amountReceivedJpy: Number(submittedAmount),
              currency: String(cashOrder.currency ?? "JPY") === "PHP" ? "PHP" : "JPY",
              orderUrl: storefrontOrderUrl(String(cashOrder.id)),
            }),
          });
        } else if (isWebOrder) {
          // Partial transfer on a web order: no email yet — the order is still
          // awaiting the balance and the Hub template would name the wrong reference.
          console.log(JSON.stringify({ storefront_email: "order-payment-received", reference: (cashOrder as any).web_reference, outcome: "skipped_partial_payment" }));
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
          user.id,
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
            user.id,
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

    // PAIDY: Reject releases the authorisation (no charge, no fee). Paidy is
    // read FIRST (P05, 2026-10-04): a payment Paidy has already captured is
    // never rejected — the money is taken, so it is Confirmed (the Hub
    // records the capture, it never charges twice). A submission a Confirm
    // has claimed is never rejected either. Closing stays best effort — a
    // Paidy refusal must not stop the reviewer; the bell says so.
    if (action === "rejected" && isPaidySubmission) {
      const json = (status: number, payload: Record<string, unknown>) => new Response(JSON.stringify(payload), {
        status, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      if (submission.status === "confirmed") {
        return json(409, { error: "paidy_confirm_in_progress", message: "A Confirm already claimed this Paidy payment. Use \"Finish recording\" instead of Reject." });
      }
      const { data: pp, error: ppErr } = await supabase
        .from("paidy_payments").select("id, paidy_payment_id, status").eq("id", submission.paidy_payment_id).maybeSingle();
      if (ppErr) return json(500, { error: "Could not read the Paidy record. Nothing was changed; try again." });
      if (pp && (pp.status === "authorized" || pp.status === "captured")) {
        let live: PaidyPayment;
        try {
          live = await paidy.get(pp.paidy_payment_id);
        } catch (e) {
          console.error("[review-payment-submission] paidy.get before reject failed:", e);
          return json(502, { error: "paidy_unverified", message: "Could not check this payment with Paidy, so it was not rejected (Paidy may already have taken the money). Try again in a few minutes." });
        }
        const outcome = paidyProviderOutcome(live);
        const at = new Date().toISOString();
        if (outcome === "captured") {
          return json(409, { error: "paidy_already_captured", message: "Paidy has already taken this payment. Do not reject it — press Confirm: the Hub records the capture and does not charge the customer again." });
        }
        if (outcome === "authorized" || outcome === "expired") {
          try {
            const closed = await paidy.close(pp.paidy_payment_id);
            const { error: recErr } = await supabase.from("paidy_payments").update({
              status: "closed", closed_at: at, closed_reason: "rejected by reviewer", last_payload: closed, updated_at: at,
            }).eq("id", pp.id);
            if (recErr) console.error("[review-payment-submission] paidy_payments closed update failed:", recErr);
          } catch (e) {
            console.warn("[review-payment-submission] paidy.close on reject failed (non-blocking):", e);
            await paidyBell(supabase, "paidy_close_failed", "Paidy authorisation could not be released",
              `Submission ${submission_id} was rejected but Paidy did not accept the close: ${e instanceof Error ? e.message : String(e)}. It expires by itself after 30 days.`,
              { submission_id, paidy_payment_id: pp.paidy_payment_id });
          }
        } else if (outcome === "closed" || outcome === "rejected") {
          const { error: recErr } = await supabase.from("paidy_payments").update({
            status: outcome, closed_at: at, closed_reason: `Paidy status ${String(live.status)} at reject`, last_payload: live, updated_at: at,
          }).eq("id", pp.id);
          if (recErr) console.error("[review-payment-submission] paidy_payments status update failed:", recErr);
        }
      }
    }

    // SQUARE: Reject voids the hold (no charge, no fee). Best effort — a
    // Square outage must not stop the reviewer; Square cancels the hold by
    // itself at the end of the window (delay_action CANCEL), and the bell says so.
    if (action === "rejected" && isSquareSubmission) {
      const { data: sp } = await supabase
        .from("square_payments").select("id, square_payment_id, status, test").eq("id", submission.square_payment_id).maybeSingle();
      if (sp && sp.status === "authorized") {
        try {
          const voided = await square.cancel(sp.test === true, sp.square_payment_id);
          await supabase.from("square_payments").update({
            status: "voided", voided_at: new Date().toISOString(), voided_reason: "rejected by reviewer", last_payload: voided, updated_at: new Date().toISOString(),
          }).eq("id", sp.id);
        } catch (e) {
          console.warn("[review-payment-submission] square.cancel on reject failed (non-blocking):", e);
          try {
            await supabase.from("staff_notifications").insert({
              type: "card_void_failed",
              title: "Card hold could not be voided",
              body: `Submission ${submission_id} was rejected but Square did not accept the cancel: ${e instanceof Error ? e.message : String(e)}. Square drops the hold by itself at the end of the 7-day window; check the Square Dashboard.`,
              metadata: { submission_id, square_payment_id: sp.square_payment_id },
            });
          } catch { /* bell is best effort */ }
        }
      }
    }

    // Update submission status
    const updateData: Record<string, unknown> = {
      status: action,
      reviewer_user_id: user.id,
      reviewer_notes: reviewer_notes || null,
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
    const { data: updatedRows, error: updateErr } = await updateQuery.select("id");

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

    // Audit log
    await supabase.from("audit_logs").insert({
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
