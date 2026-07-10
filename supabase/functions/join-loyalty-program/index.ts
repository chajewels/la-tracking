import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createLoyaltyEmailGate } from "../_shared/loyalty-email-gate.ts";
import { resolvePortalAuth } from "../_shared/portal-auth.ts";
import { buildPortalLinkForCustomerId } from "../_shared/portal-link.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// Constant-time string comparison — accumulate byte diffs plus a length
// mismatch; never === on the strings and never early-return.
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const gate = createLoyaltyEmailGate(supabase);

    // 0. Server-side loyalty_enabled gate (go-live toggle). Fail-closed:
    //    anything other than a strict true blocks enrollment with 403.
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
        return json({ error: "Loyalty program is not currently available" }, 403);
      }
    }

    const { portal_token, session_id, customer_id, internal } = await req.json().catch(() => ({})) as {
      portal_token?: string;
      session_id?: string;
      customer_id?: string;
      internal?: boolean;
    };

    void internal; // caller-supplied flag; the header+secret is the real gate.

    let customerId: string | undefined;

    // 0b. Internal-secret auth branch — a trusted server-side caller (e.g. the
    //     shopify-webhook function) enrolls by customer_id with no portal
    //     token/JWT. Only available when INTERNAL_FUNCTION_SECRET is configured
    //     AND the caller presents a matching x-internal-secret header
    //     (constant-time compared). With the env secret set, a present-but-wrong
    //     header is an explicit 401 (not a downgrade to portal auth). A matched
    //     secret with no customer_id falls through to portal auth. When the env
    //     secret is unset, or no header is sent, the branch is skipped entirely.
    const internalSecretHeader = req.headers.get("x-internal-secret");
    const internalSecretEnv = Deno.env.get("INTERNAL_FUNCTION_SECRET");
    if (internalSecretHeader && internalSecretEnv) {
      if (timingSafeEqual(internalSecretEnv, internalSecretHeader)) {
        if (customer_id) {
          customerId = customer_id;
          console.log(`[join-loyalty-program] internal enrollment for customer=${customerId}`);
        }
        // matched but no customer_id → fall through to portal auth below.
      } else {
        // present but wrong → explicit failure, do not fall through.
        return json({ error: "Unauthorized" }, 401);
      }
    }

    // 1. Validate portal token, session_id, or Bearer JWT — UNCHANGED path.
    //    Runs whenever the internal branch did not resolve a customerId.
    if (customerId === undefined) {
      try {
        const auth = await resolvePortalAuth(supabase, {
          portal_token,
          session_id,
          authHeader: req.headers.get('Authorization'),
        });
        customerId = auth.customer_id;
      } catch (err: any) {
        return json({ error: err?.message || "Invalid or expired portal token" }, 401);
      }
    }

    // 2. Fetch customer
    const { data: customer, error: custErr } = await supabase
      .from("customers")
      .select("id, customer_code, full_name, email")
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

    // 5b. Emit an 'enrolled' loyalty_transactions row so the Member-events
    //     feed (LoyaltyAdmin Transactions tab) mirrors what the Google
    //     Sheet backup records. Non-blocking: a failure here must NOT roll
    //     back the enrollment (sheet sync below remains the parallel path).
    try {
      const { error: enrolledTxErr } = await supabase
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
          notes: "Enrolled in Cha Jewels Circle",
          created_by_user_id: null,
        });
      if (enrolledTxErr) {
        console.warn(
          "[join-loyalty-program] enrolled tx insert failed (non-blocking):",
          enrolledTxErr,
        );
      }
    } catch (enrolledTxBlockErr) {
      console.warn(
        "[join-loyalty-program] enrolled tx block failed (non-blocking):",
        enrolledTxBlockErr,
      );
    }

    // 5c. Retroactive enrollment award — if the customer's most recent
    //   qualifying order was payment-confirmed within the grace window,
    //   award points for it now. Reuses award-loyalty-points (whose
    //   step 4b idempotency guard protects against double-award if
    //   review-payment-submission later fires for the same source).
    //   Wrapped in try/catch — any failure here must NEVER fail
    //   enrollment. Customer is already enrolled at this point.
    try {
      let graceDays = 3;
      const { data: graceRow } = await supabase
        .from("system_settings")
        .select("value")
        .eq("key", "loyalty_enrollment_grace_days")
        .maybeSingle();
      const rawGrace = graceRow?.value;
      if (rawGrace != null) {
        let parsed: number = NaN;
        if (typeof rawGrace === "number") parsed = rawGrace;
        else {
          try {
            const j = JSON.parse(String(rawGrace));
            parsed = Number(j);
          } catch {
            parsed = Number(rawGrace);
          }
        }
        if (Number.isFinite(parsed) && parsed >= 0) {
          graceDays = Math.floor(parsed);
        }
      }

      const { data: recentOrder, error: rpcErr } = await supabase.rpc(
        "get_recent_qualifying_order",
        { p_customer_id: customerId, p_lookback_days: graceDays },
      );
      if (rpcErr) {
        console.warn(
          "[join-loyalty-program] retro lookback rpc failed (non-blocking):",
          rpcErr,
        );
      } else {
        const row: any = Array.isArray(recentOrder)
          ? recentOrder[0]
          : recentOrder;
        if (row && row.source_kind) {
          const awardBody: Record<string, unknown> = {};
          if (row.source_kind === "layaway") {
            const accountId = row.account_id ?? row.source_id ?? null;
            awardBody.account_id = accountId;
            // If this single matched layaway order has no loyalty_jpy_amount
            // (typical when a non-member created it), derive it now for
            // THIS ONE account only via derive_order_loyalty_jpy. Never
            // bulk-update across the customer's other accounts.
            if (accountId && row.loyalty_jpy_amount == null) {
              const { error: deriveErr } = await supabase.rpc(
                "derive_order_loyalty_jpy",
                { p_account_id: accountId },
              );
              if (deriveErr) {
                console.warn(
                  "[join-loyalty-program] derive_order_loyalty_jpy failed (non-blocking):",
                  deriveErr,
                );
              }
            }
          } else {
            awardBody.cash_order_id = row.cash_order_id ?? row.source_id ?? null;
          }
          if (awardBody.account_id || awardBody.cash_order_id) {
            const _awRes = await fetch(
              `${Deno.env.get("SUPABASE_URL")}/functions/v1/award-loyalty-points`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
                },
                body: JSON.stringify(awardBody),
              },
            ).catch((e) => {
              console.warn(
                "[join-loyalty-program] retro award invoke failed (non-blocking):",
                e,
              );
              return null;
            });
            if (_awRes && !_awRes.ok) {
              const _t = await _awRes.text().catch(() => "<no body>");
              console.error(`[join-loyalty-program] award-loyalty-points (retro) failed (${_awRes.status}): ${_t}`);
            }
          }
        }
      }
    } catch (retroErr) {
      console.warn(
        "[join-loyalty-program] retro lookback block failed (non-blocking):",
        retroErr,
      );
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
          const _emRes = await fetch(
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
          ).catch((e) => {
            console.warn("[join-loyalty-program] welcome email failed:", e);
            return null;
          });
          if (_emRes && !_emRes.ok) {
            const _t = await _emRes.text().catch(() => "<no body>");
            console.error(`[join-loyalty-program] send-transactional-email (welcome) failed (${_emRes.status}): ${_t}`);
          }
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
              customer_id: customer.id,
              full_name: customer.full_name,
              email: customer.email,
            },
            payload: {
              member_id: customer.customer_code ?? null,
              current_tier: "Glimmer",
              lifetime_spend_jpy: 0,
              available_points: 0,
              activity_status: "Active",
              last_purchase_date: null,
              notes: "New enrollment",
            },
          }),
        },
      ).catch((e) => {
        console.warn("[join-loyalty-program] sheet sync failed:", e);
        return null;
      });
      if (_syRes && !_syRes.ok) {
        const _t = await _syRes.text().catch(() => "<no body>");
        console.error(`[join-loyalty-program] sync-loyalty-to-sheet (enrolled) failed (${_syRes.status}): ${_t}`);
      }
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
