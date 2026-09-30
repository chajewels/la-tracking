import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";

/**
 * Customer review -> Japanese (and English when the original is Japanese).
 *
 * Called from Website → Reviews in the Hub when a pending review is opened
 * with no Japanese yet, and by "Re-translate".
 *
 * Body: { review_id }
 * Response: { original_language, body_ja, body_en }
 * Saves the three fields on product_reviews.
 *
 * Auth: staff JWT + moderate_reviews (verify_jwt = true at the gateway).
 * Model / gateway: same pattern as translate-product-description.
 */

const GLOSSARY = `Glossary — these are fixed and must be obeyed exactly:
- "Preloved" -> プレラブド. NEVER 中古, 中古品, ユーズド or セカンドハンド.
- These stay in Latin script, exactly as written:
    (1) brand names: Tiffany & Co., Cartier, Bvlgari, Van Cleef & Arpels, Mikimoto, Hermès, Chanel, etc. Never transliterate a brand into katakana.
    (2) model names and model numbers: LOVE, Juste un Clou, Alhambra, N4020, B.zero1, etc.
    (3) metal marks: K18, K14, K10, 750, PT1000, PT950, PT900, SILVER925. Never 18金, never Au750.
    (4) sizes, lengths, weights, carats, counts and prices: 40cm, 2.0g, 0.5ct, #12, ¥72,980. Do not convert or re-format them.
- "Made in Japan" -> 日本製. NEVER a country-branded gold (ジャパンゴールド, サウジゴールド, etc.).`;

const PROMPT = `You translate a CUSTOMER REVIEW of a jewelry shop (Cha Jewels) for its website.
The review may be in English, Japanese, Tagalog, or Taglish (mixed English/Tagalog).

${GLOSSARY}

Rules:
- Keep the customer's meaning, tone and warmth. Do not add or remove claims, facts or praise. Keep emoji.
- body_ja: natural, polite Japanese as a real customer would write it (です・ます調). Taglish becomes natural Japanese, not a literal word-by-word rendering. If the original is already Japanese, body_ja is the original text unchanged.
- body_en: ONLY when the original is Japanese — a natural English translation. Otherwise null.
- original_language: "en", "ja", "tl" (mostly Tagalog) or "mixed" (Taglish or several languages).
- Respond with ONLY a JSON object of exactly this shape, no markdown fences, no commentary:
  {"original_language": "en"|"ja"|"tl"|"mixed", "body_ja": "<Japanese>", "body_en": "<English>"|null}`;

const LANGS = ["en", "ja", "tl", "mixed"];

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;

  const ctx = await requireAuth(req);
  if (ctx instanceof Response) return ctx;
  const denied = await requirePermission(ctx, "moderate_reviews");
  if (denied) return denied;

  const body = await req.json().catch(() => ({}));
  const reviewId = String(body?.review_id ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(reviewId)) return jsonResponse({ error: "review_id is required" }, 400);

  const { data: review, error: rErr } = await ctx.supabase
    .from("product_reviews").select("id, body_original").eq("id", reviewId).maybeSingle();
  if (rErr) return jsonResponse({ error: rErr.message }, 500);
  if (!review) return jsonResponse({ error: "Review not found" }, 404);

  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!apiKey) return jsonResponse({ error: "LOVABLE_API_KEY is not configured" }, 500);

  let res: Response;
  try {
    res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: PROMPT },
          { role: "user", content: String(review.body_original) },
        ],
        temperature: 0.2,
      }),
    });
  } catch (err) {
    console.error("translate-review: gateway unreachable", (err as Error)?.message ?? err);
    return jsonResponse({ error: "Translation service is unreachable." }, 502);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (res.status === 429) return jsonResponse({ error: "AI rate limit reached. Try again in a moment." }, 429);
    if (res.status === 402) return jsonResponse({ error: "AI credits exhausted. Add credits in workspace billing." }, 402);
    console.error("translate-review: gateway error", res.status, detail);
    return jsonResponse({ error: `Translation failed (${res.status}).` }, 502);
  }

  const json = await res.json();
  let raw = String(json?.choices?.[0]?.message?.content ?? "").trim();
  if (raw.startsWith("```")) raw = raw.replace(/^```(?:\w+)?\s*/, "").replace(/\s*```$/, "").trim();
  let parsed: { original_language?: unknown; body_ja?: unknown; body_en?: unknown } | null = null;
  try { parsed = JSON.parse(raw); } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch { parsed = null; } }
  }
  if (!parsed) return jsonResponse({ error: "Translation came back in an unexpected shape. Try again." }, 502);

  const original_language = LANGS.includes(String(parsed.original_language)) ? String(parsed.original_language) : "mixed";
  const body_ja = String(parsed.body_ja ?? "").trim();
  const enRaw = parsed.body_en == null ? "" : String(parsed.body_en).trim();
  const body_en = original_language === "ja" ? (enRaw || null) : null;
  if (!body_ja) return jsonResponse({ error: "Translation came back empty." }, 502);
  if (original_language === "ja" && !body_en) return jsonResponse({ error: "English translation came back empty." }, 502);
  if (/(ジャパン|日本|サウジ|イタリア|ドバイ|香港|中国)\s*製?\s*ゴールド/.test(body_ja)) {
    return jsonResponse({ error: "Translation used a country-branded gold term. Re-translate or edit by hand." }, 422);
  }
  if (/preloved/i.test(String(review.body_original)) && /中古|ユーズド|セカンドハンド/.test(body_ja)) {
    return jsonResponse({ error: "Translation rendered Preloved as a second-hand term. Re-translate or edit by hand." }, 422);
  }

  const { error: upErr } = await ctx.supabase
    .from("product_reviews").update({ original_language, body_ja, body_en }).eq("id", reviewId);
  if (upErr) return jsonResponse({ error: upErr.message }, 500);

  return jsonResponse({ original_language, body_ja, body_en });
});
