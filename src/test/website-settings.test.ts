import { describe, expect, it } from "vitest";
import {
  EMPTY_DRAFT, SETTING_KEYS, SETTING_KIND, type SettingsDraft,
  announcementExpired, isEmail, isSettingHref, parseSetting, serializeSetting, validateSection,
} from "@/components/website/website-settings";

/**
 * The Settings tab reads and writes jsonb. Both directions are pure functions,
 * and both are exactly where a silent bug lives: a value that parses wrong
 * shows the site's copy as blank, and a value that serializes wrong writes
 * blank copy to the site.
 *
 * SEED is the live seed from
 * supabase/migrations/20260921150000_record_website_settings.sql, verbatim, so
 * these tests fail if the shipped copy and the parser ever disagree.
 */
const SEED: Record<string, unknown> = {
  "social.follow": [
    { key: "email", href: "mailto:sales@chajewelsjp.com" },
    { key: "facebook", href: "https://www.facebook.com/chajewelsjapan" },
    { key: "messenger", href: "https://m.me/chajewelsjapan" },
  ],
  "social.loyalty_groups": [
    { key: "whatsapp", href: "https://chat.whatsapp.com/ENdMNvF8N3jB3iG963f6EF" },
    { key: "line", href: "https://line.me/ti/g/5fb8KyBCCJ" },
    { key: "messenger", href: "https://m.me/ch/AbYF1EaEkypQc5Jk/?send_source=cm:copy_invite_link" },
  ],
  "contact.email": "sales@chajewelsjp.com",
  "footer.tagline": {
    en: "Fine gold, pearl and diamond jewelry. Made in Japan.",
    ja: "上質なゴールド・パール・ダイヤモンドジュエリー。日本製。",
  },
  "announcement.active": false,
  "announcement.text": { en: "", ja: "" },
  "announcement.href": "",
  "announcement.until": null,
};

const draftFromSeed = (): SettingsDraft => {
  const out = { ...EMPTY_DRAFT };
  for (const k of SETTING_KEYS) (out[k] as unknown) = parseSetting(k, SEED[k]);
  return out;
};

describe("the live seed", () => {
  it("parses every key without losing anything", () => {
    const d = draftFromSeed();
    expect(d["contact.email"]).toBe("sales@chajewelsjp.com");
    expect(d["social.follow"].map(r => r.key)).toEqual(["email", "facebook", "messenger"]);
    expect(d["social.loyalty_groups"].map(r => r.key)).toEqual(["whatsapp", "line", "messenger"]);
    expect(d["footer.tagline"].ja).toContain("日本製");
    expect(d["announcement.active"]).toBe(false);
    expect(d["announcement.until"]).toBe("");
  });

  it("round-trips: parse then serialize returns the seed, bar the null date", () => {
    const d = draftFromSeed();
    for (const k of SETTING_KEYS) {
      const out = serializeSetting(k, d[k]);
      if (k === "announcement.until") continue; // covered below
      expect(out, k).toEqual(SEED[k]);
    }
  });

  it("declares a kind the table's CHECK allows for every key", () => {
    const allowed = ["text", "bilingual", "json", "bool", "date"];
    for (const k of SETTING_KEYS) expect(allowed, k).toContain(SETTING_KIND[k]);
  });
});

describe("serializeSetting", () => {
  // `value` is jsonb NOT NULL and PostgREST turns a JSON null into SQL NULL,
  // which would fail that constraint. Nothing may serialize to null.
  it("never returns null, for any key, on an empty draft", () => {
    for (const k of SETTING_KEYS) expect(serializeSetting(k, EMPTY_DRAFT[k]), k).not.toBeNull();
  });

  it("writes an unset end date as \"\", and reads the seeded null back as \"\"", () => {
    expect(serializeSetting("announcement.until", "")).toBe("");
    expect(parseSetting("announcement.until", null)).toBe("");
    expect(parseSetting("announcement.until", "")).toBe("");
  });

  it("trims text before storing it", () => {
    expect(serializeSetting("contact.email", "  a@b.co  ")).toBe("a@b.co");
  });
});

describe("parseSetting is tolerant", () => {
  it("reads a missing key as its default rather than throwing", () => {
    expect(parseSetting("footer.tagline", undefined)).toEqual({ en: "", ja: "" });
    expect(parseSetting("social.follow", undefined)).toEqual([]);
    expect(parseSetting("announcement.active", undefined)).toBe(false);
  });

  it("drops a social row whose channel is not one the storefront renders", () => {
    const rows = parseSetting("social.follow", [
      { key: "facebook", href: "https://x.test" },
      { key: "myspace", href: "https://y.test" },
    ]);
    expect(rows.map(r => r.key)).toEqual(["facebook"]);
  });

  it("reads a value of the wrong shape as the default instead of crashing", () => {
    expect(parseSetting("social.follow", "not a list")).toEqual([]);
    expect(parseSetting("footer.tagline", 42)).toEqual({ en: "", ja: "" });
  });
});

describe("validation", () => {
  it("accepts mailto: and https:, refuses http: and bare text", () => {
    expect(isSettingHref("mailto:a@b.co")).toBe(true);
    expect(isSettingHref("https://example.test/x")).toBe(true);
    expect(isSettingHref("http://example.test")).toBe(false);
    expect(isSettingHref("example.test")).toBe(false);
    expect(isSettingHref("")).toBe(false);
  });

  it("checks the contact email", () => {
    expect(isEmail("sales@chajewelsjp.com")).toBe(true);
    expect(isEmail("sales@")).toBe(false);
  });

  it("passes the seed on every section", () => {
    const d = draftFromSeed();
    for (const id of ["contact", "social", "footer", "announcement"] as const) {
      expect(validateSection(id, d), id).toEqual([]);
    }
  });

  it("lets an INACTIVE announcement be half-written, but not an active one", () => {
    const d = draftFromSeed();
    expect(validateSection("announcement", d)).toEqual([]);
    const on = { ...d, "announcement.active": true };
    expect(validateSection("announcement", on).length).toBeGreaterThan(0);
  });

  it("catches a duplicated channel and a bad link", () => {
    const d = draftFromSeed();
    const dupe = {
      ...d,
      "social.follow": [
        { key: "facebook" as const, href: "https://a.test" },
        { key: "facebook" as const, href: "not-a-link" },
      ],
    };
    const errs = validateSection("social", dupe);
    expect(errs.some(e => e.includes("twice"))).toBe(true);
    expect(errs.some(e => e.includes("mailto:"))).toBe(true);
  });
});

describe("announcementExpired", () => {
  it("is false with no end date", () => {
    expect(announcementExpired("")).toBe(false);
  });
  it("is true for a date already past and false for one ahead", () => {
    expect(announcementExpired("2020-01-01")).toBe(true);
    expect(announcementExpired("2999-01-01")).toBe(false);
  });
});
