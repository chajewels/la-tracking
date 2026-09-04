// process-loyalty-notification-queue — Phase 4
//
// Cron-driven queue processor. Runs hourly via pg_cron and picks up
// loyalty_notifications rows whose scheduled_for has passed, then runs
// the same fan-out logic as send-loyalty-notification.
//
// Auth: service_role JWT only. The cron schedule (set up in C1) must
// be configured to send the service_role JWT in the Authorization
// header — anon will be rejected.
//
// Idempotency: each candidate is locked with a check-and-update
// (status='scheduled' → 'sending') before fan-out, so concurrent ticks
// or retries don't double-send.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isServiceRole } from "../_shared/jwt-claims.ts";
import { createLoyaltyEmailGate } from "../_shared/loyalty-email-gate.ts";
import { getPortalLinkForCustomer } from "../_shared/portal-link.ts";
import { postAppEmail } from "../_shared/send-app-email.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const BATCH_LIMIT = 100;
const EMAIL_BATCH = 25;

interface NotificationRow {
  id: string;
  title: string;
  body: string;
  category: string;
  audience_type: "all" | "tier" | "specific";
  audience_tiers: string[] | null;
  audience_member_ids: string[] | null;
  link_target: string | null;
  send_email: boolean;
  scheduled_for: string;
  status: string;
}

function resolveCtaUrl(linkTarget: string | null | undefined, portalUrl: string): string | null {
  if (!linkTarget) return null;
  const t = linkTarget.trim();
  if (t.startsWith("https://") || t.startsWith("http://")) return t;
  return portalUrl;
}

async function resolveAudienceMemberIds(
  supabase: any,
  notif: NotificationRow,
): Promise<string[]> {
  if (notif.audience_type === "all") {
    const { data, error } = await supabase
      .from("loyalty_members")
      .select("id");
    if (error) throw new Error(`audience_resolve_failed: ${error.message}`);
    return (data ?? []).map((r: any) => r.id);
  }
  if (notif.audience_type === "tier") {
    const tiers = notif.audience_tiers ?? [];
    if (tiers.length === 0) return [];
    const { data: tierRows, error: tierErr } = await supabase
      .from("loyalty_tiers")
      .select("id")
      .in("name", tiers);
    if (tierErr) throw new Error(`tier_resolve_failed: ${tierErr.message}`);
    const tierIds = (tierRows ?? []).map((r: any) => r.id);
    if (tierIds.length === 0) return [];
    const { data, error } = await supabase
      .from("loyalty_members")
      .select("id")
      .in("current_tier_id", tierIds);
    if (error) throw new Error(`audience_resolve_failed: ${error.message}`);
    return (data ?? []).map((r: any) => r.id);
  }
  // 'specific'
  return notif.audience_member_ids ?? [];
}

interface MemberWithCustomer {
  id: string;
  customer_id: string;
  customers: {
    email: string | null;
    full_name: string | null;
    auth_user_id: string | null;
  } | null;
}

async function sendBroadcastEmails(
  supabase: any,
  notificationId: string,
  memberIds: string[],
  title: string,
  bodyText: string,
  linkTarget: string | null,
) {
  const { data: members, error } = await supabase
    .from("loyalty_members")
    .select("id, customer_id, customers!inner(email, full_name, auth_user_id)")
    .in("id", memberIds);
  if (error) {
    console.warn(
      `[queue] email member fetch failed for ${notificationId}:`,
      error.message,
    );
    return;
  }
  const rows = (members ?? []) as MemberWithCustomer[];

  const customerIds = rows.map((r) => r.customer_id);
  const { data: tokens } = await supabase
    .from("customer_portal_tokens")
    .select("customer_id, token, expires_at, created_at")
    .in("customer_id", customerIds)
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  const tokenByCustomer = new Map<string, string>();
  for (const row of (tokens ?? []) as Array<{
    customer_id: string;
    token: string;
    expires_at: string | null;
  }>) {
    if (tokenByCustomer.has(row.customer_id)) continue;
    if (row.expires_at && new Date(row.expires_at) < new Date()) continue;
    tokenByCustomer.set(row.customer_id, row.token);
  }
  // Build parallel auth_user_id map from already-fetched rows
  // (no extra DB round-trip).
  const authByCustomer = new Map<string, string | null>();
  for (const r of rows) {
    authByCustomer.set(r.customer_id, r.customers?.auth_user_id ?? null);
  }

  // Synchronous URL builder — uses the pure helper to route
  // migrated customers to bare /loyalty URL and non-migrated
  // customers to token-bearing /loyalty?token=... or /portal
  // fallback. Preserves the bulk-Map performance pattern.
  const portalUrlFor = (customerId: string): string => {
    const auth_user_id = authByCustomer.get(customerId) ?? null;
    const portal_token = tokenByCustomer.get(customerId) ?? null;
    return getPortalLinkForCustomer({ auth_user_id, portal_token }, 'loyalty');
  };

  const emailEndpoint = `${Deno.env.get("SUPABASE_URL")}/functions/v1/send-transactional-email`;
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
  };

  for (let i = 0; i < rows.length; i += EMAIL_BATCH) {
    const batch = rows.slice(i, i + EMAIL_BATCH);
    await Promise.allSettled(
      batch.map(async (m) => {
        const email = m.customers?.email;
        if (!email) return;
        const firstName =
          (m.customers?.full_name || "Valued Member").split(" ")[0] || "Valued Member";
        const portalUrl = portalUrlFor(m.customer_id);
        const ctaUrl = resolveCtaUrl(linkTarget, portalUrl);
        try {
          const _emRes = await postAppEmail({
              templateName: "loyalty-broadcast",
              recipientEmail: email,
              idempotencyKey: `loyalty-broadcast-${notificationId}-${m.id}`,
              templateData: {
                memberFirstName: firstName,
                notificationTitle: title,
                notificationBody: bodyText,
                ctaUrl,
              },
            });
          if (!_emRes.ok) {
            const _t = await _emRes.text().catch(() => "<no body>");
            console.error(`[process-loyalty-notification-queue] app email send failed (${_emRes.status}) for ${email}: ${_t}`);
          }
        } catch (e) {
          console.warn(
            `[queue] email to ${email} failed (${notificationId}):`,
            e,
          );
        }
      }),
    );
  }

  await supabase
    .from("loyalty_notifications")
    .update({ email_sent: true })
    .eq("id", notificationId);
}

function inBackground(promise: Promise<unknown>) {
  // deno-lint-ignore no-explicit-any
  const er = (globalThis as any).EdgeRuntime;
  if (er && typeof er.waitUntil === "function") {
    er.waitUntil(promise);
  } else {
    promise.catch((e) => {
      console.warn("[queue] background task failed:", e);
    });
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const authToken = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
  if (!isServiceRole(authToken)) {
    return json({ error: "forbidden", detail: "service_role JWT required" }, 403);
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const gate = createLoyaltyEmailGate(supabase);
    const nowIso = new Date().toISOString();

    // 1. Fetch candidates — scheduled and overdue
    const { data: candidates, error: candErr } = await supabase
      .from("loyalty_notifications")
      .select(
        "id, title, body, category, audience_type, audience_tiers, audience_member_ids, link_target, send_email, scheduled_for, status",
      )
      .eq("status", "scheduled")
      .lte("scheduled_for", nowIso)
      .order("scheduled_for", { ascending: true })
      .limit(BATCH_LIMIT);

    if (candErr) {
      console.error("[queue] candidate fetch failed:", candErr.message);
      return json({ error: "fetch_failed", detail: candErr.message }, 500);
    }

    const candidateRows = (candidates ?? []) as NotificationRow[];
    console.log(`[queue] tick: ${candidateRows.length} candidate(s)`);

    if (candidateRows.length === 0) {
      return json({
        success: true,
        candidates: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
      });
    }

    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    for (const notif of candidateRows) {
      try {
        // 2a. Atomic lock: scheduled → sending
        const { data: locked, error: lockErr } = await supabase
          .from("loyalty_notifications")
          .update({ status: "sending" })
          .eq("id", notif.id)
          .eq("status", "scheduled")
          .select("id")
          .maybeSingle();

        if (lockErr) {
          throw new Error(`lock_failed: ${lockErr.message}`);
        }
        if (!locked) {
          // Already picked up by another tick or cancelled out from under us
          skipped++;
          console.log(`[queue] skip ${notif.id} — no longer scheduled`);
          continue;
        }

        // 2b. Resolve audience
        const memberIds = await resolveAudienceMemberIds(supabase, notif);

        // 2c. Bulk insert recipients
        let recipientCount = 0;
        if (memberIds.length > 0) {
          const recipientRows = memberIds.map((id) => ({
            notification_id: notif.id,
            member_id: id,
          }));
          const { error: recErr, count } = await supabase
            .from("loyalty_notification_recipients")
            .insert(recipientRows, { count: "exact" });
          if (recErr) throw new Error(`fan_out_failed: ${recErr.message}`);
          recipientCount = count ?? memberIds.length;
        }

        // 2d. Mark sent + clear ephemeral audience_member_ids
        const sentAt = new Date().toISOString();
        const { error: markErr } = await supabase
          .from("loyalty_notifications")
          .update({
            status: "sent",
            sent_at: sentAt,
            audience_member_ids: null,
          })
          .eq("id", notif.id);
        if (markErr) {
          console.warn(
            `[queue] mark sent failed for ${notif.id} (recipients already inserted):`,
            markErr.message,
          );
        }

        // 2e. Email side-fire (background, gated)
        let emailAttempted = false;
        if (notif.send_email && memberIds.length > 0) {
          const allowed = await gate("loyalty_email_broadcast");
          if (allowed) {
            emailAttempted = true;
            inBackground(
              sendBroadcastEmails(
                supabase,
                notif.id,
                memberIds,
                notif.title,
                notif.body,
                notif.link_target,
              ),
            );
          } else {
            console.log(
              `[email-gate] loyalty-broadcast skipped for ${notif.id} — toggle 'loyalty_email_broadcast' is OFF`,
            );
          }
        }

        // 2f. Audit log — success path
        await supabase.from("audit_logs").insert({
          entity_type: "loyalty_notification",
          entity_id: notif.id,
          action: "queue_sent",
          performed_by_user_id: null,
          new_value_json: {
            title: notif.title,
            category: notif.category,
            audience_type: notif.audience_type,
            send_email: notif.send_email,
            recipient_count: recipientCount,
            email_attempted: emailAttempted,
            scheduled_for: notif.scheduled_for,
            sent_at: sentAt,
          },
        });

        succeeded++;
        console.log(
          `[queue] sent ${notif.id} — ${recipientCount} recipient(s)${
            emailAttempted ? ", email queued" : ""
          }`,
        );
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : "unknown";
        console.error(`[queue] failed ${notif.id}:`, msg);

        // Mark as terminal-failed so admin can investigate; cron won't retry it.
        await supabase
          .from("loyalty_notifications")
          .update({ status: "failed" })
          .eq("id", notif.id);

        await supabase.from("audit_logs").insert({
          entity_type: "loyalty_notification",
          entity_id: notif.id,
          action: "queue_failed",
          performed_by_user_id: null,
          new_value_json: {
            title: notif.title,
            scheduled_for: notif.scheduled_for,
            error: msg,
          },
        });
      }
    }

    console.log(
      `[queue] done: ${candidateRows.length} candidates, ${succeeded} succeeded, ${failed} failed, ${skipped} skipped`,
    );

    return json({
      success: true,
      candidates: candidateRows.length,
      succeeded,
      failed,
      skipped,
    });
  } catch (err: any) {
    console.error("[queue] unexpected error:", err);
    return json({ error: err?.message || "internal_error" }, 500);
  }
});
