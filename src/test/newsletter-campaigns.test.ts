import { describe, expect, it } from "vitest";
import type { NewsletterSubscriberRow } from "@/components/website/newsletter-types";
import {
  SEND_RATE_PER_HOUR, campaignPayload, emptyCampaign, estimateHours, estimateText,
  isCancellable, isEditable, isLayawayError, progressText, recipientCount, statusOf,
  campaignLangFor, campaignReach, parseTestResponse,
  toDraft, validateCampaign, type CampaignRow,
} from "@/components/website/newsletter-campaigns";

/**
 * A campaign send is irreversible in the way that matters: the mail is gone.
 * The two numbers staff read before pressing Send — who it reaches and how
 * long it takes — are therefore the ones tested hardest, along with the
 * layaway refusal, which has to be recognised from a database exception
 * message rather than a code.
 */

let n = 0;
const sub = (over: Partial<NewsletterSubscriberRow> = {}): NewsletterSubscriberRow => ({
  id: `s${++n}`, email: `a${n}@b.co`, email_norm: null, lang: "en", source: null,
  customer_id: null, consented_at: null, unsubscribed_at: null, unsubscribe_token: null,
  created_at: "2026-01-01", ...over,
});

describe("recipientCount", () => {
  it("counts active subscribers of the chosen language", () => {
    const list = [sub({ lang: "en" }), sub({ lang: "en" }), sub({ lang: "ja" })];
    expect(recipientCount(list, "all")).toBe(3);
    expect(recipientCount(list, "en")).toBe(2);
    expect(recipientCount(list, "ja")).toBe(1);
  });

  it("excludes the unsubscribed — unsubscribed_at is the whole definition", () => {
    const list = [sub(), sub({ unsubscribed_at: "2026-02-01" })];
    expect(recipientCount(list, "all")).toBe(1);
  });

  it("excludes a TEST customer's subscription", () => {
    const list = [sub(), sub({ customers: { id: "c1", full_name: "T", is_test: true } })];
    expect(recipientCount(list, "all")).toBe(1);
  });

  it("KEEPS a subscriber with no customer — most sign-ups never bought anything", () => {
    expect(recipientCount([sub({ customer_id: null, customers: null })], "all")).toBe(1);
  });

  it("keeps an unknown language under All and under neither language", () => {
    const list = [sub({ lang: "fr" }), sub({ lang: null })];
    expect(recipientCount(list, "all")).toBe(2);
    expect(recipientCount(list, "en")).toBe(0);
    expect(recipientCount(list, "ja")).toBe(0);
  });
});

describe("estimateHours / estimateText", () => {
  it("is zero for nobody, and says so in words", () => {
    expect(estimateHours(0)).toBe(0);
    expect(estimateText(0)).toBe("no recipients");
  });

  it("rounds UP — a part hour is still an hour of sending", () => {
    expect(estimateHours(1)).toBe(1);
    expect(estimateHours(SEND_RATE_PER_HOUR)).toBe(1);
    expect(estimateHours(SEND_RATE_PER_HOUR + 1)).toBe(2);
  });

  it("never under-promises: rate × estimate always covers the list", () => {
    for (const n of [1, 59, 60, 61, 199, 1000, 3001]) {
      expect(estimateHours(n) * SEND_RATE_PER_HOUR, String(n)).toBeGreaterThanOrEqual(n);
    }
  });

  it("says hour singular once and hours after that", () => {
    expect(estimateText(60)).toBe("about 1 hour at 60 per hour");
    expect(estimateText(61)).toBe("about 2 hours at 60 per hour");
  });

  it("stays below the 100/hour workspace cap the reminders already use", () => {
    // docs/RETROACTIVE-AND-EMAIL.md: hard cap 100/hr, reminders reach ~100/hr
    // on peak days. A newsletter at the cap would compete with them.
    expect(SEND_RATE_PER_HOUR).toBeLessThan(100);
  });
});

describe("isLayawayError", () => {
  // campaign_no_layaway_in_ja() RAISEs without an ERRCODE, so it arrives as
  // P0001 — the code every other RAISE in the schema shares. The message is
  // what identifies it.
  it("recognises the trigger's message", () => {
    expect(isLayawayError({
      message: "Layaway is English-only: remove it from the Japanese version or send this campaign in English only",
    })).toBe(true);
  });

  it("recognises it whatever the casing, and without a code", () => {
    expect(isLayawayError({ message: "layaway is english-only: ..." })).toBe(true);
  });

  it("does not claim an unrelated failure", () => {
    expect(isLayawayError({ message: 'duplicate key value violates unique constraint' })).toBe(false);
    expect(isLayawayError({ message: "the word layaway appears here" })).toBe(false);
    expect(isLayawayError(null)).toBe(false);
    expect(isLayawayError(undefined)).toBe(false);
  });
});

describe("status rules", () => {
  it("lets only a draft be edited", () => {
    expect(isEditable("draft")).toBe(true);
    for (const s of ["queued", "sending", "sent", "cancelled"] as const) {
      expect(isEditable(s), s).toBe(false);
    }
  });

  it("lets only an in-flight campaign be cancelled", () => {
    expect(isCancellable("queued")).toBe(true);
    expect(isCancellable("sending")).toBe(true);
    for (const s of ["draft", "sent", "cancelled"] as const) {
      expect(isCancellable(s), s).toBe(false);
    }
  });

  it("reads an unknown status as draft rather than rendering blank", () => {
    expect(statusOf("banana")).toBe("draft");
    expect(statusOf(null)).toBe("draft");
  });
});

describe("validateCampaign", () => {
  it("needs a subject in at least one language, matching the table CHECK", () => {
    expect(validateCampaign(emptyCampaign())).toEqual([
      "Give the campaign a subject in at least one language.",
    ]);
  });

  it("refuses a language with a subject but no body", () => {
    const d = { ...emptyCampaign(), subject_ja: "件名" };
    expect(validateCampaign(d).some(e => e.includes("Japanese"))).toBe(true);
  });

  it("accepts one language only — English subject and body, no Japanese", () => {
    expect(validateCampaign({ ...emptyCampaign(), subject_en: "Hi", body_en: "Body" })).toEqual([]);
  });

  it("caps the products at six", () => {
    const d = { ...emptyCampaign(), subject_en: "S", body_en: "B", product_ids: Array(7).fill("p") };
    expect(validateCampaign(d).some(e => e.includes("at most 6"))).toBe(true);
  });
});

describe("payload and draft", () => {
  it("sends empty text as null so the subject CHECK sees it", () => {
    const p = campaignPayload({ ...emptyCampaign(), subject_en: " Hi ", body_en: "B" }, "u1");
    expect(p.subject_en).toBe("Hi");
    expect(p.subject_ja).toBeNull();
    expect(p.body_ja).toBeNull();
    expect(p.post_slug).toBeNull();
    expect(p.created_by).toBe("u1");
    expect("id" in p).toBe(false);
  });

  it("reads a row with null arrays and text back without going uncontrolled", () => {
    const row: CampaignRow = {
      id: "c1", subject_en: null, subject_ja: "件名", body_en: null, body_ja: null,
      audience: null, status: null, product_ids: null, post_slug: null,
      queued_at: null, sent_at: null, total: null, sent_count: null, failed_count: null,
      created_at: "2026-01-01",
    };
    const d = toDraft(row);
    expect(d.product_ids).toEqual([]);
    expect(d.audience).toBe("all");
    expect(typeof d.body_en).toBe("string");
  });
});

describe("progressText", () => {
  const row = (over: Partial<CampaignRow>): CampaignRow => ({
    id: "c", subject_en: "s", subject_ja: null, body_en: "b", body_ja: null,
    audience: "all", status: "sending", product_ids: [], post_slug: null,
    queued_at: null, sent_at: null, total: 0, sent_count: 0, failed_count: 0,
    created_at: "2026-01-01", ...over,
  });

  it("shows sent over total, and failures only when there are some", () => {
    expect(progressText(row({ total: 100, sent_count: 40 }))).toBe("40/100");
    expect(progressText(row({ total: 100, sent_count: 40, failed_count: 3 }))).toBe("40/100 · 3 failed");
  });

  it("shows a dash before anything has been queued", () => {
    expect(progressText(row({}))).toBe("—");
  });
});

/**
 * Lovable scan 2026-09-29: the confirm dialog must show what campaign-queue
 * will queue. campaignLangFor is a copy of the server's recipientLang
 * (supabase/functions/_shared/newsletter/render.tsx); these cases pin it.
 */
const en = { subject_en: "New arrivals", body_en: "Rings", subject_ja: null, body_ja: null };
const both = { subject_en: "New", body_en: "Rings", subject_ja: "新作", body_ja: "指輪" };
const jaOnly = { subject_en: null, body_en: null, subject_ja: "新作", body_ja: "指輪" };
const enLayaway = { subject_en: "Layaway offer", body_en: "Pay in 3 months", subject_ja: "", body_ja: "" };

describe("campaignLangFor (mirror of the server rule)", () => {
  it("sends each subscriber her own language when the campaign has it", () => {
    expect(campaignLangFor(both, "en")).toBe("en");
    expect(campaignLangFor(both, "ja")).toBe("ja");
  });
  it("falls back to the other language", () => {
    expect(campaignLangFor(en, "ja")).toBe("en");
    expect(campaignLangFor(jaOnly, "en")).toBe("ja");
  });
  it("never sends a Japanese subscriber an English-only layaway campaign", () => {
    expect(campaignLangFor(enLayaway, "ja")).toBe("skip");
    expect(campaignLangFor(enLayaway, "en")).toBe("en");
  });
  it("treats blank text as missing and any other lang as English", () => {
    expect(campaignLangFor({ subject_en: " ", body_en: "x", subject_ja: null, body_ja: null }, "en")).toBe("skip");
    expect(campaignLangFor(en, "fr")).toBe("en");
  });
});

describe("campaignReach", () => {
  it("counts what will be queued and what is skipped for language", () => {
    const list = [sub({ lang: "en" }), sub({ lang: "ja" }), sub({ lang: "ja" })];
    expect(campaignReach(list, "all", enLayaway)).toEqual({ send: 1, skipped: 2 });
    expect(campaignReach(list, "all", both)).toEqual({ send: 3, skipped: 0 });
  });
  it("still excludes test customers and the unsubscribed", () => {
    const list = [sub(), sub({ unsubscribed_at: "2026-02-01" }),
      sub({ customers: { id: "c1", full_name: "T", is_test: true } })];
    expect(campaignReach(list, "all", en)).toEqual({ send: 1, skipped: 0 });
  });
});

describe("parseTestResponse (campaign-queue test mode)", () => {
  it("reads the per-language rendered list — there is no top-level html", () => {
    const r = parseTestResponse({
      mode: "test", sent: true, provider: { enabled: true, reason: "ok", message: "ok" },
      rendered: [{ lang: "en", subject: "S", html: "<p>x</p>", sent: true }],
    });
    expect(r.rendered).toHaveLength(1);
    expect(r.sent).toBe(true);
  });
  it("reports not sent, with the sender's own sentence, while sending is off", () => {
    const r = parseTestResponse({
      mode: "test", sent: false,
      provider: { enabled: false, reason: "missing_api_key", message: "Add the API key." },
      rendered: [{ lang: "en", subject: "S", html: "<p>x</p>", sent: false }],
    });
    expect(r.sent).toBe(false);
    expect(r.reason).toBe("Add the API key.");
    expect(r.rendered[0].html).toBe("<p>x</p>");
  });
  it("tolerates an empty or odd body", () => {
    expect(parseTestResponse(null)).toEqual({ rendered: [], sent: false, reason: null });
    expect(parseTestResponse({ html: "<p>old shape</p>" }).rendered).toEqual([]);
  });
});
