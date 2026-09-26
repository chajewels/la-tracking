// Background-removal providers behind one interface (docs/MEDIA-CUTOUTS.md
// "PROVIDERS"). Owner decision D1: fal.ai BiRefNet v2 primary; Replicate
// (the same BiRefNet model) as backup — wired, off unless its token AND model
// version are set, or CUTOUT_PROVIDER=replicate forces it.
//
// Queue + polling (D9): submit returns at once; the worker polls on its next
// tick. No webhook, so there is no public unauthenticated endpoint.
//
// SECRETS: FAL_KEY / REPLICATE_API_TOKEN are edge-function secrets, read with
// Deno.env.get by the caller and passed in. They are never logged, never put
// in the database, and scrubbed from every error message this module builds.
// No imports, `fetch` injected — vitest runs this file as-is.

export interface SubmittedJob {
  provider: string;
  model: string;
  requestId: string;
  statusUrl: string;
  responseUrl: string;
}

export type PollResult =
  | { state: "pending" }
  | { state: "done"; resultUrl: string }
  | { state: "error"; error: string; retryable: boolean };

export interface CutoutProvider {
  name: string;
  model: string;
  submit(imageUrl: string, opts: { highDetail: boolean }): Promise<SubmittedJob>;
  poll(job: { requestId: string; statusUrl: string; responseUrl: string }): Promise<PollResult>;
}

export class ProviderError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean) {
    super(message);
  }
}

type FetchFn = typeof fetch;

/** 429 and 5xx are worth another try; other 4xx are not (bad input, bad key). */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Remove the secret (and anything shaped like a bearer / key header) from text. */
export function scrub(text: string, secret: string | undefined): string {
  let out = text;
  if (secret && secret.length >= 6) out = out.split(secret).join("[secret]");
  return out.replace(/(Key|Bearer|Token)\s+[A-Za-z0-9:_\-.]{12,}/gi, "$1 [secret]").slice(0, 200);
}

async function failure(res: Response, secret: string, what: string): Promise<ProviderError> {
  let body = "";
  try { body = await res.text(); } catch { /* ignore */ }
  return new ProviderError(scrub(`${what}: HTTP ${res.status} ${body}`, secret), res.status, isRetryableStatus(res.status));
}

// ---------------------------------------------------------------------------
// fal.ai — fal-ai/birefnet/v2 via the queue API.
// ---------------------------------------------------------------------------
export const FAL_MODEL = "fal-ai/birefnet/v2";
export const FAL_QUEUE = "https://queue.fal.run";

export function falRequestBody(imageUrl: string, highDetail: boolean) {
  return {
    image_url: imageUrl,
    model: highDetail ? "General Use (Dynamic)" : "General Use (Heavy)",
    operating_resolution: highDetail ? "2304x2304" : "2048x2048",
    output_format: "png",
    refine_foreground: true,
    output_mask: false,
  };
}

export function falProvider(key: string, fetchFn: FetchFn = fetch): CutoutProvider {
  const headers = { Authorization: `Key ${key}`, "Content-Type": "application/json" };
  return {
    name: "fal",
    model: FAL_MODEL,
    async submit(imageUrl, { highDetail }) {
      const res = await fetchFn(`${FAL_QUEUE}/${FAL_MODEL}`, {
        method: "POST", headers, body: JSON.stringify(falRequestBody(imageUrl, highDetail)),
      });
      if (!res.ok) throw await failure(res, key, "fal submit");
      const j = await res.json() as Record<string, unknown>;
      const requestId = String(j.request_id ?? "");
      if (!requestId || typeof j.status_url !== "string" || typeof j.response_url !== "string") {
        throw new ProviderError("fal submit: no request_id / status_url / response_url", 502, true);
      }
      return { provider: "fal", model: `${FAL_MODEL}${highDetail ? ":dynamic" : ":heavy"}`, requestId,
               statusUrl: j.status_url, responseUrl: j.response_url };
    },
    async poll(job) {
      const res = await fetchFn(job.statusUrl, { headers });
      if (!res.ok) {
        const e = await failure(res, key, "fal status");
        return { state: "error", error: e.message, retryable: e.retryable };
      }
      const s = await res.json() as Record<string, unknown>;
      if (s.status === "IN_QUEUE" || s.status === "IN_PROGRESS") return { state: "pending" };
      if (s.status !== "COMPLETED") return { state: "error", error: scrub(`fal status: ${String(s.status)}`, key), retryable: true };
      if (s.error) return { state: "error", error: scrub(`fal: ${String(s.error)}`, key), retryable: false };
      const out = await fetchFn(job.responseUrl, { headers });
      if (!out.ok) {
        const e = await failure(out, key, "fal result");
        return { state: "error", error: e.message, retryable: e.retryable };
      }
      const r = await out.json() as { image?: { url?: string } };
      const url = r.image?.url;
      if (!url) return { state: "error", error: "fal result: no image", retryable: false };
      return { state: "done", resultUrl: url };
    },
  };
}

// ---------------------------------------------------------------------------
// Replicate — a BiRefNet community model; its version hash is a secret-like
// setting (REPLICATE_BIREFNET_VERSION) because community models are addressed
// by version, and the owner picks it when opening the account.
// ---------------------------------------------------------------------------
export const REPLICATE_API = "https://api.replicate.com/v1/predictions";

export function replicateProvider(token: string, version: string, fetchFn: FetchFn = fetch): CutoutProvider {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return {
    name: "replicate",
    model: `men1scus/birefnet:${version.slice(0, 12)}`,
    async submit(imageUrl) {
      const res = await fetchFn(REPLICATE_API, {
        method: "POST", headers, body: JSON.stringify({ version, input: { image: imageUrl } }),
      });
      if (!res.ok) throw await failure(res, token, "replicate submit");
      const j = await res.json() as { id?: string; urls?: { get?: string } };
      if (!j.id || !j.urls?.get) throw new ProviderError("replicate submit: no id / urls.get", 502, true);
      return { provider: "replicate", model: `men1scus/birefnet:${version.slice(0, 12)}`, requestId: j.id,
               statusUrl: j.urls.get, responseUrl: j.urls.get };
    },
    async poll(job) {
      const res = await fetchFn(job.statusUrl, { headers });
      if (!res.ok) {
        const e = await failure(res, token, "replicate status");
        return { state: "error", error: e.message, retryable: e.retryable };
      }
      const p = await res.json() as { status?: string; output?: unknown; error?: unknown };
      if (p.status === "starting" || p.status === "processing") return { state: "pending" };
      if (p.status === "succeeded") {
        const out = Array.isArray(p.output) ? p.output[p.output.length - 1] : p.output;
        if (typeof out === "string" && out.startsWith("https://")) return { state: "done", resultUrl: out };
        return { state: "error", error: "replicate result: no image", retryable: false };
      }
      return { state: "error", error: scrub(`replicate: ${p.status} ${String(p.error ?? "")}`, token), retryable: false };
    },
  };
}

/**
 * Which provider to use. FAL_KEY → fal. CUTOUT_PROVIDER=replicate (with its
 * token + version) → Replicate. Nothing configured → null: the worker queues
 * nothing and says so.
 */
export function pickProvider(env: (k: string) => string | undefined, fetchFn: FetchFn = fetch): CutoutProvider | null {
  const falKey = env("FAL_KEY")?.trim();
  const repToken = env("REPLICATE_API_TOKEN")?.trim();
  const repVersion = env("REPLICATE_BIREFNET_VERSION")?.trim();
  const forced = env("CUTOUT_PROVIDER")?.trim().toLowerCase();
  const replicate = repToken && repVersion ? replicateProvider(repToken, repVersion, fetchFn) : null;
  if (forced === "replicate" && replicate) return replicate;
  if (falKey) return falProvider(falKey, fetchFn);
  return replicate;
}

/** A job still waiting at the provider after this long is given up (then retried). */
export const PROVIDER_TIMEOUT_MS = 30 * 60 * 1000;
