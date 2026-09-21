/**
 * The typed schema behind the Website → Settings tab.
 *
 * public.website_settings is a key/value table — `value` is jsonb and `kind`
 * says how to read it. A free-form key editor over that would be a JSON text
 * box, which is how a storefront ends up with `announcement.untill` and a
 * silently dead banner. So the Hub knows every key it manages, what shape its
 * value has, and what counts as valid; anything else in the table is shown
 * read-only rather than hidden (see UNKNOWN_KEYS handling in SettingsCard).
 *
 * `kind` must be one of the five the table's CHECK allows:
 *   text | bilingual | json | bool | date
 * SETTING_KIND below is what the card writes, and it is the only place that
 * decides — a key added here without a kind will not compile.
 */

export type SettingKind = "text" | "bilingual" | "json" | "bool" | "date";

export const SETTING_KEYS = [
  "contact.email",
  "social.follow",
  "social.loyalty_groups",
  "footer.tagline",
  "announcement.active",
  "announcement.text",
  "announcement.href",
  "announcement.until",
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export const SETTING_KIND: Record<SettingKey, SettingKind> = {
  "contact.email": "text",
  "social.follow": "json",
  "social.loyalty_groups": "json",
  "footer.tagline": "bilingual",
  "announcement.active": "bool",
  "announcement.text": "bilingual",
  "announcement.href": "text",
  "announcement.until": "date",
};

/** The channels a social row may name. Fixed: the storefront renders an icon
 *  per key, so a key it does not know renders as nothing at all. */
export const SOCIAL_KEYS = [
  "email", "facebook", "messenger", "instagram",
  "whatsapp", "line", "tiktok", "youtube",
] as const;
export type SocialKey = (typeof SOCIAL_KEYS)[number];

export const SOCIAL_LABEL: Record<SocialKey, string> = {
  email: "Email", facebook: "Facebook", messenger: "Messenger", instagram: "Instagram",
  whatsapp: "WhatsApp", line: "LINE", tiktok: "TikTok", youtube: "YouTube",
};

export interface SocialRow { key: SocialKey; href: string }
export interface Bilingual { en: string; ja: string }

export interface SettingsDraft {
  "contact.email": string;
  "social.follow": SocialRow[];
  "social.loyalty_groups": SocialRow[];
  "footer.tagline": Bilingual;
  "announcement.active": boolean;
  "announcement.text": Bilingual;
  "announcement.href": string;
  /** ISO date, or "" for no end date (stored as JSON null). */
  "announcement.until": string;
}

export const EMPTY_DRAFT: SettingsDraft = {
  "contact.email": "",
  "social.follow": [],
  "social.loyalty_groups": [],
  "footer.tagline": { en: "", ja: "" },
  "announcement.active": false,
  "announcement.text": { en: "", ja: "" },
  "announcement.href": "",
  "announcement.until": "",
};

export const SECTIONS = [
  { id: "contact", label: "Contact", keys: ["contact.email"] },
  { id: "social", label: "Social", keys: ["social.follow", "social.loyalty_groups"] },
  { id: "footer", label: "Footer", keys: ["footer.tagline"] },
  {
    id: "announcement",
    label: "Announcement",
    keys: ["announcement.active", "announcement.text", "announcement.href", "announcement.until"],
  },
] as const satisfies readonly { id: string; label: string; keys: readonly SettingKey[] }[];

export type SectionId = (typeof SECTIONS)[number]["id"];

const isSocialKey = (v: unknown): v is SocialKey =>
  typeof v === "string" && (SOCIAL_KEYS as readonly string[]).includes(v);

const str = (v: unknown) => (typeof v === "string" ? v : "");

const bilingual = (v: unknown): Bilingual => {
  const o = (v ?? {}) as Record<string, unknown>;
  return { en: str(o.en), ja: str(o.ja) };
};

/**
 * jsonb → draft. TOLERANT BY DESIGN: a row whose value has drifted out of
 * shape reads as the empty default rather than throwing, because one bad row
 * must not take the whole Settings tab down with it. A row read as a default
 * shows as empty and is fixed by saving it.
 */
export function parseSetting<K extends SettingKey>(key: K, raw: unknown): SettingsDraft[K] {
  switch (key) {
    case "contact.email":
    case "announcement.href":
      return str(raw) as SettingsDraft[K];
    case "announcement.until":
      // Stored as JSON null when unset; the input wants "".
      return str(raw) as SettingsDraft[K];
    case "announcement.active":
      return (raw === true) as SettingsDraft[K];
    case "footer.tagline":
    case "announcement.text":
      return bilingual(raw) as SettingsDraft[K];
    case "social.follow":
    case "social.loyalty_groups": {
      const list = Array.isArray(raw) ? raw : [];
      return list
        .map((r) => (r ?? {}) as Record<string, unknown>)
        .filter((r) => isSocialKey(r.key))
        .map((r) => ({ key: r.key as SocialKey, href: str(r.href) })) as SettingsDraft[K];
    }
    default:
      return EMPTY_DRAFT[key];
  }
}

/**
 * draft → jsonb.
 *
 * NEVER RETURNS null. `value` is `jsonb NOT NULL`, and PostgREST turns a JSON
 * `null` in the request body into SQL NULL rather than the JSON null scalar —
 * which would fail the constraint on every save of an announcement with no end
 * date. An unset value is written as "" instead, which is already this table's
 * own convention: the seed stores `announcement.href` as `""` for exactly the
 * same "optional, not set" case.
 *
 * The seed does store `announcement.until` as JSON null, and parseSetting
 * reads null and "" identically, so the seeded row needs no migration — it
 * simply becomes "" the first time someone saves the announcement.
 */
export function serializeSetting<K extends SettingKey>(key: K, value: SettingsDraft[K]): unknown {
  if (typeof value === "string") return value.trim();
  return value;
}

export const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

/**
 * A social href is a mailto: or an https:// URL and nothing else. Plain http://
 * is refused: the storefront is https, and a http link in the footer is a
 * mixed-content warning in the customer's browser.
 */
export const isSettingHref = (v: string) => {
  const s = v.trim();
  if (s.startsWith("mailto:")) return /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  if (!s.startsWith("https://")) return false;
  try { return !!new URL(s).hostname; } catch { return false; }
};

/** Per-section validation. Empty array = the section may be saved. */
export function validateSection(id: SectionId, d: SettingsDraft): string[] {
  const errs: string[] = [];
  if (id === "contact") {
    const email = d["contact.email"].trim();
    if (!email) errs.push("Contact email is required — it is the address the site tells people to write to.");
    else if (!isEmail(email)) errs.push(`"${email}" is not an email address.`);
  }
  if (id === "social") {
    for (const listKey of ["social.follow", "social.loyalty_groups"] as const) {
      const rows = d[listKey];
      const seen = new Set<string>();
      rows.forEach((r, i) => {
        if (!r.href.trim()) errs.push(`${SOCIAL_LABEL[r.key]} (row ${i + 1}) has no link.`);
        else if (!isSettingHref(r.href)) {
          errs.push(`${SOCIAL_LABEL[r.key]} (row ${i + 1}) must be a mailto: address or an https:// link.`);
        }
        if (seen.has(r.key)) errs.push(`${SOCIAL_LABEL[r.key]} appears twice in the same list.`);
        seen.add(r.key);
      });
    }
  }
  if (id === "footer") {
    if (!d["footer.tagline"].en.trim()) errs.push("The English tagline is required.");
  }
  if (id === "announcement") {
    const href = d["announcement.href"].trim();
    if (href && !isSettingHref(href)) errs.push("The announcement link must be a mailto: address or an https:// link.");
    // Only blocking when the bar is ON — an inactive announcement is a draft,
    // and half-written drafts are exactly what the Active switch is for.
    if (d["announcement.active"] && !d["announcement.text"].en.trim()) {
      errs.push("An active announcement needs English text.");
    }
    const until = d["announcement.until"].trim();
    if (until && Number.isNaN(Date.parse(until))) errs.push("The end date is not a date.");
  }
  return errs;
}

/** True when the announcement's end date is in the past (PHT calendar day). */
export function announcementExpired(until: string): boolean {
  const s = until.trim();
  if (!s) return false;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
  return s < today;
}
