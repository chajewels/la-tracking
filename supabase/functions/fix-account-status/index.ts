import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function hasPermission(supabase: any, userId: string, permissionKey: string) {
  const { data: roles, error: roleError } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  if (roleError) throw roleError;

  const roleNames = (roles ?? []).map((row: any) => row.role);
  if (roleNames.length === 0) return false;

  const { data: permissions, error: permissionError } = await supabase
    .from("role_permissions")
    .select("role, is_allowed")
    .eq("permission_key", permissionKey)
    .in("role", roleNames);
  if (permissionError) throw permissionError;

  return (permissions ?? []).some((row: any) => row.is_allowed);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Validate JWT — allow service-role or anon-key bypass for internal invocations
    const authHeader = req.headers.get("Authorization");
    let userId: string | null = null;
    if (authHeader) {
      const token = authHeader.replace("Bearer ", "");
      const isInternalKey = token === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || token === Deno.env.get("SUPABASE_ANON_KEY");
      if (!isInternalKey) {
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) throw new Error("Unauthorized");
        const canRunSystemHealthFixes = await hasPermission(supabase, user.id, "system_health");
        if (!canRunSystemHealthFixes) throw new Error("Permission denied");
        userId = user.id;
      }
    }

    const body = await req.json();
    const { action, schedule_id, invoice_number } = body;
    let { account_id } = body;

    // Allow lookup by invoice_number as alternative to account_id
    if (!account_id && invoice_number) {
      const { data: found } = await supabase
        .from("layaway_accounts")
        .select("id")
        .eq("invoice_number", invoice_number)
        .single();
      if (!found) throw new Error(`Account not found for invoice_number: ${invoice_number}`);
      account_id = found.id;
    }

    if (!action || !account_id) throw new Error("Missing action or account_id");

    const results: any = { action, account_id, changes: [] };
    const today = new Date().toISOString().split("T")[0];

    // Get account
    const { data: account, error: accErr } = await supabase
      .from("layaway_accounts")
      .select("*")
      .eq("id", account_id)
      .single();
    if (accErr || !account) throw new Error("Account not found");

    const oldStatus = account.status;

    if (action === "fix_status") {
      // Determine correct status based on schedule and payments
      const { data: schedules } = await supabase
        .from("layaway_schedule")
        .select("*")
        .eq("account_id", account_id)
        .not("status", "eq", "cancelled")
        .order("due_date");

      const allPaid = (schedules || []).every((s: any) => s.status === "paid" || Number(s.paid_amount) >= Number(s.base_installment_amount));
      const hasPastDueUnpaid = (schedules || []).some(
        (s: any) => s.due_date < today && s.status !== "paid" && s.status !== "cancelled" && Number(s.paid_amount) < Number(s.base_installment_amount)
      );

      let correctStatus = "active";
      if (allPaid) correctStatus = "completed";
      else if (hasPastDueUnpaid) correctStatus = "overdue";

      if (correctStatus !== oldStatus) {
        const { error: updErr } = await supabase
          .from("layaway_accounts")
          .update({ status: correctStatus })
          .eq("id", account_id);
        if (updErr) throw updErr;
        results.changes.push({ field: "status", from: oldStatus, to: correctStatus });
      } else {
        results.changes.push({ field: "status", note: `Already correct: ${oldStatus}` });
      }
    } else if (action === "recalculate") {
      // Recalculate total_paid and remaining_balance from actual payments
      const { data: payments } = await supabase
        .from("payments")
        .select("amount_paid")
        .eq("account_id", account_id)
        .is("voided_at", null);

      const actualTotalPaid = (payments || []).reduce((s: number, p: any) => s + Number(p.amount_paid), 0);

      // remainingBalance = total_amount + activePenalties + services - totalPaid
      // activePenalties = non-waived penalty_fees (paid + unpaid, excludes waived)
      const { data: activePens } = await supabase
        .from("penalty_fees")
        .select("penalty_amount")
        .eq("account_id", account_id)
        .not("status", "eq", "waived");
      const activePenaltySum = (activePens || []).reduce((s: number, f: any) => s + Number(f.penalty_amount), 0);

      const { data: accountSvcs } = await supabase
        .from("account_services")
        .select("amount")
        .eq("account_id", account_id);
      const servicesSum = (accountSvcs || []).reduce((s: number, sv: any) => s + Number(sv.amount), 0);

      const correctRemaining = Math.max(0, Number(account.total_amount) + activePenaltySum + servicesSum - actualTotalPaid);

      const updates: any = {};
      if (Math.abs(actualTotalPaid - Number(account.total_paid)) > 0.01) {
        updates.total_paid = actualTotalPaid;
        results.changes.push({ field: "total_paid", from: Number(account.total_paid), to: actualTotalPaid });
      }
      if (Math.abs(correctRemaining - Number(account.remaining_balance)) > 0.01) {
        updates.remaining_balance = correctRemaining;
        results.changes.push({ field: "remaining_balance", from: Number(account.remaining_balance), to: correctRemaining });
      }

      if (Object.keys(updates).length > 0) {
        const { error: updErr } = await supabase
          .from("layaway_accounts")
          .update(updates)
          .eq("id", account_id);
        if (updErr) throw updErr;
      } else {
        results.changes.push({ note: "All totals already correct" });
      }

      // Sync schedule rows: zero out penalty_amount + total_due_amount for waived penalties
      const { data: waivedPens } = await supabase
        .from("penalty_fees")
        .select("schedule_id, penalty_amount")
        .eq("account_id", account_id)
        .eq("status", "waived");

      for (const pf of (waivedPens || [])) {
        if (!pf.schedule_id) continue;
        const { data: sched } = await supabase
          .from("layaway_schedule")
          .select("id, installment_number, penalty_amount, base_installment_amount, total_due_amount")
          .eq("id", pf.schedule_id)
          .single();
        if (!sched) continue;
        if (Number(sched.penalty_amount) === 0) continue; // already zeroed

        const newTotal = Number(sched.base_installment_amount);
        const { error: schErr } = await supabase
          .from("layaway_schedule")
          .update({ penalty_amount: 0, total_due_amount: newTotal })
          .eq("id", sched.id);
        if (schErr) throw schErr;
        results.changes.push({
          field: `schedule_${sched.installment_number}_penalty`,
          from: Number(sched.penalty_amount),
          to: 0,
        });
        results.changes.push({
          field: `schedule_${sched.installment_number}_total_due`,
          from: Number(sched.total_due_amount),
          to: newTotal,
        });
      }
    } else if (action === "sync_schedule") {
      // For a specific schedule row or all: align status with paid_amount
      const query = supabase
        .from("layaway_schedule")
        .select("*")
        .eq("account_id", account_id)
        .not("status", "eq", "cancelled");

      if (schedule_id) query.eq("id", schedule_id);

      const { data: schedules } = await query;
      let fixed = 0;

      for (const s of (schedules || [])) {
        const paidAmt = Number(s.paid_amount);
        const baseAmt = Number(s.base_installment_amount);
        let correctStatus = s.status;

        if (paidAmt >= baseAmt && baseAmt > 0) {
          correctStatus = "paid";
        } else if (paidAmt > 0 && paidAmt < baseAmt) {
          correctStatus = "partially_paid";
        } else if (s.due_date < today && paidAmt === 0) {
          correctStatus = "overdue";
        } else if (paidAmt === 0) {
          correctStatus = "pending";
        }

        if (correctStatus !== s.status) {
          await supabase
            .from("layaway_schedule")
            .update({ status: correctStatus })
            .eq("id", s.id);
          fixed++;
          results.changes.push({
            field: `schedule_${s.installment_number}_status`,
            from: s.status,
            to: correctStatus,
          });
        }
      }
      if (fixed === 0) results.changes.push({ note: "All schedule statuses already correct" });
    } else {
      throw new Error(`Unknown action: ${action}`);
    }

    // Audit log
    if (results.changes.some((c: any) => c.from !== undefined)) {
      await supabase.from("audit_logs").insert({
        action: `SYSTEM_HEALTH_FIX_${action.toUpperCase()}`,
        entity_type: "layaway_account",
        entity_id: account_id,
        performed_by_user_id: userId,
        old_value_json: { status: oldStatus, changes_applied: results.changes.filter((c: any) => c.from !== undefined).map((c: any) => ({ field: c.field, old: c.from })) },
        new_value_json: { action, changes: results.changes },
      });
    }

    return new Response(JSON.stringify(results), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
