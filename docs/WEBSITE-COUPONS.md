# Website coupons

Owner decisions 2026-10-15. Migration `supabase/migrations/20261217100000_website_coupons.sql`.

## Rules

- A coupon is a code worth a **percent** (1–100) or a **whole number of yen** off the **pieces**,
  never shipping, services or the cash-on-delivery fee. One coupon per order.
- Options per coupon: minimum pieces subtotal (yen), start / end, total uses, uses per customer
  (default 1), full-price pieces only (default off: the coupon applies on the price she pays,
  sale price included), allowed on layaway (default on), active, staff note.
- **Coupon first, then points.** The points cap is pieces − coupon. A layaway plan is priced on
  pieces − coupon, with the same plan-minimum check.
- A use is **held** at checkout (the draft), **used** when staff Confirm, **released** when the
  draft is declined or expires. Held + used count towards total uses and uses per customer.

## Where the maths lives

`public.website_coupon_quote(code, customer, subtotal_jpy, full_price_subtotal_jpy, mode)` is the
only place a coupon is validated and priced. The `website` edge function and the storefront relay
its answer (`_shared/website-coupons.ts` only converts its yen to pesos, half-up, as SQL `round()`).
`create_web_draft_atomic` locks the coupon row and asks it again inside the transaction that holds
the pieces; a changed answer is `coupon_changed`.

## The draft and the order

- The draft stores its figures **after** the coupon (`subtotal`, `total`, `subtotal_jpy`,
  `total_jpy`) plus `coupon_code`, `coupon_discount_jpy`, `coupon_discount`, `coupon_use_id`.
- The review screen (`_shared/web-draft-figures.ts`) adds the coupon back: Pieces shows the full
  price, a "Coupon CODE −¥X" row sits under it, and the Discount box starts at the coupon and may
  not go below it (`discount_below_coupon`, also refused by `materialize_web_draft_atomic`).
- The order's `discount_amount` is the **whole** discount including the coupon;
  `cash_orders.coupon_code` / `layaway_accounts.coupon_code` is the label only.
- Loyalty basis = pieces − whole discount, in yen (the coupon is never earned on).

## Website API

- `POST /checkout/quote` takes optional `coupon_code`; a refused code is 409 with its reason and no
  quote is created.
- `POST /checkout/quote/:id/choice` and `POST /checkout/pay` take `coupon_code` (absent = keep the
  stored code, `""`/`null` = clear). A refused code is 409 and nothing is stored.
- Every quote read carries `coupon: null | { code, error } | { code, kind, value, discount_jpy,
  discount, error: null }` and `totals.coupon_discount`; `total_after_points` and
  `due_now_after_points` are after the coupon. The pay reply carries `coupon_code`,
  `coupon_discount`, `coupon_discount_jpy`.
- Errors (409): `coupon_not_found`, `coupon_inactive`, `coupon_not_started`, `coupon_expired`,
  `coupon_exhausted`, `coupon_customer_limit`, `coupon_min_subtotal`, `coupon_layaway_not_allowed`,
  `coupon_full_price_only`, `coupon_changed`, `coupon_total_zero`.

## Hub

Website → Settings → Coupons (admin only): `get_website_coupons`, `upsert_website_coupon`,
`set_website_coupon_active` — admin role, one `audit_logs` row per change, never deleted. A coupon's
code cannot change once it has been used (`coupon_code_locked`).

## Not built

- A cancelled order does not give its coupon use back (it stays `used`).
- The customer emails show the reduced total but have no separate coupon line.
