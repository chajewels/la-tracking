// bulk-send-setup-invites — Phase B bulk rollout
//
// Admin-only edge function that sends portal-setup-invite emails to
// the next batch of eligible customers. Eligibility is computed by
// the SECURITY DEFINER RPC get_bulk_setup_invite_candidates which
// applies all exclusions (staff-email collision, shared-email pool,
// already-migrated, already-sent).
//
// Architecture:
//   - Per-candidate: call send-transactional-email via supabase.functions.invoke
//   - On success: stamp customers.setup_link_sent_at to NOW()
//   - On failure: log to errors[], leave setup_link_sent_at unchanged
//     (failed sends remain eligible for retry on next batch)
//   - No internal sleep / rate-limit; process-email-queue paces actual
//     delivery via the email queue dispatcher
//
// Driver pattern: caller (Cloud Shell while-loop or admin tool) re-invokes
// this function until remaining_eligible reaches 0.
//
// Auth: mirror manual-forfeit pattern — Bearer JWT extraction +
// user_roles.role = 'admin' check. 401 on missing/invalid JWT, 403 on
// non-admin caller.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendTemplateEmail } from "../_shared/transactional-email-templates/send-email.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PORTAL_BASE = "https://portal.chajewelsjp.com";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

interface Candidate {
  id: string;
  customer_code: string | null;
  full_name: string;
  email: string;
  total_eligible: number;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Auth check — require valid Bearer token
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Unauthorized" }, 401);
    }
    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (authError || !user) {
      return json({ error: "Unauthorized" }, 401);
    }

    // Admin role check — only admins can trigger bulk invites
    const { data: userRole } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .maybeSingle();
    if (userRole?.role !== "admin") {
      return json(
        { error: "Permission denied: bulk invites are admin-only" },
        403,
      );
    }

    // Parse + validate body
    let body: {
      dry_run?: boolean;
      test_customer_codes?: string[] | null;
      batch_size?: number;
    } = {};
    try {
      body = await req.json().catch(() => ({}));
    } catch {
      return json({ error: "Invalid JSON in request body" }, 400);
    }

    const dryRun = body.dry_run === true;
    const testCodes = Array.isArray(body.test_customer_codes) && body.test_customer_codes.length > 0
      ? body.test_customer_codes
      : null;
    const requestedBatchSize = typeof body.batch_size === "number" ? body.batch_size : 50;
    const batchSize = Math.max(1, Math.min(100, Math.floor(requestedBatchSize)));

    // Step 1: fetch candidate batch
    const { data: candidates, error: rpcError } = await supabase.rpc(
      "get_bulk_setup_invite_candidates",
      {
        p_test_codes: testCodes,
        p_limit: batchSize,
        p_count_only: false,
      },
    );

    if (rpcError) {
      console.error("[bulk-send-setup-invites] RPC failed:", rpcError);
      return json(
        { error: `Candidate fetch failed: ${rpcError.message ?? "unknown"}` },
        500,
      );
    }

    const rows = (candidates ?? []) as Candidate[];
    const totalEligibleBeforeBatch = rows.length > 0 ? Number(rows[0].total_eligible) : 0;

    // Step 2: dry-run early-return
    if (dryRun) {
      return json({
        success: true,
        dry_run: true,
        enqueued: 0,
        failed: 0,
        remaining_eligible: totalEligibleBeforeBatch,
        candidates: rows.map((r) => ({
          customer_code: r.customer_code,
          full_name: r.full_name,
          email: r.email,
        })),
        errors: [],
      });
    }

    // Step 3: per-candidate send + stamp (sequential, no internal throttle)
    let enqueued = 0;
    let failed = 0;
    const errors: { customer_code: string | null; error: string }[] = [];

    // Batch-fetch mobile_number for all candidates in one query so the
    // per-candidate loop can derive customerPin (last 4 digits) without an
    // extra round-trip per row.
    const mobileByCustomerId = new Map<string, string | null>();
    if (rows.length > 0) {
      const { data: mobileRows } = await supabase
        .from("customers")
        .select("id, mobile_number")
        .in("id", rows.map((r) => r.id));
      for (const m of (mobileRows ?? []) as { id: string; mobile_number: string | null }[]) {
        mobileByCustomerId.set(m.id, m.mobile_number);
      }
    }

    for (const c of rows) {
      const setupUrl = `${PORTAL_BASE}/portal/setup?email=${encodeURIComponent(c.email)}`;
      const digits = (mobileByCustomerId.get(c.id) ?? "").replace(/\D/g, "");
      const customerPin = digits.length >= 4 ? digits.slice(-4) : "----";

      try {
        const { data: invokeData, error: invokeError } = await supabase.functions.invoke(
          "send-transactional-email",
          {
            body: {
              template_name: "portal-setup-invite",
              recipient_email: c.email,
              templateData: {
                customerName: c.full_name,
                setupUrl,
                customerEmail: c.email,
                customerPin,
              },
            },
          },
        );

        // send-transactional-email returns { success: true, queued: true } on
        // enqueue; { success: false, reason: 'email_suppressed' } on suppression
        // (still a success status, but we treat it as a failure for tracking).
        const dispatched =
          !invokeError &&
          invokeData &&
          typeof invokeData === "object" &&
          (invokeData as { success?: boolean }).success === true;

        if (!dispatched) {
          const errMsg = invokeError?.message
            ?? (invokeData as { reason?: string; error?: string })?.reason
            ?? (invokeData as { reason?: string; error?: string })?.error
            ?? "send-transactional-email did not return success";
          errors.push({ customer_code: c.customer_code, error: errMsg });
          failed += 1;
          continue;
        }

        // Stamp setup_link_sent_at — failure here logs but doesn't abort batch
        const { error: stampError } = await supabase
          .from("customers")
          .update({ setup_link_sent_at: new Date().toISOString() })
          .eq("id", c.id);

        if (stampError) {
          console.warn(
            `[bulk-send-setup-invites] stamp failed for ${c.customer_code}:`,
            stampError,
          );
          errors.push({
            customer_code: c.customer_code,
            error: `email enqueued but tracking update failed: ${stampError.message}`,
          });
          // Still count as enqueued — the email was dispatched. The customer
          // will resurface in the next batch (since stamp failed) but the
          // suppression list / send-transactional-email idempotency won't
          // cause double-sends in normal cases. Reported in errors[].
        }

        enqueued += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[bulk-send-setup-invites] send failed for ${c.customer_code}:`,
          err,
        );
        errors.push({ customer_code: c.customer_code, error: message });
        failed += 1;
      }
    }

    // Step 4: query remaining count after this batch
    let remainingEligible = Math.max(0, totalEligibleBeforeBatch - enqueued);
    try {
      const { data: countRows, error: countError } = await supabase.rpc(
        "get_bulk_setup_invite_candidates",
        {
          p_test_codes: testCodes,
          p_limit: 0,
          p_count_only: true,
        },
      );
      if (!countError && Array.isArray(countRows) && countRows.length > 0) {
        remainingEligible = Number(
          (countRows[0] as { total_eligible: number }).total_eligible,
        );
      }
    } catch (countErr) {
      console.warn(
        "[bulk-send-setup-invites] post-batch count failed, using estimate:",
        countErr,
      );
    }

    return json({
      success: true,
      dry_run: false,
      enqueued,
      failed,
      remaining_eligible: remainingEligible,
      errors,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[bulk-send-setup-invites] unexpected error:", err);
    return json({ error: message || "internal_error" }, 500);
  }
});
