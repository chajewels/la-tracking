import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkPermission } from "../_shared/check-permission.ts";
import { sendTemplateEmail } from "../_shared/transactional-email-templates/send-email.ts";
import { customerReference } from "../_shared/order-reference.ts";
import { reactivateRefusal } from "../_shared/web-order-rules.ts";

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
 * OWNER-APPROVED CHANGE 2026-09-23 — reactivation is ALL-OR-NOTHING. Actions
 * 1, 2 and 4 below (account flip, reactivation fields, un-cancel) and the
 * Extension Month row are now ONE transaction in reactivate_layaway_atomic,
 * with the same values as before. For a WEB plan whose pieces were put back on
 * sale at forfeiture, the RPC re-holds them first; if one has sold it returns
 * out_of_stock and NOTHING changes — schedule rows stay cancelled, the status
 * stays forfeited — and staff get a 409 naming the piece. Every guard, the
 * penalty-engine call, the audit row, the extension-granted email and the
 * loyalty restore are unchanged and in the same order.
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

    // Extension = 1 month from reactivation date (Bug #108 fix, 2026-05-15)
    // Business rule: customer gets 1 month from reactivation to settle, regardless of last due date
    const extDate = new Date();
    extDate.setUTCMonth(extDate.getUTCMonth() + 1);
    const extensionEndDate = extDate.toISOString().split("T")[0];

    const now = new Date().toISOString();

    // Un-cancel the remaining schedule items, flip the account and add the
    // Extension Month row — ONE transaction (owner-approved 2026-09-23). Same
    // rows and values as the three separate writes this replaced; the
    // Extension Month insert still never blocks reactivation (the RPC runs it
    // in a subtransaction and reports a failure instead of raising).
    // For a web plan whose pieces were released at forfeiture the RPC re-holds
    // them first and refuses out_of_stock before writing anything.
    // Service-role client for the RPC only: `supabase` above carries the staff
    // JWT (every other call here runs under it, unchanged), and the RPC is
    // granted to service_role alone so no signed-in user can call it directly
    // and skip the reactivate_account permission checked above.
    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: reactivated, error: reactErr } = await serviceClient.rpc("reactivate_layaway_atomic", {
      p_account_id: account_id,
      p_user_id: staffUserId,
      p_extension_end_date: extensionEndDate,
      p_penalty_count: currentPenaltyCount,
    });
    const refusal = reactivateRefusal(
      reactErr ? { message: reactErr.message } : (reactivated as Record<string, unknown> | null),
    );
    if (refusal) {
      return new Response(JSON.stringify(refusal.body), {
        status: refusal.status, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (reactErr) throw reactErr;
    if ((reactivated as any)?.extension_row_error) {
      console.warn(
        `[reactivate-account] Extension Month row not inserted for ${account.invoice_number} (non-blocking, as before): ${(reactivated as any).extension_row_error}`,
      );
    }

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

    // ── Run the penalty engine for THIS account, now ──────────────────────
    // Reactivation is the moment the account re-enters the engine's eligible
    // status set. Waiting for the 00:05 UTC cron leaves up to ~24 hours in
    // which the schedule shows overdue months carrying no penalty the rules
    // already say is due — which is what happened to invoice 18788
    // (reactivated 04:16 UTC, next cron 20 hours away).
    //
    // Deliberately AFTER the account update, the Extension Month row and the
    // extension_requests block: the engine reads account.status,
    // is_reactivated and the un-cancelled schedule rows, so it must not run
    // until all three are written.
    //
    // Non-blocking, exactly like restore-loyalty-points below: a failure here
    // must never undo a reactivation that already succeeded. The engine is
    // idempotent per stage:cycle, so tonight's cron picks up anything missed.
    let penaltyResult: {
      penalties_created: number;
      created: Array<{ installment_number: number | null; amount: number; currency?: string }>;
      error?: string;
    } = { penalties_created: 0, created: [] };

    try {
      const peRes = await fetch(
        `${Deno.env.get("SUPABASE_URL")}/functions/v1/penalty-engine`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({ account_id }),
        },
      );
      if (peRes.ok) {
        const peBody = await peRes.json().catch(() => null);
        penaltyResult = {
          penalties_created: Number(peBody?.penalties_created ?? 0),
          created: Array.isArray(peBody?.created) ? peBody.created : [],
        };
        console.log(
          `[reactivate-account] penalty-engine (account scope) for ${account.invoice_number}: ${penaltyResult.penalties_created} penalty row(s)`,
        );
      } else {
        const t = await peRes.text().catch(() => "<no body>");
        penaltyResult.error = `penalty-engine returned ${peRes.status}`;
        console.error(
          `[reactivate-account] penalty-engine failed (${peRes.status}) for ${account.invoice_number} (non-blocking): ${t}`,
        );
      }
    } catch (peErr) {
      penaltyResult.error = (peErr as Error)?.message ?? "penalty-engine call failed";
      console.warn(
        `[reactivate-account] penalty-engine call threw for ${account.invoice_number} (non-blocking):`,
        peErr,
      );
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
        penalties_created_at_reactivation: penaltyResult.penalties_created,
        extension_end_date: extensionEndDate,
        timestamp: now,
      },
    });

    // Send extension-granted email (fire-and-forget)
    try {
      const { data: acctForEmail } = await supabase
        .from("layaway_accounts")
        .select("invoice_number, web_reference, source_channel, currency, remaining_balance, customers(full_name, email)")
        .eq("id", account_id)
        .single();
      const customerEmail = (acctForEmail as any)?.customers?.email;
      const customerName = (acctForEmail as any)?.customers?.full_name;
      if (customerEmail) {
        const portalUrl = `https://portal.chajewelsjp.com/portal?invoice=${(acctForEmail as any)?.invoice_number || ""}`;
        const result = await sendTemplateEmail(
          "extension-granted",
          customerEmail,
          {
            templateData: {
              customerName,
              invoiceNumber: customerReference(acctForEmail as any),
              extensionEndDate,
              remainingBalance: Number((acctForEmail as any)?.remaining_balance ?? 0).toLocaleString("en-US"),
              currency: (acctForEmail as any)?.currency,
              portalUrl,
            },
            idempotencyKey: `extension-granted-${account_id}`,
          },
        );
        if (!result.sent) {
          console.log(`[reactivate-account] "extension-granted" suppressed for ${customerEmail}`);
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
      penalty_result: penaltyResult,
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
