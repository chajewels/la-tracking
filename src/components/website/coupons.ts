/**
 * Website coupons (Website → Settings): the rules, words and shapes the card
 * uses, kept out of CouponsCard.tsx so the component file exports only
 * components and the rules can be unit-tested.
 *
 * The coupons are public.website_coupons (owner 2026-10-15): a code worth a
 * percent or a number of yen off the PIECES (never shipping, services or the
 * COD fee), one per order. The maths is the SQL function website_coupon_quote;
 * the table is written only through upsert_website_coupon /
 * set_website_coupon_active (admin role, audited) — migration
 * 20261217100000_website_coupons.sql. None of these are in
 * src/integrations/supabase/types.ts yet, hence the local types.
 */

export const WEBSITE_COUPONS_KEY = ["website-coupons"] as const;

export type CouponKind = "percent" | "amount";

export interface WebsiteCoupon {
  id: string;
  code: string;
  kind: CouponKind;
  value: number;
  min_subtotal_jpy: number | null;
  starts_at: string | null;
  ends_at: string | null;
  max_uses: number | null;
  per_customer_limit: number;
  full_price_only: boolean;
  allow_layaway: boolean;
  is_active: boolean;
  note: string | null;
  used_count: number;
  held_count: number;
}

export type CouponsState =
  | { available: true; coupons: WebsiteCoupon[] }
  | { available: false };

/** The add/edit form, as text inputs. Dates are `datetime-local` values (local time) or "". */
export interface CouponForm {
  id: string | null;
  code: string;
  kind: CouponKind;
  value: string;
  min_subtotal_jpy: string;
  starts_at: string;
  ends_at: string;
  max_uses: string;
  per_customer_limit: string;
  full_price_only: boolean;
  allow_layaway: boolean;
  is_active: boolean;
  note: string;
}

export const COUPON_NOTE =
  "A coupon comes off the pieces only — never shipping, services or the cash on delivery fee. One coupon per order; points apply after it.";

export function emptyCouponForm(): CouponForm {
  return {
    id: null, code: "", kind: "percent", value: "", min_subtotal_jpy: "", starts_at: "", ends_at: "",
    max_uses: "", per_customer_limit: "1", full_price_only: false, allow_layaway: true, is_active: true, note: "",
  };
}

/** ISO timestamp → `datetime-local` value in the browser's time. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formFromCoupon(c: WebsiteCoupon): CouponForm {
  return {
    id: c.id, code: c.code, kind: c.kind, value: String(c.value),
    min_subtotal_jpy: c.min_subtotal_jpy == null ? "" : String(c.min_subtotal_jpy),
    starts_at: toLocalInput(c.starts_at), ends_at: toLocalInput(c.ends_at),
    max_uses: c.max_uses == null ? "" : String(c.max_uses), per_customer_limit: String(c.per_customer_limit),
    full_price_only: c.full_price_only, allow_layaway: c.allow_layaway, is_active: c.is_active, note: c.note ?? "",
  };
}

/** What a typed code is stored as: upper case, no surrounding spaces. */
export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

const WHOLE = /^\d+$/;

/** Validates the form (the server re-checks every field). Returns an error message or null. */
export function validateCouponForm(f: CouponForm): string | null {
  if (!/^[A-Z0-9-]{3,20}$/.test(normalizeCode(f.code))) {
    return "The code is 3–20 letters, digits or hyphens (no spaces).";
  }
  if (!WHOLE.test(f.value.trim()) || Number(f.value) <= 0) {
    return f.kind === "percent" ? "The percent is a whole number from 1 to 100." : "The amount is a whole number of yen, more than 0.";
  }
  if (f.kind === "percent" && Number(f.value) > 100) return "The percent is a whole number from 1 to 100.";
  if (f.kind === "amount" && Number(f.value) > 100_000_000) return "That amount is too large.";
  if (f.min_subtotal_jpy.trim() !== "" && (!WHOLE.test(f.min_subtotal_jpy.trim()) || Number(f.min_subtotal_jpy) <= 0)) {
    return "The minimum is a whole number of yen, more than 0 (or leave it empty).";
  }
  if (f.max_uses.trim() !== "" && (!WHOLE.test(f.max_uses.trim()) || Number(f.max_uses) <= 0)) {
    return "Total uses is a whole number, more than 0 (or leave it empty for no limit).";
  }
  if (!WHOLE.test(f.per_customer_limit.trim()) || Number(f.per_customer_limit) <= 0) {
    return "Uses per customer is a whole number, 1 or more.";
  }
  if (f.starts_at && Number.isNaN(new Date(f.starts_at).getTime())) return "The start date is not valid.";
  if (f.ends_at && Number.isNaN(new Date(f.ends_at).getTime())) return "The end date is not valid.";
  if (f.starts_at && f.ends_at && new Date(f.ends_at) <= new Date(f.starts_at)) return "The end must be after the start.";
  return null;
}

/** The jsonb upsert_website_coupon takes. */
export function couponPayload(f: CouponForm): Record<string, unknown> {
  const opt = (s: string) => (s.trim() === "" ? null : Number(s));
  const iso = (s: string) => (s ? new Date(s).toISOString() : null);
  return {
    ...(f.id ? { id: f.id } : {}),
    code: normalizeCode(f.code), kind: f.kind, value: Number(f.value),
    min_subtotal_jpy: opt(f.min_subtotal_jpy), starts_at: iso(f.starts_at), ends_at: iso(f.ends_at),
    max_uses: opt(f.max_uses), per_customer_limit: Number(f.per_customer_limit),
    full_price_only: f.full_price_only, allow_layaway: f.allow_layaway, is_active: f.is_active,
    note: f.note.trim() === "" ? null : f.note.trim(),
  };
}

export function formatYen(n: number): string {
  return `¥${Math.round(n).toLocaleString("en-US")}`;
}

/** "10% off" / "¥5,000 off" */
export function couponValueLabel(c: Pick<WebsiteCoupon, "kind" | "value">): string {
  return c.kind === "percent" ? `${c.value}% off` : `${formatYen(c.value)} off`;
}

/** "3 used · 1 held / 50" */
export function usesLabel(c: Pick<WebsiteCoupon, "used_count" | "held_count" | "max_uses">): string {
  return `${c.used_count} used · ${c.held_count} held / ${c.max_uses == null ? "no limit" : c.max_uses}`;
}

/** "Active" / "Inactive" / "Scheduled" / "Ended" — what a checkout would see now. */
export function couponStatus(c: Pick<WebsiteCoupon, "is_active" | "starts_at" | "ends_at">, now = new Date()): string {
  if (!c.is_active) return "Inactive";
  if (c.ends_at && new Date(c.ends_at) <= now) return "Ended";
  if (c.starts_at && new Date(c.starts_at) > now) return "Scheduled";
  return "Active";
}

/** Words for a refusal from upsert_website_coupon / set_website_coupon_active. */
export function couponRefusal(code: string): string {
  switch (code) {
    case "permission_denied": return "Only an admin can change coupons.";
    case "user_identity_required": return "Your session has expired. Sign in again.";
    case "coupon_code_taken": return "Another coupon already uses that code.";
    case "coupon_code_locked": return "This coupon has been used, so its code cannot change. Create a new coupon instead.";
    case "invalid_code": return "The code is 3–20 letters, digits or hyphens (no spaces).";
    case "invalid_kind": return "Choose percent or yen.";
    case "invalid_value": return "The value is not valid (percent 1–100, or yen more than 0).";
    case "invalid_min_subtotal": return "The minimum is a whole number of yen, more than 0.";
    case "invalid_dates": return "The end must be after the start.";
    case "invalid_max_uses": return "Total uses must be more than 0.";
    case "invalid_per_customer_limit": return "Uses per customer must be 1 or more.";
    case "invalid_input": return "One of the fields is not a valid number or date.";
    case "not_found": return "That coupon no longer exists.";
    default: return code || "Could not save the coupon.";
  }
}
