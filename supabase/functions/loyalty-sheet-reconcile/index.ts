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

// Canonical taxonomy — must match sync-loyalty-to-sheet/index.ts exactly.
// Members-tab events status_changed / admin_edited live on loyalty_members,
// not loyalty_transactions, so they are out of scope for this reconciler.
const TRANSACTIONS_TAB_EVENTS = new Set([
  "earned",
  "bonus",
  "redeemed",
  "expired",
  "adjusted",
  "refunded",
  "revoked",
  "birthday_bonus",
]);
const MEMBERS_TAB_EVENTS_FROM_TX = new Set([
  "tier_changed",
  "enrolled",
]);

function deriveActivity(lastPurchaseAt: string | null | undefined): "Active" | "Inactive" {
  if (!lastPurchaseAt) return "Active";
  const d = new Date(lastPurchaseAt);
  if (Number.isNaN(d.getTime())) return "Active";
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
  return Date.now() - d.getTime() >= ninetyDaysMs ? "Inactive" : "Active";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Auth: env-equality OR admin/finance user fallback.
    // Matches award-loyalty-points post-Bug-#163 fix. See Bug #163 in
    // docs/FIXED-BUGS.md for rationale on why direct env equality is
    // used instead of JWT decode.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return json({ error: "Unauthorized" }, 401);
    }
    const token = authHeader.replace("Bearer ", "");
    let authorized = false;
    if (token === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) {
      authorized = true;
    }
    if (!authorized) {
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) {
        return json({ error: "Unauthorized" }, 401);
      }
      const [{ data: isAdmin }, { data: isFinance }] = await Promise.all([
        supabase.rpc("has_role", { _user_id: user.id, _role: "admin" }),
        supabase.rpc("has_role", { _user_id: user.id, _role: "finance" }),
      ]);
      if (!isAdmin && !isFinance) {
        return json({ error: "Forbidden" }, 403);
      }
    }

    // Optional body parameters
    //   max_rows    1..200, default 100
    //   window_days 1..90,  default 30
    const body = await req.json().catch(() => ({})) as {
      max_rows?: number;
      window_days?: number;
    };
    const maxRows = Math.min(Math.max(Number(body.max_rows ?? 100), 1), 200);
    const windowDays = Math.min(Math.max(Number(body.window_days ?? 30), 1), 90);
    const cutoff = new Date(Date.now() - windowDays * 24 * 3600 * 1000).toISOString();

    // Fetch unsynced rows with embedded customer + tier context.
    const { data: rows, error: queryErr } = await supabase
      .from("loyalty_transactions")
      .select(`
        id,
        transaction_type,
        points_amount,
        spend_amount_jpy,
        invoice_number,
        tier_at_time,
        account_id,
        cash_order_id,
        promo_id,
        notes,
        created_by_user_id,
        created_at,
        member_id,
        loyalty_members!inner (
          id,
          customer_id,
          current_tier_id,
          cumulative_spend_jpy,
          remaining_points,
          last_purchase_at,
          customers!inner ( id, customer_code, full_name, email ),
          loyalty_tiers ( name, points_multiplier )
        )
      `)
      .is("synced_to_sheet_at", null)
      .gt("created_at", cutoff)
      .order("created_at", { ascending: true })
      .limit(maxRows);

    if (queryErr) {
      console.error("[loyalty-sheet-reconcile] query failed:", queryErr);
      return json({ error: "query_failed", detail: queryErr.message }, 500);
    }

    if (!rows || rows.length === 0) {
      return json({
        processed: 0,
        succeeded: 0,
        failed: 0,
        remaining: 0,
        window_days: windowDays,
        max_rows: maxRows,
      });
    }

    const syncSheetUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/sync-loyalty-to-sheet`;
    const syncHeaders = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
    };

    let succeeded = 0;
    let failed = 0;
    const failures: Array<{ id: string; reason: string; detail?: string }> = [];

    for (const row of rows as any[]) {
      const member = row.loyalty_members;
      const customer = member?.customers;
      const tier = member?.loyalty_tiers;

      if (!customer || !customer.customer_code) {
        failed++;
        failures.push({ id: row.id, reason: "customer_not_resolved" });
        continue;
      }

      const eventType = row.transaction_type as string;
      const isTransactionsTab = TRANSACTIONS_TAB_EVENTS.has(eventType);
      const isMembersTab = MEMBERS_TAB_EVENTS_FROM_TX.has(eventType);

      if (!isTransactionsTab && !isMembersTab) {
        failed++;
        failures.push({ id: row.id, reason: `unsupported_event_type:${eventType}` });
        continue;
      }

      // Resolve invoice_number from layaway_accounts or cash_orders if not on the row.
      let invoiceNumber: string = row.invoice_number ?? "";
      if (!invoiceNumber && row.account_id) {
        const { data: la } = await supabase
          .from("layaway_accounts")
          .select("invoice_number")
          .eq("id", row.account_id)
          .maybeSingle();
        invoiceNumber = la?.invoice_number ?? "";
      } else if (!invoiceNumber && row.cash_order_id) {
        const { data: co } = await supabase
          .from("cash_orders")
          .select("invoice_number")
          .eq("id", row.cash_order_id)
          .maybeSingle();
        invoiceNumber = co?.invoice_number ?? "";
      }

      const customerBlock = {
        customer_id: customer.id,
        full_name: customer.full_name ?? null,
        email: customer.email ?? null,
      };

      let payload: Record<string, unknown>;
      if (isTransactionsTab) {
        payload = {
          event_type: eventType,
          customer: customerBlock,
          payload: {
            member_id: customer.customer_code,
            transaction_id: row.id,
            points_amount: row.points_amount,
            spend_amount_jpy: row.spend_amount_jpy ?? null,
            multiplier: tier?.points_multiplier ?? null,
            tier_at_time: row.tier_at_time ?? "",
            invoice_number: invoiceNumber,
            account_id: row.account_id ?? null,
            notes: row.notes ?? "",
            created_by: row.created_by_user_id ? "admin" : "system",
          },
        };
      } else {
        // Members tab: tier_changed | enrolled.
        // Values reflect CURRENT member state, not at-the-time. For
        // backfill of historical rows this is acceptable — the row.notes
        // carries the at-the-time transition narrative (e.g. "Glimmer → Radiant").
        payload = {
          event_type: eventType,
          customer: customerBlock,
          payload: {
            member_id: customer.customer_code,
            current_tier: tier?.name ?? row.tier_at_time ?? "",
            lifetime_spend_jpy: member.cumulative_spend_jpy ?? 0,
            available_points: member.remaining_points ?? 0,
            activity_status: deriveActivity(member.last_purchase_at),
            last_purchase_at: member.last_purchase_at ?? null,
            notes: row.notes ?? "",
          },
        };
      }

      try {
        const res = await fetch(syncSheetUrl, {
          method: "POST",
          headers: syncHeaders,
          body: JSON.stringify(payload),
        });

        if (res.ok) {
          const { error: markErr } = await supabase
            .from("loyalty_transactions")
            .update({ synced_to_sheet_at: new Date().toISOString() })
            .eq("id", row.id);
          if (markErr) {
            // Critical edge case: sheet has the row but DB still says
            // unsynced. Next tick will re-emit creating a sheet duplicate.
            // Log loudly so operator can manually clean up if it happens.
            console.error(
              "[loyalty-sheet-reconcile] CRITICAL: sheet POST succeeded but mark update failed",
              { id: row.id, error: markErr.message },
            );
            failed++;
            failures.push({
              id: row.id,
              reason: "mark_synced_update_failed",
              detail: markErr.message,
            });
          } else {
            succeeded++;
          }
        } else {
          const errBody = await res.text().catch(() => "");
          failed++;
          failures.push({
            id: row.id,
            reason: `sheet_post_${res.status}`,
            detail: errBody.slice(0, 200),
          });
        }
      } catch (e) {
        failed++;
        failures.push({
          id: row.id,
          reason: "fetch_threw",
          detail: (e as Error).message,
        });
      }
    }

    // Count rows still unsynced in the window after this run.
    const { count: remaining } = await supabase
      .from("loyalty_transactions")
      .select("id", { count: "exact", head: true })
      .is("synced_to_sheet_at", null)
      .gt("created_at", cutoff);

    return json({
      processed: rows.length,
      succeeded,
      failed,
      remaining: remaining ?? 0,
      window_days: windowDays,
      max_rows: maxRows,
      failures: failures.length > 0 ? failures.slice(0, 10) : undefined,
    });
  } catch (err) {
    console.error("[loyalty-sheet-reconcile] unexpected error:", err);
    return json({ error: (err as Error)?.message || "internal_error" }, 500);
  }
});
