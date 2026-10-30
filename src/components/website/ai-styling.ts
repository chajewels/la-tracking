import { type ProductForm, metalLabel } from "@/components/website/product-form";

/**
 * "Write description (AI)" in the product editor (owner 2026-10-30/31).
 *
 * The read-only gemini-product-enhance edge function writes a warm English
 * description in the approved R8913 sample's shape: the piece itself (about
 * 60-90 words), a preloved line for preloved pieces, and a "Lovely for:" line
 * of occasions and gifts. This module is the pure part of the editor flow:
 *   - what is sent: name, weight, English description, metal, brand (Branded
 *     only), condition, sizes and stones; the first photo is added by the
 *     caller. Origin is never sent;
 *   - a business-rule check on what comes back, BEFORE staff ever see it;
 *   - where an accepted text lands: ABOVE the existing English description,
 *     which is never changed.
 * Nothing is saved here: staff choose "Add to description" or "Discard", and
 * the product is saved only by the normal Save. The Japanese description is
 * never touched (staff use "Translate from English", same rule as #680).
 */

const norm = (s: string | null | undefined) => (s ?? "").trim();

export interface StylingProduct {
  name: string;
  weight_g?: number;
  description_en: string;
  metal?: string;
  brand?: string;
  condition?: "New" | "Preloved";
  size?: string;
  stone?: string;
}

const uniqueJoin = (xs: (string | null | undefined)[]) =>
  [...new Set(xs.map(norm).filter(Boolean))].join(", ");

/**
 * The product fields sent to the function (owner 2026-10-31: the Edit product
 * fields too, so the AI relies less on the photo). Origin is NEVER sent — the
 * website's origin badge is the only place an origin is stated — and the brand
 * only for a Branded piece.
 */
export function stylingProduct(
  f: Pick<ProductForm, "name" | "weight_g" | "description_en"> &
    Partial<Pick<ProductForm, "metals" | "brand" | "origin" | "condition" | "variants">>,
): StylingProduct {
  const out: StylingProduct = { name: norm(f.name), description_en: norm(f.description_en) };
  if (typeof f.weight_g === "number" && Number.isFinite(f.weight_g) && f.weight_g > 0) out.weight_g = f.weight_g;
  const metal = uniqueJoin((f.metals ?? []).map(metalLabel));
  if (metal) out.metal = metal.slice(0, 60);
  if (f.origin === "BRAND" && norm(f.brand)) out.brand = norm(f.brand).slice(0, 60);
  if (f.condition === "New" || f.condition === "Preloved") out.condition = f.condition;
  const size = uniqueJoin((f.variants ?? []).map((v) => v.size));
  if (size) out.size = size.slice(0, 200);
  const stone = uniqueJoin((f.variants ?? []).map((v) => v.stone));
  if (stone) out.stone = stone.slice(0, 200);
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
  { re: /\bjapan(ese)?\b|\btokyo\b|日本|東京/i,
    reason: "it mentions Japan or Tokyo (where a piece is from is shown only by the origin badge)" },
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
  const facts = [p.name, p.description_en, p.weight_g ?? "", p.metal, p.brand, p.size, p.stone].join(" ");
  const known = new Set((facts.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(",", ".")));
  return (text.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(",", ".")).filter((n) => !known.has(n));
}

export type StylingCheck = { ok: true; text: string } | { ok: false; reason: string };

/** Decide whether a returned description may be shown to staff at all. */
export function checkStylingSuggestion(raw: string | null | undefined, p: StylingProduct): StylingCheck {
  // Keep the paragraph breaks; tidy spaces and extra blank lines.
  const text = (raw ?? "")
    .split("\n").map((l) => l.trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return { ok: false, reason: "the AI returned no text" };
  if (text.length > 1200) return { ok: false, reason: "it is longer than the approved length" };
  if (text.split("\n\n").length > 4) return { ok: false, reason: "it has more parts than the approved shape" };
  if (/^#|^[-*•]\s|^\d+[.)]\s|\*\*/m.test(text)) return { ok: false, reason: "it is formatted as a list or heading, not paragraphs" };
  if (!/^Lovely for: \S/m.test(text.split("\n\n").at(-1) ?? "")) return { ok: false, reason: "the last line is not the \"Lovely for:\" line" };
  for (const f of FORBIDDEN) if (f.re.test(text)) return { ok: false, reason: f.reason };
  const extra = newNumbers(text, p);
  if (extra.length) return { ok: false, reason: `it adds a number that is not in the product (${extra[0]})` };
  return { ok: true, text };
}

/**
 * Where an accepted description goes (owner 2026-10-31): ABOVE the existing
 * English description, which is kept exactly as it is underneath.
 */
export function placeAboveExisting(descriptionEn: string, text: string): string {
  return descriptionEn.trim() ? `${text}\n\n${descriptionEn}` : text;
}

/** What the editor looked like when the suggestion was requested. */
export interface StylingAsk { session: number; id?: string }

/** A suggestion belongs to the editor that asked: another product or a reopened editor discards it. */
export const stylingStillApplies = (ask: StylingAsk, currentSession: number, currentId: string | undefined) =>
  ask.session === currentSession && ask.id === currentId;
