/**
 * Square API client (S2, 2026-10-04). docs/SQUARE.md; reference
 * developer.squareup.com/reference/square (Payments API, Webhooks).
 *
 * The ACCESS TOKEN lives only in the edge-function secret SQUARE_ACCESS_TOKEN
 * and the webhook SIGNATURE KEY only in SQUARE_WEBHOOK_SIGNATURE_KEY; only
 * here are they read. Every call is server → Square; the storefront only
 * ever holds the PUBLIC Application ID / Location ID and a one-time card
 * token from the Web Payments SDK. No Square SDK package (dependencies are
 * frozen) — plain fetch.
 *
 * Which host (sandbox / production) is NOT decided by the token (Square tokens
 * carry no family): the caller passes `sandbox` from square_mode ("test" →
 * sandbox). A production token against the sandbox host (or the reverse) is
 * answered 401 by Square, which surfaces as SquareError 401 — never a charge.
 */

import { normalizeSquareStatus, type SquarePaymentStatus } from "./card-rules.ts";

export const SQUARE_VERSION = "2026-09-16";
const HOSTS = { sandbox: "https://connect.squareupsandbox.com", production: "https://connect.squareup.com" } as const;

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
export interface SquarePayment {
  id: string;
  status: SquarePaymentStatus;
  amount_money: SquareMoney;
  approved_money?: SquareMoney;
  total_money?: SquareMoney;
  refunded_money?: SquareMoney;
  card_details?: SquareCardDetails;
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
  created_at: string;
  updated_at?: string;
  version_token?: string;
}
export interface SquareApiError { category?: string; code?: string; detail?: string; field?: string }

export class SquareError extends Error {
  constructor(public status: number, public code: string, message: string, public category = "", public errors: SquareApiError[] = []) {
    super(message);
    this.name = "SquareError";
  }
  /**
   * A refusal of the card itself (declined, CVV, expired, insufficient funds)
   * — the customer's problem, not the Hub's. Square files these under
   * PAYMENT_METHOD_ERROR. A used / expired nonce (CARD_TOKEN_*) and a merchant
   * configuration error (CARD_PROCESSING_NOT_ENABLED) are NOT card refusals
   * (review finding S3).
   */
  get isCardRefusal(): boolean {
    return isCardRefusalCode(this.category, this.code);
  }
}

/** Pure, so the deno test pins it. */
export function isCardRefusalCode(category: string, code: string): boolean {
  if (/^CARD_TOKEN_/.test(code) || code === "CARD_PROCESSING_NOT_ENABLED") return false;
  if (category === "PAYMENT_METHOD_ERROR") return true;
  return /^(CARD_DECLINED|CARD_EXPIRED|CARD_NOT_SUPPORTED|CVV_FAILURE|ADDRESS_VERIFICATION_FAILURE|INVALID_EXPIRATION|INSUFFICIENT_FUNDS|GENERIC_DECLINE|VERIFY_CVV_FAILURE|VERIFY_AVS_FAILURE|INVALID_CARD|INVALID_CARD_DATA|TRANSACTION_LIMIT|VOICE_FAILURE|PAN_FAILURE|EXPIRATION_FAILURE|CHIP_INSERTION_REQUIRED|ALLOWABLE_PIN_TRIES_EXCEEDED|MANUALLY_ENTERED_PAYMENT_NOT_SUPPORTED|GIFT_CARD_AVAILABLE_AMOUNT|BAD_EXPIRATION|INVALID_ACCOUNT|CARDHOLDER_INSUFFICIENT_PERMISSIONS|INVALID_PIN|PAYMENT_LIMIT_EXCEEDED|CARD_DECLINED_CALL_ISSUER|CARD_DECLINED_VERIFICATION_REQUIRED)$/.test(code);
}

function accessToken(): string {
  const key = Deno.env.get("SQUARE_ACCESS_TOKEN")?.trim();
  if (!key || key.length < 20) throw new SquareError(500, "square_not_configured", "SQUARE_ACCESS_TOKEN is not set");
  return key;
}

async function call(sandbox: boolean, method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>> {
  const host = sandbox ? HOSTS.sandbox : HOSTS.production;
  const res = await fetch(`${host}/v2${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${accessToken()}`,
      "Square-Version": SQUARE_VERSION,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 500) }; }
  if (!res.ok) {
    const errors = Array.isArray(json.errors) ? (json.errors as SquareApiError[]) : [];
    const first = errors[0] ?? {};
    throw new SquareError(res.status, String(first.code ?? res.status), String(first.detail ?? `Square ${res.status}`), String(first.category ?? ""), errors);
  }
  return json;
}

/** Every read-back goes through normalizeSquareStatus (card-rules.ts) so website / review / webhook compare case-safely. */
export function normalizeSquarePayment(json: unknown): SquarePayment {
  const p = (json ?? {}) as Record<string, unknown>;
  return { ...(p as unknown as SquarePayment), status: normalizeSquareStatus(p.status) };
}

function paymentOf(json: Record<string, unknown>): SquarePayment {
  if (!json.payment || typeof json.payment !== "object") throw new SquareError(502, "square_bad_response", "Square answered without a payment");
  return normalizeSquarePayment(json.payment);
}

export interface CreateCardPaymentInput {
  sandbox: boolean;
  /** The one-time token from the Web Payments SDK (card.tokenize). */
  sourceId: string;
  /** The 3-D Secure verification token (card.tokenize with verificationDetails). */
  verificationToken?: string | null;
  amountJpy: number;
  locationId: string;
  /** order id + attempt — Square makes the call idempotent on it. */
  idempotencyKey: string;
  /** The invoice number: shows in the Square Dashboard and on exports. */
  referenceId: string;
  /** Free text on the payment (the customer reference). */
  note: string;
  /** Square emails its own receipt when set — we do NOT set it (the Hub sends the order emails). */
  buyerEmail?: string | null;
}

export const square = {
  /**
   * Authorise only (owner D6): autocomplete:false holds the money; delay_action
   * CANCEL (owner Q2) lets Square drop the hold at the end of its window if
   * nobody captured it. statement_description_identifier is the merchant
   * statement suffix ("CHA JEWELS"). JPY has no minor unit: amount = yen.
   */
  create: (i: CreateCardPaymentInput) =>
    call(i.sandbox, "POST", "/payments", {
      idempotency_key: i.idempotencyKey,
      source_id: i.sourceId,
      verification_token: i.verificationToken ?? undefined,
      amount_money: { amount: Math.round(i.amountJpy), currency: "JPY" },
      location_id: i.locationId,
      autocomplete: false,
      delay_action: "CANCEL",
      reference_id: i.referenceId.slice(0, 40),
      note: i.note.slice(0, 500),
      statement_description_identifier: "CHA JEWELS",
      buyer_email_address: i.buyerEmail ?? undefined,
    }).then(paymentOf),
  /** The payment as Square holds it — the only thing the Hub trusts about a card payment. */
  get: (sandbox: boolean, id: string) => call(sandbox, "GET", `/payments/${encodeURIComponent(id)}`).then(paymentOf),
  /** Takes the money (reviewer Confirm). */
  complete: (sandbox: boolean, id: string) => call(sandbox, "POST", `/payments/${encodeURIComponent(id)}/complete`, {}).then(paymentOf),
  /** Voids the hold (reviewer Reject, or a mismatch). No charge, no fee. */
  cancel: (sandbox: boolean, id: string) => call(sandbox, "POST", `/payments/${encodeURIComponent(id)}/cancel`, {}).then(paymentOf),
};

/**
 * Webhook signature: base64(HMAC-SHA256(signature_key, notification_url + raw_body)).
 * The notification URL is the one registered in Square Developer → Webhooks,
 * passed by the caller as a constant (a proxy may rewrite the request URL).
 * Compared timing-safe. A missing key or header verifies false — never true.
 */
export async function verifySquareSignature(notificationUrl: string, rawBody: string, header: string | null | undefined, key?: string): Promise<boolean> {
  const secret = (key ?? Deno.env.get("SQUARE_WEBHOOK_SIGNATURE_KEY") ?? "").trim();
  if (!secret || !header) return false;
  const expected = await hmacSha256Base64(secret, notificationUrl + rawBody);
  return timingSafeEqual(expected, header.trim());
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
