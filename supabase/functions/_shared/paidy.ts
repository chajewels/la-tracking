/**
 * Paidy API client (2026-10-03). docs/PAIDY.md; reference paidy.com/docs/api/en.
 *
 * The SECRET key lives only in the edge-function secret PAIDY_SECRET_KEY and
 * only here is it read. Every call is server → Paidy; the storefront never
 * talks to this API. One key family at a time: the key decides whether a
 * payment is a test payment, and the Hub refuses a payment whose `test` flag
 * disagrees with paidy_mode (website POST /orders/:id/paidy).
 */

import { normalizePaidyStatus, validatePaidyPaymentObject } from "./paidy-rules.ts";

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
  refunds?: { id: string; amount: number; created_at: string; capture_id?: string; reason?: string | null }[];
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

/** R09: every Paidy call has a deadline, so a slow Paidy can never hold a webhook past its 10 s. */
export const PAIDY_TIMEOUT_MS = 6000;

async function call(method: "GET" | "POST", path: string, expectId: string, body?: unknown, timeoutMs = PAIDY_TIMEOUT_MS): Promise<PaidyPayment> {
  const key = secretKey(); // paidy_not_configured is thrown as itself, never as a network error
  let res: Response;
  try {
    res = await fetch(`${PAIDY_API}${path}`, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "Authorization": `Bearer ${key}`,
        "Paidy-Version": PAIDY_VERSION,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch (e) {
    // A timeout or network failure is NOT an answer from Paidy: callers treat
    // it as "unknown" and read Paidy back later (never as success or refusal).
    throw new PaidyError(503, e instanceof DOMException && e.name === "TimeoutError" ? "paidy_timeout" : "paidy_network", String(e instanceof Error ? e.message : e));
  }
  const text = await res.text();
  let json: Record<string, unknown> = {};
  let unparseable = false;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 500) }; unparseable = true; }
  if (!res.ok) {
    throw new PaidyError(res.status, String(json.code ?? res.status), String(json.description ?? json.title ?? `Paidy ${res.status}`));
  }
  // PA12: a 2xx is a payment only when it is a complete financial object FOR
  // THE ID WE ASKED ABOUT. Anything else is thrown as paidy_bad_response —
  // every caller already treats a non-404 PaidyError as "unknown: keep the
  // row / event and read Paidy again", never as a verified state.
  if (unparseable) throw new PaidyError(502, "paidy_bad_response", "Paidy answered 2xx with a body that is not JSON");
  const v = validatePaidyPaymentObject(json, expectId);
  if (!v.ok) throw new PaidyError(502, "paidy_bad_response", `Paidy answered 2xx with an incomplete payment object: ${v.reason}${v.detail ? ` (${v.detail})` : ""}`);
  return normalizePaidyPayment(v.payment);
}

/** Every API read-back goes through normalizePaidyStatus (paidy-rules.ts) so website / paidy-webhook compare case-safely. */
export function normalizePaidyPayment(json: Record<string, unknown>): PaidyPayment {
  return { ...(json as unknown as PaidyPayment), status: normalizePaidyStatus(json.status) as PaidyPayment["status"] };
}

/** Paidy payment ids look like pay_…; refuse anything else before it reaches a URL. */
export function isPaidyPaymentId(id: unknown): id is string {
  return typeof id === "string" && /^pay_[A-Za-z0-9_-]{6,80}$/.test(id);
}

export const paidy = {
  /** The authorisation as Paidy holds it — the only thing the Hub trusts about a Paidy payment. */
  get: (id: string) => call("GET", `/payments/${encodeURIComponent(id)}`, id),
  /** Releases an authorisation (reviewer Reject, a mismatch, a stale filing). No charge.
   *  There is deliberately NO capture here (owner 2026-10-04): staff capture in
   *  Paidy's merchant dashboard and the Hub records what Paidy reports. */
  close: (id: string) => call("POST", `/payments/${encodeURIComponent(id)}/close`, id, {}),
};
