import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";

/**
 * English -> Japanese catalog copy for the website.
 *
 * Called from Website Catalog in the Hub when a product or jewelry type is
 * saved with changed English text, and by the "Regenerate" buttons.
 *
 * Body: { name?: string, description?: string }
 *   - each field is translated INDEPENDENTLY. The name never leaks into the
 *     description and the description never leaks into the name.
 *   - `text` is accepted as an alias of `description` for older callers.
 * Response: { name_ja: string | null, description_ja: string | null }
 *
 * Auth: staff JWT + manage_website_catalog (verify_jwt = true at the gateway).
 * Model: Lovable AI gateway, same pattern as ai-customer-insights.
 */

const GLOSSARY = `Glossary — these are fixed and must be obeyed exactly:
- "Preloved" -> プレラブド. NEVER 中古, 中古品, ユーズド or セカンドハンド.
- Brand names and model names stay exactly as written, in Latin letters: Tiffany & Co., Cartier, Bvlgari, Van Cleef & Arpels, Mikimoto, Hermès, Chanel, N4020, etc. Never transliterate them into katakana.
- Metal marks stay exactly as written: K18, K14, K10, 750, PT1000, PT950, PT900, SILVER925. Never 18金, never Au750, never spell them out.
- Sizes, lengths, weights, carats, counts and prices stay exactly as written (40cm, 45 cm, 2.0g, 0.5ct, 7.5mm, #12, size 12, ¥72,980). Do not convert, round or re-format them.
- Jewelry types:
    Anklet / Anklets -> アンクレット
    Bracelet / Bracelets -> ブレスレット
    Earring / Earrings -> ピアス・イヤリング (pierced earrings alone -> ピアス; clip-on alone -> イヤリング)
    Necklace / Necklaces -> ネックレス
    Pendant / Pendants -> ペンダント
    Ring / Rings -> リング
    Set / Sets -> セット
- "Made in Japan" -> 日本製. NEVER attach it to the metal as a gold type: never ジャパンゴールド, 日本ゴールド, 日本製ゴールド or any equivalent. The same ban applies to Saudi / Italian / Dubai / HK / Chinese gold.`;

const SHARED_RULES = `You translate jewelry catalog copy from English into Japanese for a Japanese retail website (Cha Jewels, Tokyo).

${GLOSSARY}

General rules:
- Do not add facts, marketing claims, prices or details the English text does not contain. Do not drop any.
- Output ONLY the Japanese translation. No preamble, no quotes, no romaji, no explanation, no markdown.`;

const DESCRIPTION_PROMPT = `${SHARED_RULES}

You are translating a product DESCRIPTION (or a category description). Write formal retail Japanese (です・ます調), the register a Japanese jewelry boutique uses on a product page. Natural, not literal. Translate ONLY the text you are given — do not prepend a product name, a heading or a label.`;

const NAME_PROMPT = `${SHARED_RULES}

You are translating a short product NAME or category NAME, as it appears in a heading. Output a short Japanese name of the same content, not a sentence: no です・ます, no trailing 。, no added words. Keep the order of information where Japanese allows it (metal, type, length: "K18 Rope Chain 45cm" -> "K18 ロープチェーン 45cm"; "Preloved Cartier Love Bracelet" -> "プレラブド Cartier ラブブレスレット").`;

const MAX_NAME = 200;
const MAX_DESCRIPTION = 4000;

type Field = "name" | "description";

async function translateOne(apiKey: string, field: Field, text: string): Promise<{ ok: true; out: string } | { ok: false; res: Response }> {
  let res: Response;
  try {
    res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: field === "name" ? NAME_PROMPT : DESCRIPTION_PROMPT },
          { role: "user", content: text },
        ],
        temperature: 0.2,
      }),
    });
  } catch (err) {
    console.error("translate-product-description: gateway unreachable", (err as Error)?.message ?? err);
    return { ok: false, res: jsonResponse({ error: "Translation service is unreachable." }, 502) };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (res.status === 429) return { ok: false, res: jsonResponse({ error: "AI rate limit reached. Try again in a moment." }, 429) };
    if (res.status === 402) return { ok: false, res: jsonResponse({ error: "AI credits exhausted. Add credits in workspace billing." }, 402) };
    console.error("translate-product-description: gateway error", res.status, detail);
    return { ok: false, res: jsonResponse({ error: `Translation failed (${res.status}).` }, 502) };
  }

  const json = await res.json();
  let out = String(json?.choices?.[0]?.message?.content ?? "").trim();
  if (out.startsWith("```")) {
    out = out.replace(/^```(?:\w+)?\s*/, "").replace(/\s*```$/, "").trim();
  }
  // A name is a heading: one line, no sentence punctuation the model may add.
  if (field === "name") out = out.split(/\r?\n/)[0].replace(/[。．.]+$/u, "").trim();
  if (!out) return { ok: false, res: jsonResponse({ error: "Translation came back empty." }, 502) };

  // Belt and braces on the terminology rule the DB trigger also enforces.
  const bannedGold = /(ジャパン|日本|サウジ|イタリア|ドバイ|香港|中国)\s*製?\s*ゴールド/;
  if (bannedGold.test(out)) {
    console.error("translate-product-description: banned gold term in output");
    return {
      ok: false,
      res: jsonResponse({ error: "Translation used a country-branded gold term. Regenerate or write the Japanese by hand." }, 422),
    };
  }
  // Glossary: Preloved is プレラブド, never a second-hand word.
  if (/preloved/i.test(text) && /中古|ユーズド|セカンドハンド/.test(out)) {
    console.error("translate-product-description: glossary miss (Preloved)");
    return {
      ok: false,
      res: jsonResponse({ error: "Translation rendered Preloved as a second-hand term. Regenerate or write the Japanese by hand." }, 422),
    };
  }
  return { ok: true, out };
}

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;

  const ctx = await requireAuth(req);
  if (ctx instanceof Response) return ctx;
  const denied = await requirePermission(ctx, "manage_website_catalog");
  if (denied) return denied;

  const body = await req.json().catch(() => ({}));
  const name = String(body?.name ?? "").trim();
  // `text` is the pre-bilingual field name; treat it as the description.
  const description = String(body?.description ?? body?.text ?? "").trim();

  if (!name && !description) return jsonResponse({ error: "name or description is required" }, 400);
  if (name.length > MAX_NAME) return jsonResponse({ error: `name is too long (max ${MAX_NAME} characters)` }, 400);
  if (description.length > MAX_DESCRIPTION) {
    return jsonResponse({ error: `description is too long (max ${MAX_DESCRIPTION} characters)` }, 400);
  }

  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!apiKey) return jsonResponse({ error: "LOVABLE_API_KEY is not configured" }, 500);

  // Independent calls: the name is never shown to the description translation
  // and vice versa, so neither can leak into the other.
  const [nameResult, descResult] = await Promise.all([
    name ? translateOne(apiKey, "name", name) : Promise.resolve(null),
    description ? translateOne(apiKey, "description", description) : Promise.resolve(null),
  ]);

  if (nameResult && !nameResult.ok) return nameResult.res;
  if (descResult && !descResult.ok) return descResult.res;

  return jsonResponse({
    name_ja: nameResult ? nameResult.out : null,
    description_ja: descResult ? descResult.out : null,
  });
});
