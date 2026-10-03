/**
 * Paidy API client (2026-10-03). docs/PAIDY.md; reference paidy.com/docs/api/en.
 *
 * The SECRET key lives only in the edge-function secret PAIDY_SECRET_KEY and
 * only here is it read. Every call is server → Paidy; the storefront never
 * talks to this API. One key family at a time: the key decides whether a
 * payment is a test payment, and the Hub refuses a payment whose `test` flag
 * disagrees with paidy_mode (website POST /orders/:id/paidy).
 */

const PAIDY_API = "https://api.paidy.com";
const PAIDY_VERSION = "2018-04-10";

export interface PaidyCapture { id: string; created_at: string; amount: number }
export interface PaidyPayment {
  id: string;
  status: "AUTHORIZED" | "CLOSED" | "REJECTED";
  amount: number;
  currency: string;
  test: boolean;
  created_at: string;
  expires_at?: string;
  order?: { order_ref?: string | null } | null;
  captures?: PaidyCapture[];
  refunds?: { id: string; amount: number; created_at: string }[];
}

export class PaidyError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "PaidyError";
  }
}

function secretKey(): string {
  const key = Deno.env.get("PAIDY_SECRET_KEY")?.trim();
  if (!key || !/^sk_(test|live)_/.test(key)) throw new PaidyError(500, "paidy_not_configured", "PAIDY_SECRET_KEY is not set");
  return key;
}

/** Which key family the Hub is configured with — compared to the mode before any money moves. */
export function paidySecretIsTest(): boolean {
  return secretKey().startsWith("sk_test_");
}

async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<PaidyPayment> {
  const res = await fetch(`${PAIDY_API}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${secretKey()}`,
      "Paidy-Version": PAIDY_VERSION,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 500) }; }
  if (!res.ok) {
    throw new PaidyError(res.status, String(json.code ?? res.status), String(json.description ?? json.title ?? `Paidy ${res.status}`));
  }
  return json as unknown as PaidyPayment;
}

/** Paidy payment ids look like pay_…; refuse anything else before it reaches a URL. */
export function isPaidyPaymentId(id: unknown): id is string {
  return typeof id === "string" && /^pay_[A-Za-z0-9_-]{6,80}$/.test(id);
}

export const paidy = {
  /** The authorisation as Paidy holds it — the only thing the Hub trusts about a Paidy payment. */
  get: (id: string) => call("GET", `/payments/${encodeURIComponent(id)}`),
  /** Takes the money (reviewer Confirm). Paidy answers the payment with its new capture. */
  capture: (id: string, metadata?: Record<string, string>) =>
    call("POST", `/payments/${encodeURIComponent(id)}/captures`, metadata ? { metadata } : {}),
  /** Releases an authorisation (reviewer Reject, or a mismatch). No charge. */
  close: (id: string) => call("POST", `/payments/${encodeURIComponent(id)}/close`, {}),
};
