import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";

/**
 * Cancel a newsletter campaign mid-flight.
 *
 * Body: { campaign_id }. Only queued / sending campaigns can be cancelled;
 * already-sent recipients stay 'sent' (the mail is out, pretending otherwise
 * would be a lie), and every still-pending recipient becomes 'skipped' so the
 * worker never picks them up again.
 */

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const ctx = await requireAuth(req);
  if (ctx instanceof Response) return ctx;
  const denied = await requirePermission(ctx, "manage_website_content");
  if (denied) return denied;
  const supabase = ctx.supabase;

  try {
    const body = await req.json().catch(() => ({}));
    const campaignId = typeof body.campaign_id === "string" ? body.campaign_id : "";
    if (!campaignId) return jsonResponse({ error: "campaign_id is required" }, 400);

    const { data: campaign, error: cErr } = await supabase
      .from("newsletter_campaigns")
      .select("id, status")
      .eq("id", campaignId)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!campaign) return jsonResponse({ error: "campaign_not_found" }, 404);
    if (campaign.status !== "queued" && campaign.status !== "sending") {
      return jsonResponse({ error: "campaign_not_cancellable", status: campaign.status }, 409);
    }

    const { data: skippedRows, error: rErr } = await supabase
      .from("newsletter_campaign_recipients")
      .update({ status: "skipped", error: "campaign cancelled" })
      .eq("campaign_id", campaignId)
      .eq("status", "pending")
      .select("subscriber_id");
    if (rErr) throw rErr;

    const { error: uErr } = await supabase
      .from("newsletter_campaigns")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", campaignId)
      .in("status", ["queued", "sending"]);
    if (uErr) throw uErr;

    return jsonResponse({ cancelled: true, skipped: skippedRows?.length ?? 0 });
  } catch (e) {
    console.error("[campaign-cancel] failed:", e);
    return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
