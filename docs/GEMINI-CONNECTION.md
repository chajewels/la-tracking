# Direct Gemini connection (`gemini-product-enhance`)

Status: source only. NOT deployed, NOT called live. Deploy and the first live call need the owner's approval.

Flow: Hub (staff JWT) -> edge function `gemini-product-enhance` -> Google Gemini API -> structured reply.

- Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent`; key in the `x-goog-api-key` header only.
- Model `gemini-3.8-flash` (stable; text + image in, text out; 1,048,576 in / 65,536 out tokens). Verified at ai.google.dev, 2026-10-30. Re-check before deploy: model ids move.
- Secret: edge secret `GEMINI_API_KEY`, read with `Deno.env.get`. If absent the function answers 503 `not_configured` (it does not fall back to anything). Never in the repo, DB, logs, chat or browser.
- Auth: `verify_jwt = true`, `requireAuth` then `requirePermission('manage_website_catalog')`.
- READ-ONLY: no database, storage or RPC call. It returns suggested text only; a caller must show it beside the original and require explicit staff acceptance before any Save.
- Bounds: body <= 1.6M chars, name 200, description 4000, 1 image (JPEG/PNG/WebP, <= 1 MB), 1024 output tokens, 20 s timeout, ONE request and no retry.
- Test mode: `{ "connectivity_test": true }` always uses a built-in fictional product; no real data can ride along.
- Response: `{ ok, model, connected, addition, usage{prompt,output,thoughts,total tokens}, image_processed, error_category, message }`. `image_processed` is true only if an image was in the request Gemini answered.
- Pricing (paid tier, USD per 1M tokens, through 2026-12-31): input 0.75, output 3.75 (thinking bills as output); from 2027-01-01 1.50 / 7.50. A free tier exists, but only the key's Google project knows which tier it is on. Free-tier content may be used by Google to improve its products; paid-tier content is not (ai.google.dev/gemini-api/terms).
- Separate from `translate-product-description` (Lovable AI gateway).
