import { sendTemplateEmail } from "../_shared/transactional-email-templates/send-email.ts";
import { customerReference } from "../_shared/order-reference.ts";
import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";
import { forfeitEmailKind } from "../_shared/web-order-rules.ts";
import { sendLayawayForfeitedEmail } from "../_shared/layaway-forfeit-email.ts";

/**
 * manual-forfeit — staff forfeit a layaway (permission forfeit_account).
 *
 * 2026-09-23: the account flip, the schedule cancel and the audit row were
 * three separate PostgREST writes; they are now ONE transaction in
 * manual_forfeit_layaway_atomic, which for a WEB plan also puts the held pieces
 * back on sale (website_product_variants) and stamps stock_released_at. If the
 * plan is later reactivated, trg_rehold_released_web_layaway_stock takes the
 * stock back or refuses the reactivation if a piece has sold.
 *
 * The customer email follows the channel: a web plan gets the storefront
 * layaway-forfeited email (Cha Jewels brand, customer's language, Reply-To
 * sales@); every other plan keeps the Hub's account-forfeited template exactly
 * as before. Both helpers log every attempt through recordEmailAttempt.
 * The staff bell and the loyalty revoke are unchanged.
 */
Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;

  const ctx = await requireAuth(req);
  if (ctx instanceof Response) return ctx;
  const denied = await requirePermission(ctx, "forfeit_account");
  if (denied) return denied;
  const { supabase } = ctx;
  const user = ctx.user!;

  try {
    const { account_id } = await req.json().catch(() => ({}));
    if (!account_id) return jsonResponse({ error: "account_id is required" }, 400);

    // Read what the side effects below need, before the flip changes it.
    const { data: account, error: accErr } = await supabase
      .from("layaway_accounts")
      .select("id, invoice_number, web_reference, source_channel, status, customer_id, currency, total_amount, total_paid, remaining_balance, customer_lang, customers(full_name, email, is_test)")
      .eq("id", account_id)
      .single();
    if (accErr || !account) return jsonResponse({ error: "Account not found" }, 404);

    // Status, schedule, audit and (web) stock — one transaction.
    const { data: forfeit, error: rpcErr } = await supabase.rpc("manual_forfeit_layaway_atomic", {
      p_account_id: account_id,
      p_user_id: user.id,
      p_source: "staff",
    });
    if (rpcErr) {
      return jsonResponse({ error: "Failed to forfeit account: " + rpcErr.message }, 500);
    }
    const result = (forfeit ?? {}) as Record<string, any>;
    if (result.error === "not_found") return jsonResponse({ error: "Account not found" }, 404);
    if (result.error === "not_forfeitable") {
      return jsonResponse({ error: `Cannot forfeit account with status '${result.status}'` }, 400);
    }
    if (result.error) return jsonResponse(result, 400);

    // Staff bell — account forfeited (fire-and-forget)
    try {
      await supabase.from("staff_notifications").insert({
        type: "account_forfeited",
        title: "Account forfeited",
        body: `Inv #${account.invoice_number} — forfeited (manual) by ${user.email ?? "Admin"}`,
        account_id,
        customer_id: account.customer_id,
        invoice_number: account.invoice_number,
        metadata: { kind: "forfeited", manual: true },
      });
    } catch (nErr) {
      console.warn("[manual-forfeit] account_forfeited notification insert failed (non-blocking):", nErr);
    }

    // Customer email (non-blocking — the forfeit has already committed).
    const customer = (account as any).customers;
    try {
      if (forfeitEmailKind((account as any).source_channel) === "storefront") {
        // Same sender as the automatic path (auto-forfeit-settlement).
        await sendLayawayForfeitedEmail(supabase, account_id, {
          final: false,
          idempotencyKey: `layaway-forfeited-${account_id}-${result.forfeited_at}`,
        });
      } else if (customer?.email) {
        const portalUrl = `https://portal.chajewelsjp.com/portal?invoice=${account.invoice_number || ""}`;
        const sent = await sendTemplateEmail(
          "account-forfeited",
          customer.email,
          {
            templateData: {
              customerName: customer.full_name,
              invoiceNumber: customerReference(account as any),
              currency: account.currency,
              remainingBalance: Number((account as any).remaining_balance ?? 0).toLocaleString("en-US"),
              forfeitureReason: "Account forfeited due to non-payment",
              extensionAvailable: true,
              portalUrl,
            },
            idempotencyKey: `account-forfeited-${account_id}-${Date.now()}`,
          },
        );
        if (!sent.sent) {
          console.log(`[manual-forfeit] "account-forfeited" suppressed for ${customer.email}`);
        }
      }
    } catch (emailErr) {
      console.warn("[manual-forfeit] email send failed (non-blocking):", emailErr);
    }

    // Bug #99 — fire-and-forget loyalty revoke for manually forfeited account
    try {
      let spendJpy: number = Number(account.total_paid ?? 0);
      if (account.currency === "PHP") {
        const { data: rateRow } = await supabase
          .from("system_settings")
          .select("value")
          .eq("key", "php_jpy_rate")
          .single();
        const phpJpyRate = rateRow ? parseFloat(String(rateRow.value)) : NaN;
        if (Number.isFinite(phpJpyRate) && phpJpyRate > 0) {
          spendJpy = Math.round(Number(account.total_paid ?? 0) / phpJpyRate);
        } else {
          console.warn("[manual-forfeit] php_jpy_rate unusable, skipping loyalty revoke:", rateRow);
          throw new Error("php_jpy_rate unusable");
        }
      }
      if (spendJpy > 0) {
        const _rvRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/revoke-loyalty-points`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({
            customer_id: account.customer_id,
            source_reference: account.invoice_number,
            spend_jpy: spendJpy,
            account_id: account.id,
            invoice_number: account.invoice_number,
            notes: `Account forfeited (manual): ${account.invoice_number}`,
            trigger_event: "manual_forfeit",
          }),
        }).catch((e) => {
          console.warn("[manual-forfeit] revoke-loyalty-points failed (non-blocking):", e);
          return null;
        });
        if (_rvRes && !_rvRes.ok) {
          const _t = await _rvRes.text().catch(() => "<no body>");
          console.error(`[manual-forfeit] revoke-loyalty-points failed (${_rvRes.status}): ${_t}`);
        }
      }
    } catch (revokeErr) {
      console.warn("[manual-forfeit] revoke block failed (non-blocking):", revokeErr);
    }

    return jsonResponse({
      ok: true,
      invoice_number: account.invoice_number,
      account_id,
      is_web: result.is_web === true,
      stock_lines_restored: Number(result.stock_lines_restored ?? 0),
    });
  } catch (error) {
    console.error("manual-forfeit error:", error);
    return jsonResponse({ error: (error as Error).message }, 500);
  }
});
