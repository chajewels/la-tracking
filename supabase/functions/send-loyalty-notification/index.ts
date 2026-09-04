// send-loyalty-notification — Phase 4
//
// Synchronous fan-out edge function called by the loyalty admin
// Notifications tab. Inserts the master loyalty_notifications row,
// resolves the audience to a member_id list, bulk-inserts the
// recipient rows, and (optionally) fires per-recipient broadcast
// emails as a background task.
//
// Auth: caller must be admin or finance. Deployed with
// --no-verify-jwt so CORS preflight (OPTIONS without Authorization)
// reaches the function's own handler — internal supabase.auth.getUser()
// + role check below enforce the actual auth contract.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
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

const VALID_CATEGORIES = new Set([
  "info", "promo", "tier", "system", "reward", "birthday",
]);
const VALID_AUDIENCE = new Set(["all", "tier", "specific"]);
const VALID_TIERS = new Set(["Glimmer", "Radiant", "Elite", "Crown VIP"]);

interface RequestBody {
  notification_id?: string;
  title?: string;
  body?: string;
  category?: string;
  audience_type?: string;
  audience_tiers?: string[];
  audience_member_ids?: string[];
  link_target?: string | null;
  send_email?: boolean;
  scheduled_for?: string | null;
  expires_at?: string | null;
}

async function getUserRoles(supabase: any, userId: string): Promise<string[]> {
  const { data } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  return (data ?? []).map((r: any) => r.role);
}

function validate(body: RequestBody): string | null {
  if (!body.title || body.title.trim().length === 0) return "title is required";
  if (body.title.trim().length > 100) return "title must be 1-100 chars";
  if (!body.body || body.body.trim().length === 0) return "body is required";
  if (body.body.trim().length > 500) return "body must be 1-500 chars";
  if (!body.category || !VALID_CATEGORIES.has(body.category)) {
    return `category must be one of: ${[...VALID_CATEGORIES].join(", ")}`;
  }
  if (!body.audience_type || !VALID_AUDIENCE.has(body.audience_type)) {
    return `audience_type must be one of: ${[...VALID_AUDIENCE].join(", ")}`;
  }
  if (body.audience_type === "tier") {
    if (!Array.isArray(body.audience_tiers) || body.audience_tiers.length === 0) {
      return "audience_tiers required and non-empty when audience_type='tier'";
    }
    const bad = body.audience_tiers.filter((t) => !VALID_TIERS.has(t));
    if (bad.length > 0) return `unknown tier names: ${bad.join(", ")}`;
  }
  if (body.audience_type === "specific") {
    if (!Array.isArray(body.audience_member_ids) || body.audience_member_ids.length === 0) {
      return "audience_member_ids required and non-empty when audience_type='specific'";
    }
  }
  if (body.scheduled_for) {
    const t = Date.parse(body.scheduled_for);
    if (Number.isNaN(t)) return "scheduled_for must be an ISO timestamp";
  }
  if (body.expires_at) {
    const t = Date.parse(body.expires_at);
    if (Number.isNaN(t)) return "expires_at must be an ISO timestamp";
  }
  return null;
}

function resolveCtaUrl(linkTarget: string | null | undefined, portalUrl: string): string | null {
  if (!linkTarget) return null;
  const t = linkTarget.trim();
  if (t.startsWith("https://") || t.startsWith("http://")) return t;
  // tab:foo — caller must already be in the portal to navigate.
  // Send them to the per-recipient portal landing URL.
  return portalUrl;
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
  linkTarget: string | null | undefined,
) {
  // Pull member → customer (email + name + auth_user_id) in one query.
  // auth_user_id drives bare-URL routing for migrated customers via
  // getPortalLinkForCustomer below.
  const { data: members, error } = await supabase
    .from("loyalty_members")
    .select("id, customer_id, customers!inner(email, full_name, auth_user_id)")
    .in("id", memberIds);
  if (error) {
    console.warn("[send-loyalty-notification] email member fetch failed:", error.message);
    return;
  }
  const rows = (members ?? []) as MemberWithCustomer[];

  // Pull active portal tokens for all customers in one query
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
    if (tokenByCustomer.has(row.customer_id)) continue; // newest wins (ordered desc)
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

  const BATCH = 25;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
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
            console.error(`[send-loyalty-notification] app email send failed (${_emRes.status}) for ${email}: ${_t}`);
          }
        } catch (e) {
          console.warn(
            `[send-loyalty-notification] email to ${email} failed:`,
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
  // Supabase Edge Runtime exposes EdgeRuntime.waitUntil to keep the
  // invocation alive past the response. Fall back to fire-and-forget
  // if the global isn't present (local dev with deno serve).
  // deno-lint-ignore no-explicit-any
  const er = (globalThis as any).EdgeRuntime;
  if (er && typeof er.waitUntil === "function") {
    er.waitUntil(promise);
  } else {
    promise.catch((e) => {
      console.warn("[send-loyalty-notification] background task failed:", e);
    });
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const gate = createLoyaltyEmailGate(supabase);

    // Auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "auth_missing" }, 401);
    const { data: { user }, error: authErr } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (authErr || !user) return json({ error: "auth_failed" }, 401);

    const roles = await getUserRoles(supabase, user.id);
    const isAdmin = roles.includes("admin");
    const isFinance = roles.includes("finance");
    if (!(isAdmin || isFinance)) {
      return json({ error: "forbidden", detail: "admin or finance role required" }, 403);
    }

    const reqBody = (await req.json().catch(() => null)) as RequestBody | null;
    if (!reqBody) return json({ error: "invalid_body" }, 400);

    const validationErr = validate(reqBody);
    if (validationErr) return json({ error: "validation_failed", detail: validationErr }, 400);

    const now = new Date();
    const scheduledFor = reqBody.scheduled_for ? new Date(reqBody.scheduled_for) : null;
    const sendNow = !scheduledFor || scheduledFor <= now;
    const targetStatus = sendNow ? "sent" : "scheduled";

    const baseRow: Record<string, unknown> = {
      title: reqBody.title!.trim(),
      body: reqBody.body!.trim(),
      category: reqBody.category,
      audience_type: reqBody.audience_type,
      audience_tiers: reqBody.audience_type === "tier" ? reqBody.audience_tiers : null,
      audience_member_ids:
        reqBody.audience_type === "specific" ? reqBody.audience_member_ids : null,
      link_target: reqBody.link_target?.trim() || null,
      send_email: !!reqBody.send_email,
      scheduled_for: scheduledFor?.toISOString() ?? null,
      expires_at: reqBody.expires_at ?? null,
      status: targetStatus,
    };

    let notificationId = reqBody.notification_id;

    if (notificationId) {
      // Update existing draft / scheduled
      const { data: existing, error: fetchErr } = await supabase
        .from("loyalty_notifications")
        .select("id, status")
        .eq("id", notificationId)
        .maybeSingle();
      if (fetchErr) {
        return json({ error: "fetch_failed", detail: fetchErr.message }, 500);
      }
      if (!existing) return json({ error: "not_found" }, 404);
      if (!["draft", "scheduled"].includes(existing.status)) {
        return json(
          {
            error: "conflict",
            detail: `cannot update notification with status='${existing.status}'`,
          },
          409,
        );
      }

      const { error: upErr } = await supabase
        .from("loyalty_notifications")
        .update(baseRow)
        .eq("id", notificationId);
      if (upErr) {
        return json({ error: "update_failed", detail: upErr.message }, 500);
      }
    } else {
      const insertRow = { ...baseRow, created_by_user_id: user.id };
      const { data: inserted, error: insErr } = await supabase
        .from("loyalty_notifications")
        .insert(insertRow)
        .select("id")
        .single();
      if (insErr || !inserted) {
        return json(
          { error: "insert_failed", detail: insErr?.message || "no row returned" },
          500,
        );
      }
      notificationId = inserted.id;
    }

    // Future-scheduled — return without fan-out. Cron processor handles it.
    if (!sendNow) {
      await supabase.from("audit_logs").insert({
        entity_type: "loyalty_notification",
        entity_id: notificationId,
        action: "scheduled",
        performed_by_user_id: user.id,
        new_value_json: {
          title: baseRow.title,
          category: baseRow.category,
          audience_type: baseRow.audience_type,
          send_email: baseRow.send_email,
          scheduled_for: baseRow.scheduled_for,
        },
      });
      return json({
        success: true,
        notification_id: notificationId,
        status: "scheduled",
        scheduled_for: scheduledFor!.toISOString(),
      });
    }

    // Resolve audience → member_id list
    let memberIds: string[] = [];
    if (reqBody.audience_type === "all") {
      const { data, error } = await supabase
        .from("loyalty_members")
        .select("id");
      if (error) {
        return json({ error: "audience_resolve_failed", detail: error.message }, 500);
      }
      memberIds = (data ?? []).map((r: any) => r.id);
    } else if (reqBody.audience_type === "tier") {
      const { data: tierRows, error: tierErr } = await supabase
        .from("loyalty_tiers")
        .select("id, name")
        .in("name", reqBody.audience_tiers ?? []);
      if (tierErr) {
        return json({ error: "tier_resolve_failed", detail: tierErr.message }, 500);
      }
      const tierIds = (tierRows ?? []).map((r: any) => r.id);
      if (tierIds.length > 0) {
        const { data, error } = await supabase
          .from("loyalty_members")
          .select("id")
          .in("current_tier_id", tierIds);
        if (error) {
          return json({ error: "audience_resolve_failed", detail: error.message }, 500);
        }
        memberIds = (data ?? []).map((r: any) => r.id);
      }
    } else {
      memberIds = reqBody.audience_member_ids ?? [];
    }

    // Bulk insert recipients (single multi-row INSERT)
    let recipientCount = 0;
    if (memberIds.length > 0) {
      const recipientRows = memberIds.map((id) => ({
        notification_id: notificationId,
        member_id: id,
      }));
      const { error: recErr, count } = await supabase
        .from("loyalty_notification_recipients")
        .insert(recipientRows, { count: "exact" });
      if (recErr) {
        // Best-effort rollback for fresh inserts only — don't delete a
        // resend's master row since admin may have edited other fields
        // and we'd lose the change.
        if (!reqBody.notification_id) {
          await supabase
            .from("loyalty_notifications")
            .delete()
            .eq("id", notificationId);
        }
        return json({ error: "fan_out_failed", detail: recErr.message }, 500);
      }
      recipientCount = count ?? memberIds.length;
    }

    // Mark sent + clear ephemeral audience_member_ids per Q9 schema delta
    const { error: markErr } = await supabase
      .from("loyalty_notifications")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        audience_member_ids: null,
      })
      .eq("id", notificationId);
    if (markErr) {
      console.warn(
        "[send-loyalty-notification] mark sent failed (recipients already inserted):",
        markErr.message,
      );
    }

    // Email side-fire (gated by per-notification toggle + global setting)
    let emailAttempted = false;
    if (reqBody.send_email && memberIds.length > 0) {
      const allowed = await gate("loyalty_email_broadcast");
      if (allowed) {
        emailAttempted = true;
        inBackground(
          sendBroadcastEmails(
            supabase,
            notificationId!,
            memberIds,
            baseRow.title as string,
            baseRow.body as string,
            baseRow.link_target as string | null,
          ),
        );
      } else {
        console.log(
          "[email-gate] loyalty-broadcast skipped — toggle 'loyalty_email_broadcast' is OFF",
        );
      }
    }

    await supabase.from("audit_logs").insert({
      entity_type: "loyalty_notification",
      entity_id: notificationId,
      action: "sent",
      performed_by_user_id: user.id,
      new_value_json: {
        title: baseRow.title,
        category: baseRow.category,
        audience_type: baseRow.audience_type,
        send_email: baseRow.send_email,
        recipient_count: recipientCount,
        email_attempted: emailAttempted,
      },
    });

    return json({
      success: true,
      notification_id: notificationId,
      status: "sent",
      recipient_count: recipientCount,
      email_attempted: emailAttempted,
    });
  } catch (err: any) {
    console.error("[send-loyalty-notification] unexpected error:", err);
    return json({ error: err?.message || "internal_error" }, 500);
  }
});
