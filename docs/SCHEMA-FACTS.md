## SCHEMA FACTS & OPERATIONAL LEARNINGS (added 2026-05-16)

### payments.submitted_by_type CHECK constraint (added 2026-05-18)

  - `payments` has CHECK constraint `payments_submitted_by_type_check`
    restricting `submitted_by_type` to {'customer', 'staff'} ONLY.
    Writing 'admin' or 'finance' silently fails the INSERT.
  - `cash_payments` has NO such constraint (its only CHECK is
    amount_paid > 0).
  - ALL system-generated synthetic payments (loyalty_redemption, and
    any future automated payment) MUST write `submitted_by_type='staff'`
    on the `payments` table. The actual approver is preserved via
    `entered_by_user_id` + `submitted_by_name`. (Root cause of the
    TEST-004 bfd0da07 silent-fail; fixed Phase B Patch 1, 2afca0f.)

### loyalty_redemptions / loyalty_transactions / payment_allocations columns (added 2026-05-18)

  - `loyalty_redemptions` has NO `confirmed_at` column. Approval timing
    is derived (via the corresponding loyalty_transactions.created_at,
    or processed_at where present) — do NOT reference confirmed_at.
  - `loyalty_transactions` uses the `notes` column, NOT `remarks`.
  - `payment_allocations` columns: id, payment_id, schedule_id,
    allocation_type, allocated_amount, created_at. There is NO `amount`
    column — the value column is `allocated_amount`.

### loyalty_transactions full column reference

  Common-mistake column names that DO NOT exist on loyalty_transactions:
  event_type, points_change, amount_spent_jpy, multiplier, created_by (as text).

  Actual schema (verified via information_schema 2026-05-16):
    id                  uuid       PK
    member_id           uuid       NOT NULL, FK to loyalty_members.id
    account_id          uuid       nullable, FK to layaway_accounts
    cash_order_id       uuid       nullable, FK to cash_orders
    payment_id          uuid       nullable
    promo_id            uuid       nullable
    transaction_type    enum       NOT NULL (loyalty_transaction_type —
                                    12 values as of 2026-05-17; see
                                    "loyalty_transaction_type enum
                                    (2026-05-17 expansion)" below)
    points_amount       numeric    NOT NULL — signed; negative for
                                    redeemed/revoked/expired
    spend_amount_jpy    numeric    nullable
    rate_snapshot       numeric    nullable — PHP/JPY exchange rate at
                                    transaction time
    invoice_number      text       nullable
    tier_at_time        text       nullable
    notes               text       nullable
    created_by_user_id  uuid       nullable, FK auth.users
    created_at          timestamptz NOT NULL

  The sheet's "Multiplier" column is DERIVED at sync time by sync-loyalty-to-sheet
  via loyalty_tiers lookup keyed on tier_at_time — it is NOT stored on the
  transaction row.

### loyalty_transaction_type enum (2026-05-17 expansion)

  Original 7: earned, bonus, redeemed, expired, adjusted, refunded, revoked
  Added 5:    enrolled, tier_changed, status_changed, admin_edited, birthday_bonus

  (Total 12. birthday_bonus was already referenced in prior schema notes
  but is grouped here under the 2026-05-17 ALTER TYPE expansion that
  formally added the 5 member-event / lifecycle values. 475 historical
  'enrolled' rows backfilled from loyalty_members.enrolled_at, one row
  per member with non-null enrolled_at dated to actual enrollment time.)

  Member-event types (enrolled, tier_changed, status_changed, admin_edited):
    points_amount=0 by convention; spend_amount_jpy and other monetary
    columns typically NULL. Represent non-monetary lifecycle events.
  Transaction types (the original 7 + birthday_bonus): represent
    points-affecting events; monetary columns populated as relevant.

  Sub-tab filter convention in TransactionsTab.tsx:
    Member view: WHERE transaction_type IN ('enrolled', 'tier_changed',
                                            'status_changed', 'admin_edited')
    Transactions view: WHERE transaction_type IN ('earned', 'bonus',
                                                  'redeemed', 'expired',
                                                  'adjusted', 'refunded',
                                                  'revoked', 'birthday_bonus')

  Going-forward emission status (2026-05-17):
    enrolled       → wired (join-loyalty-program, non-blocking insert)
    tier_changed   → wired (award-loyalty-points, tierUpgraded block)
    status_changed → reserved, NOT yet emitted (future workstream)
    admin_edited   → reserved, NOT yet emitted (future workstream)
    birthday_bonus → EMITTED via the Birthday Reward feature (shipped 2026-05-26; see SYSTEM-STATUS → Birthday Reward)

### Birthday Reward columns (added 2026-05-26)

  Birthday Reward columns (customers): birthday (date; sentinel year 2000 = month+day only),
    birthday_locked_at (timestamptz; set-once lock), birthday_admin_edits_used (smallint;
    admin/staff correction counter, cap 1), last_birthday_award_year (smallint; once-per-year claim guard).
  loyalty_tiers.birthday_bonus_points (integer): Glimmer 500 / Radiant 1000 / Elite 1500 / Crown VIP 2000.

### customers.email mixed-case storage (rule)

  customers.email is stored mixed-case in this DB (e.g. 'Stokesmaria85@yahoo.com'
  with capital S). Always use LOWER(c.email) = LOWER(...) when comparing by email.
  Case-sensitive comparison via = or IN (...) will silently drop matches without
  erroring. This rule applies to every email-keyed JOIN, WHERE, and UPDATE.

  Empirical case: 2026-05-16 catch-up migration — case-sensitive A1 query missed
  Stokesmaria85 entirely; only resurfaced via LOWER() lookup, leading to an
  UPDATE that would have erroneously re-enrolled an existing member.

### Supabase SQL Editor CSV export alphabetizes columns

  Supabase SQL Editor's "Export to CSV" sorts result columns alphabetically by
  column name, regardless of the SELECT order specified in the query. The
  in-editor result grid also displays columns alphabetically. This is irrelevant
  for inspection but breaks any downstream import where column position matters
  (e.g. appending to a Google Sheet with locked column order).

  Workaround: post-export reorder via Python pandas/csv module before downstream
  use. Confirmed twice — Substep 7 backfill 2026-05-16 (475 + 372 rows) and
  catch-up migration 2026-05-16 (6 + 6 rows). Template script lives at
  /home/claude/build_csvs.py in the Claude sandbox during such sessions.

### Trade Program columns (added 2026-05-31)

  - layaway_accounts: is_trade BOOLEAN NOT NULL DEFAULT false — locked at creation, indicates Trade Program origin, pure metadata (no calculation effect)
  - cash_orders: is_trade BOOLEAN NOT NULL DEFAULT false — same semantics as layaway_accounts.is_trade

### payment-proofs bucket INSERT paths — PINNED (added 2026-06-05)

  All three of the following INSERT policies on `storage.objects`
  must survive any future security pass. Dropping any one of them
  breaks a live upload surface that has no fallback.

  1. **Staff via `is_staff()`** — `authenticated` role, predicate
     `is_staff(auth.uid())`. Covers internal staff record-payment
     dialogs and any admin-side upload.
  2. **Token customers via `x-portal-token` header** — `anon` role,
     predicate joins the request's `x-portal-token` header against
     an active, non-expired `customer_portal_tokens` row. Covers
     the legacy `?token=` portal flow.
  3. **Session customers via ownership policy** — `authenticated`
     role, predicate joins `auth.uid()` → `auth_user_id` on either
     `layaway_accounts` OR `cash_orders`, AND the first path
     segment of the upload `name` equals the owning record id.
     Covers Phase B JWT session customers.

  Frontend upload sites must continue to use the `{account_id or
  cash_order_id}/` path prefix the ownership policy expects:
  `src/pages/CustomerPortal.tsx` L2100 (layaway submit), L2622
  (layaway edit), `src/components/portal/CashPortalPaymentDialog.tsx`
  L133 (cash submit). Changing the prefix breaks path 3.

## PROOF OF PAYMENT (added 2026-04-13)

  - Stored in Supabase Storage bucket: payment-proofs
  - File naming: {CustomerName}_{InvoiceNumber}_Month{N}_{Date}.{ext}
  - Linked to payment_submissions.proof_url
  - Only confirmed submissions (status='confirmed') appear in the
    Proof of Payment tab (.eq('status', 'confirmed') filter)
  - Visible to all roles (admin, finance, staff, customer)
  - Upload available to admin, finance, staff only
  - Standalone page: /payments-hub (Submissions & Proofs)
  - Per-account view: integrated into Payment History as inline
    "📎 View Proof · {sender}" link (AccountDetail.tsx)

  Staff-submission flow for proof:
    record-payment (server) INSERTs submission row without proof →
    client uploads file to payment-proofs bucket → client UPDATEs
    the same row with proof_url + sender_name. No duplicate row.

## ACCOUNT NOTES (added 2026-04-13)

  - Table: account_notes
  - Columns: id, account_id, note_text, created_by_user_id,
    created_by_name, created_at
  - Immutable — no edit or delete after creation
  - Max 1000 chars per note
  - Visible to admin, finance, staff roles
  - Inline panel in AccountDetail — after Payment History
  - Optional initial note on new account creation (NewAccount.tsx)

### RPC grant model (added 2026-06-06)

  Since the 2026-06-05 evening privilege lockdown,
  `ALTER DEFAULT PRIVILEGES` on the `public` schema revokes
  EXECUTE from PUBLIC for new functions. New frontend-called RPCs
  must therefore explicitly `GRANT EXECUTE ON FUNCTION
  public.foo(...) TO authenticated;` at creation — otherwise
  PostgREST returns 403 for every signed-in caller. Server-only
  RPCs (those reached only through a service-role edge function
  or a trigger) should NOT receive any client grant; they run via
  service-role's BYPASSRLS / superuser-like access. See
  docs/SYSTEM-STATUS.md "RPC + view privilege lockdown
  (2026-06-05 evening, SQL Editor)" for the canonical 17/16 split
  and the lockdown rationale.

### extension_requests columns (added 2026-06-06)

  extension_requests: no `created_at` column — recency column is
  `requested_at` (timestamp with time zone, default `now()`). Also
  has `portal_token` text column (populated in token-mode portal
  submissions). Account link is `account_id` (uuid), NOT
  `invoice_number`.

### customer_pins table (added 2026-06-07)

  `customer_pins`: `customer_id UUID PK` (FK → `customers.id`
  `ON DELETE CASCADE`), `pin_hash TEXT`, `pin_attempts INTEGER
  DEFAULT 0`, `pin_locked_until TIMESTAMPTZ`. RLS enabled — no
  SELECT policy for `authenticated` role. `service_role` bypasses
  RLS (edge functions read/write freely). Only writer:
  `verify-portal-pin` edge function. No frontend access. 303 rows
  migrated from `customers` on 2026-06-07.

### `payments` table — column names (verified 2026-06-07 via information_schema)

| column | type | notes |
|---|---|---|
| `id` | uuid NOT NULL | primary key |
| `account_id` | uuid NOT NULL | FK to layaway/cash account |
| `amount_paid` | numeric NOT NULL | NOT `amount` |
| `currency` | USER-DEFINED enum NOT NULL | PHP, JPY |
| `date_paid` | date NOT NULL | NOT `payment_date`; the actual transfer date |
| `payment_method` | text NULLABLE | |
| `reference_number` | text NULLABLE | NOT `ref`; bank/transfer reference |
| `remarks` | text NULLABLE | also used to identify DP submissions via `remarks LIKE '%down%' AND voided_at IS NULL` |
| `entered_by_user_id` | uuid NULLABLE | staff member who recorded the row |
| `created_at` | timestamptz NOT NULL | row insertion time — diverges from `date_paid` on back-entered records |
| `voided_at` | timestamptz NULLABLE | void marker; filter `voided_at IS NULL` for active payments |
| `voided_by_user_id` | uuid NULLABLE | |
| `void_reason` | text NULLABLE | |
| `submitted_by_type` | text NULLABLE | |
| `submitted_by_name` | text NULLABLE | |

**Naming corrections from prior incorrect documentation** (verified 2026-06-07):
- `amount` → actual column is `amount_paid`
- `payment_date` → actual column is `date_paid`
- `ref` → actual column is `reference_number`

**`created_at` vs `date_paid` semantics**: For accounts where every payment is recorded same-day as it happens, both columns track together. For accounts with back-entered payments (staff catching up on weeks/months of historical transfers in a single session), `created_at` reflects data-entry order while `date_paid` reflects actual transfer order. Use `date_paid` for any sort or filter that displays customer-meaningful payment history — see Bug #179 for the UI bug that surfaced from sorting by the wrong column.



### `schedule_with_actuals` view

The view does NOT expose `paid_amount` or `is_downpayment` columns. Per-row payment totals are exposed as `allocated` (live `SUM(payment_allocations.allocated_amount)` where `payments.voided_at IS NULL`). The remaining-due value is exposed as `actual_remaining` (= `GREATEST(0, LEAST(base+penalty+carried, total_due_amount) - allocated)`, pre-clamped at 0). Status is exposed as `db_status` (raw, from layaway_schedule.status) and `computed_status` (live, derived). When mapping rows from this view into components that expect `paid_amount` / `status` field names, alias at the boundary (e.g. in `useSchedule`) rather than referencing those names directly off the view. See Bug #181 for an instance where direct references silently returned undefined.
