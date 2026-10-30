import type { ProductForm } from "@/components/website/product-form";

/**
 * "Suggest styling text (AI)" in the product editor (owner 2026-10-31).
 *
 * The gemini-product-enhance edge function (#681, read-only) returns ONE short
 * English paragraph of styling / gifting suggestions for a product. This module
 * is the pure part of the editor flow:
 *   - what is sent: the English name, weight (when set) and English description;
 *     the first photo is added by the caller (owner: include it);
 *   - a business-rule check on what comes back, BEFORE staff ever see it;
 *   - how an accepted suggestion lands in the English description.
 * Nothing is saved here: staff choose "Add to description" or "Discard", and
 * the product is saved only by the normal Save. The Japanese description is
 * never touched (staff use "Translate from English", same rule as #680).
 */

const norm = (s: string | null | undefined) => (s ?? "").trim();

export interface StylingProduct { name: string; weight_g?: number; description_en: string }

/** The product fields sent to the function (no length: the editor has no length field). */
export function stylingProduct(f: Pick<ProductForm, "name" | "weight_g" | "description_en">): StylingProduct {
  const out: StylingProduct = { name: norm(f.name), description_en: norm(f.description_en) };
  if (typeof f.weight_g === "number" && Number.isFinite(f.weight_g) && f.weight_g > 0) out.weight_g = f.weight_g;
  return out;
}

/**
 * Words a suggestion must never introduce. Each rule names the business rule it
 * protects; the reason is shown to staff instead of the text.
 */
const FORBIDDEN: { re: RegExp; reason: string }[] = [
  { re: /\blay[\s-]?away\b|\binstal?l?ments?\b|\bmonthly payments?\b|\bdown[\s-]?payment\b|\bdeposit\b|分割|取り置き|レイアウェイ/i,
    reason: "it mentions layaway or payment plans" },
  { re: /\bmade in japan\b|\bjapan[\s-]made\b|\bjapanese[\s-]made\b|\bmade in japanese\b|日本製/i,
    reason: "it makes a \"Made in Japan\" claim (only the origin badge may say that)" },
  { re: /\b(japan|japanese|saudi|arabian|arab|italian|italy|dubai|hong\s?kong|hk|chinese|china|singapore|thai|thailand|turkish|turkey|indian|india|korean|korea)\s+gold\b/i,
    reason: "it uses a country name for gold (say K18 gold)" },
  { re: /\bkarats?\b|\b(9|10|14|18|21|22|24)\s?(k|kt|ct)\s+gold\b|\b(9|10|14|18|21|22|24)[\s-]?karat\b/i,
    reason: "it writes gold purity in a non-standard way (say K18 gold)" },
  { re: /\bcertif|\bauthentic|\bgenuine\b|\bguarantee|\bwarrant(y|ies|ed)\b|\bappraise|\bhallmark/i,
    reason: "it makes an authenticity, certification or guarantee claim" },
  { re: /[¥$₱€]|\byen\b|\bpesos?\b|\bphp\b|\bprice[ds]?\b|\bdiscount|\bsale\b|\b(loyalty|reward|rewards|bonus|member|membership)\s+points?\b|\bearn(s|ing)?\s+points?\b|ポイント/i,
    reason: "it mentions price, sales or points" },
];

/** Numbers in the suggestion must already be in the product facts (no invented measurements). */
function newNumbers(text: string, p: StylingProduct): string[] {
  const facts = `${p.name} ${p.description_en} ${p.weight_g ?? ""}`;
  const known = new Set((facts.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(",", ".")));
  return (text.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(",", ".")).filter((n) => !known.has(n));
}

export type StylingCheck = { ok: true; text: string } | { ok: false; reason: string };

/** Decide whether a returned suggestion may be shown to staff at all. */
export function checkStylingSuggestion(raw: string | null | undefined, p: StylingProduct): StylingCheck {
  const text = norm(raw).replace(/\s*\n+\s*/g, " ");
  if (!text) return { ok: false, reason: "the AI returned no text" };
  if (text.length > 800) return { ok: false, reason: "it is longer than one short paragraph" };
  if (/^#|^[-*•]\s|\*\*/m.test(text)) return { ok: false, reason: "it is formatted as a list or heading, not a paragraph" };
  for (const f of FORBIDDEN) if (f.re.test(text)) return { ok: false, reason: f.reason };
  const extra = newNumbers(text, p);
  if (extra.length) return { ok: false, reason: `it adds a number that is not in the product (${extra[0]})` };
  return { ok: true, text };
}

/** Where an accepted suggestion goes: a new paragraph at the end of the English description. */
export function appendStyling(descriptionEn: string, text: string): string {
  const base = descriptionEn.replace(/\s+$/, "");
  return base ? `${base}\n\n${text}` : text;
}

/** What the editor looked like when the suggestion was requested. */
export interface StylingAsk { session: number; id?: string }

/** A suggestion belongs to the editor that asked: another product or a reopened editor discards it. */
export const stylingStillApplies = (ask: StylingAsk, currentSession: number, currentId: string | undefined) =>
  ask.session === currentSession && ask.id === currentId;
