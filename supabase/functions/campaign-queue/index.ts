import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";
import { recordEmailAttempt } from "../_shared/email-log.ts";
import { providerStatus, sendCampaignEmail } from "../_shared/newsletter/provider.ts";
import {
  type Campaign,
  hasLang,
  type Lang,
  recipientLang,
  renderCampaign,
  unsubscribeUrl,
} from "../_shared/newsletter/render.tsx";

/**
 * Queue a newsletter campaign, or send one test copy.
 *
 * Body: { campaign_id, test_email? }
 *
 * Two jobs, deliberately in one endpoint: the test send renders through the
 * exact same code path as the real send, so "it looked right in the test" means
 * something. Nothing here sends to the list — it snapshots the recipients and
 * hands pacing to process-newsletter-campaigns.
 */

const CAMPAIGN_FIELDS =
  "id, subject_en, subject_ja, body_en, body_ja, audience, status, product_ids, post_slug";

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
    const testEmail = typeof body.test_email === "string" ? body.test_email.trim() : "";
    if (!campaignId) return jsonResponse({ error: "campaign_id is required" }, 400);

    const { data: campaign, error: cErr } = await supabase
      .from("newsletter_campaigns")
      .select(CAMPAIGN_FIELDS)
      .eq("id", campaignId)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!campaign) return jsonResponse({ error: "campaign_not_found" }, 404);
    const c = campaign as Campaign;

    const langs = (["en", "ja"] as Lang[]).filter((l) => hasLang(c, l));
    if (langs.length === 0) {
      return jsonResponse({ error: "campaign_has_no_complete_language" }, 400);
    }

    const provider = providerStatus();

    // ---------- Test send ----------
    if (testEmail) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testEmail)) {
        return jsonResponse({ error: "invalid_test_email" }, 400);
      }
      const rendered: Array<{ lang: Lang; subject: string; html: string; sent: boolean }> = [];
      for (const lang of langs) {
        // A test copy carries a real-looking unsubscribe link so the footer can
        // be eyeballed, but the token is not a subscriber's.
        const unsub = unsubscribeUrl("test-preview");
        const { subject, html } = await renderCampaign(supabase, c, lang, unsub, "[TEST] ");
        let sent = false;
        if (provider.enabled) {
          const outcome = await sendCampaignEmail({ to: testEmail, subject, html, unsubscribeUrl: unsub });
          sent = outcome.status === "sent";
          await recordEmailAttempt({
            channel: "hub",
            template: "newsletter-campaign",
            recipient: testEmail,
            status: sent ? "sent" : "failed",
            error: sent ? undefined : (outcome as { error: string }).error,
            metadata: { campaign_id: c.id, lang, test: true },
          });
          if (!sent) {
            return jsonResponse({
              error: "test_send_failed",
              message: (outcome as { error: string }).error,
              rendered,
            }, 502);
          }
        } else {
          // Sending is off: the rendered HTML is the whole point of the test.
          await recordEmailAttempt({
            channel: "hub",
            template: "newsletter-campaign",
            recipient: testEmail,
            status: "skipped",
            metadata: { campaign_id: c.id, lang, test: true, reason: provider.reason },
          });
        }
        rendered.push({ lang, subject, html, sent });
      }
      return jsonResponse({
        mode: "test",
        sent: provider.enabled,
        provider: { enabled: provider.enabled, reason: provider.reason, message: provider.message, from: provider.fromEmail },
        rendered,
      });
    }

    // ---------- Queue the list ----------
    if (c.status !== "draft") {
      return jsonResponse({ error: "campaign_not_draft", status: c.status }, 409);
    }
    if (!provider.enabled) {
      return jsonResponse({
        error: "sending_disabled",
        reason: provider.reason,
        message: provider.message,
      }, 409);
    }

    let subs = supabase
      .from("newsletter_subscribers")
      .select("id, lang")
      .is("unsubscribed_at", null);
    if (c.audience === "en" || c.audience === "ja") subs = subs.eq("lang", c.audience);
    const { data: subscribers, error: sErr } = await subs;
    if (sErr) throw sErr;

    const rows: Array<{ campaign_id: string; subscriber_id: string; lang: string; status: string }> = [];
    let pending = 0;
    let skipped = 0;
    for (const s of subscribers ?? []) {
      const lang = recipientLang(c, s.lang);
      if (lang === "skip") {
        // Recorded, not dropped: "why did this person not get it" must be
        // answerable from the recipient snapshot alone.
        rows.push({ campaign_id: c.id, subscriber_id: s.id, lang: s.lang, status: "skipped" });
        skipped++;
      } else {
        rows.push({ campaign_id: c.id, subscriber_id: s.id, lang, status: "pending" });
        pending++;
      }
    }

    if (rows.length > 0) {
      for (let i = 0; i < rows.length; i += 500) {
        const { error: iErr } = await supabase
          .from("newsletter_campaign_recipients")
          .upsert(rows.slice(i, i + 500), { onConflict: "campaign_id,subscriber_id" });
        if (iErr) throw iErr;
      }
    }

    const { error: uErr } = await supabase
      .from("newsletter_campaigns")
      .update({
        total: pending,
        status: "queued",
        queued_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", c.id)
      .eq("status", "draft");
    if (uErr) throw uErr;

    return jsonResponse({ mode: "queued", total: pending, skipped, audience: c.audience });
  } catch (e) {
    console.error("[campaign-queue] failed:", e);
    return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
