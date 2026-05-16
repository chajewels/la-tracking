import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  createLoyaltyEmailGate,
  type LoyaltyEmailKey,
} from "../_shared/loyalty-email-gate.ts";
import { buildPortalLinkForCustomerId } from "../_shared/portal-link.ts";
import { emitNotification } from "../_shared/emit-notification.ts";
import {
  buildExpiryFiredNotification,
  buildPreExpiryNotification,
  buildTierDowngradeNotification,
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

const DAY_MS = 24 * 60 * 60 * 1000;
const INACTIVITY_DAYS = 180;
const WARNING_WINDOW_START = 166;
const WARNING_REPEAT_COOLDOWN_DAYS = 30;
const GAP_DOWNGRADE_DAYS = 180;

const daysBetween = (a: Date, b: Date) =>
  Math.floor((a.getTime() - b.getTime()) / DAY_MS);

const addDays = (d: Date, days: number) =>
  new Date(d.getTime() + days * DAY_MS);

const fmtFriendlyDate = (d: Date) =>
  d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

async function sendEmail(
  gate: (key: LoyaltyEmailKey) => Promise<boolean>,
  gateKey: LoyaltyEmailKey,
  templateName: string,
  recipientEmail: string,
  idempotencyKey: string,
  templateData: Record<string, unknown>,
) {
  try {
    if (!(await gate(gateKey))) {
      console.log(
        `[email-gate] ${templateName} skipped — toggle '${gateKey}' is OFF`,
      );
      return;
    }
    await fetch(
      `${Deno.env.get("SUPABASE_URL")}/functions/v1/send-transactional-email`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify({
          templateName,
          recipientEmail,
          idempotencyKey,
          templateData,
        }),
      },
    ).catch((e) =>
      console.warn(`[loyalty-inactivity-check] ${templateName} email failed:`, e)
    );
  } catch (e) {
    console.warn(`[loyalty-inactivity-check] ${templateName} email block failed:`, e);
  }
}

// TODO Substep 3 follow-up: emit status_changed when activity_status
// transition is implemented. loyalty_members has no activity_status
// column today and this function never sets one, so status_changed is
// intentionally not emitted here.
async function syncSheet(
  eventType: string,
  customer: { customer_id: string; full_name: string | null; email: string | null },
  payload: Record<string, unknown>,
) {
  try {
    await fetch(
      `${Deno.env.get("SUPABASE_URL")}/functions/v1/sync-loyalty-to-sheet`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify({
          event_type: eventType,
          customer,
          payload,
        }),
      },
    ).catch((e) =>
      console.warn(`[loyalty-inactivity-check] sheet sync ${eventType} failed:`, e)
    );
  } catch (e) {
    console.warn(`[loyalty-inactivity-check] sheet sync ${eventType} block failed:`, e);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const gate = createLoyaltyEmailGate(supabase);

  const now = new Date();

  const summary = {
    processed: 0,
    warnings_sent: 0,
    expiries_processed: 0,
    downgrades_processed: 0,
    errors: [] as { member_id: string; error: string }[],
  };

  // Tier catalogue — used for finding next-lower tier by display_order.
  const { data: tiersList, error: tiersErr } = await supabase
    .from("loyalty_tiers")
    .select("id, name, display_order")
    .order("display_order", { ascending: true });
  if (tiersErr || !tiersList) {
    console.error("[loyalty-inactivity-check] tiers fetch failed:", tiersErr);
    return json({ error: "Failed to load loyalty_tiers" }, 500);
  }
  const tierById = new Map(tiersList.map((t) => [t.id, t]));
  const tierByOrder = new Map(tiersList.map((t) => [t.display_order, t]));

  const { data: members, error: membersErr } = await supabase
    .from("loyalty_members")
    .select(
      "id, customer_id, current_tier_id, earned_tier_id, remaining_points, total_points_expired, last_purchase_at, prev_purchase_at, pre_expiry_warned_at, is_downgraded, cumulative_spend_jpy",
    )
    .not("last_purchase_at", "is", null)
    .gt("remaining_points", 0);
  if (membersErr || !members) {
    console.error("[loyalty-inactivity-check] members fetch failed:", membersErr);
    return json({ error: "Failed to load loyalty_members" }, 500);
  }

  for (const member of members) {
    summary.processed += 1;
    try {
      const lastPurchase = new Date(member.last_purchase_at);
      const prevPurchase = member.prev_purchase_at
        ? new Date(member.prev_purchase_at)
        : null;
      const daysSinceLast = daysBetween(now, lastPurchase);
      const gapBetweenLastTwo = prevPurchase
        ? daysBetween(lastPurchase, prevPurchase)
        : null;

      const currentTier = tierById.get(member.current_tier_id);
      if (!currentTier) {
        summary.errors.push({
          member_id: member.id,
          error: `Unknown current_tier_id ${member.current_tier_id}`,
        });
        continue;
      }

      const { data: customer } = await supabase
        .from("customers")
        .select("id, customer_code, full_name, email")
        .eq("id", member.customer_id)
        .maybeSingle();
      const customerName = customer?.full_name || "Valued Customer";
      const customerBlock = customer
        ? {
          customer_id: customer.id,
          full_name: customer.full_name,
          email: customer.email,
        }
        : null;

      // ── EXPIRY (highest priority) ─────────────────────────────────
      if (daysSinceLast >= INACTIVITY_DAYS) {
        const wasRemaining = Number(member.remaining_points);
        const nextLower = currentTier.display_order > 1
          ? tierByOrder.get(currentTier.display_order - 1)
          : currentTier;
        const tierChanged = nextLower!.id !== currentTier.id;

        const { data: expiredTxRow, error: txErr } = await supabase
          .from("loyalty_transactions")
          .insert({
            member_id: member.id,
            transaction_type: "expired",
            points_amount: -wasRemaining,
            tier_at_time: currentTier.name,
            notes: "Inactivity expiry: 6 months since last purchase",
          })
          .select("id")
          .single();
        if (txErr) throw txErr;
        const expiredTxId: string | null =
          (expiredTxRow as { id?: string } | null)?.id ?? null;

        const { error: updErr } = await supabase
          .from("loyalty_members")
          .update({
            remaining_points: 0,
            total_points_expired:
              Number(member.total_points_expired ?? 0) + wasRemaining,
            current_tier_id: nextLower!.id,
            is_downgraded: tierChanged ? true : member.is_downgraded,
            pre_expiry_warned_at: null,
          })
          .eq("id", member.id);
        if (updErr) throw updErr;

        summary.expiries_processed += 1;

        if (customer?.email) {
          const portalUrl = await buildPortalLinkForCustomerId(supabase, member.customer_id, 'loyalty');
          await sendEmail(
            gate,
            "loyalty_email_expire_deduct",
            "loyalty-expire-deduct",
            customer.email,
            `loyalty-expire-${member.id}-${lastPurchase.toISOString().split("T")[0]}`,
            {
              customerName,
              pointsExpired: wasRemaining,
              oldTier: currentTier.name,
              newTier: nextLower!.name,
              daysSinceLastPurchase: daysSinceLast,
              portalUrl,
            },
          );
        }
        if (customerBlock) {
          await syncSheet("expired", customerBlock, {
            member_id: customer?.customer_code ?? null,
            transaction_id: expiredTxId,
            points_amount: -wasRemaining,
            notes: "Expired: 6mo inactivity",
            created_by: "system",
          });
        }

        // Phase 4.2 — in-portal notifications.
        // Expiry-fired always; tier-downgrade ALSO when expiry caused
        // a tier change (two distinct events the customer should see
        // as separate cards in their portal).
        await emitNotification(supabase, member.id, {
          category: "expiry",
          ...buildExpiryFiredNotification({ pointsLost: wasRemaining }),
          link_target: "tab:points",
        });
        if (tierChanged) {
          await emitNotification(supabase, member.id, {
            category: "tier",
            ...buildTierDowngradeNotification({
              oldTier: currentTier.name,
              newTier: nextLower!.name,
            }),
            link_target: "tab:home",
          });
        }

        continue; // expiry replaces downgrade for this member
      }

      // ── PRE-EXPIRY WARNING ────────────────────────────────────────
      const inWarningWindow = daysSinceLast >= WARNING_WINDOW_START &&
        daysSinceLast < INACTIVITY_DAYS;
      if (inWarningWindow) {
        const lastWarn = member.pre_expiry_warned_at
          ? new Date(member.pre_expiry_warned_at)
          : null;
        const needsWarn = !lastWarn ||
          daysBetween(now, lastWarn) > WARNING_REPEAT_COOLDOWN_DAYS;
        if (needsWarn) {
          const expirationDate = addDays(lastPurchase, INACTIVITY_DAYS);

          if (customer?.email) {
            const portalUrl = await buildPortalLinkForCustomerId(supabase, member.customer_id, 'loyalty');
            await sendEmail(
              gate,
              "loyalty_email_pre_expire",
              "loyalty-pre-expire",
              customer.email,
              `loyalty-pre-expire-${member.id}-${
                expirationDate.toISOString().split("T")[0]
              }`,
              {
                customerName,
                remainingPoints: Number(member.remaining_points),
                expirationDate: fmtFriendlyDate(expirationDate),
                daysRemaining: INACTIVITY_DAYS - daysSinceLast,
                currentTier: currentTier.name,
                portalUrl,
              },
            );
          }

          const { error: warnUpdErr } = await supabase
            .from("loyalty_members")
            .update({ pre_expiry_warned_at: now.toISOString() })
            .eq("id", member.id);
          if (warnUpdErr) throw warnUpdErr;

          // Phase 4.2 — in-portal pre-expiry warning. Inside the same
          // (needsWarn) gate as the email so the notification respects
          // the WARNING_REPEAT_COOLDOWN_DAYS cooldown via
          // pre_expiry_warned_at. Emitted AFTER warned_at update so a
          // failed update doesn't leave the customer notified-but-not-
          // tracked (next tick would re-notify).
          await emitNotification(supabase, member.id, {
            category: "expiry",
            ...buildPreExpiryNotification({
              daysUntilExpiry: INACTIVITY_DAYS - daysSinceLast,
              points: Number(member.remaining_points),
            }),
            link_target: "tab:points",
          });

          summary.warnings_sent += 1;
        }
      }

      // ── TIER DOWNGRADE ON GAP (independent of warning) ────────────
      const gapTooBig = gapBetweenLastTwo != null &&
        gapBetweenLastTwo > GAP_DOWNGRADE_DAYS;
      const canDowngrade = gapTooBig && !member.is_downgraded &&
        currentTier.display_order > 1;
      if (canDowngrade) {
        const nextLower = tierByOrder.get(currentTier.display_order - 1);
        if (!nextLower) {
          summary.errors.push({
            member_id: member.id,
            error: `No tier at display_order ${currentTier.display_order - 1}`,
          });
        } else {
          const { error: dgErr } = await supabase
            .from("loyalty_members")
            .update({
              current_tier_id: nextLower.id,
              is_downgraded: true,
            })
            .eq("id", member.id);
          if (dgErr) throw dgErr;

          summary.downgrades_processed += 1;

          if (customer?.email) {
            const portalUrl = await buildPortalLinkForCustomerId(supabase, member.customer_id, 'loyalty');
            await sendEmail(
              gate,
              "loyalty_email_tier_downgrade",
              "loyalty-tier-downgrade",
              customer.email,
              `loyalty-tier-downgrade-${member.id}-${
                lastPurchase.toISOString().split("T")[0]
              }`,
              {
                customerName,
                oldTier: currentTier.name,
                newTier: nextLower.name,
                daysSinceLastPurchase: gapBetweenLastTwo,
                remainingPoints: Number(member.remaining_points),
                portalUrl,
              },
            );
          }
          if (customerBlock) {
            await syncSheet("tier_changed", customerBlock, {
              member_id: customer?.customer_code ?? null,
              current_tier: nextLower.name,
              lifetime_spend_jpy: Number(member.cumulative_spend_jpy ?? 0),
              available_points: Number(member.remaining_points ?? 0),
              last_purchase_date: member.last_purchase_at ?? null,
              old_tier: currentTier.name,
              new_tier: nextLower.name,
              reason: "inactivity",
              notes: `${currentTier.name} → ${nextLower.name}`,
            });
          }

          // Phase 4.2 — in-portal tier-downgrade notification (standalone
          // path: gap-too-big without points expiry). The expiry path
          // above handles its own twin emit when expiry causes a
          // downgrade; the two paths are mutually exclusive (expiry
          // branch `continue`s out of the loop iteration) so no
          // duplicate emit is possible.
          await emitNotification(supabase, member.id, {
            category: "tier",
            ...buildTierDowngradeNotification({
              oldTier: currentTier.name,
              newTier: nextLower.name,
            }),
            link_target: "tab:home",
          });
        }
      }
    } catch (memberErr: any) {
      console.error(
        `[loyalty-inactivity-check] member ${member.id} failed:`,
        memberErr,
      );
      summary.errors.push({
        member_id: member.id,
        error: memberErr?.message || String(memberErr),
      });
    }
  }

  return json(summary);
});
