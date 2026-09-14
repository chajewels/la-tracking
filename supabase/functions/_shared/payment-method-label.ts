/**
 * The customer-facing NAME of a payment method.
 *
 * Why this exists: `payments.payment_method` / `cash_payments.payment_method`
 * store the Hub's own registry KEY — "rakuten", "gcash", "cash_pickup". The
 * CJ-W-900011 test on 2026-09-14 put one of those keys straight into a
 * customer's inbox as "Payment Method: rakuten".
 *
 * It cannot be resolved from `transfer_payment_methods`: that table describes
 * the ACCOUNTS a customer pays INTO (one JP bank row, one overseas bank row,
 * keyed by region and method_type) and has no row keyed "rakuten". Its
 * bank_name happens to read "Rakuten Bank Ltd (楽天銀行)", which is the
 * destination account, not the method the customer chose. Two different
 * vocabularies; joining them would be a coincidence, not a lookup.
 *
 * So this mirrors src/lib/payment-method-registry.ts, which edge functions
 * cannot import (it is browser TypeScript under src/). KEEP THE TWO IN STEP:
 * a method added there and not here degrades to printing nothing.
 *
 * Stored values are inconsistent in real data — "PayPay" and "paypay",
 * "Sumitomo", "sumitomo" and "Sumitomo Bank", "BDO" and "bdo" all appear in
 * cash_payments — so matching is case-insensitive and alias-aware.
 */

const LABELS: Record<string, string> = {
  // PHP group
  bdo: "BDO",
  bpi: "BPI",
  metrobank: "Metrobank",
  gcash: "GCash",
  cash_pickup: "Cash Pick Up",
  // JPY group
  cash: "Cash Payment",
  cod: "Cash on Delivery",
  rakuten: "Rakuten",
  sumitomo: "Sumitomo",
  paypay: "PayPay",
  jp_bank: "JP Bank",
  credit_card: "Credit Card",
  genkin_kaketome: "Genkin Kaketome",
  // Neutral
  bank_transfer: "Bank Transfer",
  other: "Other",
  loyalty_redemption: "Loyalty Points",
};

/** Alternate spellings seen in stored data → canonical key. Lowercased. */
const ALIASES: Record<string, string> = {
  "cash pickup": "cash_pickup",
  "cash pick up": "cash_pickup",
  "cash-pickup": "cash_pickup",
  "rakuten bank": "rakuten",
  "sumitomo bank": "sumitomo",
  "cash payment": "cash",
  "cash-payment": "cash",
  "cash on delivery": "cod",
  "cash-on-delivery": "cod",
  "bank transfer": "bank_transfer",
  "credit card": "credit_card",
  "jp bank": "jp_bank",
};

/**
 * The display name, or null when nothing resolves.
 *
 * NULL IS THE POINT: a customer email prints nothing rather than a raw key.
 * An unknown method is a gap in this map, and a missing line reads as an
 * oversight while "rakuten" reads as a broken system.
 */
export function paymentMethodLabel(raw: unknown): string | null {
  const key = String(raw ?? "").trim().toLowerCase();
  if (!key) return null;
  const canonical = ALIASES[key] ?? key;
  return LABELS[canonical] ?? null;
}
