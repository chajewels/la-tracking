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

async function buildLoyaltyPortalUrl(supabase: any, customerId: string): Promise<string> {
  const { data: tokenRow } = await supabase
    .from("customer_portal_tokens")
    .select("token, expires_at")
    .eq("customer_id", customerId)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (tokenRow?.token) {
    const expired = tokenRow.expires_at && new Date(tokenRow.expires_at) < new Date();
    if (!expired) {
      return `https://portal.chajewelsjp.com/loyalty?token=${encodeURIComponent(tokenRow.token)}`;
    }
  }
  return "https://portal.chajewelsjp.com/portal";
}

async function sendEmail(
  templateName: string,
  recipientEmail: string,
  idempotencyKey: string,
  templateData: Record<string, unknown>,
) {
  try {
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
      "id, customer_id, current_tier_id, earned_tier_id, remaining_points, total_points_expired, last_purchase_at, prev_purchase_at, pre_expiry_warned_at, is_downgraded",
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
        .select("id, full_name, email")
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

        const { error: txErr } = await supabase
          .from("loyalty_transactions")
          .insert({
            member_id: member.id,
            transaction_type: "expired",
            points_amount: -wasRemaining,
            tier_at_time: currentTier.name,
            notes: "Inactivity expiry: 6 months since last purchase",
          });
        if (txErr) throw txErr;

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
          const portalUrl = await buildLoyaltyPortalUrl(supabase, member.customer_id);
          await sendEmail(
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
            points_amount: -wasRemaining,
            notes: "Expired: 6mo inactivity",
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
            const portalUrl = await buildLoyaltyPortalUrl(supabase, member.customer_id);
            await sendEmail(
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
            const portalUrl = await buildLoyaltyPortalUrl(supabase, member.customer_id);
            await sendEmail(
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
            await syncSheet("tier_change", customerBlock, {
              old_tier: currentTier.name,
              new_tier: nextLower.name,
              reason: "inactivity",
            });
          }
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
