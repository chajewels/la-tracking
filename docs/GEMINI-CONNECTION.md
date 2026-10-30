# Direct Gemini connection (`gemini-product-enhance`)

Status: DEPLOYED (Lovable, from main) and live-tested by the owner's approval on 2026-10-31 (connectivity test: 200, `ok: true`).
Used by: the product editor button "Suggest styling text (AI)" (branch `feat/ai-styling-suggestion`, catalog staff only). The editor sends the English name, weight and English description plus the first photo (shrunk to a JPEG <= 1 MB; skipped if it cannot be read), checks the reply against the business rules (no layaway/payment plans, no "Made in Japan"/日本製, no country gold, no karat wording, no authenticity/guarantee claims, no price/sale/points, no new numbers, one paragraph <= 800 chars) and shows it for "Add to description" / "Discard". Add appends to the English description only; nothing is saved until Save; the Japanese description is never touched.

Flow: Hub (staff JWT) -> edge function `gemini-product-enhance` -> Google Gemini API -> structured reply.

- Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent`; key in the `x-goog-api-key` header only.
- Model `gemini-3.8-flash` (stable; text + image in, text out; 1,048,576 in / 65,536 out tokens). Verified at ai.google.dev, 2026-10-30. Re-check before deploy: model ids move.
- Secret: edge secret `GEMINI_API_KEY`, read with `Deno.env.get`. If absent the function answers 503 `not_configured` (it does not fall back to anything). Never in the repo, DB, logs, chat or browser.
- Auth: `verify_jwt = true`, `requireAuth` then `requirePermission('manage_website_catalog')`.
- READ-ONLY: no database, storage or RPC call. It returns suggested text only; a caller must show it beside the original and require explicit staff acceptance before any Save.
- Bounds: body <= 1.6M chars, name 200, description 4000, 1 image (JPEG/PNG/WebP, <= 1 MB), 1024 output tokens, 20 s timeout, ONE request and no retry.
- Test mode: the body must be EXACTLY `{ "connectivity_test": true }`. Any image, product, fixture text or other field is rejected with 400 before the secret is read or Google is called (QA-681-01); the built-in fictional product is the only content sent. Enhancement requests are strict too: unknown fields (top level, product, image) are rejected. Image input stays available for authorized enhancement use only and has no connectivity-test mode.
- Pipeline order (tested through the real handler, `_shared/gemini-enhance-handler.ts`): method, auth, permission, body size, JSON, strict validation, THEN the secret, then one Gemini call.
- Response: `{ ok, model, connected, addition, usage{prompt,output,thoughts,total tokens}, image_processed, error_category, message }`. `image_processed` is true only if an image was in the request Gemini answered.
- Pricing (paid tier, USD per 1M tokens, through 2026-12-31): input 0.75, output 3.75 (thinking bills as output); from 2027-01-01 1.50 / 7.50. A free tier exists, but only the key's Google project knows which tier it is on. Free-tier content may be used by Google to improve its products; paid-tier content is not (ai.google.dev/gemini-api/terms).
- Separate from `translate-product-description` (Lovable AI gateway).
