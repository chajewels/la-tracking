import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";
import {
  planSettlementPenalties,
  settlementAmount,
  settlementDayOpen,
  type SettlementPenalty,
  type SettlementRow,
} from "../_shared/final-forfeit-settlement.ts";
import { phtDay } from "../_shared/extension-rules.ts";

/**
 * SAME-DAY FINAL-FORFEIT SETTLEMENT (owner rule R7, 2026-10-20).
 * docs/PENALTY-AND-FORFEITURE.md "Same-day settlement after final forfeiture".
 *
 * Body: { account_id, preview?, payment_method, payment_date?, reference_number?,
 *         sender_name?, notes?, proof_url }.
 * preview: true → the amount and that day's penalty, or the refusal; writes nothing.
 * Otherwise creates the ONE settlement submission (pending a reviewer's Confirm,
 * which stays under confirm_payment in review-payment-submission).
 *
 * Starting it needs record_payment (staff, no new key). The figures are computed
 * here with the penalty engine's own helpers (_shared/penalty-schedule.ts) and
 * re-checked and written in one transaction by
 * settle_final_forfeited_same_day_atomic.
 */
Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;
  if (req.method !== "POST")
    return jsonResponse({ error: "Method not allowed" }, 405);

  const ctx = await requireAuth(req);
  if (ctx instanceof Response) return ctx;
  const denied = await requirePermission(ctx, "record_payment");
  if (denied) return denied;
  const supabase = ctx.supabase;

  try {
    const body = await req.json().catch(() => ({}));
    const accountId =
      typeof body?.account_id === "string" ? body.account_id : "";
    const preview = body?.preview === true;
    if (!accountId)
      return jsonResponse({ error: "account_id is required" }, 400);

    const { data: account } = await supabase
      .from("layaway_accounts")
      .select(
        "id, invoice_number, status, currency, payment_plan_months, is_reactivated, total_amount",
      )
      .eq("id", accountId)
      .maybeSingle();
    if (!account)
      return jsonResponse(
        { error: "Account not found", code: "not_found" },
        404,
      );
    if (account.status !== "final_forfeited") {
      return jsonResponse(
        {
          error: "Only a final-forfeited account can be settled this way.",
          code: "not_final_forfeited",
        },
        409,
      );
    }

    const { data: ffRow } = await supabase
      .from("audit_logs")
      .select("created_at")
      .eq("entity_type", "layaway_account")
      .eq("entity_id", accountId)
      .eq("action", "final_forfeited")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!ffRow?.created_at) {
      return jsonResponse(
        {
          error: "The final-forfeiture date is not on record.",
          code: "final_forfeit_date_unknown",
        },
        409,
      );
    }
    const day = phtDay(ffRow.created_at);
    if (!settlementDayOpen(ffRow.created_at)) {
      return jsonResponse(
        {
          error: `A same-day settlement can only be submitted on ${day} (PHT), the day of the final forfeiture.`,
          code: "settlement_day_passed",
          final_forfeit_day: day,
        },
        409,
      );
    }

    const [
      { data: rows },
      { data: pens },
      { data: override },
      { data: settings },
      { data: pays },
    ] = await Promise.all([
      supabase
        .from("layaway_schedule")
        .select(
          "id, installment_number, due_date, status, paid_amount, base_installment_amount",
        )
        .eq("account_id", accountId),
      supabase
        .from("penalty_fees")
        .select(
          "id, schedule_id, penalty_stage, penalty_cycle, penalty_amount, status, penalty_date",
        )
        .eq("account_id", accountId),
      supabase
        .from("penalty_cap_overrides")
        .select("penalty_cap_amount")
        .eq("account_id", accountId)
        .eq("is_active", true)
        .maybeSingle(),
      supabase
        .from("system_settings")
        .select("key, value")
        .in("key", [
          "penalty_php_week1",
          "penalty_php_week2",
          "penalty_jpy_week1",
          "penalty_jpy_week2",
          "penalty_waiver_grace_days",
        ]),
      supabase
        .from("payments")
        .select("amount_paid")
        .eq("account_id", accountId)
        .is("voided_at", null),
    ]);

    // Guard 2 input, exactly as the engine reads it: installment allocations of
    // non-voided payments.
    const scheduleIds = (rows ?? []).map((r: SettlementRow) => r.id);
    const allocSumBySchedule = new Map<string, number>();
    if (scheduleIds.length > 0) {
      const { data: allocs } = await supabase
        .from("payment_allocations")
        .select("schedule_id, allocated_amount, payment_id")
        .in("schedule_id", scheduleIds)
        .eq("allocation_type", "installment");
      const paymentIds = [
        ...new Set(
          (allocs ?? []).map((a: { payment_id: string }) => a.payment_id),
        ),
      ];
      const valid = new Set<string>();
      if (paymentIds.length > 0) {
        const { data: okPays } = await supabase
          .from("payments")
          .select("id")
          .in("id", paymentIds)
          .is("voided_at", null);
        (okPays ?? []).forEach((p: { id: string }) => valid.add(p.id));
      }
      for (const a of allocs ?? []) {
        if (!valid.has(a.payment_id)) continue;
        allocSumBySchedule.set(
          a.schedule_id,
          (allocSumBySchedule.get(a.schedule_id) || 0) +
            Number(a.allocated_amount),
        );
      }
    }

    const config: Record<string, number> = {};
    for (const s of settings ?? [])
      config[s.key] = Number(JSON.parse(String(s.value)));
    const cur = String(account.currency).toLowerCase();
    const fallback = account.currency === "PHP" ? 500 : 1000;
    const graceRaw = config["penalty_waiver_grace_days"];
    const waiverGraceDays =
      Number.isFinite(graceRaw) && graceRaw >= 0 ? Math.floor(graceRaw) : 7;

    const planned = planSettlementPenalties({
      day,
      currency: account.currency,
      planMonths: account.payment_plan_months,
      isReactivated: !!account.is_reactivated,
      rows: (rows ?? []) as SettlementRow[],
      allocSumBySchedule,
      penalties: (pens ?? []) as SettlementPenalty[],
      overrideCap: override ? Number(override.penalty_cap_amount) : undefined,
      amounts: {
        week1: config[`penalty_${cur}_week1`] || fallback,
        week2: config[`penalty_${cur}_week2`] || fallback,
      },
      waiverGraceDays,
    });
    const penaltiesPayload = planned.map((p) => ({
      schedule_id: p.scheduleId,
      installment_number: p.installmentNumber,
      stage: p.stage,
      cycle: p.cycle,
      amount: p.amount,
      penalty_date: p.penaltyDate,
    }));

    const amount = settlementAmount({
      totalAmount: Number(account.total_amount),
      nonWaivedPenalties: (pens ?? [])
        .filter((p: SettlementPenalty) => p.status !== "waived")
        .reduce(
          (s: number, p: SettlementPenalty) => s + Number(p.penalty_amount),
          0,
        ),
      newPenalties: planned.reduce((s, p) => s + p.amount, 0),
      payments: (pays ?? []).reduce(
        (s: number, p: { amount_paid: number }) => s + Number(p.amount_paid),
        0,
      ),
    });

    const { data: result, error: rpcErr } = await supabase.rpc(
      "settle_final_forfeited_same_day_atomic",
      {
        p_account_id: accountId,
        p_user_id: ctx.user?.id ?? null,
        p_amount: amount,
        p_payment_date:
          typeof body?.payment_date === "string" && body.payment_date
            ? body.payment_date
            : day,
        p_payment_method:
          typeof body?.payment_method === "string" && body.payment_method
            ? body.payment_method
            : "bank_transfer",
        p_reference_number:
          typeof body?.reference_number === "string"
            ? body.reference_number
            : null,
        p_sender_name:
          typeof body?.sender_name === "string" ? body.sender_name : null,
        p_notes: typeof body?.notes === "string" ? body.notes : null,
        p_proof_url:
          typeof body?.proof_url === "string" ? body.proof_url : null,
        p_penalties: penaltiesPayload,
        p_preview: preview,
      },
    );
    if (rpcErr) {
      const msg = rpcErr.message || "Settlement failed";
      if (msg.includes("web_layaway_stock_unavailable")) {
        return jsonResponse(
          {
            error: "A piece on this plan is no longer in stock.",
            code: "out_of_stock",
          },
          409,
        );
      }
      console.error(
        `[settle-final-forfeited] ${account.invoice_number}: ${msg}`,
      );
      return jsonResponse({ error: msg }, 500);
    }
    if (result?.error) {
      return jsonResponse(
        {
          error: refusalText(result.error, result),
          code: result.error,
          ...result,
        },
        409,
      );
    }

    return jsonResponse({
      ...result,
      invoice_number: account.invoice_number,
      currency: account.currency,
      final_forfeit_day: day,
    });
  } catch (err) {
    console.error("[settle-final-forfeited] error:", err);
    return jsonResponse(
      { error: (err as Error).message || "Settlement failed" },
      500,
    );
  }
});

function refusalText(code: string, r: Record<string, unknown>): string {
  switch (code) {
    case "settlement_day_passed":
      return `A same-day settlement can only be submitted on ${r.final_forfeit_day} (PHT).`;
    case "submission_pending":
      return "A payment submission is still pending on this account — resolve it first.";
    case "already_settled":
      return "A settlement has already been submitted for this account.";
    case "proof_required":
      return "Proof of payment is required.";
    case "out_of_stock":
      return "A piece on this plan is no longer in stock.";
    case "amount_mismatch":
      return "The amount changed — reopen the settlement to see the current amount.";
    case "nothing_to_pay":
      return "Nothing is left to pay on this account.";
    case "penalty_slot_taken":
      return "That day's penalty has already been charged — reopen the settlement.";
    case "permission_denied":
      return "You do not have permission to record payments.";
    default:
      return code;
  }
}
