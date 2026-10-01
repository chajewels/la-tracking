/**
 * WHICH BRAND AN EMAIL WEARS.
 *
 * "Cha Jewels Hub" is the internal system. The customer has never heard of it
 * — storefront-email.ts has carried that rule in its comments since the
 * storefront shipped, but every template in this folder hard-coded
 * SITE_NAME = 'Cha Jewels Hub' regardless of who received it.
 *
 * The CJ-W-900011 test on 2026-09-14 put the consequence in one inbox: four
 * emails about one order, two signed "Cha Jewels" and two "Cha Jewels Hub",
 * the latter footed "Payment & Loyalty Management". Real customers are already
 * getting these — payment-confirmed reached five and penalty-applied two on
 * 2026-09-14 alone.
 *
 * So every template declares an audience in the registry, and that decides the
 * From name and the footer. Getting one backwards sends internal mail to a
 * customer, which is worse than the bug being fixed — so there is no default:
 * TemplateEntry.audience is required, and a new template will not compile
 * until someone chooses.
 */

export type Audience = "customer" | "internal";

export const CUSTOMER_SITE_NAME = "Cha Jewels";
export const INTERNAL_SITE_NAME = "Cha Jewels Hub";

/**
 * The REGISTERED company name, full-width exactly as the storefront prints it
 * (cha-jewels-web lib/content/legal.ts COMPANY_NAME): "Ｃｈａ　Ｊｅｗｅｌｓ株式会社".
 * It is an identifier, so it is the same characters in Japanese AND English
 * mail, never an English "Co., Ltd." rendering (owner acceptance run 2026-09-24).
 */
export const COMPANY_NAME = "\uFF23\uFF48\uFF41\u3000\uFF2A\uFF45\uFF57\uFF45\uFF4C\uFF53\u682A\u5F0F\u4F1A\u793E";

/** Matches the storefront family's footer so one inbox reads as one sender. */
export const CUSTOMER_FOOTER = `${COMPANY_NAME} · Tateishi, Katsushika, Tokyo`;
export const INTERNAL_FOOTER = "Cha Jewels Hub · Payment & Loyalty Management";

export const siteNameFor = (a: Audience): string =>
  a === "internal" ? INTERNAL_SITE_NAME : CUSTOMER_SITE_NAME;

/**
 * The REGISTERED postal address, as the storefront's tokusho page prints it
 * (cha-jewels-web lib/content/legal.ts COMPANY_ADDRESS). A PROMOTIONAL email
 * must carry the sender's full address (特定電子メール法 §4), so the cart
 * reminder prints this, not the short CUSTOMER_FOOTER line. Change it here and
 * in the storefront together.
 */
export const COMPANY_ADDRESS = {
  en: "Time Mansion 301, 6-5-1 Tateishi, Katsushika-ku, Tokyo 124-0012, Japan",
  ja: "〒124-0012 東京都葛飾区立石6-5-1 タイムマンション301",
} as const;
