import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";

/**
 * English -> Japanese product copy for the website catalog.
 * Called from Website Catalog in the Hub when a product is saved with a
 * changed English description, and by the "Regenerate" button.
 *
 * Auth: staff JWT + manage_website_catalog (verify_jwt = true at the gateway).
 * Model: Lovable AI gateway, same pattern as ai-customer-insights.
 */

const SYSTEM_PROMPT = `You translate jewelry product copy from English into Japanese for a Japanese retail website (Cha Jewels, Tokyo).

Rules:
- Write formal retail Japanese (です・ます調), the register a Japanese jewelry boutique uses on a product page. Natural, not literal.
- Keep every number, measurement and unit exactly as written (40cm, 2.0g, 750, ¥72,980). Do not convert, round or re-format them.
- Keep metal names exactly as written in Latin letters: K18, K14, K10, PT1000, PT950, PT900, SILVER925. Never spell them out, never translate them, never turn K18 into 18金 or 750 or Au750.
- "Made in Japan" is a statement of where the piece was made. Render it as 日本製 or leave it as "Made in Japan". NEVER attach it to the metal as a gold type — do not write ジャパンゴールド, 日本ゴールド, 日本製ゴールド or any equivalent country-branded gold term. The same ban applies to Saudi / Italian / Dubai / HK / Chinese gold.
- Keep brand names, model codes and SKUs in their original script (Tiffany & Co., N4020).
- Do not add facts, marketing claims, prices or details the English text does not contain. Do not drop any.
- Output ONLY the Japanese translation. No preamble, no quotes, no romaji, no explanation.`;

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;

  const ctx = await requireAuth(req);
  if (ctx instanceof Response) return ctx;
  const denied = await requirePermission(ctx, "manage_website_catalog");
  if (denied) return denied;

  const body = await req.json().catch(() => ({}));
  const text = String(body?.text ?? "").trim();
  if (!text) return jsonResponse({ error: "text is required" }, 400);
  if (text.length > 4000) return jsonResponse({ error: "text is too long (max 4000 characters)" }, 400);

  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!apiKey) return jsonResponse({ error: "LOVABLE_API_KEY is not configured" }, 500);

  const name = String(body?.name ?? "").trim();
  const userPrompt = name
    ? `Product name: ${name}\n\nDescription to translate:\n${text}`
    : text;

  let res: Response;
  try {
    res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
      }),
    });
  } catch (err) {
    console.error("translate-product-description: gateway unreachable", (err as Error)?.message ?? err);
    return jsonResponse({ error: "Translation service is unreachable." }, 502);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (res.status === 429) return jsonResponse({ error: "AI rate limit reached. Try again in a moment." }, 429);
    if (res.status === 402) return jsonResponse({ error: "AI credits exhausted. Add credits in workspace billing." }, 402);
    console.error("translate-product-description: gateway error", res.status, detail);
    return jsonResponse({ error: `Translation failed (${res.status}).` }, 502);
  }

  const json = await res.json();
  let out = String(json?.choices?.[0]?.message?.content ?? "").trim();
  if (out.startsWith("```")) {
    out = out.replace(/^```(?:\w+)?\s*/, "").replace(/\s*```$/, "").trim();
  }
  if (!out) return jsonResponse({ error: "Translation came back empty." }, 502);

  // Belt and braces on the terminology rule the DB trigger also enforces.
  const banned = /(ジャパン|日本|サウジ|イタリア|ドバイ|香港|中国)\s*製?\s*ゴールド/;
  if (banned.test(out)) {
    console.error("translate-product-description: banned gold term in output");
    return jsonResponse(
      { error: "Translation used a country-branded gold term. Regenerate or write the Japanese by hand." },
      422,
    );
  }

  return jsonResponse({ description_ja: out });
});
