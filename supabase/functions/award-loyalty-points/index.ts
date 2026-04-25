import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json().catch(() => ({}));
    const { account_id, cash_order_id } = body as {
      account_id?: string;
      cash_order_id?: string;
    };

    if (!account_id && !cash_order_id) {
      return json({ skipped: true, reason: "missing_source" });
    }

    // 2. Fetch source record
    let customerId: string | null = null;
    let loyaltyJpy = 0;
    let invoiceNumber = "";
    let sourceKind: "layaway" | "cash" = "layaway";

    if (account_id) {
      const { data, error } = await supabase
        .from("layaway_accounts")
        .select("customer_id, loyalty_jpy_amount, invoice_number")
        .eq("id", account_id)
        .single();
      if (error || !data) return json({ skipped: true, reason: "account_not_found" });
      customerId = data.customer_id;
      loyaltyJpy = Number(data.loyalty_jpy_amount ?? 0);
      invoiceNumber = data.invoice_number;
      sourceKind = "layaway";
    } else {
      const { data, error } = await supabase
        .from("cash_orders")
        .select("customer_id, loyalty_jpy_amount, invoice_number")
        .eq("id", cash_order_id!)
        .single();
      if (error || !data) return json({ skipped: true, reason: "cash_order_not_found" });
      customerId = data.customer_id;
      loyaltyJpy = Number(data.loyalty_jpy_amount ?? 0);
      invoiceNumber = data.invoice_number;
      sourceKind = "cash";
    }

    // 3. Validate minimum
    if (!Number.isFinite(loyaltyJpy) || loyaltyJpy < 10000) {
      return json({ skipped: true, reason: "below_minimum" });
    }

    // 4. Find loyalty member (no auto-enroll)
    const { data: member } = await supabase
      .from("loyalty_members")
      .select(
        "id, customer_id, current_tier_id, earned_tier_id, cumulative_spend_jpy, total_points_earned, remaining_points, last_purchase_at",
      )
      .eq("customer_id", customerId!)
      .maybeSingle();

    if (!member) {
      return json({ skipped: true, reason: "not_enrolled" });
    }

    // 5. Current tier multiplier
    const { data: currentTier } = await supabase
      .from("loyalty_tiers")
      .select("id, name, points_multiplier, min_spend_jpy")
      .eq("id", member.current_tier_id)
      .single();

    if (!currentTier) {
      return json({ skipped: true, reason: "tier_not_found" });
    }

    const multiplier = Number(currentTier.points_multiplier ?? 1);

    // 6. Calculate points
    const baseUnits = Math.floor(loyaltyJpy / 10000);
    const points = baseUnits * 100 * multiplier;

    // 7. Check active promo
    const today = new Date().toISOString().split("T")[0];
    const { data: promos } = await supabase
      .from("loyalty_promos")
      .select("*")
      .eq("is_active", true)
      .lte("start_date", today)
      .gte("end_date", today)
      .order("created_at", { ascending: false })
      .limit(1);

    let activePromo: any = null;
    if (promos && promos.length > 0) {
      const candidate = promos[0];
      const tiersAllowed = candidate.applicable_tiers as string[] | null;
      const tierOk = !tiersAllowed || tiersAllowed.length === 0 ||
        tiersAllowed.includes(currentTier.name);

      let underCap = true;
      if (tierOk && candidate.max_per_customer != null) {
        const { count } = await supabase
          .from("loyalty_transactions")
          .select("id", { count: "exact", head: true })
          .eq("member_id", member.id)
          .eq("transaction_type", "bonus")
          .eq("promo_id", candidate.id);
        underCap = (count ?? 0) < Number(candidate.max_per_customer);
      }

      if (tierOk && underCap) activePromo = candidate;
    }

    const bonusPoints = activePromo ? Number(activePromo.bonus_points ?? 0) : 0;

    // 8. Insert earned transaction
    const earnedTxRow: Record<string, unknown> = {
      member_id: member.id,
      transaction_type: "earned",
      points_amount: points,
      spend_amount_jpy: loyaltyJpy,
      invoice_number: invoiceNumber,
      tier_at_time: currentTier.name,
      notes: null,
    };
    if (sourceKind === "layaway") earnedTxRow.account_id = account_id;
    else earnedTxRow.cash_order_id = cash_order_id;

    const { error: earnedErr } = await supabase
      .from("loyalty_transactions")
      .insert(earnedTxRow);
    if (earnedErr) {
      console.error("[award-loyalty-points] earned tx insert failed:", earnedErr);
      return json({ error: "earned_tx_insert_failed", detail: earnedErr.message }, 500);
    }

    // 9. Insert bonus transaction if promo active
    if (activePromo) {
      const { error: bonusErr } = await supabase.from("loyalty_transactions").insert({
        member_id: member.id,
        transaction_type: "bonus",
        points_amount: bonusPoints,
        promo_id: activePromo.id,
        invoice_number: invoiceNumber,
        notes: `Promo: ${activePromo.name}`,
      });
      if (bonusErr) {
        console.warn(
          "[award-loyalty-points] bonus tx insert failed (non-blocking):",
          bonusErr,
        );
      }
    }

    // 10. Recalculate tier
    const totalAdded = points + bonusPoints;
    const newCumulative = Number(member.cumulative_spend_jpy ?? 0) + loyaltyJpy;
    const newTotalEarned = Number(member.total_points_earned ?? 0) + totalAdded;
    const newRemaining = Number(member.remaining_points ?? 0) + totalAdded;

    const { data: newTierRow } = await supabase
      .from("loyalty_tiers")
      .select("id, name, min_spend_jpy")
      .lte("min_spend_jpy", newCumulative)
      .order("min_spend_jpy", { ascending: false })
      .limit(1)
      .maybeSingle();

    // 11. Detect upgrade
    const oldMin = Number(currentTier.min_spend_jpy ?? 0);
    const newMin = Number(newTierRow?.min_spend_jpy ?? oldMin);
    const tierUpgraded = !!newTierRow && newMin > oldMin;
    const oldTierName = currentTier.name;
    const newTierName = tierUpgraded ? newTierRow!.name : oldTierName;

    // 12. Update loyalty_member
    const memberUpdate: Record<string, unknown> = {
      cumulative_spend_jpy: newCumulative,
      total_points_earned: newTotalEarned,
      remaining_points: newRemaining,
      prev_purchase_at: member.last_purchase_at,
      last_purchase_at: new Date().toISOString(),
      pre_expiry_warned_at: null,
    };
    if (tierUpgraded) {
      memberUpdate.earned_tier_id = newTierRow!.id;
      memberUpdate.current_tier_id = newTierRow!.id;
      memberUpdate.is_downgraded = false;
    }

    const { error: memberUpdateErr } = await supabase
      .from("loyalty_members")
      .update(memberUpdate)
      .eq("id", member.id);
    if (memberUpdateErr) {
      console.warn(
        "[award-loyalty-points] member update failed after tx insert (manual reconcile needed):",
        memberUpdateErr,
      );
    }

    // 13/14. Email — fire-and-forget
    try {
      const { data: customer } = await supabase
        .from("customers")
        .select("full_name, email")
        .eq("id", customerId!)
        .single();
      const recipientEmail = customer?.email;
      if (recipientEmail) {
        const customerName = customer?.full_name || "Valued Customer";
        const baseUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/send-transactional-email`;
        const authHeader = {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        };

        await fetch(baseUrl, {
          method: "POST",
          headers: authHeader,
          body: JSON.stringify({
            templateName: "loyalty-earned",
            recipientEmail,
            idempotencyKey: `loyalty-earned-${sourceKind}-${account_id ?? cash_order_id}`,
            templateData: {
              customerName,
              points: totalAdded,
              invoiceNumber,
              tierName: newTierName,
              remainingPoints: newRemaining,
            },
          }),
        }).catch((e) =>
          console.warn("[award-loyalty-points] loyalty-earned email failed:", e)
        );

        if (tierUpgraded) {
          await fetch(baseUrl, {
            method: "POST",
            headers: authHeader,
            body: JSON.stringify({
              templateName: "loyalty-tier-upgrade",
              recipientEmail,
              idempotencyKey: `loyalty-tier-upgrade-${member.id}-${newTierRow!.id}`,
              templateData: {
                customerName,
                oldTier: oldTierName,
                newTier: newTierName,
                remainingPoints: newRemaining,
              },
            }),
          }).catch((e) =>
            console.warn(
              "[award-loyalty-points] loyalty-tier-upgrade email failed:",
              e,
            )
          );
        }
      }
    } catch (emailErr) {
      console.warn("[award-loyalty-points] email block failed:", emailErr);
    }

    // 15. Sync to Google Sheet — fire-and-forget
    try {
      await fetch(
        `${Deno.env.get("SUPABASE_URL")}/functions/v1/sync-loyalty-to-sheet`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({ member_id: member.id }),
        },
      ).catch((e) =>
        console.warn("[award-loyalty-points] sheet sync failed:", e)
      );
    } catch (sheetErr) {
      console.warn("[award-loyalty-points] sheet sync block failed:", sheetErr);
    }

    // 16. Return
    return json({
      awarded: true,
      points_earned: points,
      bonus_points: bonusPoints,
      tier_upgraded: tierUpgraded,
      old_tier: oldTierName,
      new_tier: newTierName,
      remaining_points: newRemaining,
    });
  } catch (err: any) {
    console.error("[award-loyalty-points] unexpected error:", err);
    return json({ error: err?.message || "internal_error" }, 500);
  }
});
