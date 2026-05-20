import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createLoyaltyEmailGate } from "../_shared/loyalty-email-gate.ts";
import { buildPortalLinkForCustomerId } from "../_shared/portal-link.ts";
import { emitNotification } from "../_shared/emit-notification.ts";
import {
  buildPointsEarnedNotification,
  buildTierUpgradeNotification,
  buildWelcomeNotification,
} from "../_shared/loyalty-notification-templates.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const fmtFriendlyDate = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
    : "soon";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const gate = createLoyaltyEmailGate(supabase);

    const body = await req.json().catch(() => ({}));
    const { account_id, cash_order_id } = body as {
      account_id?: string;
      cash_order_id?: string;
    };

    if (!account_id && !cash_order_id) {
      return json({ skipped: true, reason: "missing_source" });
    }

    // 1b. Server-side loyalty_enabled gate (go-live toggle).
    //   system_settings.loyalty_enabled is a jsonb scalar. supabase-js
    //   returns it already parsed (boolean true/false or string). Treat
    //   anything other than a strict true as disabled (fail-closed).
    {
      const { data: flagRow } = await supabase
        .from("system_settings")
        .select("value")
        .eq("key", "loyalty_enabled")
        .maybeSingle();
      let loyaltyEnabled = false;
      const raw = flagRow?.value;
      if (raw != null) {
        if (typeof raw === "boolean") loyaltyEnabled = raw;
        else {
          try {
            const parsed = JSON.parse(String(raw));
            loyaltyEnabled = parsed === true || parsed === "true";
          } catch {
            loyaltyEnabled = String(raw).toLowerCase() === "true";
          }
        }
      }
      if (!loyaltyEnabled) {
        return json({ skipped: true, reason: "loyalty_disabled" });
      }
    }

    // 2. Fetch source record
    let customerId: string | null = null;
    let loyaltyJpy = 0;
    let invoiceNumber = "";
    let sourceKind: "layaway" | "cash" = "layaway";
    let sourceCurrency: string | null = null;

    if (account_id) {
      const { data, error } = await supabase
        .from("layaway_accounts")
        .select("customer_id, loyalty_jpy_amount, invoice_number, currency")
        .eq("id", account_id)
        .single();
      if (error || !data) return json({ skipped: true, reason: "account_not_found" });
      customerId = data.customer_id;
      loyaltyJpy = Number(data.loyalty_jpy_amount ?? 0);
      invoiceNumber = data.invoice_number;
      sourceCurrency = data.currency;
      sourceKind = "layaway";
    } else {
      const { data, error } = await supabase
        .from("cash_orders")
        .select("customer_id, loyalty_jpy_amount, invoice_number, currency")
        .eq("id", cash_order_id!)
        .single();
      if (error || !data) return json({ skipped: true, reason: "cash_order_not_found" });
      customerId = data.customer_id;
      loyaltyJpy = Number(data.loyalty_jpy_amount ?? 0);
      invoiceNumber = data.invoice_number;
      sourceCurrency = data.currency;
      sourceKind = "cash";
    }

    // 2b. Loyalty amount guard — loyalty is based on loyalty_jpy_amount
    //     (the Product Amount (JPY) — Loyalty Only field, populated for
    //     both PHP and JPY accounts). Skip only when no loyalty amount
    //     is recorded (e.g., services-only or shipping-only orders).
    if (!(loyaltyJpy > 0)) {
      return json({ skipped: true, reason: "no_loyalty_amount" });
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

    // 4b. Idempotency guard — skip if an 'earned' transaction already
    //     exists for this source (account_id or cash_order_id).
    //     Today every order is awarded exactly once via review-payment-
    //     submission, so this is invisible to existing callers. It
    //     becomes load-bearing for join-loyalty-program's retroactive
    //     enrollment award (5c) where the same order could be awarded
    //     again if the enrollment fires after the award already
    //     happened. Write nothing on hit (no txn, lot, member update,
    //     sheet, or email).
    {
      let existsQuery = supabase
        .from("loyalty_transactions")
        .select("id")
        .eq("transaction_type", "earned");
      if (sourceKind === "layaway") {
        existsQuery = existsQuery.eq("account_id", account_id!);
      } else {
        existsQuery = existsQuery.eq("cash_order_id", cash_order_id!);
      }
      const { data: existingEarned } = await existsQuery.limit(1).maybeSingle();
      if (existingEarned) {
        return json({ skipped: true, reason: "already_awarded" });
      }
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

    // 5b. Pre-compute post-upgrade tier so the points award reflects the
    //     ratcheted-up multiplier when the same purchase causes the upgrade.
    //     Ratchet-up: effectiveMultiplier resolved post-tier-upgrade (Bug fix 2026-05-10)
    //     A qualifying purchase that triggers a tier upgrade earns at the
    //     POST-upgrade multiplier on this same award. effectiveMultiplier and
    //     effectiveTierName flow into points computation, transaction
    //     tier_at_time, lot p_amount (via `points`), the email payload, and
    //     the in-portal points-earned notification.
    const newCumulative = Number(member.cumulative_spend_jpy ?? 0) + loyaltyJpy;
    const { data: newTierRow } = await supabase
      .from("loyalty_tiers")
      .select("id, name, min_spend_jpy, points_multiplier")
      .lte("min_spend_jpy", newCumulative)
      .order("min_spend_jpy", { ascending: false })
      .limit(1)
      .maybeSingle();

    const oldMin = Number(currentTier.min_spend_jpy ?? 0);
    const newMin = Number(newTierRow?.min_spend_jpy ?? oldMin);
    const tierUpgraded = !!newTierRow && newMin > oldMin;
    const effectiveMultiplier = tierUpgraded
      ? Number(newTierRow!.points_multiplier ?? 1)
      : multiplier;
    const effectiveTierName = tierUpgraded ? newTierRow!.name : currentTier.name;
    const oldTierName = currentTier.name;
    const newTierName = effectiveTierName;

    // 6. Check active promo
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

    // 7. Calculate points
    // earned tx = baseUnits × 100 × effectiveMultiplier (post-upgrade if the
    //             purchase ratchets the tier up; otherwise current tier)
    // bonus tx  = delta_from_multiplier + flat_bonus_points
    //   delta = baseUnits × 100 × effectiveMultiplier × (promo_multiplier - 1)
    // member total = earned + bonus = baseUnits × 100 × effective × promo_mult + flat
    const promoMultiplier = activePromo
      ? Number(activePromo.bonus_multiplier ?? 1)
      : 1;
    const flatBonus = activePromo ? Number(activePromo.bonus_points ?? 0) : 0;
    const baseUnits = Math.floor(loyaltyJpy / 10000);
    const points = baseUnits * 100 * effectiveMultiplier;
    const deltaFromMultiplier = activePromo
      ? Math.round(points * (promoMultiplier - 1))
      : 0;
    const bonusTxPoints = deltaFromMultiplier + flatBonus;

    // 8. Insert earned transaction
    const earnedTxRow: Record<string, unknown> = {
      member_id: member.id,
      transaction_type: "earned",
      points_amount: points,
      spend_amount_jpy: loyaltyJpy,
      invoice_number: invoiceNumber,
      tier_at_time: effectiveTierName,
      notes: null,
    };
    if (sourceKind === "layaway") earnedTxRow.account_id = account_id;
    else earnedTxRow.cash_order_id = cash_order_id;

    const { data: earnedTxData, error: earnedErr } = await supabase
      .from("loyalty_transactions")
      .insert(earnedTxRow)
      .select("id")
      .single();
    if (earnedErr) {
      console.error("[award-loyalty-points] earned tx insert failed:", earnedErr);
      return json({ error: "earned_tx_insert_failed", detail: earnedErr.message }, 500);
    }
    const earnedTxId: string | null = (earnedTxData as { id?: string } | null)?.id ?? null;

    // 9. Insert bonus transaction if any bonus applies
    //    Skip when both delta_from_multiplier = 0 AND flat_bonus = 0
    //    (e.g. no active promo, or active promo with multiplier=1.00 and bonus_points=0)
    let bonusTxId: string | null = null;
    if (activePromo && bonusTxPoints > 0) {
      let bonusNotes: string;
      if (deltaFromMultiplier > 0 && flatBonus > 0) {
        bonusNotes =
          `Multiplier promo (delta: ${deltaFromMultiplier}) + flat bonus (${flatBonus})`;
      } else if (deltaFromMultiplier > 0) {
        bonusNotes = `Multiplier promo (delta: ${deltaFromMultiplier})`;
      } else {
        bonusNotes = `Flat bonus (${flatBonus})`;
      }
      const { data: bonusTxData, error: bonusErr } = await supabase
        .from("loyalty_transactions")
        .insert({
          member_id: member.id,
          transaction_type: "bonus",
          points_amount: bonusTxPoints,
          promo_id: activePromo.id,
          invoice_number: invoiceNumber,
          notes: bonusNotes,
        })
        .select("id")
        .single();
      if (bonusErr) {
        console.warn(
          "[award-loyalty-points] bonus tx insert failed (non-blocking):",
          bonusErr,
        );
      } else {
        bonusTxId = (bonusTxData as { id?: string } | null)?.id ?? null;
      }
    }

    // 10. Recalculate scalar totals (newCumulative + newTierRow + tierUpgraded
    //     resolved earlier in step 5b for ratchet-up multiplier; reuse them).
    const totalAdded = points + bonusTxPoints;
    const newTotalEarned = Number(member.total_points_earned ?? 0) + totalAdded;
    const newRemaining = Number(member.remaining_points ?? 0) + totalAdded;

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

    // 12b. Phase 6.1 dual-mode: shadow-write to loyalty_point_lots.
    //   Lots are shadow data; the scalar UPDATE above remains authoritative
    //   until the loyalty_lots_enabled flag flip in a later phase. This
    //   block does NOT branch on the flag — lots are written unconditionally.
    //   Two lots are written when an active promo applies, per Q4.3
    //   ("promo bonus separate" — distinct source_type from order_earn).
    //   Skipped if scalar UPDATE failed so lots cannot diverge from scalar.
    if (!memberUpdateErr) {
      const earnedAt = new Date().toISOString();

      // Lot 1: order_earn — base × tier multiplier (Q4.2 "no tier bonuses",
      // tier multiplier is part of the earn amount, not a separate lot).
      // RPC computes expires_at = earned_at + 12 months for order_earn and
      // handles the rolling extension on prior lots (AREA 2 lines 6195-6204).
      try {
        const { data: lotId, error: lotErr } = await supabase.rpc("insert_lot_and_extend", {
          p_member_id: member.id,
          p_source_type: "order_earn",
          p_source_reference: invoiceNumber,
          p_amount: points,
          p_earned_at: earnedAt,
          p_expires_at: null,
          p_notes: null,
        });
        if (lotErr) {
          console.error(
            "[award-loyalty-points] order_earn lot shadow write failed",
            lotErr,
          );
          // Non-fatal: scalar update already committed. Drift caught by validation.
        } else if (lotId) {
          // Stamp spend_basis_jpy on the lot (RPC does not accept it as a param).
          // points already includes tier multiplier (baseUnits × 100 × multiplier);
          // spend_basis_jpy records the single underlying JPY spend, not doubled.
          const { error: basisErr } = await supabase
            .from("loyalty_point_lots")
            .update({ spend_basis_jpy: loyaltyJpy })
            .eq("id", lotId);
          if (basisErr) {
            console.warn(
              "[award-loyalty-points] order_earn lot spend_basis_jpy stamp failed",
              basisErr,
            );
          }
        }
      } catch (e) {
        console.error(
          "[award-loyalty-points] order_earn lot shadow write threw",
          e,
        );
        // Non-fatal — scalar success is enough during dual-mode.
      }

      // Lot 2: promo_bonus — only when an active promo emitted a bonus tx.
      // TODO Phase 6.x: loyalty_promos has no per-promo expiration column
      // yet — passing null. Thread real expiration through when schema
      // supports it (AREA 2 lines 6217-6219: "configurable per promo").
      if (activePromo && bonusTxPoints > 0) {
        try {
          const { error: bonusLotErr } = await supabase.rpc(
            "insert_lot_and_extend",
            {
              p_member_id: member.id,
              p_source_type: "promo_bonus",
              p_source_reference: invoiceNumber,
              p_amount: bonusTxPoints,
              p_earned_at: earnedAt,
              p_expires_at: null,
              p_notes: `promo_id=${activePromo.id}`,
            },
          );
          if (bonusLotErr) {
            console.error(
              "[award-loyalty-points] promo_bonus lot shadow write failed",
              bonusLotErr,
            );
          }
        } catch (e) {
          console.error(
            "[award-loyalty-points] promo_bonus lot shadow write threw",
            e,
          );
        }
      }
    }

    // 13. Fetch customer once for both the email block (recipient
    //     address + greeting name) and the in-portal notification
    //     block below (firstName extraction). Hoisted out of the
    //     email try/catch so notifications can reuse it without a
    //     second round-trip.
    let customer:
      | { id: string; customer_code: string | null; full_name: string | null; email: string | null }
      | null = null;
    try {
      const { data } = await supabase
        .from("customers")
        .select("id, customer_code, full_name, email")
        .eq("id", customerId!)
        .single();
      customer = data ?? null;
    } catch (custErr) {
      console.warn("[award-loyalty-points] customer fetch failed:", custErr);
    }

    // 14. Email — fire-and-forget
    try {
      const recipientEmail = customer?.email;
      if (recipientEmail) {
        const customerName = customer?.full_name || "Valued Customer";
        const baseUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/send-transactional-email`;
        const authHeader = {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        };
        const portalUrl = await buildPortalLinkForCustomerId(supabase, customerId!, 'loyalty');

        if (await gate("loyalty_email_earned")) {
          await fetch(baseUrl, {
            method: "POST",
            headers: authHeader,
            body: JSON.stringify({
              templateName: "loyalty-earned",
              recipientEmail,
              idempotencyKey: `loyalty-earned-${sourceKind}-${account_id ?? cash_order_id}`,
              templateData: {
                customerName,
                pointsEarned: points,
                spendAmountJpy: loyaltyJpy,
                invoiceNumber,
                tierName: effectiveTierName,
                tierMultiplier: effectiveMultiplier,
                remainingPoints: newRemaining,
                cumulativeSpendJpy: newCumulative,
                portalUrl,
              },
            }),
          }).catch((e) =>
            console.warn("[award-loyalty-points] loyalty-earned email failed:", e)
          );
        } else {
          console.log(
            "[email-gate] loyalty-earned skipped — toggle 'loyalty_email_earned' is OFF",
          );
        }

        if (activePromo) {
          if (await gate("loyalty_email_bonus")) {
            await fetch(baseUrl, {
              method: "POST",
              headers: authHeader,
              body: JSON.stringify({
                templateName: "loyalty-bonus",
                recipientEmail,
                idempotencyKey:
                  `loyalty-bonus-${activePromo.id}-${sourceKind}-${account_id ?? cash_order_id}`,
                templateData: {
                  customerName,
                  bonusPoints: bonusTxPoints,
                  promoName: activePromo.name,
                  promoEndDate: fmtFriendlyDate(activePromo.end_date),
                  invoiceNumber,
                  remainingPoints: newRemaining,
                  portalUrl,
                },
              }),
            }).catch((e) =>
              console.warn("[award-loyalty-points] loyalty-bonus email failed:", e)
            );
          } else {
            console.log(
              "[email-gate] loyalty-bonus skipped — toggle 'loyalty_email_bonus' is OFF",
            );
          }
        }

        if (tierUpgraded) {
          if (await gate("loyalty_email_tier_upgrade")) {
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
                  newMultiplier: Number(newTierRow!.points_multiplier ?? 1),
                  cumulativeSpendJpy: newCumulative,
                  remainingPoints: newRemaining,
                  portalUrl,
                },
              }),
            }).catch((e) =>
              console.warn(
                "[award-loyalty-points] loyalty-tier-upgrade email failed:",
                e,
              )
            );
          } else {
            console.log(
              "[email-gate] loyalty-tier-upgrade skipped — toggle 'loyalty_email_tier_upgrade' is OFF",
            );
          }
        }
      }
    } catch (emailErr) {
      console.warn("[award-loyalty-points] email block failed:", emailErr);
    }

    // 14b. In-portal notifications — Phase 4.2
    //   Welcome on first-ever award; points earned on every award;
    //   tier upgrade when crossed. emitNotification is fire-and-forget
    //   internally — errors log with [loyalty-notify] and never throw,
    //   so awaiting them won't fail the parent. Sequential await keeps
    //   execution ordered and ensures the inserts complete before the
    //   function returns (Edge Runtime can terminate post-response).
    const prevTotalEarned = Number(member.total_points_earned ?? 0);
    const isFirstAward = prevTotalEarned === 0;
    const firstName =
      (customer?.full_name || "").trim().split(" ")[0] || null;

    if (isFirstAward) {
      await emitNotification(supabase, member.id, {
        category: "order",
        ...buildWelcomeNotification({ firstName, points: totalAdded }),
        link_target: "tab:home",
      });
    }

    await emitNotification(supabase, member.id, {
      category: "points",
      ...buildPointsEarnedNotification({
        points: totalAdded,
        invoiceNumber,
      }),
      link_target: "tab:points",
    });

    if (tierUpgraded) {
      await emitNotification(supabase, member.id, {
        category: "tier",
        ...buildTierUpgradeNotification({
          oldTier: oldTierName,
          newTier: newTierName,
        }),
        link_target: "tab:home",
      });
    }

    // 15. Sync to Google Sheet — canonical taxonomy emissions.
    //     earned (always) → bonus (if any) → tier_changed (if upgrade).
    //     All fire-and-forget; each isolated so one failure can't block
    //     the others or the function return.
    const syncSheetUrl =
      `${Deno.env.get("SUPABASE_URL")}/functions/v1/sync-loyalty-to-sheet`;
    const syncSheetHeaders = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
    };
    const memberPublicId = customer?.customer_code ?? null;
    const customerBlock = {
      customer_id: customerId,
      full_name: customer?.full_name ?? null,
      email: customer?.email ?? null,
    };

    // CALL 1 — earned (always)
    try {
      await fetch(syncSheetUrl, {
        method: "POST",
        headers: syncSheetHeaders,
        body: JSON.stringify({
          event_type: "earned",
          customer: customerBlock,
          payload: {
            member_id: memberPublicId,
            transaction_id: earnedTxId,
            points_amount: points,
            spend_amount_jpy: loyaltyJpy,
            multiplier: effectiveMultiplier,
            tier_at_time: effectiveTierName,
            invoice_number: invoiceNumber,
            account_id: account_id ?? null,
            notes: "",
            created_by: "system",
          },
        }),
      }).catch((e) =>
        console.warn("[award-loyalty-points] sheet sync (earned) failed:", e)
      );
    } catch (sheetErr) {
      console.warn("[award-loyalty-points] sheet sync (earned) block failed:", sheetErr);
    }

    // CALL 2 — bonus (only when a promo bonus was awarded)
    if (bonusTxPoints > 0) {
      try {
        await fetch(syncSheetUrl, {
          method: "POST",
          headers: syncSheetHeaders,
          body: JSON.stringify({
            event_type: "bonus",
            customer: customerBlock,
            payload: {
              member_id: memberPublicId,
              transaction_id: bonusTxId ?? earnedTxId,
              points_amount: bonusTxPoints,
              multiplier: effectiveMultiplier,
              tier_at_time: effectiveTierName,
              invoice_number: invoiceNumber,
              account_id: account_id ?? null,
              notes: `Promo bonus${activePromo?.name ? `: ${activePromo.name}` : ""}`,
              created_by: "system",
            },
          }),
        }).catch((e) =>
          console.warn("[award-loyalty-points] sheet sync (bonus) failed:", e)
        );
      } catch (sheetErr) {
        console.warn("[award-loyalty-points] sheet sync (bonus) block failed:", sheetErr);
      }
    }

    // CALL 3 — tier_changed (only on upgrade caused by this purchase)
    if (tierUpgraded === true) {
      // Emit a 'tier_changed' loyalty_transactions row so the Member-events
      // feed mirrors the sheet sync. Non-blocking: failure logs a warning
      // and never rolls back the award. spend_amount_jpy is NULL here — the
      // spend is already captured on the corresponding 'earned' row above
      // (don't double-count). Source IDs pass through for traceability.
      try {
        const tierTxRow: Record<string, unknown> = {
          member_id: member.id,
          transaction_type: "tier_changed",
          points_amount: 0,
          account_id: sourceKind === "layaway" ? account_id ?? null : null,
          cash_order_id: sourceKind === "cash" ? cash_order_id ?? null : null,
          payment_id: null,
          spend_amount_jpy: null,
          rate_snapshot: null,
          invoice_number: invoiceNumber || null,
          tier_at_time: newTierName,
          notes:
            `Tier upgraded: ${oldTierName} → ${newTierName} at ${newCumulative.toLocaleString()} JPY cumulative spend`,
          created_by_user_id: null,
        };
        const { error: tierTxErr } = await supabase
          .from("loyalty_transactions")
          .insert(tierTxRow);
        if (tierTxErr) {
          console.warn(
            "[award-loyalty-points] tier_changed tx insert failed (non-blocking):",
            tierTxErr,
          );
        }
      } catch (tierTxBlockErr) {
        console.warn(
          "[award-loyalty-points] tier_changed tx block failed (non-blocking):",
          tierTxBlockErr,
        );
      }

      try {
        await fetch(syncSheetUrl, {
          method: "POST",
          headers: syncSheetHeaders,
          body: JSON.stringify({
            event_type: "tier_changed",
            customer: customerBlock,
            payload: {
              member_id: memberPublicId,
              current_tier: newTierName,
              lifetime_spend_jpy: newCumulative,
              available_points: newRemaining,
              activity_status: "Active",
              last_purchase_date: today,
              old_tier: oldTierName,
              new_tier: newTierName,
              notes: `${oldTierName} → ${newTierName}`,
            },
          }),
        }).catch((e) =>
          console.warn("[award-loyalty-points] sheet sync (tier_changed) failed:", e)
        );
      } catch (sheetErr) {
        console.warn("[award-loyalty-points] sheet sync (tier_changed) block failed:", sheetErr);
      }
    }

    // 16. Return
    return json({
      awarded: true,
      points_earned: points,
      bonus_points: bonusTxPoints,
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
