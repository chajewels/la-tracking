import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";
import { recordEmailAttempt } from "../_shared/email-log.ts";
import {
  getRatePerHour,
  providerStatus,
  RUNS_PER_HOUR,
  sendCampaignEmail,
} from "../_shared/newsletter/provider.ts";
import {
  type Campaign,
  type Lang,
  renderCampaign,
  unsubscribeUrl,
} from "../_shared/newsletter/render.tsx";

/**
 * Newsletter campaign worker. Cron: every 10 minutes.
 *
 * Paces the send: each run takes a sixth of the configured hourly allowance
 * (system_settings.newsletter_rate_per_hour, default 60), oldest queued
 * campaign first, 5 concurrent. Unlike transactional mail this budget is the
 * campaign provider's own — raising it does not eat into payment or loyalty
 * email.
 */

const CONCURRENCY = 5;
const CAMPAIGN_FIELDS =
  "id, subject_en, subject_ja, body_en, body_ja, audience, status, product_ids, post_slug, sent_count, failed_count, queued_at";

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;

  const ctx = await requireAuth(req, { allowServiceRole: true });
  if (ctx instanceof Response) return ctx;
  if (!ctx.isService) {
    const denied = await requirePermission(ctx, "manage_website_content");
    if (denied) return denied;
  }
  const supabase = ctx.supabase;

  try {
    const provider = providerStatus();
    if (!provider.enabled) {
      // Not an error: this is the documented pre-go-live state. Recipients stay
      // pending, so nothing is lost when sending is switched on.
      return jsonResponse({ skipped: true, reason: provider.reason, message: provider.message });
    }

    const rate = await getRatePerHour(supabase);
    const budget = Math.max(1, Math.floor(rate / RUNS_PER_HOUR));

    const { data: campaigns, error: cErr } = await supabase
      .from("newsletter_campaigns")
      .select(CAMPAIGN_FIELDS)
      .in("status", ["queued", "sending"])
      .order("queued_at", { ascending: true, nullsFirst: true })
      .limit(5);
    if (cErr) throw cErr;
    if (!campaigns || campaigns.length === 0) {
      return jsonResponse({ processed: 0, note: "no queued campaigns" });
    }

    let remaining = budget;
    let sentTotal = 0;
    let failedTotal = 0;
    let skippedTotal = 0;
    let rateLimited = false;

    for (const campaignRow of campaigns) {
      if (remaining <= 0 || rateLimited) break;
      const c = campaignRow as Campaign;

      const { data: pendingRows, error: rErr } = await supabase
        .from("newsletter_campaign_recipients")
        .select("subscriber_id, lang, newsletter_subscribers(email, unsubscribe_token, unsubscribed_at)")
        .eq("campaign_id", c.id)
        .eq("status", "pending")
        .limit(remaining);
      if (rErr) throw rErr;

      if (!pendingRows || pendingRows.length === 0) {
        await supabase
          .from("newsletter_campaigns")
          .update({ status: "sent", sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq("id", c.id)
          .in("status", ["queued", "sending"]);
        continue;
      }

      // Render once per language, not once per recipient: the body is identical
      // and only the unsubscribe link differs.
      const renderedByLang = new Map<Lang, { subject: string; html: string }>();
      const renderFor = async (lang: Lang) => {
        const hit = renderedByLang.get(lang);
        if (hit) return hit;
        const made = await renderCampaign(supabase, c, lang, unsubscribeUrl("PLACEHOLDER"));
        renderedByLang.set(lang, made);
        return made;
      };

      let campaignSent = 0;
      let campaignFailed = 0;

      for (let i = 0; i < pendingRows.length && !rateLimited; i += CONCURRENCY) {
        const slice = pendingRows.slice(i, i + CONCURRENCY);
        const outcomes = await Promise.all(slice.map(async (row: Record<string, unknown>) => {
          const sub = row.newsletter_subscribers as
            | { email: string; unsubscribe_token: string; unsubscribed_at: string | null }
            | null;
          const lang: Lang = row.lang === "ja" ? "ja" : "en";
          const subscriberId = row.subscriber_id as string;

          if (!sub || !sub.email) {
            return { subscriberId, kind: "skipped" as const, error: "no email on subscriber" };
          }
          // Re-checked at send time: someone who unsubscribed after the snapshot
          // must not receive the campaign they just opted out of.
          if (sub.unsubscribed_at) {
            await recordEmailAttempt({
              channel: "hub",
              template: "newsletter-campaign",
              recipient: sub.email,
              status: "skipped",
              metadata: { campaign_id: c.id, lang, reason: "unsubscribed_mid_campaign" },
            });
            return { subscriberId, kind: "skipped" as const, error: "unsubscribed before send" };
          }

          const base = await renderFor(lang);
          const unsub = unsubscribeUrl(sub.unsubscribe_token);
          const html = base.html.replaceAll(unsubscribeUrl("PLACEHOLDER"), unsub);

          const outcome = await sendCampaignEmail({
            to: sub.email,
            subject: base.subject,
            html,
            unsubscribeUrl: unsub,
          });

          if (outcome.status === "sent") {
            await recordEmailAttempt({
              channel: "hub",
              template: "newsletter-campaign",
              recipient: sub.email,
              status: "sent",
              metadata: { campaign_id: c.id, lang, provider_id: outcome.providerId },
            });
            return { subscriberId, kind: "sent" as const };
          }
          if (outcome.status === "rate_limited") {
            await recordEmailAttempt({
              channel: "hub",
              template: "newsletter-campaign",
              recipient: sub.email,
              status: "skipped",
              metadata: { campaign_id: c.id, lang, reason: "provider_rate_limited" },
            });
            return { subscriberId, kind: "rate_limited" as const, error: outcome.error };
          }
          await recordEmailAttempt({
            channel: "hub",
            template: "newsletter-campaign",
            recipient: sub.email,
            status: "failed",
            error: outcome.error,
            metadata: { campaign_id: c.id, lang },
          });
          return { subscriberId, kind: "failed" as const, error: outcome.error };
        }));

        for (const o of outcomes) {
          if (o.kind === "rate_limited") {
            // Stop the whole run and leave this recipient pending — it goes out
            // on the next tick rather than counting as a failure.
            rateLimited = true;
            continue;
          }
          const patch: Record<string, unknown> = { status: o.kind === "sent" ? "sent" : o.kind };
          if (o.kind === "sent") patch.sent_at = new Date().toISOString();
          if ("error" in o && o.error) patch.error = String(o.error).slice(0, 1000);
          await supabase
            .from("newsletter_campaign_recipients")
            .update(patch)
            .eq("campaign_id", c.id)
            .eq("subscriber_id", o.subscriberId);
          if (o.kind === "sent") { campaignSent++; sentTotal++; remaining--; }
          if (o.kind === "failed") { campaignFailed++; failedTotal++; remaining--; }
          if (o.kind === "skipped") skippedTotal++;
        }
      }

      const { data: still } = await supabase
        .from("newsletter_campaign_recipients")
        .select("subscriber_id")
        .eq("campaign_id", c.id)
        .eq("status", "pending")
        .limit(1);
      const done = !still || still.length === 0;

      const patch: Record<string, unknown> = {
        sent_count: (Number((campaignRow as { sent_count?: number }).sent_count) || 0) + campaignSent,
        failed_count: (Number((campaignRow as { failed_count?: number }).failed_count) || 0) + campaignFailed,
        updated_at: new Date().toISOString(),
      };
      if (done && !rateLimited) {
        patch.status = "sent";
        patch.sent_at = new Date().toISOString();
      } else if (campaignSent > 0) {
        patch.status = "sending";
      }
      await supabase
        .from("newsletter_campaigns")
        .update(patch)
        .eq("id", c.id)
        .in("status", ["queued", "sending"]);
    }

    return jsonResponse({
      budget,
      rate_per_hour: rate,
      sent: sentTotal,
      failed: failedTotal,
      skipped: skippedTotal,
      rate_limited: rateLimited,
    });
  } catch (e) {
    console.error("[process-newsletter-campaigns] failed:", e);
    return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
