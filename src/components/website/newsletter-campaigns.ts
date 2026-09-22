import { isActive, isNotTest, type NewsletterSubscriberRow } from "@/components/website/newsletter-types";

/**
 * Shape and rules for public.newsletter_campaigns.
 *
 * Pure — no Supabase — so the recipient count, the duration estimate and the
 * layaway-error detection are testable without a database
 * (src/test/newsletter-campaigns.test.ts).
 */

export const CAMPAIGN_AUDIENCES = ["all", "en", "ja"] as const;
export type CampaignAudience = (typeof CAMPAIGN_AUDIENCES)[number];

export const AUDIENCE_LABEL: Record<CampaignAudience, string> = {
  all: "All subscribers",
  en: "English subscribers",
  ja: "Japanese subscribers",
};

export const CAMPAIGN_STATUSES = ["draft", "queued", "sending", "sent", "cancelled"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const STATUS_LABEL: Record<CampaignStatus, string> = {
  draft: "Draft", queued: "Queued", sending: "Sending", sent: "Sent", cancelled: "Cancelled",
};

/** Only a draft may be edited; only these two may be cancelled. */
export const isEditable = (s: CampaignStatus) => s === "draft";
export const isCancellable = (s: CampaignStatus) => s === "queued" || s === "sending";
/** While this is true the card polls progress. */
export const isInFlight = (s: CampaignStatus) => s === "queued" || s === "sending";

export const MAX_CAMPAIGN_PRODUCTS = 6;

/**
 * SENDING RATE — 60 per hour, and that is NOT the provider ceiling.
 *
 * docs/RETROACTIVE-AND-EMAIL.md: the Lovable workspace cap is 100 emails per
 * HOUR, hard, and the deduped reminder batch already reaches ~100/hr on peak
 * days. A newsletter that also assumed 100 would be competing with the
 * reminders for the same allowance, and the reminders are the ones a customer
 * is waiting on. 60 leaves headroom on purpose.
 *
 * The number lives here so the estimate the confirm dialog shows and the rate
 * the queue actually runs at cannot drift apart silently — if Lovable's cron
 * changes, this changes with it.
 */
export const SEND_RATE_PER_HOUR = 60;

export interface CampaignRow {
  id: string;
  subject_en: string | null;
  subject_ja: string | null;
  body_en: string | null;
  body_ja: string | null;
  audience: string | null;
  status: string | null;
  product_ids: string[] | null;
  post_slug: string | null;
  queued_at: string | null;
  sent_at: string | null;
  total: number | null;
  sent_count: number | null;
  failed_count: number | null;
  created_at: string;
}

export const CAMPAIGN_SELECT =
  "id, subject_en, subject_ja, body_en, body_ja, audience, status, product_ids, post_slug, " +
  "queued_at, sent_at, total, sent_count, failed_count, created_at";

export interface CampaignDraft {
  id?: string;
  subject_en: string;
  subject_ja: string;
  body_en: string;
  body_ja: string;
  audience: CampaignAudience;
  product_ids: string[];
  post_slug: string;
}

export const emptyCampaign = (): CampaignDraft => ({
  subject_en: "", subject_ja: "", body_en: "", body_ja: "",
  audience: "all", product_ids: [], post_slug: "",
});

const audienceOf = (v: unknown): CampaignAudience =>
  (CAMPAIGN_AUDIENCES as readonly string[]).includes(v as string) ? (v as CampaignAudience) : "all";

export const statusOf = (v: unknown): CampaignStatus =>
  (CAMPAIGN_STATUSES as readonly string[]).includes(v as string) ? (v as CampaignStatus) : "draft";

export const toDraft = (r: CampaignRow): CampaignDraft => ({
  id: r.id,
  subject_en: r.subject_en ?? "",
  subject_ja: r.subject_ja ?? "",
  body_en: r.body_en ?? "",
  body_ja: r.body_ja ?? "",
  audience: audienceOf(r.audience),
  product_ids: r.product_ids ?? [],
  post_slug: r.post_slug ?? "",
});

/** Empty text goes back as NULL — the table's CHECK reads subject_* IS NOT NULL. */
export function campaignPayload(d: CampaignDraft, userId: string | null) {
  const nullable = (v: string) => v.trim() || null;
  return {
    ...(d.id ? { id: d.id } : {}),
    subject_en: nullable(d.subject_en),
    subject_ja: nullable(d.subject_ja),
    body_en: nullable(d.body_en),
    body_ja: nullable(d.body_ja),
    audience: d.audience,
    product_ids: d.product_ids,
    post_slug: nullable(d.post_slug),
    created_by: userId,
  };
}

/**
 * Who this audience actually reaches.
 *
 * The same two rules the subscriber list uses, and for the same reasons
 * (docs/NEWSLETTER-SUBSCRIBERS.md §4): active is `unsubscribed_at IS NULL`,
 * and a test CUSTOMER's subscription is excluded while a subscriber with no
 * customer at all is KEPT — most sign-ups are from people the Hub has never
 * sold to, and they are exactly who a newsletter is for.
 *
 * A subscriber whose lang is neither 'en' nor 'ja' counts under All and under
 * neither language — it is a real address, so All must not lose it, and
 * guessing which language to send it is worse than not sending.
 */
export function recipientsFor(
  subscribers: NewsletterSubscriberRow[], audience: CampaignAudience,
): NewsletterSubscriberRow[] {
  const reachable = subscribers.filter((s) => isActive(s) && isNotTest(s));
  if (audience === "all") return reachable;
  return reachable.filter((s) => s.lang === audience);
}

export const recipientCount = (subscribers: NewsletterSubscriberRow[], audience: CampaignAudience) =>
  recipientsFor(subscribers, audience).length;

/** Whole hours this many recipients take at SEND_RATE_PER_HOUR. */
export function estimateHours(recipients: number): number {
  if (recipients <= 0) return 0;
  return Math.ceil(recipients / SEND_RATE_PER_HOUR);
}

/** The sentence the confirm dialog shows. */
export function estimateText(recipients: number): string {
  if (recipients <= 0) return "no recipients";
  const h = estimateHours(recipients);
  return `about ${h} hour${h === 1 ? "" : "s"} at ${SEND_RATE_PER_HOUR} per hour`;
}

/**
 * Did the database refuse this write with the Japanese-layaway rule?
 *
 * public.campaign_no_layaway_in_ja() raises a bare EXCEPTION, which arrives as
 * SQLSTATE P0001 — the generic "raised exception" code, shared with every
 * other RAISE in the schema. So the MESSAGE is what identifies it; the code is
 * only corroboration, and is not required, because a PostgREST error object
 * does not always carry one.
 */
export function isLayawayError(e: unknown): boolean {
  const msg = (e as { message?: string } | null)?.message ?? "";
  return /layaway is english-only/i.test(msg);
}

/** What staff see instead of the raw database exception. */
export const LAYAWAY_HINT =
  "Layaway is English-only — remove it from the Japanese version, or leave Japanese empty to send in English only.";

/** A campaign needs at least one subject; the table's CHECK says so too. */
export function validateCampaign(d: CampaignDraft): string[] {
  const errs: string[] = [];
  if (!d.subject_en.trim() && !d.subject_ja.trim()) {
    errs.push("Give the campaign a subject in at least one language.");
  }
  if (d.subject_en.trim() && !d.body_en.trim()) errs.push("The English version has a subject but no body.");
  if (d.subject_ja.trim() && !d.body_ja.trim()) errs.push("The Japanese version has a subject but no body.");
  if (d.product_ids.length > MAX_CAMPAIGN_PRODUCTS) {
    errs.push(`Pick at most ${MAX_CAMPAIGN_PRODUCTS} products.`);
  }
  return errs;
}

/** Progress as the list shows it. */
export const progressText = (r: CampaignRow) => {
  const total = r.total ?? 0;
  const sent = r.sent_count ?? 0;
  const failed = r.failed_count ?? 0;
  if (!total && !sent) return "—";
  return `${sent}/${total}${failed ? ` · ${failed} failed` : ""}`;
};
