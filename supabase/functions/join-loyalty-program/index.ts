import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createLoyaltyEmailGate } from "../_shared/loyalty-email-gate.ts";
import { resolvePortalAuth } from "../_shared/portal-auth.ts";
import { buildPortalLinkForCustomerId } from "../_shared/portal-link.ts";

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
    const gate = createLoyaltyEmailGate(supabase);

    const { portal_token, session_id } = await req.json().catch(() => ({})) as {
      portal_token?: string;
      session_id?: string;
    };

    // 1. Validate portal token or session_id
    let customerId: string;
    try {
      const auth = await resolvePortalAuth(supabase, { portal_token, session_id });
      customerId = auth.customer_id;
    } catch (err: any) {
      return json({ error: err?.message || "Invalid or expired portal token" }, 401);
    }

    // 2. Fetch customer
    const { data: customer, error: custErr } = await supabase
      .from("customers")
      .select("id, full_name, email")
      .eq("id", customerId)
      .single();
    if (custErr || !customer) {
      return json({ error: "Customer not found" }, 500);
    }

    // 3. Idempotency — already enrolled?
    const { data: existing } = await supabase
      .from("loyalty_members")
      .select("id")
      .eq("customer_id", customerId)
      .maybeSingle();
    if (existing) {
      return json({ already_enrolled: true, member_id: existing.id });
    }

    // 4. Glimmer tier id
    const { data: glimmer, error: tierErr } = await supabase
      .from("loyalty_tiers")
      .select("id")
      .eq("name", "Glimmer")
      .limit(1)
      .single();
    if (tierErr || !glimmer) {
      return json({ error: "Default tier not configured" }, 500);
    }

    // 5. Insert loyalty_member
    const enrolledAt = new Date().toISOString();
    const { data: member, error: insertErr } = await supabase
      .from("loyalty_members")
      .insert({
        customer_id: customerId,
        earned_tier_id: glimmer.id,
        current_tier_id: glimmer.id,
        is_downgraded: false,
        cumulative_spend_jpy: 0,
        total_points_earned: 0,
        total_points_redeemed: 0,
        total_points_expired: 0,
        remaining_points: 0,
        last_purchase_at: null,
        prev_purchase_at: null,
        enrolled_at: enrolledAt,
      })
      .select("id, enrolled_at")
      .single();
    if (insertErr || !member) {
      console.error("[join-loyalty-program] member insert failed:", insertErr);
      return json({ error: "Failed to enroll" }, 500);
    }

    // 6. Welcome email — fire-and-forget
    if (customer.email) {
      try {
        if (await gate("loyalty_email_welcome")) {
          // Build portal URL via shared helper. Routes migrated
          // customers (auth_user_id set) to bare /loyalty, and
          // non-migrated customers to /loyalty?token=X with the
          // newest active non-expired token from DB. Fixes existing
          // latent bug where session_id auth path produced URL with
          // literal "undefined" in the token slot.
          const portalUrl = await buildPortalLinkForCustomerId(
            supabase,
            customerId,
            'loyalty',
          );
          await fetch(
            `${Deno.env.get("SUPABASE_URL")}/functions/v1/send-transactional-email`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
              },
              body: JSON.stringify({
                templateName: "loyalty-welcome",
                recipientEmail: customer.email,
                idempotencyKey: `loyalty-welcome-${member.id}`,
                templateData: {
                  customerName: customer.full_name || "Valued Customer",
                  enrolledDate: enrolledAt,
                  portalUrl,
                },
              }),
            },
          ).catch((e) =>
            console.warn("[join-loyalty-program] welcome email failed:", e)
          );
        } else {
          console.log(
            "[email-gate] loyalty-welcome skipped — toggle 'loyalty_email_welcome' is OFF",
          );
        }
      } catch (emailErr) {
        console.warn("[join-loyalty-program] welcome email block failed:", emailErr);
      }
    }

    // 7. Sheet sync — fire-and-forget
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
            event_type: "enrolled",
            customer: {
              customer_id: customer.id,
              full_name: customer.full_name,
              email: customer.email,
            },
            payload: {},
          }),
        },
      ).catch((e) =>
        console.warn("[join-loyalty-program] sheet sync failed:", e)
      );
    } catch (sheetErr) {
      console.warn("[join-loyalty-program] sheet sync block failed:", sheetErr);
    }

    // 8. Return
    return json({
      enrolled: true,
      member_id: member.id,
      tier: "Glimmer",
      enrolled_at: member.enrolled_at,
    });
  } catch (err: any) {
    console.error("[join-loyalty-program] unexpected error:", err);
    return json({ error: err?.message || "internal_error" }, 500);
  }
});
