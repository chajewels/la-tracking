/**
 * Retry a fetch when the Deno runtime throws RateLimitError.
 *
 * MOVED HERE, NOT COPIED (2026-09-16). This lived inline in
 * daily-reconciliation, whose own comment said it was "ported verbatim from
 * send-reminders" and that "future cleanup can DRY both into a shared helper".
 * send-reminders no longer has a copy, so that comment was already stale — and
 * the reason this file now exists is that the duplication finally cost
 * something: when loyalty-award-sweep was split out of daily-reconciliation,
 * the function came across and the helper did not. The sweep's first real run
 * lost 257 of 287 candidates to RateLimitError in a single second.
 *
 * A third copy would have been the wrong fix for a copy-failure. Import it.
 *
 * WHY A THROW AND NOT A STATUS: this is the Deno isolate's own outbound-request
 * limiter, not an HTTP 429 from the peer — `fetch` REJECTS, so a caller that
 * only inspects `res.ok` never sees it. The error carries `retryAfterMs`; we
 * honour it plus a small margin, and re-throw anything that is not a rate
 * limit so a real network failure is not silently retried into a timeout.
 */
export async function fetchWithRetryOnRateLimit(
  url: string,
  init: RequestInit,
  maxRetries = 3,
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      const isRateLimit =
        e && typeof e === "object" && "name" in e &&
        (e as { name: string }).name === "RateLimitError";
      if (!isRateLimit || attempt >= maxRetries) {
        throw e;
      }
      const maybeRetry = (e as unknown as { retryAfterMs?: number }).retryAfterMs;
      const retryAfterMs = typeof maybeRetry === "number" ? maybeRetry : 200;
      console.warn(
        `Rate limited at fetch, retry after ${retryAfterMs + 50}ms (attempt ${attempt + 1}/${maxRetries})`,
      );
      await new Promise((r) => setTimeout(r, retryAfterMs + 50));
    }
  }
  throw new Error("fetchWithRetryOnRateLimit: exhausted retries unexpectedly");
}
