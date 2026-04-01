import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey     = Deno.env.get("SUPABASE_ANON_KEY")!;

    // ── Auth ──────────────────────────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const anonClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: claimsData, error: claimsErr } = await anonClient.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (claimsErr || !claimsData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = claimsData.user.id;
    const supabase = createClient(supabaseUrl, serviceKey);

    // ── Role check: admin or finance only ────────────────────────────────────
    const [{ data: isAdmin }, { data: isFinance }] = await Promise.all([
      supabase.rpc("has_role", { _user_id: userId, _role: "admin" }),
      supabase.rpc("has_role", { _user_id: userId, _role: "finance" }),
    ]);
    if (!isAdmin && !isFinance) {
      return new Response(JSON.stringify({ error: "Forbidden: admin or finance role required" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Parse body ────────────────────────────────────────────────────────────
    const body = await req.json() as {
      waiver_request_ids: string[];
      notes?: string;
    };
    const { waiver_request_ids, notes } = body;

    if (!waiver_request_ids || !Array.isArray(waiver_request_ids) || waiver_request_ids.length === 0) {
      return new Response(JSON.stringify({ error: "waiver_request_ids is required and must be a non-empty array" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Fetch waiver requests + linked penalty_fees ───────────────────────────
    const { data: waivers, error: waiverFetchErr } = await supabase
      .from("penalty_waiver_requests")
      .select("*, penalty_fees(id, penalty_stage, penalty_cycle, penalty_amount, status)")
      .in("id", waiver_request_ids);

    if (waiverFetchErr || !waivers || waivers.length === 0) {
      return new Response(JSON.stringify({ error: "Waiver requests not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Validate: all must be pending and belong to same account ──────────────
    const nonPending = waivers.filter((w: any) => w.status !== "pending");
    if (nonPending.length > 0) {
      return new Response(
        JSON.stringify({ error: `${nonPending.length} waiver(s) are not pending — cannot approve` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const accountIds = [...new Set(waivers.map((w: any) => w.account_id as string))];
    if (accountIds.length !== 1) {
      return new Response(
        JSON.stringify({ error: "All waiver requests must belong to the same account" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const accountId = accountIds[0];

    const now = new Date().toISOString();

    // ── Step 1: Approve each waiver request ───────────────────────────────────
    for (const waiver of waivers as any[]) {
      const { error: wErr } = await supabase
        .from("penalty_waiver_requests")
        .update({
          status: "approved",
          approved_by_user_id: userId,
          approved_at: now,
        })
        .eq("id", waiver.id);
      if (wErr) throw new Error(`Failed to approve waiver ${waiver.id}: ${wErr.message}`);
    }

    // ── Step 2: Waive each linked penalty fee (unpaid or paid) ──────────────
    const waivedPenaltyFeeIds: string[] = [];
    for (const waiver of waivers as any[]) {
      if (waiver.penalty_fees?.status === "unpaid" ||
          waiver.penalty_fees?.status === "paid") {
        const { error: pErr } = await supabase
          .from("penalty_fees")
          .update({ status: "waived", waived_at: now })
          .eq("id", waiver.penalty_fee_id)
          .in("status", ["unpaid", "paid"]); // guard: only update if not already waived
        if (pErr) throw new Error(`Failed to waive penalty fee ${waiver.penalty_fee_id}: ${pErr.message}`);
        waivedPenaltyFeeIds.push(waiver.penalty_fee_id);
      }
    }

    // ── Step 3: Recalculate each affected schedule row ────────────────────────
    // After waiving, re-sum non-waived penalty_fees for that schedule row
    // (paid + unpaid, exclude waived — matches business-rules.ts activePenaltyTotal)
    const affectedScheduleIds = [...new Set((waivers as any[]).map((w) => w.schedule_id as string))];

    for (const schedId of affectedScheduleIds) {
      const [{ data: remainingPens }, { data: schedItem }] = await Promise.all([
        supabase
          .from("penalty_fees")
          .select("penalty_amount")
          .eq("schedule_id", schedId)
          .not("status", "eq", "waived"),
        supabase
          .from("layaway_schedule")
          .select("base_installment_amount")
          .eq("id", schedId)
          .single(),
      ]);

      if (!schedItem) continue;

      const totalActivePenalty = (remainingPens || []).reduce(
        (s: number, p: any) => s + Number(p.penalty_amount), 0
      );

      const { error: schedErr } = await supabase
        .from("layaway_schedule")
        .update({
          penalty_amount: totalActivePenalty,
          total_due_amount: Number(schedItem.base_installment_amount) + totalActivePenalty,
        })
        .eq("id", schedId);

      if (schedErr) throw new Error(`Failed to update schedule row ${schedId}: ${schedErr.message}`);
    }

    // ── Step 4: Recalculate account remaining_balance ─────────────────────────
    // remaining = total_amount + Σ(non-waived penalties) + Σ(services) − Σ(non-voided payments)
    const [{ data: accountData }, { data: activePens }, { data: accountSvcs }, { data: activePayments }] = await Promise.all([
      supabase.from("layaway_accounts").select("total_amount").eq("id", accountId).single(),
      supabase.from("penalty_fees").select("penalty_amount").eq("account_id", accountId).not("status", "eq", "waived"),
      supabase.from("account_services").select("amount").eq("account_id", accountId),
      supabase.from("payments").select("amount_paid").eq("account_id", accountId).is("voided_at", null),
    ]);

    if (!accountData) throw new Error("Account not found");

    const activePenaltySum = (activePens  || []).reduce((s: number, p: any)  => s + Number(p.penalty_amount), 0);
    const servicesSum       = (accountSvcs || []).reduce((s: number, sv: any) => s + Number(sv.amount), 0);
    const totalPaid         = (activePayments || []).reduce((s: number, p: any) => s + Number(p.amount_paid), 0);
    const newRemaining      = Math.max(0, Number(accountData.total_amount) + activePenaltySum + servicesSum - totalPaid);

    const { error: acctErr } = await supabase
      .from("layaway_accounts")
      .update({ remaining_balance: newRemaining, total_paid: totalPaid })
      .eq("id", accountId);
    if (acctErr) throw new Error(`Failed to update account balance: ${acctErr.message}`);

    // ── Step 5: Audit log ─────────────────────────────────────────────────────
    const totalWaived = (waivers as any[]).reduce((s: number, w: any) => s + Number(w.penalty_amount), 0);
    await supabase.from("audit_logs").insert({
      entity_type: "penalty_waiver",
      entity_id: accountId,
      action: "batch_waiver_approved",
      performed_by_user_id: userId,
      new_value_json: {
        waiver_ids: waiver_request_ids,
        penalty_fee_ids: waivedPenaltyFeeIds,
        penalties_waived: (waivers as any[]).map((w) => ({
          penalty_fee_id: w.penalty_fee_id,
          stage: w.penalty_fees?.penalty_stage,
          cycle: w.penalty_fees?.penalty_cycle,
          amount: w.penalty_amount,
        })),
        total_waived: totalWaived,
        new_remaining_balance: newRemaining,
        notes: notes?.trim() || null,
      },
    });

    return new Response(
      JSON.stringify({
        success: true,
        account_id: accountId,
        waivers_approved: waiver_request_ids.length,
        penalties_waived: waivedPenaltyFeeIds.length,
        schedule_rows_updated: affectedScheduleIds.length,
        new_remaining_balance: newRemaining,
        total_waived: totalWaived,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: any) {
    console.error("[approve-waiver] Error:", error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
