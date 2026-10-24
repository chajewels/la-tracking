# Measurement: Japanese translation timing on the AI gateway

Measurement only. No project file is edited, nothing is deployed, no SQL is run, no package is touched. All scratch work lives in /tmp and is deleted at the end.

## Steps

1. Read `supabase/functions/translate-product-description/index.ts` and rebuild COMBINED_PROMPT the same way the function does (SHARED_RULES + GLOSSARY + NAME_RULES expanded). Use temperature 0.2 and the user message `NAME:\n<name>\n\nDESCRIPTION:\n<description>`, the same as translateBoth(). Copy any response_format the function sends.
2. Call GET `https://ai.gateway.lovable.dev/v1/models` with `$LOVABLE_API_KEY` and list the exact id of every non-deprecated Gemini flash and flash-lite chat model.
3. Run a Python script in /tmp that sends one request at a time to `/v1/chat/completions` and times each request end to end in ms:
   - A: `google/gemini-3.8-flash`, as deployed now
   - B: A + `reasoning_effort` set to `none`. If that is rejected, try `minimal`, then `low`, and record the HTTP status and error text for each value tried
   - C: the newest non-deprecated flash-lite id from step 2
   - D: C + the first `reasoning_effort` value B accepted (skipped if B accepted none)
   - Each configuration runs twice on each of the 3 inputs, so 6 timings per configuration.
4. Report a table with these columns: configuration, the 6 timings, median, `usage.completion_tokens`, and any reasoning or thinking token count the response returns.
5. For input 2 (Cartier), paste the full name_ja and description_ja from A, B and C. For every output, report yes or no on each check:
   - Preloved rendered as プレラブド
   - any 中古, ユーズド or セカンドハンド
   - K18/750 kept as written
   - Cartier/Love kept in Latin script
   - valid JSON
6. Run `rm -rf` on the /tmp scratch directory and confirm it is gone.

The report gives measurements and checks only, with no recommendations.

## Note

This uses about 24 to 30 gateway calls, billed to the workspace's AI credits.
