import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkPermission } from "../_shared/check-permission.ts";
import { postAppEmail } from "../_shared/send-app-email.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Reactivate Account — One-time reactivation of a forfeited account
 *
 * ⛔ PERMANENT FORFEITURE LIFECYCLE — LOCKED RULE
 * DO NOT MODIFY without explicit business owner approval.
 *
 * GUARDS (all enforced server-side):
 *   - Account MUST be in 'forfeited' status
 *   - Account MUST NOT have is_reactivated = true (one-time only)
 *   - FINAL_FORFEITED accounts can NEVER be reactivated
 *
 * ACTIONS:
 *   1. Changes status to 'extension_active'
 *   2. Sets is_reactivated = true, extension_end_date = last_due + 1 month
 *   3. Records penalty_count_at_reactivation (penalty cycle continues, no reset)
 *   4. Un-cancels remaining schedule items
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const allowed = await checkPermission(supabase, user.id, "reactivate_account");
    if (!allowed) {
      return new Response(JSON.stringify({ error: "Permission denied: reactivate_account not allowed" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { account_id } = await req.json();
    if (!account_id) {
      return new Response(JSON.stringify({ error: "account_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const staffUserId = user.id;

    // Fetch account
    const { data: account, error: accErr } = await supabase
      .from("layaway_accounts")
      .select("id, invoice_number, customer_id, status, is_reactivated, currency, payment_plan_months")
      .eq("id", account_id)
      .single();

    if (accErr || !account) {
      return new Response(JSON.stringify({ error: "Account not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ══════════════════════════════════════════════
    // LOYALTY: AUTO-RESTORE (Decision 5 — UPDATED via Bug #101, 2026-05-14)
    // ══════════════════════════════════════════════
    // reactivate-account now AUTO-RESTORES loyalty by calling
    // restore-loyalty-points on the most recent revoke transaction
    // for this account. Reverses the original Bug #99 Decision 5
    // (was "no auto re-award"). See restore block placed after the
    // successful status transition below — fire-and-forget pattern.

    // ⛔ LOCKED: FINAL_FORFEITED can NEVER be reactivated
    if (account.status === "final_forfeited") {
      return new Response(JSON.stringify({ error: "This account is PERMANENTLY FORFEITED. No reactivation, extension, or negotiation is allowed." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ⛔ LOCKED: must be forfeited status
    if (account.status !== "forfeited") {
      return new Response(JSON.stringify({ error: `Account is '${account.status}', not 'forfeited'. Only forfeited accounts can be reactivated.` }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ⛔ LOCKED: one-time only — no second reactivation ever
    if (account.is_reactivated) {
      return new Response(JSON.stringify({ error: "This account has already been reactivated once. No further reactivation is allowed." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get current penalty count to preserve continuation
    const { data: penalties } = await supabase
      .from("penalty_fees")
      .select("id")
      .eq("account_id", account_id)
      .in("status", ["unpaid", "paid"]);
    const currentPenaltyCount = (penalties || []).length;

    // Get the last due date from schedule to compute extension end
    const { data: schedItems } = await supabase
      .from("layaway_schedule")
      .select("due_date, id, status")
      .eq("account_id", account_id)
      .order("installment_number", { ascending: false });

    // Extension = 1 month from reactivation date (Bug #108 fix, 2026-05-15)
    // Business rule: customer gets 1 month from reactivation to settle, regardless of last due date
    const extDate = new Date();
    extDate.setUTCMonth(extDate.getUTCMonth() + 1);
    const extensionEndDate = extDate.toISOString().split("T")[0];

    const now = new Date().toISOString();

    // Un-cancel remaining schedule items so penalty engine can continue
    const cancelledItems = (schedItems || []).filter((s: any) => s.status === "cancelled");
    for (const item of cancelledItems) {
      await supabase.from("layaway_schedule").update({
        status: "overdue",
        updated_at: now,
      }).eq("id", item.id);
    }

    // Update account
    const { error: updateErr } = await supabase
      .from("layaway_accounts")
      .update({
        status: "extension_active",
        is_reactivated: true,
        reactivated_at: now,
        reactivated_by_user_id: staffUserId,
        extension_end_date: extensionEndDate,
        penalty_count_at_reactivation: currentPenaltyCount,
        updated_at: now,
      })
      .eq("id", account_id);

    if (updateErr) throw updateErr;

    // Always create Extension Month row so penalty cap path is reachable
    // regardless of forfeit reason (Bug #106 fix, 2026-05-15)
    await supabase.from("layaway_schedule").insert({
      account_id: account_id,
      installment_number: account.payment_plan_months + 1,
      due_date: extensionEndDate,
      base_installment_amount: 0,
      total_due_amount: 0,
      currency: account.currency,
      status: "pending",
    });

    // Auto-approve any pending extension request for this account
    try {
      const { error: extReqErr } = await supabase
        .from('extension_requests')
        .update({
          status: 'approved',
          reviewed_at: now,
          reviewed_by: staffUserId,
          reviewer_notes: '[Auto-approved: account reactivated to extension_active via reactivate-account edge function]'
        })
        .eq('account_id', account_id)
        .eq('status', 'pending');

      if (extReqErr) {
        console.warn(`[reactivate-account] extension_requests auto-approve failed for ${account.invoice_number} (non-blocking):`, extReqErr);
      }
    } catch (e) {
      console.warn(`[reactivate-account] extension_requests block threw for ${account.invoice_number} (non-blocking):`, e);
    }

    // Fetch customer name for audit
    const { data: cust } = await supabase
      .from("customers")
      .select("full_name")
      .eq("id", account.customer_id)
      .single();

    // Audit log
    await supabase.from("audit_logs").insert({
      entity_type: "layaway_account",
      entity_id: account_id,
      action: "reactivated",
      performed_by_user_id: staffUserId,
      new_value_json: {
        invoice_number: account.invoice_number,
        customer_name: cust?.full_name || "Unknown",
        penalty_count_at_reactivation: currentPenaltyCount,
        extension_end_date: extensionEndDate,
        timestamp: now,
      },
    });

    // Send extension-granted email (fire-and-forget)
    try {
      const { data: acctForEmail } = await supabase
        .from("layaway_accounts")
        .select("invoice_number, currency, remaining_balance, customers(full_name, email)")
        .eq("id", account_id)
        .single();
      const customerEmail = (acctForEmail as any)?.customers?.email;
      const customerName = (acctForEmail as any)?.customers?.full_name;
      if (customerEmail) {
        const portalUrl = `https://portal.chajewelsjp.com/portal?invoice=${(acctForEmail as any)?.invoice_number || ""}`;
        const _emRes = await postAppEmail({
            templateName: "extension-granted",
            recipientEmail: customerEmail,
            idempotencyKey: `extension-granted-${account_id}`,
            templateData: {
              customerName,
              invoiceNumber: (acctForEmail as any)?.invoice_number,
              extensionEndDate,
              remainingBalance: Number((acctForEmail as any)?.remaining_balance ?? 0).toLocaleString("en-US"),
              currency: (acctForEmail as any)?.currency,
              portalUrl,
            },
          });
        if (!_emRes.ok) {
          const _t = await _emRes.text().catch(() => "<no body>");
          console.error(`[reactivate-account] app email send failed (${_emRes.status}): ${_t}`);
        }
      }
    } catch (emailErr) {
      console.warn("[reactivate-account] email send failed (non-blocking):", emailErr);
    }

    // Bug #101 — auto-restore loyalty for reactivated account.
    // Find the most recent revoke transaction tied to this account and
    // invoke restore-loyalty-points. Fire-and-forget; failures never
    // block reactivation.
    try {
      const { data: revokeTx } = await supabase
        .from("loyalty_transactions")
        .select("id")
        .eq("account_id", account_id)
        .eq("transaction_type", "revoked")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (revokeTx?.id) {
        const _rsRes = await fetch(
          `${Deno.env.get("SUPABASE_URL")}/functions/v1/restore-loyalty-points`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
            },
            body: JSON.stringify({
              revoke_transaction_id: revokeTx.id,
              trigger_event: "account_reactivated",
            }),
          },
        ).catch((e) => {
          console.warn(
            `[reactivate-account] restore-loyalty-points failed for ${account.invoice_number} (non-blocking):`,
            e,
          );
          return null;
        });
        if (_rsRes && !_rsRes.ok) {
          const _t = await _rsRes.text().catch(() => "<no body>");
          console.error(`[reactivate-account] restore-loyalty-points failed (${_rsRes.status}): ${_t}`);
        }

        console.log(
          `[reactivate-account] restore-loyalty-points invoked for ${account.invoice_number} with revoke_tx ${revokeTx.id}`,
        );
      } else {
        console.log(
          `[reactivate-account] no prior revoke transaction found for account ${account.id} — nothing to restore`,
        );
      }
    } catch (restoreErr) {
      console.warn(
        `[reactivate-account] restore block failed for ${account.invoice_number} (non-blocking):`,
        restoreErr,
      );
    }

    return new Response(JSON.stringify({
      success: true,
      invoice_number: account.invoice_number,
      new_status: "extension_active",
      extension_end_date: extensionEndDate,
      penalty_count_preserved: currentPenaltyCount,
      message: `Account reactivated. Extension until ${extensionEndDate}. Penalty count continues from ${currentPenaltyCount}.`,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Reactivate account error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
