import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";

/**
 * English -> Japanese catalog copy for the website.
 *
 * Called from Website Catalog in the Hub when a product or jewelry type is
 * saved with changed English text, and by the "Regenerate" buttons.
 *
 * Body: { name?: string, description?: string }
 *   - when BOTH are given they are translated in ONE call with shared context,
 *     so a design term ("Open Teardrop") renders identically in the name and
 *     the description (オープンティアドロップ). The description is still a
 *     translation of the description alone: the name is never prepended to it.
 *   - when only one is given, that field is translated on its own.
 *   - `text` is accepted as an alias of `description` for older callers.
 * Response: { name_ja: string | null, description_ja: string | null }
 *
 * Auth: staff JWT + manage_website_catalog (verify_jwt = true at the gateway).
 * Model: Lovable AI gateway, same pattern as ai-customer-insights.
 */

const GLOSSARY = `Glossary — these are fixed and must be obeyed exactly:
- "Preloved" -> プレラブド. NEVER 中古, 中古品, ユーズド or セカンドハンド.
- ONLY these stay in Latin script, exactly as written:
    (1) brand names: Tiffany & Co., Cartier, Bvlgari, Van Cleef & Arpels, Mikimoto, Hermès, Chanel, etc. Never transliterate a brand into katakana.
    (2) model names and model numbers: LOVE, Juste un Clou, Alhambra, N4020, B.zero1, etc.
    (3) metal marks: K18, K14, K10, 750, PT1000, PT950, PT900, SILVER925. Never 18金, never Au750, never spell them out.
    (4) sizes, lengths, weights, carats, counts and prices: 40cm, 45 cm, 2.0g, 0.5ct, 7.5mm, #12, size 12, ¥72,980. Do not convert, round or re-format them.
- EVERYTHING ELSE is translated into Japanese. Descriptive design words are never left in English: use the standard katakana loanword or the Japanese term.
    Open Teardrop -> オープンティアドロップ, Rope Chain -> ロープチェーン, Twist Bangle -> ツイストバングル, Solitaire -> ソリティア, Kihei -> 喜平, Hoop -> フープ, Stud -> スタッド, Bezel -> ベゼル, Pavé -> パヴェ, Akoya -> あこや.
- A design term that appears in both the name and the description is rendered with the SAME Japanese in both places.
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

const NAME_RULES = `A NAME is a heading: output a short Japanese name of the same content, not a sentence — no です・ます, no trailing 。, no added words. Keep the order of information where Japanese allows it ("K18 Rope Chain 45cm" -> "K18 ロープチェーン 45cm"; "Open Teardrop Pendant" -> "オープンティアドロップペンダント"; "Preloved Cartier LOVE Bracelet" -> "プレラブド Cartier LOVE ブレスレット").`;

const NAME_PROMPT = `${SHARED_RULES}

You are translating a short product NAME or category NAME. ${NAME_RULES}`;

const COMBINED_PROMPT = `${SHARED_RULES}

You are translating a product NAME and its DESCRIPTION together so that shared design terms are rendered identically in both.
- ${NAME_RULES}
- The DESCRIPTION is written in formal retail Japanese (です・ます調), natural rather than literal. It is a translation of the description text ONLY: do not prepend the name, a heading or a label to it.
- Respond with ONLY a JSON object of exactly this shape, no markdown fences, no commentary:
  {"name_ja": "<Japanese name>", "description_ja": "<Japanese description>"}`;

const MAX_NAME = 200;
const MAX_DESCRIPTION = 4000;

type Field = "name" | "description";

async function callGateway(apiKey: string, system: string, user: string): Promise<{ ok: true; content: string } | { ok: false; res: Response }> {
  let res: Response;
  try {
    res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
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
  return { ok: true, content: String(json?.choices?.[0]?.message?.content ?? "") };
}

async function translateOne(apiKey: string, field: Field, text: string): Promise<{ ok: true; out: string } | { ok: false; res: Response }> {
  const gw = await callGateway(apiKey, field === "name" ? NAME_PROMPT : DESCRIPTION_PROMPT, text);
  if (!gw.ok) return gw;
  const out = tidy(field, gw.content);
  if (!out) return { ok: false, res: jsonResponse({ error: "Translation came back empty." }, 502) };
  const bad = check(text, out);
  if (bad) return { ok: false, res: bad };
  return { ok: true, out };
}

/** Strip fences; a name is a heading — one line, no sentence punctuation the model may add. */
function tidy(field: Field, raw: string): string {
  let out = raw.trim();
  if (out.startsWith("```")) out = out.replace(/^```(?:\w+)?\s*/, "").replace(/\s*```$/, "").trim();
  if (field === "name") out = out.split(/\r?\n/)[0].replace(/[。．.]+$/u, "").trim();
  return out;
}

/** Post-checks shared by every path. Returns an error Response, or null when the output is acceptable. */
function check(source: string, out: string): Response | null {
  // Belt and braces on the terminology rule the DB trigger also enforces.
  const bannedGold = /(ジャパン|日本|サウジ|イタリア|ドバイ|香港|中国)\s*製?\s*ゴールド/;
  if (bannedGold.test(out)) {
    console.error("translate-product-description: banned gold term in output");
    return jsonResponse({ error: "Translation used a country-branded gold term. Regenerate or write the Japanese by hand." }, 422);
  }
  // Glossary: Preloved is プレラブド, never a second-hand word.
  if (/preloved/i.test(source) && /中古|ユーズド|セカンドハンド/.test(out)) {
    console.error("translate-product-description: glossary miss (Preloved)");
    return jsonResponse({ error: "Translation rendered Preloved as a second-hand term. Regenerate or write the Japanese by hand." }, 422);
  }
  return null;
}

/**
 * Name + description in ONE call. The model sees both, so "Open Teardrop" in
 * the name and in the description come back as the same オープンティアドロップ.
 */
async function translateBoth(apiKey: string, name: string, description: string): Promise<{ ok: true; name_ja: string; description_ja: string } | { ok: false; res: Response }> {
  const gw = await callGateway(apiKey, COMBINED_PROMPT, `NAME:\n${name}\n\nDESCRIPTION:\n${description}`);
  if (!gw.ok) return gw;
  let raw = gw.content.trim();
  if (raw.startsWith("```")) raw = raw.replace(/^```(?:\w+)?\s*/, "").replace(/\s*```$/, "").trim();
  let parsed: { name_ja?: unknown; description_ja?: unknown } | null = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch { parsed = null; } }
  }
  if (!parsed) {
    console.error("translate-product-description: combined output was not JSON");
    return { ok: false, res: jsonResponse({ error: "Translation came back in an unexpected shape. Try again." }, 502) };
  }
  const name_ja = tidy("name", String(parsed.name_ja ?? ""));
  const description_ja = tidy("description", String(parsed.description_ja ?? ""));
  if (!name_ja || !description_ja) return { ok: false, res: jsonResponse({ error: "Translation came back empty." }, 502) };
  const bad = check(name + " " + description, name_ja + "\n" + description_ja);
  if (bad) return { ok: false, res: bad };
  return { ok: true, name_ja, description_ja };
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

  // Both fields: one call with shared context, so design terms match across
  // name and description. One field: translate it on its own.
  if (name && description) {
    const both = await translateBoth(apiKey, name, description);
    if (!both.ok) return both.res;
    return jsonResponse({ name_ja: both.name_ja, description_ja: both.description_ja });
  }
  const single = name
    ? await translateOne(apiKey, "name", name)
    : await translateOne(apiKey, "description", description);
  if (!single.ok) return single.res;
  return jsonResponse({
    name_ja: name ? single.out : null,
    description_ja: name ? null : single.out,
  });
});
