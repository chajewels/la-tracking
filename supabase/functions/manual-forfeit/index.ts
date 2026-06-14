import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkPermission } from "../_shared/check-permission.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Auth check — require valid Bearer token
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Permission check — shared helper resolves per CLAUDE.md order
    const allowed = await checkPermission(supabase, user.id, "forfeit_account");
    if (!allowed) {
      return new Response(
        JSON.stringify({ error: "Permission denied: you don't have access to forfeit accounts" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { account_id } = await req.json();
    if (!account_id) {
      return new Response(JSON.stringify({ error: "account_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch account
    const { data: account, error: accErr } = await supabase
      .from("layaway_accounts")
      .select("id, invoice_number, status, customer_id, currency, total_paid")
      .eq("id", account_id)
      .single();

    if (accErr || !account) {
      return new Response(JSON.stringify({ error: "Account not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Block already-terminal states
    const blocked = ["forfeited", "final_forfeited", "completed", "cancelled"];
    if (blocked.includes(account.status)) {
      return new Response(
        JSON.stringify({ error: `Cannot forfeit account with status '${account.status}'` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const now = new Date().toISOString();

    // Update account to forfeited
    const { error: updateErr } = await supabase
      .from("layaway_accounts")
      .update({ status: "forfeited", updated_at: now, forfeited_at: now })
      .eq("id", account_id);

    if (updateErr) {
      return new Response(
        JSON.stringify({ error: "Failed to update account: " + updateErr.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Cancel all non-paid schedule rows
    const { error: schedErr } = await supabase
      .from("layaway_schedule")
      .update({ status: "cancelled", updated_at: now })
      .eq("account_id", account_id)
      .not("status", "eq", "paid");

    if (schedErr) {
      console.error("manual-forfeit: schedule cancel error:", schedErr.message);
    }

    // Audit log
    await supabase.from("audit_logs").insert({
      entity_type: "layaway_account",
      entity_id: account_id,
      action: "manual_forfeit",
      performed_by_user_id: user.id,
      new_value_json: {
        invoice_number: account.invoice_number,
        previous_status: account.status,
        forfeited_at: now,
      },
    });

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

    // Send account-forfeited email (fire-and-forget)
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
        const _emRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/send-transactional-email`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({
            templateName: "account-forfeited",
            recipientEmail: customerEmail,
            idempotencyKey: `account-forfeited-${account_id}-${Date.now()}`,
            templateData: {
              customerName,
              invoiceNumber: (acctForEmail as any)?.invoice_number,
              currency: (acctForEmail as any)?.currency,
              remainingBalance: Number((acctForEmail as any)?.remaining_balance ?? 0).toLocaleString("en-US"),
              forfeitureReason: "Account forfeited due to non-payment",
              extensionAvailable: true,
              portalUrl,
            },
          }),
        });
        if (!_emRes.ok) {
          const _t = await _emRes.text().catch(() => "<no body>");
          console.error(`[manual-forfeit] send-transactional-email failed (${_emRes.status}): ${_t}`);
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

    return new Response(
      JSON.stringify({ ok: true, invoice_number: account.invoice_number, account_id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("manual-forfeit error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
