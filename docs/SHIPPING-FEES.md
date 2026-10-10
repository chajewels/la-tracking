# Shipping fees and couriers

Website-orders PR 2 (2026-09-27). Plan: `~/Code/reference/website-orders/INVESTIGATION-v2.md`
§2.7, §3 and §7 row 2. Migration: `supabase/migrations/20261008100000_shipping_fees_couriers.sql`
(the owner applies it in the SQL Editor, not through Lovable).

## 1. The rate card — `public.shipping_rates`

- **Rule.** Shipping is charged on the **pieces subtotal**, in yen. For the
  destination country, the **active** row with the **highest** `min_subtotal_jpy`
  the subtotal reaches applies. No active row for the country means no fee on
  the card: the checkout asks for a manual quote. One reader:
  `shippingFor()` in `supabase/functions/website/index.ts`. The Hub card's
  `feeFor()` (`src/components/website/shipping-fees.ts`) mirrors it for the
  confirm dialogs only.
- **Live card (owner, 2026-09-27):**

  | Country | From | Fee |
  |---|---|---|
  | JP | ¥0 | ¥800 |
  | JP | ¥8,000 | ¥0 |
  | PH | ¥0 | ¥3,500 |
  | PH | ¥100,000 | ¥0 |

  The old "JP free from ¥50,000" seed is gone (see §3).
- **Where staff change it:** Hub → Website → Settings → **Shipping fees**.
  ADMIN ONLY: the card renders for admins only, and the server re-checks the
  admin role. Add a rate, change a fee, deactivate a rate, reactivate one; every
  change has a confirm dialog that says what the checkout will charge afterwards.
- **Writers:** `set_shipping_rate(country, min_subtotal_jpy, fee_jpy)` (add,
  change fee, reactivate; keyed on country + threshold) and
  `deactivate_shipping_rate(id)`. Both write one `audit_logs` row
  (`entity_type = 'shipping_rate'`, old → new). `get_shipping_rates()` reads the
  card with `can_change`.
- **Guard:** `trg_guard_shipping_rates` refuses every other INSERT/UPDATE, and
  refuses DELETE and TRUNCATE **always** (even from the SQL Editor, even with the
  flag). Never delete a rate: a deleted row comes back **active** on a rebuild
  from migrations (the seeds use `ON CONFLICT DO NOTHING`); a deactivated row
  survives it.
- **PH rows stay on** until the owner switches them off in the card (PR 9 of the
  plan), after the storefront says "shipping added at confirmation".
- **Before the migration is applied** the RPCs do not exist (PostgREST
  `PGRST202`); the card says "Waiting for the database update" instead of an
  error, and checkout keeps charging the existing card.

## 2. Couriers — `public.shipping_methods`

Live rows (2026-09-27), plus the one this PR adds:

| Courier | Used for |
|---|---|
| Yamato Transport (Domestic JP) | JP |
| Japan Post — Yu-Pack (Domestic JP) | JP |
| DHL Express | other countries |
| Japan Post — EMS (International) | other countries |
| LBC Express (PH Domestic) | PH domestic leg |
| **Pabitbit Service (Japan → Philippines, LBC local delivery)** — new | PH |

- **Pabitbit tracking (W2-11):** staff record the **LBC** tracking number, so the
  Pabitbit row uses the LBC row's `tracking_url_template` (copied from that row
  by the migration, never retyped). The customer can track the parcel on LBC.
- **Planned courier:** `planned_shipping_method_id` (nullable, FK
  `shipping_methods`, ON DELETE RESTRICT) on `cash_orders` and
  `layaway_accounts`, the two tables the web checkout writes. It is the courier
  staff **plan** to use, chosen on the confirmation screen (plan PR 4); the
  courier that actually shipped stays in `shipping_method_id` + `tracking_number`.
- **Defaults (W2-10, owner-amended 2026-09-27):** only **PH** has one —
  Pabitbit — and it is preselected by the PR 4 confirmation screen, **never** by
  a database default. **JP has no default** (staff choose Yamato or Japan Post
  Yu-Pack). **Other countries have no default** (staff choose DHL Express or
  Japan Post EMS).

## 3. Why the JP ¥50,000 seed cannot come back

The only statements that ever inserted rates are the identical seeds in
`20260911024728_…sql:163-165` and `20260911120000_phase2_step2_checkout.sql:163-165`
(`('JP',50000,0)` among them, `ON CONFLICT DO NOTHING`).

- **Live:** both versions are recorded as applied, and an applied migration never
  re-runs. The PR 2 migration's convergence step matches nothing on live.
- **Rebuild from the repo** (local reset, preview branch): the seeds run first
  and insert JP 50000 → 0; the PR 2 migration runs after them and moves that row
  to 8000 (or, if both free rows somehow exist, deactivates the 50000 one). After
  that the guard trigger refuses any insert that does not come through
  `set_shipping_rate`.

## 4. Local tests

`docs/sql/20261008_shipping_fees_couriers_local_stub.sql` +
`_local_tests.sql` (throwaway Postgres; run once as a rebuild and once with
`shipfees.as_live=yes`). Frontend: `src/test/shipping-fees.test.tsx`.

## Tracking deep links (2026-10-02, housekeeping)

- `src/lib/tracking-link.ts` is the ONE builder for a carrier's "Track parcel"
  link (Hub ShipmentTrackingCard, portal PortalTrackingRow): spaces, full-width
  spaces and hyphens are stripped from the number before the template is
  filled (letters stay — EMS codes are EJ…JP). A template without
  `{tracking_code}` or with `supports_deeplink = false` is a landing page.
- Yamato deep-links to the Kuroneko Members parcel page
  `https://member.kms.kuronekoyamato.co.jp/parcel/detail?pno=<digits>`
  (verified with a real parcel; the old toi.kuronekoyamato.co.jp form ignores
  GET parameters). Migration 20261025100000.

## Cash on delivery fee (2026-10-10)

The 代引手数料 is NOT a shipping rate and is not on this card. It has its own table
(`system_settings.cod_fee_table`, Website → Settings → Cash on delivery, `set_cod_settings`), its own
column (`cash_orders.cod_fee`, …) and its own line in every total. It is bracketed on the amount the
courier collects — pieces after points + this card's shipping (+ services − discount) — so a
shipping change can move the COD fee to another bracket. docs/COD.md.
