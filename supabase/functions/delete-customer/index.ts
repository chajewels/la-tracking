import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkPermission } from "../_shared/check-permission.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing authorization");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Verify user
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) throw new Error("Unauthorized");

    const canDeleteCustomer = await checkPermission(supabase, user.id, "delete_customer");
    if (!canDeleteCustomer) throw new Error("You do not have permission to delete customers");

    const { customer_id } = await req.json();
    if (!customer_id) throw new Error("customer_id is required");

    // Capture customer info for audit log (must happen before delete so
    // the row data is still in scope).
    const { data: customerRow } = await supabase
      .from("customers")
      .select("id, full_name, customer_code")
      .eq("id", customer_id)
      .single();

    // Consolidated pre-check — list ALL blockers in one response.
    // FK is RESTRICT/NO ACTION on both, so we block on ALL rows
    // regardless of status (status filter would let cancelled/expired
    // rows slip through and hit a generic FK 500 instead of our
    // friendly 400).
    const [accountsRes, cashOrdersRes, openDraftsRes] = await Promise.all([
      supabase
        .from("layaway_accounts")
        .select("id, invoice_number")
        .eq("customer_id", customer_id),
      supabase
        .from("cash_orders")
        .select("id, invoice_number")
        .eq("customer_id", customer_id),
      // A website checkout still waiting for staff ('to_confirm') is a live
      // order request — never deleted with the customer (owner rule
      // 2026-10-25 covers declined checkouts only). Decline it first.
      supabase
        .from("web_order_drafts")
        .select("id, web_reference")
        .eq("customer_id", customer_id)
        .eq("status", "to_confirm"),
    ]);
    if (accountsRes.error) throw accountsRes.error;
    if (cashOrdersRes.error) throw cashOrdersRes.error;
    if (openDraftsRes.error) throw openDraftsRes.error;

    const accounts = accountsRes.data || [];
    const cashOrders = cashOrdersRes.data || [];
    const openDrafts = openDraftsRes.data || [];

    if (openDrafts.length > 0 && accounts.length === 0 && cashOrders.length === 0) {
      return new Response(
        JSON.stringify({
          error: `Cannot delete: customer has ${openDrafts.length} website order(s) waiting for confirmation (${openDrafts.map((d: any) => d.web_reference).join(", ")}). Confirm or decline them first.`,
          blocked_by: { web_order_drafts: { count: openDrafts.length, web_references: openDrafts.map((d: any) => d.web_reference) } },
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (accounts.length > 0 || cashOrders.length > 0) {
      const blocked_by: Record<string, { count: number; invoice_numbers: string[] }> = {};
      if (accounts.length > 0) {
        blocked_by.layaway_accounts = {
          count: accounts.length,
          invoice_numbers: accounts.map((a: any) => a.invoice_number),
        };
      }
      if (cashOrders.length > 0) {
        blocked_by.cash_orders = {
          count: cashOrders.length,
          invoice_numbers: cashOrders.map((c: any) => c.invoice_number),
        };
      }
      const parts: string[] = [];
      if (accounts.length > 0)   parts.push(`${accounts.length} layaway account(s)`);
      if (cashOrders.length > 0) parts.push(`${cashOrders.length} cash order(s)`);
      return new Response(
        JSON.stringify({
          error: `Cannot delete: customer has ${parts.join(' and ')}. Reassign or close them first.`,
          blocked_by,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 1. Extension requests cleanup (FK is NO ACTION — must explicitly delete)
    const { error: erErr } = await supabase
      .from("extension_requests")
      .delete()
      .eq("customer_id", customer_id);
    if (erErr) throw erErr;

    // 2. Payment submissions cleanup (FK is NO ACTION — must explicitly delete)
    const { error: psErr } = await supabase
      .from("payment_submissions")
      .delete()
      .eq("customer_id", customer_id);
    if (psErr) throw psErr;

    // 3. Service jobs cleanup (FK is NO ACTION — must explicitly delete)
    const { error: sjErr } = await supabase
      .from("service_jobs")
      .delete()
      .eq("customer_id", customer_id);
    if (sjErr) throw sjErr;

    // 4. Trade-ins cleanup (FK is NO ACTION — must explicitly delete)
    const { error: tiErr } = await supabase
      .from("trade_ins")
      .delete()
      .eq("customer_id", customer_id);
    if (tiErr) throw tiErr;

    // 5. Loyalty signups (FK is NO ACTION on converted_customer_id — must be cleared).
    // The LINK is cleared, the ROW IS KEPT. A signup is not a child of the
    // customer: name, contact, region and lang are NOT NULL on the row itself,
    // and converted_customer_id is a nullable link added later if the signup
    // converts. The row records a storefront enrollment that actually happened
    // — and per CLAUDE.md, website POST /loyalty/join writes one only when an
    // enrollment FAILED, alongside the 'loyalty_join_failed' staff bell.
    // Deleting it would erase the evidence of a bug we raised an alarm about.
    const { error: lsErr } = await supabase
      .from("loyalty_signups")
      .update({ converted_customer_id: null })
      .eq("converted_customer_id", customer_id);
    if (lsErr) throw lsErr;

    // 6. Website live claims (FK is NO ACTION — must be cleared).
    // A claim HOLDS A VARIANT, so a live hold is released before the link goes,
    // the same way an expiring plan gives its stock back rather than vanishing.
    // 'released' is the enum's own terminal state for exactly this.
    const { error: wcHeldErr } = await supabase
      .from("website_live_claims")
      .update({ status: "released", customer_id: null })
      .eq("customer_id", customer_id)
      .eq("status", "held");
    if (wcHeldErr) throw wcHeldErr;

    // Claims already resolved (paid / layaway / expired / released) keep their
    // status — the stock question is settled — and only lose the link.
    const { error: wcRestErr } = await supabase
      .from("website_live_claims")
      .update({ customer_id: null })
      .eq("customer_id", customer_id);
    if (wcRestErr) throw wcRestErr;

    // 6b. Website checkouts, coupon uses and article comments (owner rule
    // 2026-10-25: delete them first, then the customer). All FKs are NO ACTION.
    // Only finished checkouts reach here: a 'confirmed' draft always has an
    // order (refused above) and a 'to_confirm' draft is refused above, so these
    // are 'declined' / 'expired' drafts whose stock was already released.
    const { data: draftRows, error: drSelErr } = await supabase
      .from("web_order_drafts")
      .select("id")
      .eq("customer_id", customer_id);
    if (drSelErr) throw drSelErr;
    const draftIds = (draftRows || []).map((d: any) => d.id);

    if (draftIds.length > 0) {
      // Drafts and coupon uses point at each other — drop the draft's link first.
      const { error: drLinkErr } = await supabase
        .from("web_order_drafts")
        .update({ coupon_use_id: null })
        .in("id", draftIds);
      if (drLinkErr) throw drLinkErr;

      // A points redemption keeps its record; only its link to the draft goes.
      const { error: lrErr } = await supabase
        .from("loyalty_redemptions")
        .update({ web_draft_id: null })
        .in("web_draft_id", draftIds);
      if (lrErr) throw lrErr;
    }

    const { error: cuErr } = await supabase
      .from("website_coupon_uses")
      .delete()
      .eq("customer_id", customer_id);
    if (cuErr) throw cuErr;

    if (draftIds.length > 0) {
      const { error: dlErr } = await supabase
        .from("web_order_draft_lines")
        .delete()
        .in("draft_id", draftIds);
      if (dlErr) throw dlErr;

      // service_requests.web_draft_id is ON DELETE SET NULL — handled by the DB.
      const { error: drDelErr } = await supabase
        .from("web_order_drafts")
        .delete()
        .in("id", draftIds);
      if (drDelErr) throw drDelErr;
    }

    const { error: pcErr } = await supabase
      .from("website_post_comments")
      .delete()
      .eq("customer_id", customer_id);
    if (pcErr) throw pcErr;

    // 7. Safe to delete — also clean up analytics
    await supabase.from("customer_analytics").delete().eq("customer_id", customer_id);
    const { error: delErr } = await supabase.from("customers").delete().eq("id", customer_id);
    if (delErr) throw delErr;

    // 8. Audit log — matches delete-account pattern from commit bf368a6
    await supabase.from("audit_logs").insert({
      entity_type: "customer",
      entity_id: customer_id,
      action: "delete",
      old_value_json: {
        full_name: customerRow?.full_name,
        customer_code: customerRow?.customer_code,
      },
      performed_by_user_id: user.id,
    });

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
