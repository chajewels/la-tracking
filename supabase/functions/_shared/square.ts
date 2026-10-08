/**
 * Square API client (S2 2026-10-04; integrity 2026-10-04, SQ21/SQ23).
 * docs/SQUARE.md; reference developer.squareup.com/reference/square.
 *
 * SECRETS, per environment (owner 2026-10-04: production keys come later, the
 * sandbox keys stay as they are):
 *   sandbox    — SQUARE_SANDBOX_ACCESS_TOKEN, else SQUARE_ACCESS_TOKEN
 *   production — SQUARE_PRODUCTION_ACCESS_TOKEN, else SQUARE_ACCESS_TOKEN
 *   webhook    — SQUARE_PRODUCTION_WEBHOOK_SIGNATURE_KEY and
 *                SQUARE_WEBHOOK_SIGNATURE_KEY are both tried (one endpoint,
 *                one subscription per environment).
 * Each attempt/row carries its environment, so a hold made in sandbox is
 * still read with the sandbox token after go-live (SQ21). Every call is
 * server → Square; the storefront only holds the PUBLIC Application ID /
 * Location ID and a one-time card token. No Square SDK package (dependencies
 * are frozen) — plain fetch.
 *
 * NETWORK (SQ23): every call has a 15 s timeout. Reads and idempotent writes
 * (CreatePayment with its key, Complete, Cancel, CancelByIdempotencyKey) are
 * retried at most twice on a network error, a timeout, 429 or 5xx, with
 * jittered backoff. What is left is classified: an AMBIGUOUS failure
 * (network/timeout/5xx after retries) means "Square may have acted" — the
 * caller resolves it by reading Square, never by concluding nothing happened.
 */

import { normalizeSquareStatus, type SquareEnvironment, type SquarePaymentStatus } from "./card-rules.ts";

export const SQUARE_VERSION = "2026-09-16";
const HOSTS = { sandbox: "https://connect.squareupsandbox.com", production: "https://connect.squareup.com" } as const;
/** Per-request deadline (headers + body). Mutable only so tests can shorten it. */
export const SQUARE_HTTP = { timeoutMs: 15_000 };
const MAX_RETRIES = 2;

export interface SquareMoney { amount: number; currency: string }
export interface SquareCardDetails {
  status?: string;
  card?: { card_brand?: string; last_4?: string; exp_month?: number; exp_year?: number; card_type?: string; prepaid_type?: string; bin?: string };
  entry_method?: string;
  cvv_status?: string;
  avs_status?: string;
  auth_result_code?: string;
  statement_description?: string;
  card_payment_timeline?: { authorized_at?: string; captured_at?: string; voided_at?: string };
  errors?: SquareApiError[];
}
export interface SquareProcessingFee { effective_at?: string; type?: string; amount_money?: SquareMoney }
export interface SquarePayment {
  id: string;
  status: SquarePaymentStatus;
  amount_money: SquareMoney;
  approved_money?: SquareMoney;
  total_money?: SquareMoney;
  refunded_money?: SquareMoney;
  card_details?: SquareCardDetails;
  processing_fee?: SquareProcessingFee[];
  risk_evaluation?: { created_at?: string; risk_level?: string };
  receipt_number?: string;
  receipt_url?: string;
  reference_id?: string;
  note?: string;
  location_id?: string;
  order_id?: string;
  delay_action?: string;
  delay_duration?: string;
  delayed_until?: string;
  source_type?: string;
  refund_ids?: string[];
  created_at: string;
  updated_at?: string;
  version_token?: string;
}
export interface SquareRefund {
  id: string;
  status: string;
  amount_money?: SquareMoney;
  payment_id?: string;
  reason?: string;
  created_at?: string;
  updated_at?: string;
  processing_fee?: SquareProcessingFee[];
}
export interface SquareDispute {
  id: string;
  dispute_id?: string;
  state: string;
  reason?: string;
  due_at?: string;
  amount_money?: SquareMoney;
  disputed_payment?: { payment_id?: string };
  created_at?: string;
  updated_at?: string;
}
export interface SquareApiError { category?: string; code?: string; detail?: string; field?: string }

export type SquareErrorKind = "card_refusal" | "client" | "auth" | "rate_limited" | "ambiguous" | "not_configured";

export class SquareError extends Error {
  constructor(public status: number, public code: string, message: string, public category = "", public errors: SquareApiError[] = [], public payment: SquarePayment | null = null) {
    super(message);
    this.name = "SquareError";
  }
  /**
   * A refusal of the card itself (declined, CVV, expired, insufficient funds)
   * — the customer's problem, not the Hub's. Square files these under
   * PAYMENT_METHOD_ERROR. A used / expired nonce (CARD_TOKEN_*) and a merchant
   * configuration error (CARD_PROCESSING_NOT_ENABLED) are NOT card refusals.
   */
  get isCardRefusal(): boolean {
    return isCardRefusalCode(this.category, this.code);
  }
  /** What the failure proves (SQ06/SQ23). Only card_refusal and client (4xx) prove Square did not act. */
  get kind(): SquareErrorKind {
    return squareErrorKind(this.status, this.category, this.code);
  }
  get ambiguous(): boolean {
    return this.kind === "ambiguous" || this.kind === "rate_limited";
  }
}

/** Pure, so the deno test pins it. */
export function isCardRefusalCode(category: string, code: string): boolean {
  if (/^CARD_TOKEN_/.test(code) || code === "CARD_PROCESSING_NOT_ENABLED") return false;
  if (category === "PAYMENT_METHOD_ERROR") return true;
  return /^(CARD_DECLINED|CARD_EXPIRED|CARD_NOT_SUPPORTED|CVV_FAILURE|ADDRESS_VERIFICATION_FAILURE|INVALID_EXPIRATION|INSUFFICIENT_FUNDS|GENERIC_DECLINE|VERIFY_CVV_FAILURE|VERIFY_AVS_FAILURE|INVALID_CARD|INVALID_CARD_DATA|TRANSACTION_LIMIT|VOICE_FAILURE|PAN_FAILURE|EXPIRATION_FAILURE|CHIP_INSERTION_REQUIRED|ALLOWABLE_PIN_TRIES_EXCEEDED|MANUALLY_ENTERED_PAYMENT_NOT_SUPPORTED|GIFT_CARD_AVAILABLE_AMOUNT|BAD_EXPIRATION|INVALID_ACCOUNT|CARDHOLDER_INSUFFICIENT_PERMISSIONS|INVALID_PIN|PAYMENT_LIMIT_EXCEEDED|CARD_DECLINED_CALL_ISSUER|CARD_DECLINED_VERIFICATION_REQUIRED)$/.test(code);
}

/** Pure classification (deno test). status 0 = network error / timeout. */
export function squareErrorKind(status: number, category: string, code: string): SquareErrorKind {
  if (code === "square_not_configured") return "not_configured";
  if (status === 0 || status >= 500 || code === "square_bad_response") return "ambiguous";
  if (status === 429 || code === "RATE_LIMITED") return "rate_limited";
  if (status === 401 || status === 403) return "auth";
  if (isCardRefusalCode(category, code)) return "card_refusal";
  return "client";
}

/** Exposed for the deno test: which secret names an environment reads, in order. */
export function accessTokenNames(env: SquareEnvironment): string[] {
  return env === "production"
    ? ["SQUARE_PRODUCTION_ACCESS_TOKEN", "SQUARE_ACCESS_TOKEN"]
    : ["SQUARE_SANDBOX_ACCESS_TOKEN", "SQUARE_ACCESS_TOKEN"];
}

function accessToken(env: SquareEnvironment): string {
  for (const name of accessTokenNames(env)) {
    const key = Deno.env.get(name)?.trim();
    if (key && key.length >= 20) return key;
  }
  throw new SquareError(500, "square_not_configured", `No Square access token for ${env}`);
}

/** Sandbox flag (legacy call sites) or an environment name. */
type Env = SquareEnvironment | boolean;
const envOf = (e: Env): SquareEnvironment => (e === true ? "sandbox" : e === false ? "production" : e);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Jittered exponential backoff: ~400 ms, ~1.2 s. */
export function backoffMs(attempt: number, random: number = Math.random()): number {
  const base = 400 * Math.pow(3, attempt);
  return Math.round(base * (0.75 + random * 0.5));
}

/**
 * HUB-1 (2026-10-05, docs review): a money-moving write (CreatePayment,
 * Complete, Cancel, CancelByIdempotencyKey) whose earlier try MAY have reached
 * Square (network error, timeout, 5xx, 429) and whose retry with the same key
 * then got a 4xx proves nothing: the first request can still be processing
 * (Square's idempotency docs do not say what a same-key retry answers while
 * the original is in flight). The final error is then AMBIGUOUS (status 0,
 * code ambiguous_then_<code>, no category) so the caller reads Square instead
 * of concluding nothing was created. Reads are not affected: a 404 after a
 * timed-out GET is a real 404.
 */
export function afterAmbiguous(err: SquareError): SquareError {
  return new SquareError(0, `ambiguous_then_${err.code}`, `${err.message} (an earlier try may have reached Square)`, "", err.errors, err.payment);
}

async function call(e: Env, method: "GET" | "POST" | "PUT", path: string, body?: unknown, opts: { retry?: boolean; write?: boolean } = {}): Promise<Record<string, unknown>> {
  const env = envOf(e);
  const host = HOSTS[env];
  const retry = opts.retry !== false;
  let last: SquareError | null = null;
  let sawAmbiguous = false;
  for (let attempt = 0; attempt <= (retry ? MAX_RETRIES : 0); attempt++) {
    if (attempt > 0) await sleep(backoffMs(attempt - 1));
    // QC14 (2026-10-05): the deadline covers the WHOLE exchange — headers AND
    // body. A stalled or cut body is a network failure (ambiguous: Square may
    // have acted), retried like one, never parsed as an answer.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SQUARE_HTTP.timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${host}/v2${path}`, {
        method,
        headers: {
          "Authorization": `Bearer ${accessToken(env)}`,
          "Square-Version": SQUARE_VERSION,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
        signal: ctrl.signal,
      });
      text = await res.text();
    } catch (err) {
      if (err instanceof SquareError) throw err; // not configured
      last = new SquareError(0, "network", err instanceof Error ? err.message : String(err));
      sawAmbiguous = true;
      continue;
    } finally {
      clearTimeout(timer);
    }
    let json: Record<string, unknown>;
    try { json = parseSquareBody(text, res.status); }
    catch (e) {
      // R08 (2026-10-08): a 2xx whose body is not JSON is an ambiguous answer
      // (gateway page, cut body) — retried like a 5xx, never read as an empty
      // page or as "nothing exists".
      last = e as SquareError;
      sawAmbiguous = true;
      continue;
    }
    if (res.ok) return json;
    const errors = Array.isArray(json.errors) ? (json.errors as SquareApiError[]) : [];
    const first = errors[0] ?? {};
    const payment = json.payment && typeof json.payment === "object" ? normalizeSquarePayment(json.payment) : null;
    last = new SquareError(res.status, String(first.code ?? res.status), String(first.detail ?? `Square ${res.status}`), String(first.category ?? ""), errors, payment);
    if (!(res.status === 429 || res.status >= 500)) throw opts.write && sawAmbiguous ? afterAmbiguous(last) : last;
    sawAmbiguous = true;
  }
  throw last ?? new SquareError(0, "network", "Square unreachable");
}

/**
 * R08 (2026-10-08): the body of a Square answer. A 2xx MUST be JSON — anything
 * else is square_bad_response (ambiguous). A non-2xx body may be anything
 * (Square's error JSON when it is one; the raw text otherwise, for the message).
 */
export function parseSquareBody(text: string, status: number): Record<string, unknown> {
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    if (status >= 200 && status < 300) throw new SquareError(502, "square_bad_response", "Square answered 2xx with a non-object body");
    return { raw: text.slice(0, 500) };
  } catch (e) {
    if (e instanceof SquareError) throw e;
    if (status >= 200 && status < 300) throw new SquareError(502, "square_bad_response", "Square answered 2xx with unreadable JSON");
    return { raw: text.slice(0, 500) };
  }
}

/** R08: a list field may be omitted (empty page) but, when present, must be an array. */
export function listField<T>(json: Record<string, unknown>, key: string): T[] {
  const v = json[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new SquareError(502, "square_bad_response", `Square answered with a non-list ${key}`);
  return v as T[];
}

/** R08: a cursor may be omitted (last page) but, when present, must be a string. */
export function cursorField(json: Record<string, unknown>): string | null {
  const c = json.cursor;
  if (c === undefined || c === null || c === "") return null;
  if (typeof c !== "string") throw new SquareError(502, "square_bad_response", "Square answered with a non-string cursor");
  return c;
}

/** Every read-back goes through normalizeSquareStatus (card-rules.ts) so every caller compares case-safely. */
export function normalizeSquarePayment(json: unknown): SquarePayment {
  const p = (json ?? {}) as Record<string, unknown>;
  return { ...(p as unknown as SquarePayment), status: normalizeSquareStatus(p.status) };
}

function paymentOf(json: Record<string, unknown>): SquarePayment {
  if (!json.payment || typeof json.payment !== "object") throw new SquareError(502, "square_bad_response", "Square answered without a payment");
  return normalizeSquarePayment(json.payment);
}

export interface CreateCardPaymentInput {
  env: Env;
  /** The one-time token from the Web Payments SDK (card.tokenize). */
  sourceId: string;
  /** A separate verification token (legacy verifyBuyer path) — normally absent. */
  verificationToken?: string | null;
  /** Integer yen, exactly the attempt's amount (never rounded here). */
  amountJpy: number;
  locationId: string;
  /** The attempt's key — the same key for every retry of the same attempt. */
  idempotencyKey: string;
  /** The attempt reference (cja_…) — Square returns it on every read and webhook. */
  referenceId: string;
  /** Free text on the payment: the customer reference + invoice. */
  note: string;
  /** Cardholder billing address (SQ17) — never the gift recipient. */
  billing?: SquareBillingAddress | null;
  /**
   * HUB-4 (2026-10-05): the customer's email on the Hub record, sent as
   * buyer_email_address (Square: max 255). Puts the buyer on the payment in
   * the Dashboard (dispute evidence). Omitted when absent or not an address.
   */
  buyerEmail?: string | null;
}
export interface SquareBillingAddress {
  first_name?: string;
  last_name?: string;
  address_line_1?: string;
  address_line_2?: string;
  locality?: string;
  administrative_district_level_1?: string;
  postal_code?: string;
  country?: string;
}

/** The CreatePayment body (pure — the deno test pins it). */
export function createPaymentBody(i: CreateCardPaymentInput): Record<string, unknown> {
  if (!Number.isSafeInteger(i.amountJpy) || i.amountJpy <= 0) throw new SquareError(400, "bad_amount", "Card amount must be a positive whole number of yen");
  const billing = i.billing ? Object.fromEntries(Object.entries(i.billing).filter(([, v]) => typeof v === "string" && v.trim() !== "").map(([k, v]) => [k, String(v).slice(0, 200)])) : null;
  return {
    idempotency_key: i.idempotencyKey,
    source_id: i.sourceId,
    verification_token: i.verificationToken ?? undefined,
    amount_money: { amount: i.amountJpy, currency: "JPY" },
    location_id: i.locationId,
    autocomplete: false,
    delay_action: "CANCEL",
    reference_id: i.referenceId.slice(0, 40),
    note: i.note.slice(0, 500),
    statement_description_identifier: "CHA JEWELS",
    customer_details: { customer_initiated: true, seller_keyed_in: false },
    billing_address: billing && Object.keys(billing).length > 0 ? billing : undefined,
    ...(buyerEmailOf(i.buyerEmail) ? { buyer_email_address: buyerEmailOf(i.buyerEmail) } : {}),
  };
}

/** A plain address check only (Square validates the rest); never a guess. */
export function buyerEmailOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const e = v.trim();
  return e.length > 0 && e.length <= 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

export const square = {
  /**
   * Authorise only (owner D6): autocomplete:false holds the money; delay_action
   * CANCEL (owner Q2) lets Square drop the hold at the end of its window if
   * nobody captured it. Retried with the SAME key on an ambiguous failure
   * (Square answers the original payment again — no second hold).
   */
  create: (i: CreateCardPaymentInput) => call(i.env, "POST", "/payments", createPaymentBody(i), { write: true }).then(paymentOf),
  /** The payment as Square holds it — the only thing the Hub trusts about a card payment. */
  get: (e: Env, id: string) => call(e, "GET", `/payments/${encodeURIComponent(id)}`).then(paymentOf),
  /** Takes the money (reviewer Confirm). version_token: Square refuses if the payment changed since our read. */
  complete: (e: Env, id: string, versionToken?: string | null) =>
    call(e, "POST", `/payments/${encodeURIComponent(id)}/complete`, versionToken ? { version_token: versionToken } : {}, { write: true }).then(paymentOf),
  /** Voids the hold (Reject, mismatch, fraud). No charge, no fee. */
  cancel: (e: Env, id: string) => call(e, "POST", `/payments/${encodeURIComponent(id)}/cancel`, {}, { write: true }).then(paymentOf),
  /**
   * Voids whatever payment the key created, when the create outcome is unknown
   * (SQ04). Square answers success also when no payment exists for the key —
   * so this proves "nothing stays held under this key", nothing more.
   */
  cancelByIdempotencyKey: (e: Env, idempotencyKey: string) => call(e, "POST", "/payments/cancel", { idempotency_key: idempotencyKey }, { write: true }).then(() => true),
  /** Payments of a location in a time window (recovery of lost create responses / missed webhooks). */
  list: async (e: Env, q: { locationId: string; beginTime: string; endTime: string; cursor?: string | null; limit?: number }) => {
    const p = new URLSearchParams({ location_id: q.locationId, begin_time: q.beginTime, end_time: q.endTime, sort_order: "ASC", limit: String(q.limit ?? 100) });
    if (q.cursor) p.set("cursor", q.cursor);
    const json = await call(e, "GET", `/payments?${p.toString()}`);
    const payments = listField<unknown>(json, "payments").map(normalizeSquarePayment);
    return { payments, cursor: cursorField(json) };
  },
  /**
   * Refunds created in a time window (QC07: discovery of refunds made in the
   * Square Dashboard whatever the age of the capture). Oldest first.
   */
  listRefunds: async (e: Env, q: { beginTime: string; endTime?: string | null; cursor?: string | null; limit?: number }) => {
    const p = new URLSearchParams({ begin_time: q.beginTime, sort_order: "ASC", limit: String(q.limit ?? 100) });
    if (q.endTime) p.set("end_time", q.endTime);
    if (q.cursor) p.set("cursor", q.cursor);
    const json = await call(e, "GET", `/refunds?${p.toString()}`);
    return { refunds: listField<SquareRefund>(json, "refunds"), cursor: cursorField(json) };
  },
  /** Disputes in the given states (QC07: a dispute the webhook missed is still found). */
  listDisputes: async (e: Env, q: { states?: string[]; cursor?: string | null }) => {
    const p = new URLSearchParams();
    if (q.states?.length) p.set("states", q.states.join(","));
    if (q.cursor) p.set("cursor", q.cursor);
    const qs = p.toString();
    const json = await call(e, "GET", `/disputes${qs ? `?${qs}` : ""}`);
    return { disputes: listField<SquareDispute>(json, "disputes"), cursor: cursorField(json) };
  },
  getRefund: async (e: Env, id: string): Promise<SquareRefund> => {
    const json = await call(e, "GET", `/refunds/${encodeURIComponent(id)}`);
    if (!json.refund || typeof json.refund !== "object") throw new SquareError(502, "square_bad_response", "Square answered without a refund");
    return json.refund as SquareRefund;
  },
  getDispute: async (e: Env, id: string): Promise<SquareDispute> => {
    const json = await call(e, "GET", `/disputes/${encodeURIComponent(id)}`);
    if (!json.dispute || typeof json.dispute !== "object") throw new SquareError(502, "square_bad_response", "Square answered without a dispute");
    return json.dispute as SquareDispute;
  },
  /**
   * Events API (Beta): only events from while it is ENABLED are searchable
   * (PUT /v2/events/enable — an owner step), 28 days back, personal token
   * only. An error here is reported, never fatal: the ListPayments sweep is
   * the primary recovery.
   */
  searchEvents: async (e: Env, q: { types: string[]; beginTime: string; endTime: string; cursor?: string | null }) => {
    const json = await call(e, "POST", "/events", {
      cursor: q.cursor ?? undefined,
      limit: 100,
      query: { filter: { event_types: q.types, created_at: { start_at: q.beginTime, end_at: q.endTime } }, sort: { field: "DEFAULT", order: "ASC" } },
    });
    return { events: listField<Record<string, unknown>>(json, "events"), cursor: cursorField(json) };
  },
};

/** The fields apply_square_payment_state / file_square_authorization_atomic take, from a Square payment. */
export function paymentFacts(p: SquarePayment) {
  const amount = Number(p.amount_money?.amount);
  const refunded = Number(p.refunded_money?.amount ?? 0);
  const cd = p.card_details ?? {};
  return {
    amountJpy: Number.isSafeInteger(amount) ? amount : null,
    currency: p.amount_money?.currency ?? null,
    refundedJpy: Number.isSafeInteger(refunded) ? refunded : 0,
    cardBrand: cd.card?.card_brand ?? null,
    cardLast4: cd.card?.last_4 && /^\d{4}$/.test(cd.card.last_4) ? cd.card.last_4 : null,
    receiptUrl: p.receipt_url ?? null,
    riskLevel: p.risk_evaluation?.risk_level ? String(p.risk_evaluation.risk_level).toUpperCase() : null,
    authorizedAt: cd.card_payment_timeline?.authorized_at ?? p.created_at ?? null,
    capturedAt: cd.card_payment_timeline?.captured_at ?? null,
    captureBy: p.delayed_until ?? null,
    providerVersion: p.version_token ?? null,
    providerUpdatedAt: p.updated_at ?? null,
    verification: { avs_status: cd.avs_status ?? null, cvv_status: cd.cvv_status ?? null, auth_result_code: cd.auth_result_code ?? null, card_status: cd.status ?? null },
  };
}

/** Square signature keys to try, in order (production first when set). */
export function webhookSignatureKeys(): string[] {
  return ["SQUARE_PRODUCTION_WEBHOOK_SIGNATURE_KEY", "SQUARE_WEBHOOK_SIGNATURE_KEY"]
    .map((n) => (Deno.env.get(n) ?? "").trim())
    .filter((k, i, a) => k !== "" && a.indexOf(k) === i);
}

/**
 * Webhook signature: base64(HMAC-SHA256(signature_key, notification_url + raw_body)).
 * The notification URL is the one registered in Square Developer → Webhooks,
 * passed by the caller as a constant (a proxy may rewrite the request URL).
 * Compared timing-safe. A missing key or header verifies false — never true.
 * With no explicit key, every configured key is tried.
 */
export async function verifySquareSignature(notificationUrl: string, rawBody: string, header: string | null | undefined, key?: string): Promise<boolean> {
  if (!header) return false;
  const keys = key !== undefined ? [key.trim()].filter(Boolean) : webhookSignatureKeys();
  for (const secret of keys) {
    const expected = await hmacSha256Base64(secret, notificationUrl + rawBody);
    if (timingSafeEqual(expected, header.trim())) return true;
  }
  return false;
}

export async function hmacSha256Base64(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(message));
  let bin = "";
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  return btoa(bin);
}

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}
