/**
 * Page365 import — which invoice lines are SERVICES (owner 2026-10-27:
 * "left out all kinds of services").
 *
 * A service line is labour or paperwork the customer pays for, never a piece:
 * it is booked as a service on the import screen and is NEVER part of the
 * loyalty basis (loyalty_jpy_amount = product lines − discount). The kinds are
 * the Hub's own service types (AddServiceDialog / ServiceJobDialog):
 * resize, certificate, polish, colour change, engraving, repair, appraisal,
 * plus plating, cleaning and generic service / labour fees.
 *
 * Seen on real invoices: "RESIZE FEE" (19832, 19855, 19857, 19867, 19868,
 * 19885, 19668) and "Certificate Mini Booklet (A5 Size)" (19855, 19857, 19869,
 * 19901 — the last four were booked as products until this rule).
 *
 * GUARD: a PRODUCT can mention one of these words ("… with GIA certificate",
 * "… Engraved Band"). Page365 product names lead with the product code, and
 * every code carries a digit (N4032, E8JS, 7DLY, BLCH2). So a line whose FIRST
 * word contains a digit is always a product here; service names start with a
 * plain word ("RESIZE FEE", "Certificate …"). Words are matched as service
 * nouns, not adjectives: "polish"/"polishing" but not "polished", "engraving"
 * but not "engraved".
 *
 * This only pre-sets the line on the review screen; staff can still switch any
 * line between Product and Service before creating the order.
 */
const SERVICE_WORDS: RegExp[] = [
  /\bre-?siz(e|ing)\b/i,
  /\bsizing\b/i,
  /\bcertificat(e|es|ion)\b/i,
  /\bpolish(ing)?\b/i,
  /\bcolou?r\s*change\b/i,
  /\bchange\s*colou?r\b/i,
  /\bengraving\b/i,
  /\brepair(s|ing)?\b/i,
  /\bappraisal\b/i,
  /\bre-?plating\b/i,
  /\bplating\s*fee\b/i,
  /\bcleaning\b/i,
  /\bservice\s*(fee|charge)\b/i,
  /\blabou?r\s*(fee|charge)?\b/i,
];

function firstWordHasDigit(name: string): boolean {
  const first = name.trim().split(/\s+/)[0] ?? "";
  return /\d/.test(first);
}

export function isPage365ServiceLine(name: string | null | undefined): boolean {
  const n = String(name ?? "").trim();
  if (!n) return false;
  if (firstWordHasDigit(n)) return false;
  return SERVICE_WORDS.some((re) => re.test(n));
}
