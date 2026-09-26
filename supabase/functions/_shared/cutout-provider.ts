// Background-removal providers behind one interface (docs/MEDIA-CUTOUTS.md
// "PROVIDERS").
//
// Owner decision 2026-09-27 (after "Test 30"): PHOTOROOM is the provider —
// its Remove Background API (Basic plan, $0.02 / image). fal.ai BiRefNet v2
// (PR 1's D1 choice) and Replicate stay in the code but are used ONLY when
// system_settings.media_cutout_provider names them explicitly.
//
// Two shapes:
//   "sync"  (Photoroom) — one POST with the photo's bytes answers with the
//           cut-out. The worker stores it and processes it in the same tick.
//   "queue" (fal, Replicate) — submit returns at once; the worker polls on
//           its next tick (D9). No webhook, so no public endpoint.
//
// SECRETS: PHOTOROOM_API_KEY / FAL_KEY / REPLICATE_API_TOKEN are edge-function
// secrets, read with Deno.env.get by the caller and passed in. Never logged,
// never put in the database, scrubbed from every error message built here.
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

export interface QueueProvider {
  kind: "queue";
  name: string;
  model: string;
  submit(imageUrl: string, opts: { highDetail: boolean }): Promise<SubmittedJob>;
  poll(job: { requestId: string; statusUrl: string; responseUrl: string }): Promise<PollResult>;
}

export interface SyncResult {
  /** The cut-out: RGBA PNG, same framing and size as the photo. */
  bytes: Uint8Array;
  /** 0 (sure) – 1 (unsure); null when the provider gave none (or -1). */
  uncertainty: number | null;
  model: string;
}

export interface SyncProvider {
  kind: "sync";
  name: string;
  model: string;
  remove(image: Uint8Array, opts: { highDetail: boolean; contentType?: string }): Promise<SyncResult>;
}

export type CutoutProvider = QueueProvider | SyncProvider;

export class ProviderError extends Error {
  /**
   * `haltTick`: the problem is the ACCOUNT, not this photo (rate limit, no
   * credits, bad key) — stop submitting for the rest of the tick so one
   * problem is not recorded against every queued photo.
   */
  constructor(message: string, readonly status: number, readonly retryable: boolean, readonly haltTick = false) {
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

export function falProvider(key: string, fetchFn: FetchFn = fetch): QueueProvider {
  const headers = { Authorization: `Key ${key}`, "Content-Type": "application/json" };
  return {
    kind: "queue",
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

export function replicateProvider(token: string, version: string, fetchFn: FetchFn = fetch): QueueProvider {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return {
    kind: "queue",
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

// ---------------------------------------------------------------------------
// Photoroom — Remove Background API (Basic plan). Official docs, read
// 2026-09-27:
//   endpoint  POST https://sdk.photoroom.com/v1/segment, multipart/form-data
//             (docs.photoroom.com/remove-background-api-basic-plan/quickstart-guide)
//   auth      header x-api-key (same page)
//   fields    image_file (required, binary) · format png|jpg|webp (default
//             png) · channels rgba|alpha (default rgba) · bg_color · size
//             preview|medium|hd|full (default full, 36 MP) · crop true|false
//             (default false) · despill (default false)
//             (docs.photoroom.com/getting-started/api-reference-openapi,
//              …/remove-background-api-basic-plan/background-color-size-and-crop)
//   URLs      not accepted — the bytes are uploaded
//             (…/remove-background-api-basic-plan/file-size-resolution-and-format)
//   limits    ≤ 50 MB, ≤ 6,000 px on the widest side (same page); 60 images
//             a minute, then 429 (…/getting-started/frequently-asked-questions)
//   response  200 image/png body; errors 400 / 402 / 403 with JSON
//             {detail, status_code, type} (OpenAPI)
//   score     x-uncertainty-score header, 0 sure – 1 unsure, -1 = none
//             (…/remove-background-api-basic-plan/uncertainty-score)
//   billing   $0.02 per call; "Calls that result in an error will not
//             consume an image" (…/remove-background-api-basic-plan/pricing,
//             …/getting-started/pricing)
//
// We ask for exactly what the Hub composites from: a transparent PNG at the
// photo's full size, uncropped, no background colour, no shadow. Trim, chalk
// #F5F5F2, contact shadow, centring, sizes and WebP stay in the Hub
// (cutout-image.ts). Sandbox keys ("sandbox_…") watermark the result — the
// key the owner sets is a LIVE key.
// ---------------------------------------------------------------------------
export const PHOTOROOM_URL = "https://sdk.photoroom.com/v1/segment";
export const PHOTOROOM_MODEL = "photoroom/v1/segment";
/** Photoroom's median is 350 ms; big photos take longer. Past this → retry later. */
export const PHOTOROOM_TIMEOUT_MS = 60_000;

export function photoroomForm(image: Uint8Array, contentType = "image/jpeg"): FormData {
  const form = new FormData();
  const ext = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
  form.append("image_file", new Blob([new Uint8Array(image)], { type: contentType }), `photo.${ext}`);
  form.append("format", "png");
  form.append("channels", "rgba");
  form.append("size", "full");
  form.append("crop", "false");
  return form;
}

/** The header as a number in [0, 1]; -1, missing or garbage → null. */
export function readUncertainty(header: string | null): number | null {
  if (header == null || header.trim() === "") return null;
  const n = Number(header);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

export function photoroomProvider(key: string, fetchFn: FetchFn = fetch, timeoutMs = PHOTOROOM_TIMEOUT_MS): SyncProvider {
  return {
    kind: "sync",
    name: "photoroom",
    model: PHOTOROOM_MODEL,
    // highDetail: Photoroom's Basic plan has one model; full size is already
    // the most detail it gives. A "high detail" re-run is an ordinary re-run.
    async remove(image, { contentType }) {
      let res: Response;
      try {
        // No Content-Type header: fetch sets the multipart boundary itself
        // (setting it by hand breaks the request — Photoroom troubleshooting).
        res = await fetchFn(PHOTOROOM_URL, {
          method: "POST",
          headers: { "x-api-key": key, Accept: "image/png" },
          body: photoroomForm(image, contentType),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const name = (e as { name?: string })?.name;
        if (name === "TimeoutError" || name === "AbortError") {
          throw new ProviderError(`photoroom: no answer within ${Math.round(timeoutMs / 1000)} s`, 408, true);
        }
        throw new ProviderError(scrub(`photoroom: ${e instanceof Error ? e.message : String(e)}`, key), 503, true);
      }
      if (!res.ok) {
        const e = await failure(res, key, "photoroom");
        // 429 rate limit, 402 no credits, 401/403 key: the account, not the photo.
        const account = res.status === 429 || res.status === 402 || res.status === 401 || res.status === 403;
        throw new ProviderError(e.message, res.status, account || e.retryable, account);
      }
      const type = res.headers.get("content-type") ?? "";
      const bytes = new Uint8Array(await res.arrayBuffer());
      const png = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
      if (!png) throw new ProviderError(`photoroom: expected a PNG, got ${type || "no content-type"} (${bytes.length} bytes)`, 502, true);
      return { bytes, uncertainty: readUncertainty(res.headers.get("x-uncertainty-score")), model: PHOTOROOM_MODEL };
    },
  };
}

// ---------------------------------------------------------------------------
// Choice + price.
// ---------------------------------------------------------------------------
export type ProviderName = "photoroom" | "fal" | "replicate";
export const PROVIDER_NAMES: readonly ProviderName[] = ["photoroom", "fal", "replicate"];

/** Fail-safe: anything but the exact names "fal" / "replicate" is Photoroom. */
export function readProviderSetting(value: unknown): ProviderName {
  return value === "fal" || value === "replicate" ? value : "photoroom";
}

/**
 * US$ per photo, for the Photos card's estimate. Photoroom from its pricing
 * page; fal measured on "Test 30" ($1.29 / 36 photos on the fal dashboard);
 * Replicate is billed by GPU time — unknown until measured.
 */
export const DEFAULT_PRICE_USD: Record<ProviderName, number | null> = {
  photoroom: 0.02,
  fal: 0.036,
  replicate: null,
};

/** Fail-safe: a number 0–10 with up to 4 decimals, else the provider default. */
export function readPriceSetting(value: unknown, provider: ProviderName): number | null {
  const s = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (/^[0-9]{1,2}(\.[0-9]{1,4})?$/.test(s) && Number(s) <= 10) return Number(s);
  return DEFAULT_PRICE_USD[provider];
}

/** Estimated spend in US$ (null when the price is unknown). */
export function estimateCost(photos: number, priceUsd: number | null): number | null {
  return priceUsd == null ? null : Math.round(photos * priceUsd * 100) / 100;
}

/**
 * Which provider to submit to: the one the SETTING names, and only if its
 * secret is set. Photoroom is the default; fal / Replicate are never used
 * unless selected — no fal call happens just because FAL_KEY exists.
 * null = the selected provider has no key: the worker submits nothing and
 * says so.
 */
export function pickProvider(
  env: (k: string) => string | undefined,
  setting: unknown = "photoroom",
  fetchFn: FetchFn = fetch,
): CutoutProvider | null {
  const want = readProviderSetting(setting);
  if (want === "photoroom") {
    const key = env("PHOTOROOM_API_KEY")?.trim();
    return key ? photoroomProvider(key, fetchFn) : null;
  }
  if (want === "fal") {
    const key = env("FAL_KEY")?.trim();
    return key ? falProvider(key, fetchFn) : null;
  }
  const token = env("REPLICATE_API_TOKEN")?.trim();
  const version = env("REPLICATE_BIREFNET_VERSION")?.trim();
  return token && version ? replicateProvider(token, version, fetchFn) : null;
}

/** The secret each provider needs (for "not configured" messages). */
export const PROVIDER_SECRET: Record<ProviderName, string> = {
  photoroom: "PHOTOROOM_API_KEY",
  fal: "FAL_KEY",
  replicate: "REPLICATE_API_TOKEN + REPLICATE_BIREFNET_VERSION",
};

/** A job still waiting at the provider after this long is given up (then retried). */
export const PROVIDER_TIMEOUT_MS = 30 * 60 * 1000;
