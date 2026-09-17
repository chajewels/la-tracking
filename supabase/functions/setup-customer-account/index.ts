// setup-customer-account — Phase B
//
// Links a Supabase Auth user (auth.users) to the existing
// customers row via customers.auth_user_id. Called by the
// customer portal after a successful Supabase Auth signup
// (email + password).
//
// Auth: Bearer JWT in Authorization header. The JWT is
// validated via supabase.auth.getUser(). The customer is
// looked up by case-insensitive email match against the
// JWT user's email.
//
// Idempotent: re-running with the same user is a no-op
// (returns success). If the customer is already linked to a
// different auth_user_id, returns 409 conflict.
//
// Schema requirements (already in production):
//   - customers.auth_user_id column (Step 2 file 2)
//   - partial unique index on LOWER(email) WHERE auth_user_id
//     IS NOT NULL (Step 2 file 3) — protects against race
//     conditions at DB level
//
// This function is independent of resolvePortalAuth: that
// helper only succeeds AFTER auth_user_id is set; this
// function is what sets it in the first place.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createLoyaltyEmailGate } from "../_shared/loyalty-email-gate.ts";
import { buildPortalLinkForCustomerId } from "../_shared/portal-link.ts";
import { sendTemplateEmail } from "../_shared/transactional-email-templates/send-email.ts";

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
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 1. Extract Bearer JWT from Authorization header
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Missing Authorization header" }, 401);
    }
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return json({ error: "Invalid Authorization header format" }, 401);
    }
    const jwt = match[1].trim();

    // 2. Validate JWT and get auth.users row
    const { data: userData, error: userErr } =
      await supabase.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return json({ error: "Invalid or expired token" }, 401);
    }
    const authUser = userData.user;
    const authUserId = authUser.id;
    const authUserEmail = authUser.email;

    if (!authUserEmail) {
      return json(
        { error: "Account has no email — cannot link to customer" },
        400,
      );
    }

    // 2b. Self-signup profile fields come from Supabase Auth
    //     user_metadata (set at signUp via options.data). This is
    //     reliable across the email-verification round-trip, unlike
    //     the prior localStorage handoff. supabase.auth.getUser(jwt)
    //     above already resolved the auth.users row with metadata.
    //     Used only on the new-customer creation path; linking an
    //     existing customer ignores these.
    const metadata = (authUser.user_metadata ?? {}) as Record<string, unknown>;
    const metaStr = (v: unknown) =>
      typeof v === "string" ? v.trim() : "";

    // 3. Look up customer by case-insensitive email match.
    // Note: ilike acts as case-insensitive equality when the
    // input contains no LIKE wildcards. Real email addresses
    // do not contain _ or % so this is safe.
    const { data: customers, error: lookupErr } = await supabase
      .from("customers")
      .select("id, auth_user_id")
      .ilike("email", authUserEmail);

    if (lookupErr) {
      console.error("[setup-customer-account] customer lookup failed:", lookupErr);
      return json({ error: "Database lookup failed" }, 500);
    }

    if (!customers || customers.length === 0) {
      // New-customer self-signup path: create the customers row
      // (auth_user_id + email from the verified JWT) and auto-enroll
      // into the Glimmer loyalty tier. customer_code is auto-generated
      // by the existing BEFORE INSERT trigger.
      const fullName = metaStr(metadata.full_name);
      const mobileNumber = metaStr(metadata.mobile_number);
      const facebookName = metaStr(metadata.facebook_name);
      const messengerLink = metaStr(metadata.messenger_link);
      const locationVal = metaStr(metadata.location);
      const country = metaStr(metadata.country);

      if (!fullName) {
        return json(
          { error: "Full name is required to create your profile" },
          400,
        );
      }
      if (!facebookName) {
        return json(
          { error: "Facebook name is required to create your profile" },
          400,
        );
      }
      if (!country) {
        return json(
          { error: "Country is required to create your profile" },
          400,
        );
      }

      const customerInsert: Record<string, unknown> = {
        full_name: fullName,
        email: authUserEmail,
        auth_user_id: authUserId,
        facebook_name: facebookName,
        country,
      };
      if (mobileNumber) customerInsert.mobile_number = mobileNumber;
      if (messengerLink) customerInsert.messenger_link = messengerLink;
      if (locationVal) customerInsert.location = locationVal;

      const { data: newCustomer, error: createErr } = await supabase
        .from("customers")
        .insert(customerInsert)
        .select("id, customer_code, full_name, email")
        .single();

      if (createErr || !newCustomer) {
        console.error(
          "[setup-customer-account] customer create failed:",
          createErr,
        );
        return json({ error: "Failed to create your profile" }, 500);
      }

      // Auto-enroll into Glimmer.
      const { data: glimmer, error: tierErr } = await supabase
        .from("loyalty_tiers")
        .select("id")
        .eq("name", "Glimmer")
        .limit(1)
        .single();

      if (tierErr || !glimmer) {
        console.error(
          "[setup-customer-account] Glimmer tier lookup failed:",
          tierErr,
        );
        return json({ error: "Loyalty tier not configured" }, 500);
      }

      const { data: member, error: memberErr } = await supabase
        .from("loyalty_members")
        .insert({
          customer_id: newCustomer.id,
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
          enrolled_at: new Date().toISOString(),
          enrollment_source: "portal_signup",
        })
        .select("id, enrolled_at")
        .single();

      if (memberErr || !member) {
        console.error(
          "[setup-customer-account] loyalty enroll failed:",
          memberErr,
        );
        return json({ error: "Failed to enroll in loyalty program" }, 500);
      }

      // Enrolled ledger row — mirrors join-loyalty-program step 5b so the
      // LoyaltyAdmin Member-events feed shows portal signups.
      let enrolledTxId: string | null = null;
      try {
        const { data: enrolledTx, error: enrolledTxErr } = await supabase
          .from("loyalty_transactions")
          .insert({
            member_id: member.id,
            transaction_type: "enrolled",
            points_amount: 0,
            account_id: null,
            cash_order_id: null,
            payment_id: null,
            spend_amount_jpy: null,
            rate_snapshot: null,
            invoice_number: null,
            tier_at_time: null,
            notes: "Enrolled in Cha Jewels Circle (portal signup)",
            created_by_user_id: null,
          })
          .select("id")
          .single();
        enrolledTxId = enrolledTx?.id ?? null;
        if (enrolledTxErr) {
          console.warn("[setup-customer-account] enrolled tx insert failed (non-blocking):", enrolledTxErr);
        }
      } catch (enrolledTxBlockErr) {
        console.warn("[setup-customer-account] enrolled tx block failed (non-blocking):", enrolledTxBlockErr);
      }

      // Welcome email — mirrors join-loyalty-program step 6 (same template,
      // same toggle, same idempotency key).
      if (newCustomer.email) {
        try {
          const gate = createLoyaltyEmailGate(supabase);
          if (await gate("loyalty_email_welcome")) {
            const portalUrl = await buildPortalLinkForCustomerId(supabase, newCustomer.id, "loyalty");
            const result = await sendTemplateEmail(
              "loyalty-welcome",
              newCustomer.email,
              {
                templateData: {
                  customerName: newCustomer.full_name || "Valued Customer",
                  enrolledDate: member.enrolled_at,
                  portalUrl,
                },
                idempotencyKey: `loyalty-welcome-${member.id}`,
              },
            );
            if (!result.sent) {
              console.log(`[setup-customer-account] "loyalty-welcome" suppressed for ${newCustomer.email}`);
            }
          } else {
            console.log("[email-gate] loyalty-welcome skipped — toggle 'loyalty_email_welcome' is OFF");
          }
        } catch (emailErr) {
          console.warn("[setup-customer-account] welcome email block failed:", emailErr);
        }
      }

      // Sheet sync — mirrors join-loyalty-program step 7, then marks the
      // enrolled row synced so the reconciler does not append it again.
      try {
        const _syRes = await fetch(
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
                customer_id: newCustomer.id,
                full_name: newCustomer.full_name,
                email: newCustomer.email,
              },
              payload: {
                member_id: newCustomer.customer_code ?? null,
                current_tier: "Glimmer",
                lifetime_spend_jpy: 0,
                available_points: 0,
                activity_status: "Active",
                last_purchase_date: null,
                notes: "New enrollment — portal signup",
              },
            }),
          },
        ).catch((e) => {
          console.warn("[setup-customer-account] sheet sync failed:", e);
          return null;
        });
        if (_syRes && !_syRes.ok) {
          const _t = await _syRes.text().catch(() => "<no body>");
          console.error(`[setup-customer-account] sync-loyalty-to-sheet (enrolled) failed (${_syRes.status}): ${_t}`);
        } else if (_syRes && _syRes.ok && enrolledTxId) {
          const { error: markErr } = await supabase
            .from("loyalty_transactions")
            .update({ synced_to_sheet_at: new Date().toISOString() })
            .eq("id", enrolledTxId);
          if (markErr) {
            console.warn("[setup-customer-account] failed to mark enrolled tx synced (non-blocking):", markErr);
          }
        }
      } catch (sheetErr) {
        console.warn("[setup-customer-account] sheet sync block failed:", sheetErr);
      }

      return json({
        success: true,
        customer_id: newCustomer.id,
        customer_code: newCustomer.customer_code,
        created: true,
        member_id: member.id,
      });
    }

    if (customers.length > 1) {
      // Defensive: should never happen for authed customers
      // because of partial unique index, but possible for
      // unlinked customers if data has duplicates.
      console.error(
        "[setup-customer-account] multiple customers matched email:",
        authUserEmail,
        "count:",
        customers.length,
      );
      return json(
        {
          error:
            "Multiple customer records match this email. Contact support.",
        },
        409,
      );
    }

    const customer = customers[0];

    // 4. Idempotency / conflict checks
    if (customer.auth_user_id === authUserId) {
      // Already linked to this user — no-op, return success
      return json({
        success: true,
        customer_id: customer.id,
        already_linked: true,
      });
    }

    if (customer.auth_user_id && customer.auth_user_id !== authUserId) {
      // Linked to a different user — conflict, do not overwrite
      console.error(
        "[setup-customer-account] customer already linked to different user. customer:",
        customer.id,
        "existing:",
        customer.auth_user_id,
        "requested:",
        authUserId,
      );
      return json(
        {
          error:
            "This email is already linked to a different account.",
        },
        409,
      );
    }

    // 5. Set auth_user_id (link customer to auth user)
    const { error: updateErr } = await supabase
      .from("customers")
      .update({ auth_user_id: authUserId })
      .eq("id", customer.id);

    if (updateErr) {
      console.error("[setup-customer-account] update failed:", updateErr);
      return json({ error: "Failed to link account" }, 500);
    }

    return json({
      success: true,
      customer_id: customer.id,
      already_linked: false,
    });
  } catch (err: any) {
    console.error("[setup-customer-account] unexpected error:", err);
    return json(
      { error: err?.message || "Internal error" },
      500,
    );
  }
});
