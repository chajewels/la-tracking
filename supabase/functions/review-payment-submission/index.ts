import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { checkPermission } from "../_shared/check-permission.ts";
import { appendManyReceipts, type CashReceiptSlot } from "../_shared/cash-receipt.ts";
import { sendTemplateEmail } from "../_shared/transactional-email-templates/send-email.ts";

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
    if (action === "confirmed" && (typeof submission.proof_url !== "string" || submission.proof_url.trim().length === 0)) {
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

      // 1. Fetch cash order — must exist and be pending
      const { data: cashOrder, error: cashOrderErr } = await supabase
        .from("cash_orders")
        .select("id, customer_id, currency, invoice_number, status, total_paid, remaining_balance, completed_at, cash_receipt_sheet_id")
        .eq("id", submission.cash_order_id)
        .maybeSingle();
      if (cashOrderErr || !cashOrder) {
        return new Response(JSON.stringify({ error: "cash_order not found" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (cashOrder.status === "cancelled" || cashOrder.status === "expired") {
        return new Response(JSON.stringify({ error: `cash_order is ${cashOrder.status}, cannot confirm payment` }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // 2. Re-validate ceiling at review time (other payments may have arrived between submission and review)
      const submittedAmount = Number(submission.submitted_amount);
      const liveRemaining = Number(cashOrder.remaining_balance);
      if (submittedAmount > liveRemaining + 0.005) {
        return new Response(JSON.stringify({
          error: `submitted_amount (${submittedAmount}) exceeds current remaining_balance (${liveRemaining})`,
        }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // 3. Insert cash_payments row
      const submittedByType = submission.portal_token ? "customer" : "staff";
      const { data: cashPayment, error: cpErr } = await supabase
        .from("cash_payments")
        .insert({
          cash_order_id: cashOrder.id,
          amount_paid: submittedAmount,
          currency: cashOrder.currency,
          date_paid: submission.payment_date,
          payment_method: submission.payment_method,
          reference_number: submission.reference_number,
          remarks: submission.notes,
          entered_by_user_id: user.id,
          submitted_by_type: submittedByType,
          submitted_by_name: submission.sender_name,
        })
        .select()
        .single();
      if (cpErr || !cashPayment) {
        console.error("cash_payments insert error:", cpErr);
        return new Response(JSON.stringify({ error: cpErr?.message || "Failed to create cash_payment" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // 4. Update cash_orders totals + status if fully paid.
      //
      // Before mutating, capture a pre-update snapshot so we can revert if
      // step 5 (submission update) fails. Edge functions don't have DB
      // transactions across multiple statements, so we hand-roll rollback to
      // prevent the half-confirmed state where cash_payment + cash_order are
      // updated but the submission row is still 'submitted' (caught in
      // production 2026-04-28 — fully paid order with stale submission row,
      // customer unable to retry because remaining_balance was 0).
      const cashOrderSnapshot = {
        total_paid: cashOrder.total_paid,
        remaining_balance: cashOrder.remaining_balance,
        status: cashOrder.status,
        completed_at: cashOrder.completed_at,
      };
      const newTotalPaid = Math.round((Number(cashOrder.total_paid) + submittedAmount) * 100) / 100;
      const newRemaining = Math.max(0, Math.round((liveRemaining - submittedAmount) * 100) / 100);
      const isFullyPaid = newRemaining <= 0.005;
      // Preserve existing status when not fully paid — partial payments do NOT
      // flip an expired/extension/etc. order back to pending. The line 476 block
      // above already prevents confirming on cancelled/expired orders, so this
      // is defense in depth for any future status enum additions.
      const statusAfter = isFullyPaid ? "completed" : cashOrder.status;
      const orderUpdate: Record<string, unknown> = {
        total_paid: newTotalPaid,
        remaining_balance: newRemaining,
      };
      if (isFullyPaid) {
        orderUpdate.status = "completed";
        orderUpdate.completed_at = new Date().toISOString();
      }
      const { data: updatedOrder, error: orderUpdErr } = await supabase
        .from("cash_orders")
        .update(orderUpdate)
        .eq("id", cashOrder.id)
        .select()
        .single();
      if (orderUpdErr) {
        // Step 4 failed — rollback the cash_payment from step 3.
        await supabase.from("cash_payments").delete().eq("id", cashPayment.id);
        return new Response(JSON.stringify({ error: "Failed to update cash_order: " + orderUpdErr.message }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // 5. Update submission status
      const subUpdate: Record<string, unknown> = {
        status: "confirmed",
        reviewer_user_id: user.id,
        reviewer_notes: reviewer_notes || null,
        confirmed_payment_id: cashPayment.id,
        updated_at: new Date().toISOString(),
      };
      const { error: subUpdErr } = await supabase
        .from("payment_submissions")
        .update(subUpdate)
        .eq("id", submission_id);
      if (subUpdErr) {
        console.error("[review-payment-submission] submission update failed for cash confirm — rolling back:", subUpdErr);
        // Step 5 failed — manual rollback of step 4 (cash_orders) and step 3
        // (cash_payments) to prevent half-confirmed state.
        const { error: orderRevertErr } = await supabase
          .from("cash_orders")
          .update({
            total_paid: cashOrderSnapshot.total_paid,
            remaining_balance: cashOrderSnapshot.remaining_balance,
            status: cashOrderSnapshot.status,
            completed_at: cashOrderSnapshot.completed_at,
          })
          .eq("id", cashOrder.id);
        if (orderRevertErr) {
          // Revert failed — flag this loudly. We are now in a state where:
          //   - cash_payment exists
          //   - cash_order is updated (not reverted)
          //   - submission is still 'submitted'
          // This requires manual reconciliation. Audit-log the situation.
          console.error("[review-payment-submission] CRITICAL: cash_orders revert failed after submission update failure:", orderRevertErr);
          await supabase.from("audit_logs").insert({
            entity_type: "cash_payment_submission",
            entity_id: submission_id,
            action: "confirm_rollback_failed",
            performed_by_user_id: user.id,
            new_value_json: {
              cash_payment_id: cashPayment.id,
              cash_order_id: cashOrder.id,
              submission_update_error: subUpdErr.message,
              order_revert_error: orderRevertErr.message,
              snapshot: cashOrderSnapshot,
            },
          });
          return new Response(JSON.stringify({
            error: "Failed to record confirmation and rollback also failed. Manual reconciliation required. cash_payment_id=" + cashPayment.id,
          }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        const { error: cpDeleteErr } = await supabase
          .from("cash_payments")
          .delete()
          .eq("id", cashPayment.id);
        if (cpDeleteErr) {
          console.error("[review-payment-submission] cash_payment delete failed during rollback:", cpDeleteErr);
        }
        return new Response(JSON.stringify({
          error: "Failed to record confirmation: " + subUpdErr.message + ". State has been rolled back; please retry.",
        }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // 6. Audit log
      await supabase.from("audit_logs").insert({
        entity_type: "cash_payment_submission",
        entity_id: submission_id,
        action: "confirm",
        performed_by_user_id: user.id,
        new_value_json: {
          cash_payment_id: cashPayment.id,
          amount_confirmed: submittedAmount,
          remaining_after: newRemaining,
          status_after: statusAfter,
        },
        old_value_json: { status: submission.status },
      });

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

      // Fire-and-forget: incrementally update the payment tracking sheet (cash order).
      try {
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
        const amount_jpy = cashOrder.currency === "JPY"
          ? submission.submitted_amount
          : Math.round(submission.submitted_amount / phpJpyRate);
        fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/append-payment-tracking`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({
            invoice_number: cashOrder.invoice_number,
            payment_date: submission.payment_date,
            amount_jpy,
            currency: cashOrder.currency,
          }),
        }).catch(err => console.warn("[review-payment-submission] append-payment-tracking failed:", err));
      } catch (e) {
        console.warn("[review-payment-submission] append-payment-tracking (cash) prep failed (non-blocking):", e);
      }

      // 7. Fire-and-forget: cash-payment-confirmed email
      try {
        const { data: customer } = await supabase
          .from("customers")
          .select("full_name, email")
          .eq("id", cashOrder.customer_id)
          .single();
        const customerEmail = customer?.email;
        if (customerEmail) {
          const result = await sendTemplateEmail(
            "cash-payment-confirmed",
            customerEmail,
            {
              templateData: {
                customerName: customer?.full_name || "Valued Customer",
                invoiceNumber: cashOrder.invoice_number,
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
            console.log(`[review-payment-submission] "cash-payment-confirmed" suppressed for ${customerEmail}`);
          }
