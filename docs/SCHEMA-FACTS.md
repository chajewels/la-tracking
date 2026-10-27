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

### loyalty_members.enrollment_source (added 2026-09-17)

  loyalty_members.enrollment_source text NOT NULL DEFAULT 'unknown', CHECK in
  (portal_signup, portal_join, shopify_checkout, storefront_checkout,
  storefront_join, legacy_import, unknown). Added 2026-09-17.

  'unknown' on a NEW row means a caller sent no valid source hint —
  investigate, do not treat as normal.

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
| `remarks` | text NULLABLE | part of DP detection (see note below) |
| `entered_by_user_id` | uuid NULLABLE | staff member who recorded the row |
| `created_at` | timestamptz NOT NULL | row insertion time — diverges from `date_paid` on back-entered records |
| `voided_at` | timestamptz NULLABLE | void marker; filter `voided_at IS NULL` for active payments |
| `voided_by_user_id` | uuid NULLABLE | |
| `void_reason` | text NULLABLE | |
| `submitted_by_type` | text NULLABLE | |
| `submitted_by_name` | text NULLABLE | |

**Downpayment detection** (corrected 2026-06-19): the column is `reference_number`, NOT `ref`. A payment is a downpayment when `reference_number LIKE 'DP-%' OR remarks ILIKE '%down%'`, always with `voided_at IS NULL`. Any doc/snippet that writes `ref LIKE 'DP-%'` is using the wrong column name.

**Naming corrections from prior incorrect documentation** (verified 2026-06-07):
- `amount` → actual column is `amount_paid`
- `payment_date` → actual column is `date_paid`
- `ref` → actual column is `reference_number`

**`created_at` vs `date_paid` semantics**: For accounts where every payment is recorded same-day as it happens, both columns track together. For accounts with back-entered payments (staff catching up on weeks/months of historical transfers in a single session), `created_at` reflects data-entry order while `date_paid` reflects actual transfer order. Use `date_paid` for any sort or filter that displays customer-meaningful payment history — see Bug #179 for the UI bug that surfaced from sorting by the wrong column.



### `schedule_with_actuals` view

The view does NOT expose `paid_amount` or `is_downpayment` columns. Per-row payment totals are exposed as `allocated` (live `SUM(payment_allocations.allocated_amount)` where `payments.voided_at IS NULL`). The remaining-due value is exposed as `actual_remaining` (= `GREATEST(0, LEAST(base+penalty+carried, total_due_amount) - allocated)`, pre-clamped at 0). Status is exposed as `db_status` (raw, from layaway_schedule.status) and `computed_status` (live, derived). When mapping rows from this view into components that expect `paid_amount` / `status` field names, alias at the boundary (e.g. in `useSchedule`) rather than referencing those names directly off the view. See Bug #190 for an instance where direct references silently returned undefined.

### Atomic loyalty redemption RPCs (added 2026-06-09)

Two PL/pgSQL functions own all state changes for the loyalty redemption confirm/void flow. Both run `SECURITY DEFINER` with `search_path TO 'public'`, return `jsonb`, and execute as a single transaction so partial failures cannot leave member balance, redemption status, catalog stock, audit trail, and account-side artifacts (synthetic payments, allocations, schedule rows, account totals/status) in inconsistent states.

`public.approve_redemption_atomic(p_redemption_id uuid, p_user_id uuid, p_user_email text) RETURNS jsonb` — confirms a `pending` redemption. Created and deployed 2026-06-08. Replaced ~600 LOC of inline TypeScript in `process-loyalty-redemption`.

`public.void_redemption_atomic(p_redemption_id uuid, p_user_id uuid, p_user_email text, p_void_reason text) RETURNS jsonb` — voids a `confirmed` redemption. Created and deployed 2026-06-09 (commit `efd329d`). Replaced ~700 LOC of inline TypeScript in `process-loyalty-redemption`; net -387 LOC in the edge function after refactor.

Both are gated by `is_admin` in the calling edge function (admin role only). Caller-facing error codes returned via `jsonb_build_object('error_code', ...)`:

| Error code | HTTP status | Meaning |
|---|---|---|
| `redemption_not_found` | 404 | No row matching `p_redemption_id` |
| `redemption_not_pending` (approve) / `redemption_not_confirmed` (void) | 400 | Status precondition not met |
| `redemption_approve_race` (approve) / `redemption_void_race` (void) | 409 | Concurrent update detected after `FOR UPDATE` lock |
| `member_not_found` | 404 | Linked member row missing |
| `schedule_row_not_found` | 500 | Payment allocation references a deleted schedule row |
| `insufficient_balance` (approve only) | 400 | Member balance below redemption cost |

Side effects (staff notifications, transactional email, in-app notification, Google Sheet sync) are intentionally OUTSIDE the RPC — they run as fire-and-forget try/catch blocks in the edge function after the RPC succeeds. RPC failure = no side effects. Side effect failure = RPC's atomic write already committed.

Neither RPC touches `loyalty_lot_consumption`. Lot reservation/consumption is not part of the redemption confirm/void contract.

See `docs/SYSTEM-STATUS.md` "Loyalty redemption confirm — atomic via approve_redemption_atomic RPC (2026-06-08)" and "Loyalty redemption void — atomic via void_redemption_atomic RPC (2026-06-09)" entries for deploy history.

### Guarded payment submission RPC (added 2026-06-12)

- `public.insert_payment_submission_guarded(p_account_id uuid, p_customer_id uuid, p_submitted_amount numeric, p_payment_date date, p_payment_method text, p_reference_number text, p_notes text, p_submission_type text, p_sender_name text, p_force boolean DEFAULT false) RETURNS jsonb`
- SECURITY DEFINER, search_path = public. EXECUTE granted to service_role only (revoked from public/anon/authenticated) — called exclusively by the `record-payment` edge function.
- Behavior: takes `pg_advisory_xact_lock(hashtext('payment_submission:' || p_account_id::text))`, then (unless p_force) checks payment_submissions for a pending duplicate (status IN submitted/under_review, created within 30 minutes, abs(submitted_amount − p_submitted_amount) < 1). Duplicate → returns `{duplicate: true, minutes_ago, sender_name}` and writes nothing. Otherwise inserts the submission row (status 'submitted') and returns `{duplicate: false, submission_id}`.
- Side-effect boundary: writes ONLY payment_submissions. Audit logging remains in the edge function. Does not touch payments, layaway_schedule, or allocations.
- Added in Bug #220 to close the SELECT-then-INSERT race in record-payment's duplicate soft block.

### Atomic penalty waiver unwaive RPC (added 2026-06-10)

`public.unwaive_penalty_atomic(p_waiver_id uuid, p_user_id uuid, p_user_email text) RETURNS jsonb` — reverses an approved penalty waiver atomically. Created 2026-06-10. Replaces the previous 3-step client-side write in `handleUnwaive` (Waivers.tsx L106-195) which was asymmetric (touched penalty_fees + layaway_schedule + layaway_accounts but never reset `penalty_waiver_requests.status`). **Same-day fix (2026-06-10):** initial deploy used `::layaway_account_status` enum cast which doesn't exist; corrected via CREATE OR REPLACE FUNCTION with `::account_status` (see Enum types table above).

Called from `unwaive-waiver` edge function (auth gate via `checkPermission(_, _, "manage_waivers")`). PL/pgSQL, `SECURITY DEFINER`, `search_path = public`. Caller-facing error codes returned via `jsonb_build_object('error_code', ...)`:

| Error code | HTTP status | Meaning |
|---|---|---|
| `waiver_not_found` | 404 | No row matching `p_waiver_id` |
| `waiver_not_approved` | 400 | Status precondition (must be `approved`) not met |
| `penalty_not_found` | 404 | Linked penalty_fee row missing |
| `account_terminal_state` | 400 | Account is `forfeited` or `final_forfeited` |

Side effects (all atomic within RPC):
- `penalty_waiver_requests.status='pending'`, clears `approved_by_user_id`, `approved_at`
- `penalty_fees.status='unpaid'`, clears `waived_at`
- `layaway_schedule.penalty_amount` + `total_due_amount` recalculated from active (non-waived) penalties
- `layaway_accounts.remaining_balance` recalculated; if was `completed` and remaining > 0.01, reverts to `overdue` (if any schedule row is overdue) or `active`
- `audit_logs` row inserted with `action='waiver_unwaived'`

Symmetric to approve-waiver (which is currently inline TS in the edge function, not yet an atomic RPC — future Phase 2 unification could promote it). Mirrors the pattern of `approve_redemption_atomic` and `void_redemption_atomic`.

Known related asymmetry — Bug #194: `penalty-engine` cron at `supabase/functions/penalty-engine/index.ts` L362 also programmatically converts waived penalties back to unpaid without resetting `penalty_waiver_requests`. Different semantic context (system-driven re-evaluation, not user reversal). Separate scope.

### Enum types and column-type quirks (added 2026-06-10)

Confirmed via `information_schema.columns` queries during Bug #193 cleanup. Use these exact enum names when writing any PL/pgSQL RPC or migration that casts text values:

| Table | Column | Enum type name |
|---|---|---|
| `layaway_accounts` | `status` | `account_status` |
| `layaway_schedule` | `status` | `schedule_status` |
| `penalty_fees` | `status` | `penalty_fee_status` |
| `penalty_waiver_requests` | `status` | `waiver_status` |
| `payment_allocations` | `allocation_type` | (USER-DEFINED, name not yet confirmed) |
| `payments` | `currency` | (USER-DEFINED, name not yet confirmed) |

**Common column-type gotchas:**
- `layaway_accounts.invoice_number` is **TEXT**, not integer. SQL like `WHERE invoice_number = 17110` fails with `operator does not exist: text = integer`. Always quote: `WHERE invoice_number = '17110'`. Better — when possible, use `account_id` UUID lookups.

**`payments` table columns** (full list, confirmed 2026-06-10): `id`, `account_id`, `amount_paid`, `currency`, `date_paid` (date type), `payment_method`, `reference_number`, `remarks`, `entered_by_user_id`, `created_at` (timestamp), `voided_at`, `voided_by_user_id`, `void_reason`, `submitted_by_type`, `submitted_by_name`. **No `paid_at` column** — use `date_paid` or `created_at`.

**`insert_payment_submissions_batch(p_batch_key text, p_proof_url text, p_rows jsonb, p_source text, p_sender_name text, p_user_id uuid, p_force boolean) → jsonb`** (migration 20261020100000): inserts one pending `payment_submissions` row per element of `p_rows` in one transaction; `reference_number` = `p_batch_key` (idempotency key — a key that already has rows returns `inserted:false` and the existing ids); proof = row `proof_url` else `p_proof_url`, required; same per-account lock + 30-min duplicate guard as `insert_payment_submission_guarded` but rows of the same batch are not each other's duplicates; no rate cap; audit row per submission. SECURITY DEFINER; EXECUTE for authenticated + service_role only; caller = `coalesce(auth.uid(), p_user_id)`. Partial index `idx_payment_submissions_reference_number` (reference_number IS NOT NULL).

**`payment_allocations` table columns**: `id`, `payment_id`, `schedule_id`, `allocation_type`, `allocated_amount`, `created_at`. **Only native payments** (from `record-payment` edge function) create rows here. Bulk-imported payments don't — see Bug #195.

### Phantom Payment Identification Pattern (verified 2026-06-11)

The `payments` table does NOT have a `linked_submission_id` column despite prior assumptions in some session notes. Submission linkage is implicit via `payments.remarks` text containing the submission identifier (e.g., `"Payment submitted. Submission #9fb8f99d"`).

**Confirmed `payments` table columns (verified 2026-06-11 via SELECT *):**
- `id`, `account_id`, `amount_paid`, `created_at`, `currency`, `date_paid`
- `entered_by_user_id`, `payment_method`, `reference_number`, `remarks`
- `submitted_by_name`, `submitted_by_type` (values: `'staff'`, `'customer'`)
- `void_reason`, `voided_at`, `voided_by_user_id`

**Phantom identifier (use these in cleanup queries):**
- Phantom (staff-recorded duplicate before customer submission confirmed): `submitted_by_type = 'staff' AND remarks NOT LIKE 'Payment submitted%'`
- Legitimate from customer submission (post-confirm): `submitted_by_type = 'customer' AND remarks LIKE 'Payment submitted%'`
- Legitimate staff-recorded payment (cash drop-off, external rakuten, no portal submission): `submitted_by_type = 'staff' AND remarks NOT LIKE 'Payment submitted%' AND <no matching customer submission queued>`

The phantom and the legitimate-staff-entry share the same column signature — the differentiator is context: is there a duplicate-amount customer submission on the same account on the same date? Always investigate with SELECT * before constructing DELETE.

### penalty_fees Schema and Status Field Behavior (verified 2026-06-11)

**Columns (verified 2026-06-11):**
- `id`, `account_id`, `schedule_id`, `currency`, `penalty_amount`
- `penalty_stage` (USER-DEFINED enum — observed values: `'week1'`, `'week2'`)
- `penalty_cycle` (integer)
- `penalty_date` (date)
- `status` (USER-DEFINED enum — observed values: `'paid'`, `'unpaid'`; likely also `'waived'`)
- `waived_at` (nullable)
- `created_at`, `updated_at`

**Status field behavior:**
- When a row in `payment_allocations` referencing a penalty is DELETEd, `penalty_fees.status` does NOT auto-reset
- Manual reset pattern: `UPDATE public.penalty_fees SET status='unpaid' WHERE schedule_id = <X> AND status='paid'`
- **Self-heal exception:** if a legitimate `payment_submission` is queued and confirmed AFTER the phantom is cleaned, waterfall re-allocation re-fills the same penalty_fees rows — `status='paid'` becomes correct again. No manual reset needed.

**Cleanup decision tree for installment phantoms touching penalties:**
1. Is a matching legit submission queued? → **Yes:** clean phantom, confirm legit, penalty rows self-heal. No manual penalty_fees UPDATE needed.
2. Is a matching legit submission queued? → **No:** clean phantom AND manually UPDATE penalty_fees.status back to 'unpaid'.

### payments table is written ONLY by the confirmation flow (added 2026-06-12, Bug #219)

As of the universal-submission redesign on 2026-06-12, the `payments` table is written by ONE code path: `review-payment-submission` (the reviewer's Confirm click in the Submissions tab). No frontend, no other edge function, no DB trigger creates a `payments` row.

**Producers of `payments` rows (write-side):**
- `review-payment-submission` (sole producer of new payment rows for layaway + cash, regardless of submitter role)

**Removed / dead paths (do not reintroduce):**
- `record-payment` direct-write (admin/finance canConfirm branch) — removed Bug #219
- `record-multi-payment` per-account direct-write (canConfirm branch) — removed Bug #219
- `RecordPaymentDialog` admin/finance "search confirmed row → fallback INSERT a new pending submission" path — removed Bug #218

**Producers of `payment_submissions` rows (queue-side):**
- `submit-payment` (customer portal — layaway)
- `submit-cash-payment` (customer portal — cash orders)
- `record-payment` (staff / admin / finance / CSR — layaway, all roles)
- `record-multi-payment` (staff / admin / finance / CSR — multi-invoice batch, all roles)
- Restore action in review-payment-submission (rejected → submitted; does NOT mint a new row, only flips status)

**Consequence for read queries:** Any analysis that needs "money actually received" reads `payments WHERE voided_at IS NULL` (INVARIANT 1). Any analysis that needs "money in flight pending review" reads `payment_submissions WHERE status IN ('submitted','under_review')`. The two sets are disjoint by construction now — a payment submission becomes a payment row only via the reviewer's Confirm click.

### cash_orders revival path (added 2026-06-12, Bug #217)

A cash order can be revived from `status='expired'` back to `status='pending'` by editing its expiration date to a future timestamp.

**Path:** client-side, in `src/pages/CashOrderDetail.tsx → confirmEditExpiry`. NOT an edge function — revival runs through the existing `staff_admin_update_cash_orders` RLS policy on the `cash_orders` table, which already permits admin + staff UPDATE on `status`, `expires_at`, `expired_at`.

**Single UPDATE writes three columns atomically when reviving:**
- `expires_at` → new ISO timestamp
- `status` → `'pending'`
- `expired_at` → `null`

**Audit:** revival writes `audit_logs` with `action='cash_order_revived'` and `new_value_json: { expires_at, invoice_number, revived_from_status: 'expired' }`. Plain (non-revival) expiry edits continue to write `action='expires_at_updated'`.

**Race-safety:** `auto-expire-cash-orders` cron (jobid 17, `30 0 * * *`) guards on `status='pending'` — if the new expiry passes again, the cron will re-expire the order correctly. No special handling needed.

**Side effects intentionally NOT triggered:**
- `payment_submissions` auto-rejected at expiry STAY rejected. Customers resubmit through the portal.
- Loyalty awards (cash full-completion path) are unaffected — they fire on `payment` confirm, not on status transitions.

### Reserved permission keys (decision locked 2026-06-12, Bug #221)

Five keys exist in role_permissions with zero runtime references. They are intentionally KEPT as reserved — do not delete, do not flag as drift:
- approve_cash_order, edit_cash_order, recalculate_balance — referenced only as types in the legacy static map src/lib/role-permissions.ts; reserved against future reintroduction.
- manage_trade_ins, view_trade_ins — pre-staged for the future trade-in UI; fully seeded (4 roles) as of the Bug #221 backfill.
Rationale: unevaluated keys cost nothing; deleting and later re-seeding risks partial seeds (missing role row = silent checkPermission false, see role-permission seeding rule).

### Service-role detection helper (added 2026-06-12, Bug #223)

isServiceRole(token) in _shared/jwt-claims.ts is the ONLY correct way to detect internal service callers in edge function gates: it checks direct equality with the SUPABASE_SERVICE_ROLE_KEY env value first (works for both JWT and non-JWT key formats), then falls back to parseJwtClaims role inspection (vault-stored cron JWTs). Never use parseJwtClaims(token)?.role === "service_role" alone — it silently rejects non-JWT keys and caused the Bug #223 outage. Any function called internally via fetch to functions/v1/* must gate with isServiceRole.

**A function at `verify_jwt = false` must never rely on the claims fallback (added 2026-09-23, Bug #290).** The fallback is safe only because the gateway has already validated the signature before the handler runs. With `verify_jwt = false` nothing does, so parseJwtClaims decodes an UNSIGNED token and any caller can assert `role: "service_role"` in a hand-written payload. Two consequences, and both are now true in `supabase/config.toml`:

- If the function's internal callers send **real signed JWTs** (a cron's Vault key, a user JWT), run it at `verify_jwt = true` and keep `isServiceRole`. `reconcile-store-credit` is declared `verify_jwt = true` for exactly this reason.
- If the function's internal callers send the **env `SUPABASE_SERVICE_ROLE_KEY` verbatim**, the gateway cannot verify that format, so the function must stay at `verify_jwt = false` AND gate on an exact env-key match instead of the claims fallback. `sync-store-credit-to-shopify` is the ONE such exception: no cron and no vault caller, five edge-function callers that all send the env key, so it uses `token === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")`. Do not generalise this — every function a cron or the Vault can reach still needs `isServiceRole` (Bug #168).

`system-health-v2` is a third shape: it accepts **no service-role caller at all**. It has no cron and no edge-function caller, so it runs at `verify_jwt = true` behind a signed-in user JWT plus `checkPermission(..., "system_health")`, and its service-role branch was removed.

### dashboard-summary: known-dead adjusted prediction fields (documented 2026-06-12)

The dashboard-summary edge function computes a riskFactor (0.85) and four risk-adjusted output fields: the per-bucket `adjusted` totals, `predicted_30d`, `predicted_90d`, and `next_month_adjusted`. These are typed in src/hooks/use-supabase-data.ts but rendered NOWHERE — the Finance page displays only the `_raw` counterparts. Decision: kept intentionally (removal would touch the API shape, hook types, and a redeploy for zero visible gain; the fields are available if risk-adjusted predictions are ever surfaced). Do not re-flag as drift or dead code.

### Test-customer enforcement: customers.is_test + invoice prefix trigger (added 2026-06-12)

Columns:
- `customers.is_test` boolean NOT NULL DEFAULT false.

Triggers:
- `trg_test_invoice_prefix_layaway` on `layaway_accounts` — BEFORE INSERT OR UPDATE OF `invoice_number, customer_id`, executes `enforce_test_invoice_prefix()`.
- `trg_test_invoice_prefix_cash` on `cash_orders` — BEFORE INSERT OR UPDATE OF `invoice_number, customer_id`, executes `enforce_test_invoice_prefix()`.

Effect: when the row's `customer_id` resolves to a customer with `is_test = true` and the proposed `invoice_number` is purely numeric, the trigger rewrites it to `TEST-<number>` before the write commits. The numeric-invoice convention (CLAUDE.md TEST ACCOUNT EXCLUSION) becomes self-enforcing: staff cannot accidentally save a leak-prone numeric invoice under a test customer, so every regex filter — frontend, edge function, and the 20 reporting RPCs — excludes the account regardless of what was typed in. Motivated by the TEST-4567 incident (docs/TEST-ACCOUNTS.md).

### Timesheet tables (added 2026-06-14, feature SHIPPED & LIVE)

Three tables back the staff Timesheet feature (pure-TS engine in `src/lib/timesheetEngine.ts`, page `src/pages/Timesheet.tsx`; no edge function). See docs/TIMESHEET-SPEC.md for pay logic.

- **`timesheet_profiles`** — one row per staff member.
  Columns: `id`; `user_id` (UNIQUE, = auth uid); `template_type` CHECK(`'live_admin'` | `'csr'`); `job_title`; `timezone` (default `'Asia/Manila'`); `work_days` smallint[] (ISO dow — **Sunday IS a valid workday, treated as 1..7**); `shift_start`; `shift_end`; `basic_salary`; `allowance`; `half_day_rate` / `full_day_rate` / `full_day_threshold_hours` (**VESTIGIAL — the engine ignores these; rates are fixed code constants, CSR full rate = basic/27**); `dayoff_divisor` (default 4); `active`; `can_view_all` (bool, default false); timestamps.
  RLS: own row + admin/finance + `public.timesheet_can_view_all(auth.uid())`.

- **`timesheet_entries`** — one row per (user, day).
  Columns: `id`; `user_id`; `work_date` (date); `am_in` / `am_out` / `pm_in` / `pm_out` (timestamptz); `note`. UNIQUE(`user_id`, `work_date`). `work_date` is stamped via `getPHTToday()` (Asia/Manila).
  RLS: own + admin/finance + `can_view_all`.

- **`timesheet_monthly_history`** — SUMMARY-ONLY historical payroll.
  Columns: `month_key` (text PK, `'YYYY-MM'`); `csr_net` (numeric); `liveadmin_net` (numeric); `created_at`. RLS admin-only (EXISTS in `public.user_roles` where `role::text='admin'`).
  Holds pre-go-live months (`<= 2026-05`); live months (`2026-06` onward) are computed from `timesheet_entries`, NOT this table. The Full Summary tab blends history rows with live months, live winning on any month with punches.

- **Helper `public.timesheet_can_view_all(uuid)`** — SECURITY DEFINER STABLE; reads `timesheet_profiles.can_view_all` for the given user. Grants timesheet-only Consolidation + Cost Master visibility WITHOUT a global role. Brendalyn (`bumagatbrenda@gmail.com`) is flagged `can_view_all = true`.

### Timesheet corrections (added 2026-10-26, migration 20270202100000 — NOT yet applied live)

- **`timesheet_corrections`**: append-only history of Consolidation corrections. Columns: `user_id`, `work_date`, `old_punches` / `new_punches` (jsonb with keys `am_in`, `am_out`, `pm_in`, `pm_out`, ISO or null), `comment` (3–500, trimmed), `corrected_by`, `corrected_at`. UPDATE, DELETE and TRUNCATE are refused by triggers, and there are no write policies. Read: the gate `can_correct_timesheet(auth.uid())` (admin or `timesheet_can_view_all`, answers for the caller only) OR the staff member's own rows.
- **Day lock**: `trg_timesheet_entries_lock_corrected` (BEFORE INSERT/UPDATE on `timesheet_entries`) raises `day_locked` on a corrected (user, day) unless the caller passes the gate. `auth.uid()` IS NULL (service paths) is always allowed.
- **RPCs**: `correct_timesheet_day(p_user_id, p_work_date, p_am_in, p_am_out, p_pm_in, p_pm_out, p_comment)` is the only writer of corrections. It upserts the punches, appends the history row and writes one `audit_logs` row (`entity_type` timesheet_correction, user_id + work_date only). `get_timesheet_corrections(p_month)` returns the corrections in the 31-row window (1st .. 1st + 30) with the corrector's name: everyone's for the gate, otherwise the caller's own.
- **`timesheet_entries.note` is legacy and not shown** anywhere in the Hub (69 of 612 rows have one, 2026-10-26). Corrections never touch it.
- Full text: docs/TIMESHEET-SPEC.md "Corrections (Admin + Brenda)".

### Payslip tables (added 2026-10-26, migration 20270201100000 — NOT yet applied live)

- **`staff_payroll_details`**: address + date of birth per staff member (`user_id` = auth uid = `timesheet_profiles.user_id`). Written only by `save_staff_payroll_details`; the audit row names the changed fields, never the values.
- **`payslips`**: one live payslip per (user, month) (partial unique, void excluded). Figures and staff details frozen at `finalize_payslip`; only `finalized → paid` (payment fields) and `→ void` (void fields) are allowed, enforced by a row trigger; DELETE/TRUNCATE refused. `php_per_jpy` = `php_received / jpy_sent` (the actual remittance rate, not `php_jpy_rate`).
- Read RLS on both tables = `public.can_manage_payslips(auth.uid())` (admin or `timesheet_can_view_all`, answers for the caller only); no write policies. Proofs live in the private bucket `payslip-proofs`, `<payslip_id>/<file>`. Full text: docs/PAYSLIPS.md.

### Payslip cash advances, cash bond and pay settings (added 2026-10-27, migration 20270204100000 — NOT yet applied live)

- **`payslip_cash_advances`:**
  - Columns: date, amount, note, optional proof `payslip-proofs/advances/<id>/<file>`, `active | void`,
    `payslip_id`.
  - Written only by `add_cash_advance`, `attach_cash_advance_proof`, `void_cash_advance` and
    `finalize_payslip`.
  - Locked once the staff month has a non-void payslip.
  - Never deleted: the row trigger refuses DELETE and TRUNCATE.
  - Read RLS = `can_manage_payslips`.
- **`payslips` new columns:**
  - `employee_id`, `hire_date`, `cash_advances` (jsonb), `cash_advance_php`, `is_final_pay`,
    `cash_bond_held_php`, `cash_bond_released_php`, `cash_bond_source_payslip_id`.
  - GENERATED `net_pay_php` (= total − advances) and `amount_due_php` (= net − held + released).
  - `payslips_before_write` leaves the two GENERATED columns out of its frozen-row comparison, because
    they read NULL in a BEFORE UPDATE trigger.
- **`staff_payroll_details.employee_id`:** unique on `upper()`, pattern `^[A-Za-z0-9-]{1,30}$`. **`hire_date`:**
  the pay month containing it is the first pay month (cash bond).
- **`finalize_payslip`:** now 4 arguments `(…, p_is_final_pay boolean)` with NO default. The 3-argument
  version is a thin wrapper, because a default would make 3-argument calls ambiguous.
- **`timesheet_pay_settings`:** CSR basic/allowance per month (latest `effective_from ≤` the 1st;
  fallback to the profile). Written only by `set_timesheet_pay_setting` (admin, audited without amounts);
  never deleted.
- **Floor:** payslip months, cash advances and `correct_timesheet_day` start at 2026-04-01.
- **Second proof file (migration 20270205100000):**
  - `payslips.proof_path_2` and `payslip_cash_advances.proof_path_2` are optional; each needs the 1st
    proof and must differ from it.
  - A paid payslip allows exactly one more change: `proof_path_2` from empty to set, via
    `attach_payslip_proof`.
  - `record_payslip_payment` has 5- and 6-argument versions (the 5-argument one is a wrapper).
  - Full text: docs/PAYSLIPS.md "Second proof file".
- **Bonuses (migration 20270206100000):**
  - `payslip_bonuses` (`performance | holiday`; up to 2 proofs at `bonuses/<id>/<file>`) is locked once the
    month has a non-void payslip.
  - `payslips.total_php = timesheet_net_php + commission_php + bonus_php`, and `payslips.bonuses` holds the
    frozen snapshot.
  - `finalize_payslip` sums active bonuses on the server.
  - Full text: docs/PAYSLIPS.md "Bonuses".
- **Edit figures (migration 20270207100000):**
  - `payslips.correction_reason` / `corrected_from_payslip_id`: figures typed by hand, with the reason; the
    row still never changes — `correct_payslip` voids it ("Corrected: …") and issues the corrected one in one
    transaction, copying a Paid payslip's payment and proofs.
  - Cash bond (hire month) = floor(timesheet net / 2); commission and bonuses excluded; typed bond allowed
    with a reason; never above pay after advances.
  - Proof paths are CHECKed by shape (`<uuid>/<file>`); a copied proof keeps its original folder.
  - `payslip_issue` is internal; `finalize_payslip` has 3-, 4- and 5-argument versions.
  - Full text: docs/PAYSLIPS.md "Edit figures and the cash bond".
- Full text: docs/PAYSLIPS.md "Cash advances, employee ID, cash bond and April–May";
  docs/TIMESHEET-SPEC.md "Pay settings history".

### staff_notifications — additional types (added 2026-06-14)

`submission_confirmed` is produced by the existing Postgres trigger `notify_submission_reviewed` (on `payment_submissions` UPDATE), which writes the "Payment confirmed" `staff_notifications` row on confirm. It is NOT emitted by an edge function — earlier duplicate inserts in `review-payment-submission` were removed (2026-06-14) so the bell row + chime/speech ride solely on the trigger.

The only NEW edge-emitted bell types from the sound-notifications feature are (both fire-and-forget — try/catch, console.warn on error, never throw):
- `penalty_applied` — producer: `penalty-engine` (one aggregated row per run when `penalties_created > 0`).
- `account_forfeited` — producers: `auto-forfeit-settlement` (the extension-expiry path emits `metadata.kind='final_forfeited'` — the extension-month cap path was retired 2026-10-20; the final-month-penalty-cap and 3-month-overdue paths emit `kind='forfeited'`) and `manual-forfeit` (`kind='forfeited'`, `manual:true`).

### sales_log eligible invariant (added 2026-06-19, Bug #234)

`computeMonth()` (in `src/lib/commissionEngine.ts`, called from `src/pages/Commissions.tsx`) builds the per-month commission pool **purely** from rows with `eligible === true`, with **NO separate status filter**. `eligible` is therefore the **sole** pool gate: non-Paid rows must carry `eligible=false` to stay out of the pool. The DB column default is `true`, but the page auto-stamps `defaultEligible()` (false on non-Paid) on creation so non-Paid rows are excluded by default; on a non-Paid→Paid transition the `autocheck_sales_log_eligible()` trigger (rewritten 2026-06-19) flips `eligible=true` for qualifying rows (channel ≠ 'Live', source ∉ {'Live Post','Online Store','Other'}), overriding the page-stamped false. INSERTs still honor an explicit `eligible=false` (creation-time opt-out); already-Paid edits hit neither branch so admin opt-outs on Paid rows are preserved.

### Final-installment penalty cap + auto-forfeit Rule A gate (added 2026-06-19, Bug #235)

Final-installment penalty cap is **PHP 3000 / JPY 6000**. Reactivated `extension_active` accounts: **CLEAN** (all earlier installments paid) get **+PHP 1000 / JPY 2000** on the final installment (cap 4000 / 8000); **DIRTY** (an earlier installment unpaid) get no bump — final installment stays at 3000 / 6000. `auto-forfeit-settlement` **Rule A** (final-month cap forfeiture) is gated on `priorUnpaid` — only fires when every earlier installment is paid; otherwise the **3-month-no-payment rule** governs. Open payment submissions (status `submitted` / `under_review`) freeze all penalty accrual for that account.

### Order-level is_test KPI guard (added 2026-06-27, test-account leak fix)

Supersedes the regex/prefix framing in the trigger section above: KPI/alert exclusion no longer relies on the `TEST-` prefix or an `invoice_number` regex. The canonical, queryable guard is now an order-level boolean column.

- **`customers.is_test`** (pre-existing) — the canonical *structural* test marker. Drives the inherit trigger; flagged `true` only for pure-test customers (every order is a test).
- **`cash_orders.is_test`** / **`layaway_accounts.is_test`** — `boolean NOT NULL DEFAULT false`, added 2026-06-27. The queryable KPI guard. Backfilled `WHERE invoice_number !~ '^[0-9]{5}$'` (real invoices are 5-digit `19xxx`); flagged exactly 19 historical test orders (7 cash, 12 layaway).
- **`enforce_test_invoice_prefix()`** now ALSO sets `NEW.is_test := true` when the row's customer is a test customer (reads `customers.is_test` into a local), in addition to the existing `TEST-` numeric-invoice rewrite. A future test-customer order is therefore flagged at insert even if the invoice is bare-numeric. (The trigger-section description above predates this is_test stamping.)

Why the column, not the prefix/regex: the prefix is only applied by the trigger at insert, so test orders created *before* their customer was flagged stayed bare-numeric and slipped every `invoice_number ~ '^[0-9]+$'` guard (which only catches *lettered* tests) and every `NOT LIKE 'TEST-%'` guard (which only catches *prefixed* ones). Both patterns are now swept to `is_test = false` across 24 RPCs, 2 edge functions, and 13 frontend sites. See docs/FIXED-BUGS.md Bug #237.

Order-level is_test can be set/unset per order without touching a real customer's real orders. `service_jobs` and `trade_ins` have NO is_test column and are intentionally left on prior conventions (no test rows, manual inputs).

- Payment method canonical identity: stored value `cash_pickup`, display label `Cash Pick Up` (via payment-method-registry `methodLabel`). Staff-cash, portal, record/multi, and the submission-edit dropdown all resolve to `cash_pickup`.
- Customer portal now displays payment methods via payment-method-registry `methodLabel` (store path already canonical via `normalizeMethod`), matching staff surfaces.
- Submission-edit method dropdown dedupes options by canonical value (normalizeMethod) and stores canonical; "Bank Transfer" removed from all pickers (registry entry retained for legacy display; DB payment_methods row deleted).

### allocate_payment_atomic RPC (added 2026-07-05)

Consolidates the installment payment-allocation waterfall + all downstream writes into a single Postgres transaction. Live in the DB (not in `supabase/migrations/` — DB is authoritative per the "Live DB ahead of repo migrations" CLAUDE.md note). `service_role`-only grant.

**Params** (all `p_`-prefixed):
`p_account_id uuid`, `p_amount_paid numeric`, `p_payment_date date`, `p_payment_method text`, `p_reference_number text`, `p_remarks text`, `p_user_id uuid`, `p_currency text`, `p_is_downpayment boolean`, `p_submitted_by_type text` (`'customer'|'staff'`), `p_submitted_by_name text`, `p_preview boolean`.

**Return** — `jsonb`, two shapes by mode:
- **Write mode** (`p_preview = false`): returns the SAME full jsonb as preview mode PLUS `payment_id` — `{ payment_id, allocations, penalty_updates, schedule_updates, new_total_paid, new_remaining_balance, new_status }` (the inserted `payments.id` is `payment_id`). Callers currently read only `payment_id`. Performs the full row-by-row waterfall (penalty-then-base per schedule row, carry-over guard, Keep-credit ceiling), inserts the `payments` row, merges + inserts `payment_allocations`, updates `penalty_fees.status`, updates `layaway_schedule` (`paid_amount`/`status`), and recomputes `layaway_accounts` totals (`total_paid` via INVARIANT 1 = SUM non-voided `payments.amount_paid`; `remaining_balance` = `total_amount` + non-waived penalties − total_paid; `status`). DP payments (`p_is_downpayment = true`) skip schedule/penalty allocation entirely — payment row only, totals via INVARIANT 1.
- **Preview mode** (`p_preview = true`): `{ allocations, new_total_paid, new_remaining_balance, new_status, schedule_updates, penalty_updates }` — the exact plan, NO writes. `allocations[]` elements carry `schedule_id` / `allocation_type` / `allocated_amount` (no `penalty_fee_id`). `schedule_updates[]` carry `id` / `status` (+ paid_amount). Values are INVARIANT-1-exact, replacing the prior frontend-side cached-total approximation.

**Callers:**
- `review-payment-submission` `allocatePaymentToAccount()` — SOLE write-mode caller (`p_preview:false`); its former inline body (schedule/penalty fetch, waterfall, payment insert, TS idempotency guard, rollback helper, merged-allocation inserts, penalty/schedule updates, account-totals recompute) is now entirely delegated to the RPC.
- `record-payment` (preview_only branch) and `record-multi-payment` (per-account loop) — `p_preview:true` only.

**Atomicity note:** the TS-side idempotency guard (`skipWaterfall` when the payment already has allocations) and the best-effort `rollbackPayment` delete are superseded — a single DB transaction makes partial writes impossible, so there is no half-inserted payment to guard against or roll back.

### Loyalty lot invariant (2026-07-05)

For every member, SUM(loyalty_point_lots.remaining_amount) over rows with revoked_at IS NULL AND expired_at IS NULL must equal loyalty_members.remaining_points. Expiry (loyalty-inactivity-check) now stamps open lots expired_at + remaining_amount=0 alongside the counter zeroing (best-effort; reconcile via the lot/counter census query). Portal lot display filters revoked_at, consumed_at, AND expired_at. Redemption is now lot-wired: approve_redemption_atomic calls consume_lots_fifo (whose FIFO lot-set exactly equals the invariant set per Bug #244) and void_redemption_atomic calls restore_lots_for_redemption with a synthetic admin_adjust top-up when the ledger restores less than points_redeemed (pre-wiring redemptions).

### customers.created_at import contamination (evidence 2026-07-07)

`customers.created_at` is an IMPORT timestamp for the March 2026 cohort — the
same contamination class as `layaway_accounts.created_at` (which is why the
dashboard accounts sparkline uses `order_date`). Owner-run SQL (2026-07-07,
`is_test = false`, grouped by month of `created_at`):

| month | new customers |
|---|---|
| 2026-03 | 470 (bulk-import spike) |
| 2026-04 | 181 |
| 2026-05 | 46 |
| 2026-06 | 60 |
| 2026-07 (partial) | 4 |
| **total** | **761** |

Customers have NO alternative date column (no order_date equivalent), so any
customers-by-created_at trend metric must CLIP the import cohort rather than
correct it. Canonical adopter: the Dashboard "New Customers" StatCard
(`src/pages/Dashboard.tsx`, constant `NEW_CUSTOMER_TREND_CUTOFF = '2026-04'`)
— its sparkline/delta start at the cutoff and exclude March entirely. Reuse
the same cutoff constant semantics for any future customers-by-month surface;
do NOT present March 2026 as an acquisition month.

### products (Shopify catalog mirror, added 2026-07-08, Phase 1)
Read-only mirror of the Shopify product catalog, product-grain (single-variant
assumption — stores first variant's sku/price/inventory/barcode). Written ONLY
by the shopify-sync-products edge function via service role; RLS allows
authenticated SELECT only (no authenticated write — machine-synced).
Columns: id uuid PK; shopify_product_id text UNIQUE (gid, upsert key); title
text (carries product code, e.g. "A4724…"); sku text (nullable — codes are in
title, not sku); price_jpy numeric(12,2); inventory_quantity integer; barcode
text; status text (active|draft|unlisted|archived); vendor; handle;
product_type; tags text[]; collection_titles text[]; image_url; description;
shopify_updated_at timestamptz (delta cursor source); synced_at; created_at.
Indexes: unique(shopify_product_id), btree(status), btree(sku),
gin(collection_titles).
Sync: shopify-sync-products edge function. Auth = client-credentials grant
(POST /admin/oauth/access_token, x-www-form-urlencoded; token 24h, fetched per
run, never stored — no shpat_ secret). Cursor = system_settings key
'shopify_products_last_synced_at'; missing → full backfill, present → delta
(products query updated_at:>cursor); cursor advances only on full success.
GraphQL Admin API version 2026-07.

### cash_order_items + cash_orders.source_channel (added 2026-07-08, Phase 2)
Line-item child of cash_orders. total_amount stays AUTHORITATIVE — items are
descriptive detail that should sum to it, never override it. Values are
SNAPSHOTTED at order time (title, sku, unit_price_jpy) so historical orders
keep what was charged even if Shopify prices change later.
cash_order_items columns: id uuid PK; cash_order_id uuid NOT NULL FK ->
cash_orders ON DELETE CASCADE; product_id uuid FK -> products (nullable,
catalog link); shopify_line_item_id text (nullable, UNIQUE where not null —
Path-B webhook idempotency); title text NOT NULL (snapshot); sku text
(snapshot); quantity integer NOT NULL DEFAULT 1; unit_price_jpy numeric(12,2)
NOT NULL (snapshot); line_total_jpy numeric(12,2) NOT NULL; created_at.
Indexes: btree(cash_order_id), btree(product_id), partial-unique
(shopify_line_item_id) WHERE NOT NULL. RLS mirrors cash_payments:
admin_all (ALL), staff_admin_insert (INSERT staff+admin), staff_finance_read
(SELECT staff+finance) via has_role(auth.uid(),...). NOTE: read excludes CSR
by design (parity with cash_payments) — add a CSR read policy at Phase 3 if
the order-detail view needs CSR to see line items.
cash_orders.source_channel: text NOT NULL DEFAULT 'hub_manual', CHECK IN
('hub_manual','shopify_direct','social_manual'). Existing rows + all
Hub-native orders = 'hub_manual'; social/live manual orders = 'social_manual';
Shopify storefront = 'shopify_direct'. text+CHECK (not enum) for extensibility.
Does not touch the trg_test_invoice_prefix_cash trigger (fires only on
invoice_number/customer_id).
Phase 3 additions: image_url text (nullable) — SNAPSHOT of the product image
at pick time (backfilled from products for existing rows); lets the portal
show images without reading the Hub-internal products catalog. RLS now also
has "Customers can view own cash order items" (SELECT, authenticated,
auth.uid()-scoped via parent order ownership) — note this is INERT for the
portal (portal reads via the customer-portal edge function / service role),
harmless, retained for a possible future authenticated-client read path.

### layaway_account_items (2026-07-09)
Layaway line-item child table (mirror of cash_order_items). Columns: id uuid PK; account_id uuid FK→layaway_accounts ON DELETE CASCADE; product_id uuid FK→products (nullable); shopify_line_item_id text (reserved, unused); title text; sku text; quantity int default 1; unit_price_jpy numeric(12,2); line_total_jpy numeric(12,2); image_url text (SNAPSHOT at pick time — keeps portal off the Hub catalog); created_at.
Items stored in JPY (catalog currency) always. RLS: admin_all (ALL); account_creators_insert (INSERT admin+staff — matches create_account, NOT finance); staff_finance_read (SELECT); "Customers can view own layaway account items" (SELECT authenticated, auth.uid()-scoped via parent account ownership — INERT for portal, which reads via customer-portal edge function/service role; retained for possible future authenticated-client reads).

### AFB — discount + shipping columns on layaway_accounts AND cash_orders (2026-07-09)
Account Financial Breakdown. Both tables gained: discount_amount numeric (layaway 15,2 / cash 12,2) NOT NULL default 0; discount_type text (nullable, CHECK IN ('amount','percent') or null); discount_value numeric (layaway 15,2 / cash 12,2) (nullable — scale confirmed on live 2026-09-23; this line said bare numeric until then); shipping_fee numeric NOT NULL default 0 (precision NOT yet confirmed against live). All stored in the ACCOUNT currency (PHP for PHP accounts), all existing rows default 0/null.
MODEL: total_amount stays AUTHORITATIVE and drives the installment schedule (INVARIANT 7). discount/shipping are DESCRIPTIVE breakdown fields — they never auto-change total_amount. Percent discount applies to the items subtotal (converted to account currency). Items are JPY; discount/shipping are account-currency; reconciliation = itemsSubtotalAcct − discount + shipping (informational/suggested).
Captured in: creation forms (NewAccount, NewCashOrder) and edit dialogs (EditAccountDialog, CashOrderDetail Manage Invoice). Edit dialogs are admin-gated; discount/shipping editable there with a live reconciliation readout and an explicit admin-only "Apply to total" button (sets the total field on click — never automatic). Write confirmed on all four surfaces (2026-07-09).
IMPORTANT behavior: on EDIT, changing total via "Apply to total" writes total_amount + remaining_balance but does NOT recompute the installment schedule (schedule rows stay static). So a post-creation shipping/discount change does not auto-flow into installments — admin manually adjusts installments if the change affects what's owed. Discount/shipping are meant to be set at CREATION (where they shape the total before the schedule is generated); the edit path is for corrections/records.

### Phase 4 Shopify webhook schema (2026-07-10)
Added by P4-1: cash_orders.shopify_order_id text (partial UNIQUE index where not null
— order-level idempotency + Shopify linkage); cash_order_items.shopify_line_item_id
text (partial UNIQUE where not null — NOTE: this was documented in Phase 2 roadmap as
already existing but was NOT actually created until here); customers.needs_review
boolean default false + customers.source text (create-and-flag for webhook-created
customers with no match: source='shopify', needs_review=true); and the
shopify_webhook_events table (id, shopify_order_id, topic, webhook_id, status
[processed|error], error_detail, processed_at) with UNIQUE(shopify_order_id, topic)
for webhook idempotency/audit — RLS admin-read only, written by service role.

### Store Credit tables + enums (2026-07-11)
Two tables. `store_credit_lots`(id, customer_id, currency, original_amount, remaining_amount, status `store_credit_lot_status` ('active'|'consumed'|'expired'|'voided'), source_type ('cancelled_layaway'|'cancelled_cash'|'manual_admin'), source_account_id, source_cash_order_id, rate_snapshot, notes, issued_by_user_id, issued_at, expires_at, created_at, updated_at). `store_credit_transactions`(id, customer_id, lot_id, txn_type `store_credit_txn_type` ('issued'|'redeemed'|'expired'|'voided'|'adjusted'), amount, currency, account_id, cash_order_id, balance_after, notes, performed_by_user_id, created_at). Two enums: store_credit_lot_status, store_credit_txn_type.
RLS: admin ALL; staff/finance SELECT. NO customer-facing policy — the portal reads these via the customer-portal edge function on the service-role key (same as loyalty).
Lot/FIFO model: each issuance is a lot with its own expiry + remaining balance; consumption is FIFO by SOONEST EXPIRY. Voiding a lot cancels ONLY the unspent remainder — any portion already applied to an order is a real payment and is NOT reversed. JPY and PHP balances are separate, never summed, never converted. Full feature spec: docs/STORE-CREDIT.md.

### Operational learning — revoke_loyalty_points() matches on INVOICE NUMBER (2026-07-11)
`revoke_loyalty_points()` matches lots by `source_reference = INVOICE NUMBER`. `award-loyalty-points` writes `p_source_reference: invoiceNumber`, so revocation must be called with the invoice number to find those lots. Passing anything else (e.g. 'cash_order:<uuid>') silently no-ops — it RAISE NOTICEs and returns NULL (no error). This was the root cause of points not being revoked on cash-order cancellation (see FIXED-BUGS).

### Operational learning — loyalty_notifications is a TWO-TABLE structure (2026-07-11)
Customer portal notifications are a master row in `loyalty_notifications` PLUS a recipient row in `loyalty_notification_recipients` (keyed on member_id). `loyalty_notifications` has NO member_id column. `emitNotification()` (supabase/functions/_shared/emit-notification.ts) is keyed on `loyalty_members.id`, NOT `customers.id` — resolve the member id first (loyalty_members WHERE customer_id = …) and skip if the customer isn't enrolled.

### Operational learning — layaway vs cash payments live in separate tables (2026-07-11)
Layaway payments live in `payments`; cash-order payments live in a SEPARATE `cash_payments` table. Any account-scoped money feature (reconciliation, roll-ups, store credit, void/restore) must handle BOTH. redeem_store_credit_atomic reflects this: layaway delegates to allocate_payment_atomic (writes `payments` + schedule), cash inserts `cash_payments` directly (no schedule exists).

### Operational learning — never call a mutating *_atomic RPC from a SELECT list across multiple rows (2026-07-11)
A cleanup query called void_store_credit_lot_atomic() in a SELECT list over four rows:

    SELECT l.original_amount, public.void_store_credit_lot_atomic(l.id, ...)
    FROM store_credit_lots l ... WHERE l.status = 'active';

All four lots ended in the correct STATUS, but one ledger row was written with the WRONG AMOUNT: a ¥25,000 lot recorded a 'voided' transaction of ¥1,000. The function executes against the OUTER query's snapshot, so its internal `SELECT ... FOR UPDATE` reads can pick up stale or cross-row values — silently misrecording money in the audit ledger while the visible end state looks correct.

RULE: mutating SECURITY DEFINER RPCs (issue_store_credit_atomic, redeem_store_credit_atomic, void_store_credit_lot_atomic, cancel_cash_order_atomic, allocate_payment_atomic, approve_redemption_atomic, void_redemption_atomic, etc.) must be invoked ONE ROW AT A TIME — a single call, or an explicit `DO $$ ... FOR ... LOOP ... END $$;` block. NEVER map them across a result set in a SELECT list. The UI is safe (it calls one lot/order at a time); the risk is ad-hoc batch SQL.

Detection: after any batch RPC run, verify the LEDGER amounts, not just the row statuses — e.g. for store credit, every 'voided' transaction amount must equal the lot's remaining amount at void time. A wrong amount with a right status is the signature of this bug.

(Found 2026-07-11 during Phase A store-credit cleanup; the misrecorded row was corrected and an audit_logs 'ledger_correction' entry written.)

### Operational learning — a relaxed identity guard on an outer RPC is useless if an inner RPC still enforces one (2026-07-12)
cancel_cash_order_atomic was given a service-role path (p_source = 'shopify_webhook') so a webhook with no user could cancel an order. It still failed with user_identity_required — because it CALLS issue_store_credit_atomic, which had its own identity guard and received the same NULL p_user_id. The error appeared to come from the outer function.
RULE: when relaxing an identity/permission guard for a system caller, follow the ENTIRE call chain and relax every nested RPC that receives the same null identity.
DETECTION: read the full PL/pgSQL error CONTEXT — it names the actual failing function and line, e.g. "PL/pgSQL function issue_store_credit_atomic(...) line 14 at RAISE / PL/pgSQL function cancel_cash_order_atomic(...) line 83 at assignment". Cost three live test orders.

### Operational learning — a workspace grep does not prove what is deployed (2026-07-12)
A grep of the Lovable workspace file passed while the DEPLOYED build was stale, so a "deployed successfully" report was misleading and the old code kept running.
RULE: before deploying an edge function, require the relevant code block to be PRINTED VERBATIM from the file — a grep COUNT is not proof. After deploying, confirm behaviour against the LIVE function (edge logs, or a real call), never against a success message.

### Operational learning — adding a Shopify app access scope (2026-07-12)
Scopes live in the app VERSION, not in a settings toggle: Shopify Dev Dashboard -> app -> Versions -> New version -> Scopes (comma-separated) -> Release. Releasing a new version does NOT apply the scopes to the store — the merchant must re-install/approve the app (app -> Home -> Install app). After re-authorizing, re-run shopify-register-webhooks and confirm every topic returns `already_registered` with the SAME subscription IDs: that proves the Admin API token, the webhook subscriptions and the HMAC secret all survived.

### Operational learning — Shopify debits store credit at CHECKOUT, and records it as kind "authorization" (2026-07-13)
When an order is only AUTHORIZED (e.g. store credit + a pending bank transfer), Shopify's store-credit transaction has kind "authorization", NOT "sale" — but the customer's balance is ALREADY debited (the transaction carries receipt.debit_operation_id). A filter of `kind === "sale"` silently drops it, so the Hub never records the payment and never draws down its lots — leaving credit that Shopify has already spent still showing as available, and double-spendable. On a fully-settled order the SAME transaction appears as kind "sale", which is why this was missed for days.
RULE: for STORE CREDIT accept both "sale" and "authorization" (status must still be "success"). For REAL MONEY accept ONLY "sale" — a pending bank-deposit transaction is kind "sale"/status "pending" and must never be booked as revenue received.

### Operational learning — never assume a unique constraint exists; verify it (2026-07-13)
Idempotency was built on catching Postgres error 23505 for a duplicate payment reference. But cash_payments had NO unique constraint on reference_number, so the exception could never fire and a store-credit payment was recorded TWICE (once by orders/create, once by orders/paid), inflating an order's total_paid by ¥50,000. A partial unique index (idx_cash_payments_reference_unique, WHERE reference_number IS NOT NULL AND voided_at IS NULL) has been added.
RULE: an exception-based idempotency guard is only as good as the constraint it depends on. VERIFY the constraint exists, and prefer an explicit check-before-insert as the primary defence, with the exception as a second line.

### Operational learning — a successful write with a partial response error is NOT a failure (2026-07-13)
sync-store-credit-to-shopify requested `account { balance }` in its mutation response. That field needs a scope we did not have, so Shopify returned the SUCCESSFUL write plus a partial GraphQL error on that nested field — and the code, which failed on any gj.errors, recorded two successful pushes as 'failed'. A false 'failed' is worse than no log: it invites a retry, and a retry would DOUBLE-CREDIT the customer.
RULE: judge a GraphQL mutation's success on userErrors and on whether the transaction was returned — not on the mere presence of a top-level errors array. And do not request response fields you do not need.

### Operational learning — store-credit writes must go through the edge functions, never the RPCs (2026-07-13)
The Shopify sync lives in the EDGE FUNCTIONS (issue-store-credit, void-store-credit-lot, redeem-store-credit, cancel-cash-order), not in the RPCs they call. Voiding a lot by calling void_store_credit_lot_atomic directly in SQL updated the Hub but never pushed the debit to Shopify — silently drifting the two ledgers.
RULE: once a mirror/sync exists, any write performed via SQL bypasses it. Use the application.

### Operational learning — Shopify order-edit payload semantics (2026-07-14)
- Shopify's total_price is CUMULATIVE (the sum of everything ever added to the order; it never decreases). current_total_price is the real current total. Removed lines persist in line_items forever at current_quantity: 0. Every re-add mints a NEW line_item id.
- An order edit on a paid order manifests as a refunds[] entry in the orders/updated payload; transactions[] empty = no money moved ("owed to customer" state), populated with a successful positive amount = real cash left via gateway.
- Shopify's "You owe the customer a refund ¥X" banner and "Outstanding balance" on edited paid orders is PERMANENT AND COSMETIC in our design — settlement happens as Hub store credit. NEVER settle it via the Refund page.
- store_credit_lots.source_refund_id (added 2026-07-14) + partial unique index (WHERE source_refund_id IS NOT NULL AND status <> 'voided') provides DB-level per-refund idempotency.
- shopify_webhook_events has processed_at, NOT created_at.

### revoke_loyalty_points_partial (added 2026-07-15)
revoke_loyalty_points_partial(p_customer_id, p_source_reference, p_refund_spend_jpy, p_cash_order_id, p_refund_id, p_notes, p_created_by_user_id) returns jsonb — DB-only (post-baseline), service_role + sandbox_exec only. Revoke-and-replace on loyalty_point_lots; the effective multiplier is recovered per-lot as original_amount / (floor(spend_basis/10000) × 100). loyalty_point_lots.spend_basis_jpy is the single source for partial recomputation — replacement lots carry the reduced basis forward.

revoke_loyalty_points_partial(customer, source_reference, refund_spend_jpy, cash_order_id, refund_id, notes, created_by) — live-only until 20260917060000 recorded it. Revoke-and-replace of the single active order_earn lot: old lot revoked_at + revoked_by_transaction_id; replacement keeps earned_at and expires_at; promo_bonus lots untouched.

### Operational learning — Shopify webhook integration facts (2026-07-15)
- products.shopify_product_id is a GraphQL GID; webhook payload line_items[].product_id is numeric. Normalize on EVERY join between them (GID tail = numeric id).
- Shopify draft orders fire NO webhooks. The order (and the Hub row) exists only after the draft converts: "Mark as paid" converts already-paid (orders/create + orders/paid together); "Payment due later" -> Create order converts unpaid (orders/create only).
- Shopify offers no Mark-as-paid on cancelled orders — the paid-after-cancel race is webhook-delivery inversion only, unreachable from the admin UI. The orders/paid guard is therefore code-verified by design.

### Operational learning — schedule deletions before 2026-05-17 have NO forensic trail (2026-07-23)
The Bug #6 Stage 2 triggers on layaway_schedule (prevent_schedule_deletion BEFORE DELETE, log_schedule_deletion AFTER DELETE) and the delete_schedule_row_atomic RPC that writes schedule_audit_log all landed 2026-05-17. Any schedule row deleted before that date left nothing in schedule_audit_log — no delete_installment entry, no forensic_delete entry. Do not conclude "it was never deleted" from an empty schedule_audit_log on a pre-2026-05-17 event.
RULE: for a pre-2026-05-17 deletion, reconstruct from layaway_accounts.total_amount instead. delete-installment decrements total_amount by exactly the deleted base_installment_amount and does NOT redistribute, so a total_amount sitting base-amount-below the expected DP + schedule sum is the delete's fingerprint. Cross-check against audit_logs (entity_type layaway_accounts, action UPDATE) which snapshots the full row.
RULE: schedule edits are split across TWO audit tables. add-installment / delete-installment / extend-schedule / accept-underpayment write schedule_audit_log. edit-schedule-item and EditAccountDialog write audit_logs (actions edit_installment_amount, update_due_date, add_schedule_item, update_account_details). Query BOTH — an empty schedule_audit_log does not mean the schedule was untouched.
RULE: EditAccountDialog.recalcInstallments redistributes the pool (total − DP − frozen base) across every row that is not paid/cancelled — including OVERDUE rows that already carry penalties. Typing a new Total therefore retroactively raises the base owed on a past-due month. Frozen rows are only those with paid_amount > 0 or status paid/cancelled.
- Restoring a deleted middle month requires direct SQL, not add-installment: that function appends at MAX(installment_number) + 1 and rejects any due_date not after all existing rows. Insert the row at its original installment_number (validate_schedule_chronology only compares against installment_number − 1, so a middle insert passes), set SET LOCAL app.bypass_immutable_schedule_cols = 'on' to rewrite sibling base amounts, and leave layaway_accounts untouched if total_amount is already correct.
- Do NOT hand-insert backdated penalties. penalty-engine walks every past-dated trigger it has no penalty_fees row for (`if (now < trigger.date) break;`) and backfills on its next run, writing penalty_fees + layaway_schedule.penalty_amount + total_due_amount consistently. To run it early without handling any key, execute the daily-penalty-engine cron statement in the SQL Editor — it pulls the bearer from vault.decrypted_secrets.

### commission_splits — top-sales tiers (2026-08-01)

- `top_sales_pct` = **Top 1**, `top_sales_2_pct` = **Top 2** (added 2026-08-01,
  `numeric DEFAULT 0 NOT NULL`). Existing months defaulted to 0, and the engine
  skips a tier at 0, so the column was a no-op on all historical commissions.
- Both tiers are decided on the **closer column only**, independent of
  `merge_groups`: most appearances wins, ties break on higher closer-column
  amount. Top 2 is resolved with Top 1's key excluded, so it is always the
  SECOND closer and never the same agent as Top 1.
- Bonus = `round(pool × pct / 100)` per tier. Both **stack** on top of any role
  win — a Top 1/Top 2 winner can also win Verifier and keeps both.
- An unfilled tier (pct 0, or no eligible agent — e.g. a month with only one
  closer) is simply **not paid**; the pool under-distributes by that share.
  This matches how Top 1 already behaved when no agent had closer activity.
- There is **NO CHECK constraint** on the percentage sum. The "must equal 100"
  rule is enforced client-side only, in `Commissions.tsx` `totalPct` / `saveSplit`.

### layaway_schedule triggers (updated 2026-08-01)

`trg_validate_schedule_start_year` and its function `validate_schedule_start_year` were DROPPED in production on 2026-08-01 (Bug #253). They are still present in supabase/migrations/20260705230000_baseline_live_schema.sql at lines ~6481-6502 and ~6936 — that file is a historical snapshot and was deliberately NOT edited. Live schema is authoritative: the start-year trigger does not exist. Do not recreate it; it hardcoded a 2025-26 season.

Surviving trigger on layaway_schedule: `trg_validate_schedule_chronology` (BEFORE INSERT OR UPDATE OF due_date) — installment N due_date must be after installment N-1. This is the durable schedule guard.

### Finance overview daily sales charts — layaway + cash orders (2026-08-01)

- "New Sales · This month" and "Sales · Last month" plot TWO series: layaway
  (gold area, `get_daily_new_layaway_sales[_last_month]`) and cash orders
  (green line, `get_daily_cash_orders[_last_month]`).
- Both are **always JPY**, independent of the Finance currency toggle: the
  layaway RPCs are called with `'ALL'` (their JPY-normalising mode) and the cash
  RPCs are JPY-only by design with no `currency_mode` parameter. PHP is
  converted with `total_amount / rate` (DIVISION) from
  `system_settings.php_jpy_rate`. This matches the Cash Orders KPI row, which is
  already always-JPY.
- `cash_orders.currency` has a DDL default of `'JPY'` but that default is
  effectively dead: `NewCashOrder.tsx` renders a required Currency picker and
  always sends `currency` explicitly. **PHP cash orders are real** and the PHP
  conversion arm in these RPCs is load-bearing, not dead code.
- **The two series use DIFFERENT definitions of a "sale" — deliberate:**
  layaway counts an account once it has any non-voided payment; cash counts an
  order at `status = 'completed'`. Both bucket by `order_date` (NOT
  `completed_at`), so both lines answer the same time question.
- Both series are zero-filled for every day of the month client-side, and the
  X axis uses `interval={0}` with -45° labels so days with no sales are visible.

### layaway_schedule status recomputation (2026-08-03, Bug #254)

- `layaway_schedule.status` is NOT derived — it is a stored column written by
  whichever path last touched the row. Any operation that changes the
  DENOMINATOR (`base_installment_amount`, `penalty_amount`, `carried_amount`,
  `total_due_amount`) must recompute status, or the row silently strands.
- `admin_update_schedule_base` is the SANCTIONED bypass of
  `prevent_base_amount_change` — it sets `app.bypass_immutable_schedule_cols`
  deliberately (this is by design, not a leak). As of 2026-08-03 it also owns
  status recomputation: UPWARD ONLY (`partially_paid`/`pending`/`overdue` →
  `paid` when non-voided allocations cover `total_due_amount` within 0.01), plus
  a guarded account close to `completed`.
- **Downgrades are deliberately NOT automated.** A row raised above its
  allocations stays `paid` and is surfaced by `audit_account` CHECK 7 ARM A for
  human review. `prevent_paid_row_modification` permits `paid`-row writes only
  under three narrow rules, and silently regressing a paid row is the wrong
  default on a money table.
- **`paid_amount` vs allocations asymmetry in `allocate_payment_atomic`:**
  `v_paid_amt` is the INSTALLMENT portion only; `v_fully` tests
  `v_new_paid + v_row_pen`. So on a row with penalties, `paid_amount` is
  legitimately LESS than the allocation sum. Do not "fix" `paid_amount` to match
  allocations without accounting for `allocation_type = 'penalty'` rows.
- `audit_account` CHECK 4 ("no duplicate allocations") only fires when a single
  payment's allocations EXCEED `amount_paid`. Multiple allocation rows per
  payment — and per schedule row — are normal and expected.

### penalty_fees / penalty_waiver_requests columns (updated 2026-08-18)

- `penalty_fees` has NO `waiver_status` column (12 columns total).
  `waiver_status` belongs to `penalty_waiver_requests`, not `penalty_fees`.
  Writing `waiver_status` to `penalty_fees` fails silently at the PostgREST
  layer (unknown column) — see Bug #257.
- `penalty_waiver_requests.status` (the `waiver_status` enum) is now:
  `pending | approved | rejected | auto_unwaived`.
- `penalty_waiver_requests.auto_unwaived_at` (timestamptz, nullable) — stamped
  when penalty-engine reinstates a penalty past its grace window.
- Deleting a `layaway_schedule` row CASCADES to `payment_allocations`,
  `penalty_fees`, `penalty_waiver_requests` and `csr_notifications`
  (`reminder_logs.schedule_id` is SET NULL). UNIQUE
  (account_id, installment_number) covers cancelled rows too. Any operation
  that reshapes a schedule must update rows in place rather than
  delete + re-insert.
- `trg_guard_loyalty_jpy_amount` (BEFORE UPDATE OF `loyalty_jpy_amount` on
  `layaway_accounts` and `cash_orders`): signed-in users need
  `has_permission(uid,'edit_loyalty_amount')`; refused once the order has an
  `'earned'` `loyalty_transactions` row (`account_id` / `cash_order_id`).
  `auth.uid() IS NULL` (service role) passes.
- Eleven FKs to `customers` are NO ACTION (blocking), not CASCADE (2026-10-25):
  `extension_requests`, `payment_submissions`, `service_jobs`, `trade_ins`,
  `loyalty_signups.converted_customer_id`, `website_live_claims.customer_id`,
  `web_order_drafts`, `website_coupon_uses`, `website_post_comments`,
  `review_invites`, `product_reviews`.
  `layaway_accounts` and `cash_orders` are RESTRICT and are pre-check
  protected (delete-customer refuses rather than cascading); `review_invites`
  and `product_reviews` exist only with a completed order, so they are
  protected by the same refusal. delete-customer also refuses while a website
  checkout is `to_confirm`. Owner rule 2026-10-25: finished checkouts
  (`declined` / `expired` drafts, their lines and coupon uses) and the
  customer's article comments are DELETED before the customer; a points
  redemption keeps its row and only loses `web_draft_id`. Several other FKs are
  SET NULL; the rest CASCADE. `audit_delete_cleanup_invariants()` is what
  catches a new one — add its allowlist row in the same change.
- `loyalty_signups` is NOT a child of `customers`. `name`, `contact`, `region`
  and `lang` are NOT NULL on the row; `converted_customer_id` is a nullable
  link added only if the signup converts. Deleting a customer CLEARS THE LINK
  and KEEPS THE ROW — the signup records a storefront event that happened, and
  per CLAUDE.md `website POST /loyalty/join` writes one only when an enrollment
  FAILED (alongside the `loyalty_join_failed` bell).
- `website_live_claims.customer_id` is nullable and `csr_id` exists, so a claim
  can be held without a customer. Status enum: `held | paid | layaway |
  expired | released`. A claim holds a variant, so deleting a customer moves a
  `held` claim to `released` before clearing the link; already-resolved claims
  keep their status. WHEN THE CLAIM HOLD IS ACTUALLY BUILT, the release path
  must also return the stock — nothing decrements stock for a claim today
  (0 rows, and no `%claim%` function exists for this table), so there is
  nothing to give back yet.

## Function drift audit — `scripts/function-drift-audit` (added 2026-09-17, Bug #280)

Answers one question: **does every function live runs match what the repo says it
is?** Run it before writing any migration that redefines a function, and after
any SQL Editor session that touched one. See CLAUDE.md *"FUNCTION CHANGES START
FROM LIVE"* for why this is not optional.

```
python3 scripts/function-drift-audit          # prints the query to stdout
python3 scripts/function-drift-audit > /tmp/audit.sql
```

It reads `supabase/migrations/` in filename order, collects every
`CREATE [OR REPLACE] FUNCTION public.<name>` and every `DROP FUNCTION`, keeps
the **last** definition of each name (a later `DROP` removes it), normalises each
body (`\s+` → one space, trimmed), md5s it, and emits a single **read-only**
`SELECT` with those hashes embedded as `VALUES`. Nothing is written and no
connection is made — paste the output into the Supabase SQL Editor.

**Zero rows = live and the repo agree.** Otherwise each row carries a bucket:

| bucket | meaning | what it costs |
|---|---|---|
| `a_differs` | same name, different body | the next rebuild from the repo REVERTS live |
| `b_live_only` | live has the function, the repo does not | a rebuild loses it entirely |
| `c_repo_only` | the repo has it, live does not | a dropped function still recorded (usually benign) |

**The comparator is `pg_proc.prosrc`, whitespace-collapsed — not
`pg_get_functiondef`.** `pg_get_functiondef` canonicalises the header (argument
defaults, `SET search_path TO 'public'` quoting, `RETURNS` spelling), so it
reports drift against every hand-written migration and the signal drowns. `prosrc`
is the body as stored. Comment-only differences still show as rows; clear them
anyway — a body that differs at all cannot be diffed at a glance.

Two limits, both deliberate:

- **Name-keyed, not signature-keyed.** Overloads collapse to one row. The fleet
  has none as of 2026-09-17 (the `revoke_loyalty_points` 9-arg twin was dropped —
  CLAUDE.md loyalty rule 13), and if one appears the bucket will read as a false
  `a_differs`, which is the safe direction to fail.
- **Extension functions are excluded** (`pg_depend … deptype = 'e'`), so pgmq,
  pg_cron and friends never appear.

Shortcut for a clean/not-clean answer in one row, when the full listing is not
needed — compare digests of the whole map instead of 163 rows:

```sql
WITH live AS (
  SELECT p.proname AS name,
         substr(md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))), 1, 12) AS md5
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind IN ('f','p')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
)
SELECT count(*), md5(string_agg(name || ':' || md5, chr(10) ORDER BY name)) FROM live;
```

The repo-side digest is `md5` of the same `name:md5` lines, sorted, joined by
newline — build it from the `VALUES` block the script prints. Equal digests mean
all three buckets are 0.

**Baseline, 2026-09-17:** 163 functions, digest
`b6c6d5f1a172f9c3412d220661434861`, all buckets 0. The census that produced it
found 17 `a_differs`, 15 `b_live_only` and 2 `c_repo_only`; the live bodies are
recorded in `20260917070050_record_live_loyalty_fixes.sql`,
`20260917070100_record_live_only_functions.sql`,
`20260917070200_record_live_drifted_functions.sql` and
`20260917070300_record_drop_validate_schedule_start_year.sql`.

### checkout_quotes.reserved_invoice_seq + trg_checkout_quotes_reserve_invoice (added 2026-09-18)

`checkout_quotes.reserved_invoice_seq bigint` — drawn from `web_order_number_seq` by the
BEFORE INSERT trigger `trg_checkout_quotes_reserve_invoice` (function
`checkout_quotes_reserve_invoice()`, SECURITY DEFINER) when `mode = 'layaway'` and the
column is NULL; full-payment quotes stay NULL. Partial unique index
`uq_checkout_quotes_reserved_invoice_seq` (WHERE NOT NULL). `create_web_layaway_atomic`
sets `v_seq := coalesce(v_quote.reserved_invoice_seq, nextval(...))`, so the plan's
`invoice_number` = the seq and `web_reference` = `'CJ-W-' || lpad(seq, 6, '0')` are the
numbers the quote already carried; the coalesce serves quotes created before migration
`20260918120000`. `POST /checkout/quote` and `GET /checkout/quote/:id` return them as
`invoice_number` / `web_reference` (both `null` for full-payment quotes). Expired or
abandoned layaway quotes keep their number — the sequence has gaps by design, and cash
web orders draw from the same sequence.

## Page365 import — `invoice_numbers`, `page365_drafts`, provenance columns (added 2026-09-19)

Migration `20260919100000_page365_import.sql`.

### `public.invoice_numbers` — cross-table invoice uniqueness

`invoice_number` is UNIQUE within `cash_orders` and UNIQUE within `layaway_accounts`,
and there was **no constraint between them**. The same number could therefore be a
cash order and a layaway plan at once, and `create-layaway-account` did not even
pre-check its own table — a collision surfaced as a raw Postgres unique-violation
(`create-cash-order` has pre-checked both since it was written; the asymmetry was
real, not theoretical).

`invoice_numbers(invoice_number text PK, source text, order_id uuid, created_at)` now
holds one row per invoice number in use across both tables. It is maintained
**entirely by triggers** — `register_invoice_number()` on
`trg_zz_invoice_registry_{cash,layaway}` (BEFORE INSERT OR UPDATE OF invoice_number)
and `trg_zz_invoice_registry_{cash,layaway}_del` (AFTER DELETE). Application code
never writes it: there is a SELECT policy for staff and **no** INSERT/UPDATE/DELETE
policy at all.

**The `trg_zz_` prefix is load-bearing, not cosmetic.** Postgres fires BEFORE triggers
in *name* order. `enforce_test_invoice_prefix` runs as
`trg_test_invoice_prefix_{cash,layaway}` BEFORE INSERT and rewrites `invoice_number`
to `TEST-<n>` for `is_test` customers; on layaway `trg_enforce_plan_minimum` also runs
BEFORE INSERT. A registry trigger sorting ahead of either would record the wrong
value. Verified on live data in a rolled-back transaction: a test customer's order
numbered `990003` registers as `TEST-990003`.

**UPDATE and DELETE are handled, and must stay handled.** `invoice_number` is mutable
(the prefix trigger itself fires on `UPDATE OF invoice_number`), and unpaid,
never-completed orders can still be deleted by admin. An INSERT-only registry would
permanently burn the number of a deleted typo and would miss renames entirely.

Backfill measured on live 2026-09-19: **160 cash + 1538 layaway = 1698 rows, 1698
distinct, 0 cross-table duplicates.** APPLIED figures differ and that is correct:
when Lovable ran the migration the same day it inserted **160 + 1543 = 1703**,
five layaway plans having been created in between. The invariant the migration
post-checks is `registry = cash + layaway`, never the literal 1698. Every row is registered including `TEST-`
prefixed ones — a test invoice is still a number in use, and omitting it would let a
real order claim it. The migration's DO block RAISEs rather than skipping if any
cross-table duplicate is ever found, and post-checks that the registry count equals
the sum of both tables.

### `public.page365_drafts` — staging, not a record

`(id, created_by, created_at, expires_at default now()+2h, page365_no, page365_slug,
payload jsonb, consumed_at)`. Written only by `page365-fetch-order` under the service
role; RLS gives staff SELECT on their own unexpired rows and no write policy at all,
so a CSR cannot forge a draft carrying prices Page365 never returned.

**The `?sig=` is never stored.** It is a capability token: anyone holding the full
Page365 link can read that customer's name, phone and address. It is used for the one
outbound fetch and dropped — not persisted, not logged, not returned. Only the slug
and the invoice number survive.

### `page365_no` / `page365_slug` on both order tables

Provenance, on `cash_orders` AND `layaway_accounts` (ACCOUNT-SCOPE COVERAGE). Partial
unique indexes `uq_{cash_orders,layaway_accounts}_page365_no` make one Hub order per
Page365 invoice structural; both creating functions also pre-check across both tables
and answer 409 `already_imported` with the order's id, because an index error is not
a message a CSR can act on.

### Line-item money columns are YEN, whatever the account currency

`cash_order_items` and `layaway_account_items` name their money columns
`unit_price_jpy` / `line_total_jpy`. Page365 invoices are JPY (owner decision
2026-09-19) and the manual pages pick from a JPY catalogue, so lines stay in yen even
on a PHP account. Only account-currency money — `total_amount`, `shipping_fee`,
`discount_amount` — converts. Converting the line columns would make their names lie
and would corrupt the loyalty basis, which is the product amount in yen (INVARIANT 10).

`image_url` existed on both tables since the Shopify work and had never been written
by anything (0 of 9 live rows). A Page365 import is its first real writer; web lines
still resolve photos at read time from `website_product_media` by variant (Bug #275),
which Page365 items cannot use because they have no variant.

## `next_reconciliation_batch` and the second reconciliation run (added 2026-09-23)

`public.next_reconciliation_batch(p_limit integer DEFAULT 800)` returns the
accounts `daily-reconciliation` should reconcile next — `id, invoice_number,
status, total_paid, remaining_balance, last_checked_at` — ordered **never
reconciled first, then oldest `reconciliation_log.checked_at` first, then `id`**.
`LANGUAGE sql STABLE SECURITY DEFINER`, `search_path` pinned to `public`,
`EXECUTE` revoked from `PUBLIC` and granted to `service_role` only. It replaces a
JS sweep of `reconciliation_log` in the edge function.

Backed by `idx_reconciliation_log_account_checked (account_id, checked_at DESC)`,
which turns the lateral `max(checked_at)` into an Index Only Scan — one loop per
candidate, 563 loops, 4.231 ms measured against live.

**Why the ordering lives in SQL now.** The JS version stopped paging once its
`Map` held as many *distinct accounts* as there were *candidates*. Those are two
different populations — the log carries 1,305 accounts, the candidate set is 563 —
so it could stop with candidates still unseen and treat them as never reconciled.
On 2026-09-23 it reported 2 never-reconciled accounts where the true figure is 0.
The page count also grew with the log rather than with the work.

**What it does NOT buy is speed.** Measured from `reconciliation_log` timestamps
over five consecutive nights, the run spends ~2.0 s per account on the HTTP round
trip to `reconcile-account`, and covers 91 of 563 candidates before the budget is
spent. The sweep it replaced cost ~60 ms of database time. Throughput is unchanged
by this function; do not quote it as a performance fix.

**`daily-reconciliation-midday`** — pg_cron, `20 12 * * *` (20:20 PHT), identical
Vault-backed body to jobid 15 (`email_queue_service_role_key`, CRON AUTH RULE).
This is what moves throughput: ~91 accounts a day becomes ~182, and a full pass
over the candidate set drops from ~6.2 days to ~3. It sits far from the
00:00–00:55 morning chain and is not part of its ordering. `cron.schedule` upserts
by jobname, so re-running the migration is a no-op.

## Two polled-query indexes, and the one that is narrower than it looks (added 2026-09-23)

`idx_payment_submissions_status_pending` — `(status) WHERE status IN
('submitted','under_review')`. Serves `use-pending-submissions.ts:15` (polled every
30 s by every user who can see submissions) and `:47`. The table has 4,902 rows and
4 matches; the count query alone had burned 55,078 s of database time over the
191-day `pg_stat_statements` window. Index Only Scan, 0.053 ms measured. The
partial predicate matches the `= ANY (ARRAY[…]::submission_status[])` form
PostgREST generates from `.in('status', […])` — the pre-existing
`idx_payment_submissions_cash_order_status` already relied on this.

`idx_reminder_logs_delivery_status_created` — `(delivery_status, created_at DESC)`.
**`reminder_logs.delivery_status` is not a selective column.** Production holds
exactly two values: `sent` 15,471 and `generated` 3,448 of 18,919. So the index
serves `dashboard-summary/index.ts:172` (`.eq('failed')`, 0 rows — 3,410 s of the
window removed, Index Only Scan at 0.060 ms) and nothing else today:
`:171` (`sent`+`delivered`, 82% of the table) and `Monitoring.tsx:152` (`sent`)
correctly keep a sequential scan (5.8 ms measured), `:170` is an unfiltered count,
and `Monitoring.tsx:119` has no status filter so the `created_at DESC` column does
not apply. Its value is the failure counts and any status that becomes rare — which
is the case that matters. Do not "fix" those sequential scans with another index.

## Duplicate-customer prevention — `find_customer_matches` (added 2026-09-24)

OWNER RULES (locked 2026-09-23, verbatim):

1. A customer is a duplicate if ANY of these match an existing (non-test) customer: full name, Facebook name, mobile number, email.
   - full name / Facebook name: exact after lower-case, trim, collapse repeated spaces
   - mobile: last 10 digits, only when the number has >= 10 digits
   - email: exact, case-insensitive
2. HUB: there is NO "create anyway". A match blocks the save. Staff must look at the matching customer(s), confirm the details with the customer, and USE the existing account.
3. SIGNUP: a match on any of the four fields BLOCKS signup. The customer sees: "You are already registered. Please contact Cha Jewels for your account details." Staff get a notification.
   EXCEPTION (unchanged existing behaviour): when the signup EMAIL matches an existing customer that has no login yet, the login is linked to that customer as today — that is her own record, not a duplicate. The duplicate check runs only on the branch that would CREATE a new customer.

**The RPC.** `public.find_customer_matches(p_full_name text, p_facebook_name text,
p_mobile text, p_email text, p_exclude_customer_id uuid DEFAULT NULL)` RETURNS TABLE
`(customer_id uuid, customer_code text, full_name text, facebook_name text,
mobile_number text, email text, location text, has_login boolean, matched_on text[])`.
`matched_on` holds any of `full_name`, `facebook_name`, `mobile`, `email`; rows are
ordered oldest customer first; `is_test` customers are never returned. STABLE
SECURITY DEFINER. Staff (admin / finance / staff / csr), the service role and the SQL
Editor may call it; a signed-in non-staff caller gets 42501. EXECUTE is revoked from
PUBLIC and anon. Applied live by the owner on 2026-09-23; recorded in
`supabase/migrations/20260924000000_find_customer_matches.sql` (md5 of
`pg_get_functiondef` in its header). Normalisation note: `btrim()` strips SPACES only,
so a leading tab survives as a space — the client mirrors in
`src/lib/customer-matches.ts` copy that exactly.

**Callers — every path that creates a customer from a person's typed details:**

| Path | On match | On a failed check |
|---|---|---|
| `NewCustomerDialog` (Customers, New Account, New Cash Order, Page365 Review) | Not created. "Existing customer found" panel; each match needs "I confirmed these details with the customer" ticked before "Use this customer". Using one writes `audit_logs` (`entity_type 'customer'`, `action 'duplicate_prevented'`, `new_value_json` = typed fields + `matched_on`) and hands the full row to `onCreated`, or opens `/customers/:id` when there is no `onCreated` (Customers page). | Not created; error shown. |
| `EditCustomerDialog` | Save blocked (`p_exclude_customer_id` = the customer being edited); same list, read-only. | Save blocked. |
| `ImportCustomersDialog` | Row not inserted; listed with the matching customer code(s) and fields. Rows of the same file that match EACH OTHER are all held back — nothing in the file says which one is right. Other rows import as normal. No override. | Row marked failed, not inserted. |
| `AICommandModal` CREATE_CUSTOMER | Not inserted; the chat lists code, name and matched fields and tells staff to use the existing account. | Not inserted. |
| `setup-customer-account` (portal signup, create branch only) | 409 `{ error: "already_registered", message }` + `staff_notifications` `duplicate_signup_blocked`. | 500, no insert. |
| `website` `POST /auth/customer` (create branch only) | Same 409 + same notification (`metadata.source = 'website_auth_customer'`). Before the check, a create needs a profile: empty `full_name` or `location` → 422 `profile_required`, nothing created, nothing notified (2026-09-24). The email-prefix name fallback is gone, so the name checked and the name stored are always the one the customer typed. | 500, no insert. |

`staff_notifications` type `duplicate_signup_blocked`: title "Signup blocked — existing
customer"; body carries the signup email, name, Facebook name, mobile, location, auth user
id and each matching customer code with its `matched_on`; `customer_id` = the first
match; `metadata.matches` holds the full list.

NOT routed through the RPC (unchanged, by decision): `bulk-import` (matches on
`customer_code` only) and `shopify-webhook` (shopify_customer_id → email → exact phone,
else create-and-flag `needs_review = true`).

## Reassign Owner — guard trigger and two functions (added 2026-09-24)

Migration `20260924130000_reassign_order_owner.sql` (applied by the owner in the
SQL Editor; rules R1–R10 in CLAUDE.md "REASSIGN OWNER").

### `trg_guard_order_customer_id` → `guard_order_customer_id_change()`

`BEFORE UPDATE OF customer_id` on BOTH `layaway_accounts` and `cash_orders`.
Raises (42501) when `NEW.customer_id IS DISTINCT FROM OLD.customer_id` and
`auth.uid() IS NOT NULL`. So a signed-in user — any role, including admin — can
no longer change an order's owner through PostgREST; only a service-role caller
(the reassign RPC via its edge function) or the SQL Editor can. Writing the
same owner back, and edits to every other column, pass. It retired the old
browser `.update({ customer_id })` in ReassignOwnerDialog, which moved the order
and left its submissions, requests and loyalty history with the old customer.
Sorts before `trg_test_invoice_prefix_*`, which also fires on customer_id.

### `insert_lot_catch_up(p_member_id uuid, p_invoice text, p_amount int, p_order_date date) → uuid`

A new name, not an overload. Built from the LIVE `insert_lot_and_extend`
(md5 `68dd571baaec085daf1c8312877b1948`, length 1627, captured 2026-09-24
06:44:04 UTC — the body recorded in `20260917070050` reproduces it exactly on a
clean Postgres 17 replay). Differences:

- `expires_at` = PHT midnight of `order_date + 180` (not `earned_at + 180`).
- Other lots of the member (`order_earn`/`admin_adjust`/`birthday_bonus`,
  `remaining_amount > 0`, `expired_at IS NULL` — the live eligibility set) are
  only EXTENDED: `GREATEST(expires_at, new expiry)`, and a lot with NULL
  `expires_at` is never touched. The live function sets them outright to
  `earned_at + 180` — which SHORTENS a lot expiring later and gives a
  never-expiring lot a date (observed on the replay; normal award path, left
  as is).
- Born expired (`order_date + 180 <=` PHT today): inserted with
  `remaining_amount = 0`, `expired_at = now()`. See CLAUDE.md for why a live lot
  with a past date would be wrong.
- `earned_at = now()`; notes `catch-up after reassign` (+ `born expired`).

SECURITY DEFINER, `search_path = public`, EXECUTE for `service_role` only.
Only caller: award-loyalty-points when the body carries `catch_up`.

### `reassign_order_owner_atomic(p_kind, p_order_id, p_new_customer_id, p_loyalty_jpy_amount, p_reason, p_user_id, p_apply) → jsonb`

SECURITY DEFINER, `search_path = public`, EXECUTE for `service_role` only.
Locks the order `FOR UPDATE`. Repeats `has_permission(p_user_id,
'reassign_owner')` (and `'edit_loyalty_amount'` when the amount changes)
because `trg_guard_loyalty_jpy_amount` does not fire for a service-role caller.

Hard errors (`ok:false`): `invalid_kind`, `reason_required`, `forbidden`,
`not_found` (order or customer), `same_owner`. Refusals, collected in check
order into `refusals[]` so the preview can show every one: `status_closed`,
`test_boundary`, `both_have_points` / `points_account_is_current_owner`,
`already_earned` (claim with or without transaction_id, earned row by id or
invoice, bonus row on the invoice, any `order_earn`/`promo_bonus` lot on the
invoice in any state), `shopify_order` (`SH-` invoice, `source_channel ILIKE
'shopify%'`, or `shopify_order_id`), `split_submission` (any submission touching
the order whose account_id / cash_order_id / allocations span more than one
order, any status), `loyalty_redemption` (non-cancelled, by id or invoice),
`store_credit` (a transaction on the order or a lot sourced from it),
`loyalty_amount_required`, `loyalty_permission_required`. With `p_apply = true`
the first refusal is returned as `error` and nothing is written.

The preview carries both sides (enrolled, tier, points, spend, has_points),
the loyalty amount (stored / proposed / effective), the award point and its
source, the catch-up decision (`eligible`, `reason` ∈ eligible | not_enrolled |
not_at_award_point | paid_before_enrollment, `grace_days`, `expected_points`
computed with the award's own ratchet and requalify arithmetic and no promo,
`below_minimum`, `expired_on_award`, `lot_expires_on`, `loyalty_enabled`) and
the child-row counts. The catch-up award itself is NOT made in SQL.

Verified on a throwaway Supabase Postgres 17.6 replay of every migration plus
stand-ins for the live-only tables: every refusal, both apply paths, the child
moves, the cash address snapshot, the audit row, the guard trigger and both lot
behaviours.

### R11 identity match + wrong-customer override (added 2026-09-24)

Migration `20260924150000_reassign_identity_match.sql` (owner runs it; md5
guard on live `reassign_order_owner_atomic` d51393e67cc1f208457964a637bc3ca8 /
23658 and on `find_customer_matches` e7f259b57c2a8d2f161c7189a19f4a3e / 2852,
which it does NOT change).

**New signature** — the 7-argument function is DROPPED and re-created with one
more LAST parameter, so there is exactly one overload:

    reassign_order_owner_atomic(p_kind text, p_order_id uuid,
      p_new_customer_id uuid, p_loyalty_jpy_amount numeric, p_reason text,
      p_user_id uuid, p_apply boolean, p_allow_unmatched boolean DEFAULT false)

Same SECURITY DEFINER, `search_path = public`, EXECUTE for `service_role`
only. A 7-argument NAMED call (the pre-R11 edge function) still resolves and
gets R11 strictly.

**The check** runs after the R1/R5 refusals and before
`loyalty_amount_required`. It compares the CURRENT owner with the target on
full name and Facebook name (`lower(regexp_replace(btrim(x), '\s+', ' ',
'g'))`), mobile (last 10 digits, both sides >= 10 digits) and email
(`lower(btrim(x))`); an empty field never matches. No match →
`different_customer_details` unless `p_allow_unmatched` is true AND
`has_permission(p_user_id, 'reassign_owner_unmatched')` — the RPC re-checks
the permission even though the edge function already did. The override removes
only that one refusal.

**Output** — preview/result gain `matched_on` (jsonb array of `full_name`,
`facebook_name`, `mobile`, `email`) and `unmatched` (boolean). The
`audit_logs` row's `new_value_json` gains `matched_on`, `unmatched` and
`override_used` (true only when the override actually carried a no-match move).

**Permission `reassign_owner_unmatched`** — seeded admin = true; staff,
finance, csr, live_agent = false; `ON CONFLICT (role, permission_key) DO
NOTHING`, so a row already set in Settings is kept. Label in the Permission
Matrix: "Reassign owner — different customer (wrong-customer override)".
Fallback in `src/lib/role-permissions.ts`: `['admin']`.

**Edge function** — body `override: true` → `p_allow_unmatched` only with the
permission; asked for without it → 403 `override_not_permitted`.
`different_customer_details` → 409.

Verified on a throwaway Supabase Postgres 17.6 replay (same stand-ins): matched
move, unmatched refused, unmatched refused for a caller without the permission
even with `p_allow_unmatched`, unmatched allowed with the override (audit
`override_used` true), the override on an R1-refused order still refused, and
the 7-argument named call. A re-run of the file stops at its guard.

## `check_customer_email_conflict(uuid)` (added 2026-09-25)

Read-only helper the customer page's portal share menu calls on mount, before a
staff member sends an email/password setup link. `LANGUAGE plpgsql`, `STABLE`,
`SECURITY DEFINER`, `search_path` pinned to `public`.

**Callers:** admin / finance / staff / csr. The body gate is the same idiom as
`find_customer_matches`, and a NULL `auth.uid()` (SQL Editor, service role)
passes — it is a staff check, not an authentication one. Until 2026-09-25 the
gate admitted admin and finance ONLY, so every staff and CSR call raised `42501`
and the screen showed no warning at all; see docs/FIXED-BUGS.md
"Portal share menu email-conflict check rejected for staff/CSR".

**Four return values, and there are no others:**

| value | meaning |
|---|---|
| `NULL` | no conflict, or the customer has no email |
| `staff_conflict` | the email belongs to a login carrying a non-`customer` role |
| `customer_conflict` | the email belongs to a login already linked to a DIFFERENT `customers` row |
| `orphan_auth` | the email has a login with no role and no customer link |

Checked in that order; the first match wins. A login that IS this customer's own
`auth_user_id` is excluded from all three, so a migrated customer never conflicts
with herself.

**Matching is exact, not fuzzy:** `lower(u.email) = nullif(lower(btrim(email)), '')`.
An earlier body used `ILIKE`, which let a stray `%` or `_` in a customer's email
match unrelated logins. Never reintroduce a pattern match here.

**Grants:** `REVOKE ALL FROM PUBLIC, anon`, `GRANT EXECUTE TO authenticated,
service_role`. The `20260705230000` baseline records a REVOKE from
`authenticated` that live has never had — live's grants are the ones above, and
`20260925030000_check_customer_email_conflict_staff_gate.sql` re-asserts them.

**The caller must distinguish three states, not two.** A NULL return and a failed
call are different facts, and the UI renders them differently
(`conflictCheckFailed` vs `emailConflict === null`). A client that only checks
`if (!error)` reports a refused check as an all-clear — which is precisely the
bug above.

## `cash_orders.fx_rate_used` / `fx_rate_date` (added 2026-09-25)

`numeric(12,6)` / `date`, nullable, mirroring `layaway_accounts`. The
`fx_rates.jpy_php` rate (PHP per 1 JPY) a PHP-settled WEB order was charged at,
copied from its checkout quote by `create_web_order_atomic` — the only writer.
NULL on yen orders and on Hub-arranged peso orders (those were priced at
`system_settings.php_jpy_rate` by staff, not by a quote). CHECK
`cash_orders_fx_rate_only_on_php`: a rate only ever sits on a `currency = 'PHP'`
row, > 0. Never returned to customers. Mechanics: docs/CASH-ORDERS.md
"WEB ORDERS IN PESOS".

## `page365_stock_lines` — Page365 → website stock ledger (added 2026-09-26)

Migration `20260926120000_page365_stock_sync.sql`. Rules: docs/PAGE365-IMPORT.md "STOCK".

One row per Page365 invoice line, ever: `UNIQUE (page365_no, line_no)` is the
idempotency key (`line_no` = 1-based position in `page365_drafts.payload->items`;
Page365 line ids are not read). `cash_order_id` / `account_id` (at most one set,
both `ON DELETE SET NULL` — a deleted order leaves its lines, released). The
match: `first_word`, `match_result` (`pending | matched | not_a_product |
unmatched | ambiguous_sku | no_variant | ambiguous_variant`),
`website_product_id`, `variant_id`. Stock: `stock_state` `none` (never took) |
`held` (the Hub took website stock) | `released` (given back) | `page365_master`
(PR 2: matched and recorded, no stock moved) | `absorbed` (PR 2 cut-over: was held;
its piece is inside Page365's count, nothing is ever given back), `stock_seen`
(stock_qty before the reduction), `held_at`, `released_at`. Staff: `flag`
(`unmatched | ambiguous_sku | no_variant | ambiguous_variant |
insufficient_stock | rehold_failed`), open while `resolved_at IS NULL`;
`resolved_by`, `resolution_note`.

RLS: staff (`is_staff`) SELECT only. No INSERT/UPDATE/DELETE grant to
`authenticated` — every write is a SECURITY DEFINER function:

| Function | Caller | Does |
|---|---|---|
| `page365_first_word(text) → text` | anyone signed in | IMMUTABLE; the code rule. Twin: `firstWord()` in `_shared/page365-stock.ts` |
| `page365_match_line(text) → table` | `page365-fetch-order` (preview), staff | read-only, SECURITY INVOKER |
| `page365_apply_stock(kind, order_id, draft_id, service_line_nos int[], actor) → jsonb` | service role only | claim each line, then the conditional decrement; flags + bell + audit `page365_stock_applied` |
| `page365_stock_follow_order()` | triggers `trg_page365_stock_follow_{cash,layaway}` (AFTER UPDATE OF status) and `…_delete` (AFTER DELETE) | release on dead/delete, re-take on revive; audit `page365_stock_released` / `page365_stock_reheld` |
| `resolve_page365_stock_flag(line_id, note) → jsonb` | `manage_website_catalog` | note required; never moves stock; audit `page365_stock_flag_resolved` |

`staff_notifications.type = 'page365_stock_flag'`: `account_id` is set only for
a layaway (the bell treats `account_id` as a layaway id); `metadata` carries
`page365_no`, `order_kind`, `order_id`, `cash_order_id` (cash), `reason`
(`import` | `rehold_failed`) and, on import, the flagged `lines`.

## Page365 inventory fetch — run tables and photo identity (added 2026-09-27)

Migration `20260927100000_page365_inventory_fetch.sql`. Rules: docs/PAGE365-IMPORT.md "INVENTORY".

- `page365_inventory_runs` — `status fetching | ready | partial | failed`, `page365_count`,
  `products_total`, `previous_count` (last ready run's count, for the 20 % drop check),
  `chunks_started`, `error`, `finished_at`. Unique partial index: one `fetching` run.
- `page365_inventory_chunks` — one row per `continue` call `(run_id, chunk_no, products)`.
- `page365_inventory_products` — queue + what was read, `UNIQUE (run_id, page365_product_id)`;
  `status pending | claimed | fetched | error`, `attempts`, `photos jsonb`
  (`[{id, version, url, position}]` only — never reviews).
- `page365_inventory_items` — review rows: kind `page365` (one per Page365 variant,
  `UNIQUE (run_id, page365_product_id, page365_variant_id)`) or `hub_only`
  (`UNIQUE (run_id, website_product_id)`); `code`, `match_result`, `variant_id`,
  `seen_stock`, `web_holds`, `invoice_holds`, `proposed_stock >= 0`, `category`,
  `price_differs`, `photos_total / _to_copy / _removed`, `missing_runs`,
  `status review | applied | changed_since_fetch | failed`, `result_note`.
- RLS on all four: SELECT for `has_permission(uid, 'manage_website_catalog')`; no browser
  writes. Writers: service role (the two edge functions) and SECURITY DEFINER
  `page365_inventory_claim / _store_product / _finish / _record_photo` (service role only),
  `page365_inventory_apply` (authenticated, permission-checked inside),
  `page365_web_holds` (service role only).
- `website_product_media.page365_photo_id bigint`, `page365_photo_version text`; unique
  `(variant_id, page365_photo_id) WHERE page365_photo_id IS NOT NULL`. NULL = staff photo.
- `system_settings.page365_inventory_auto_apply` seeded `false`; since PR 3 (20260930100000) the
  guarded switch for automatic decreases (see "Page365 inventory schedule" below).
- New `audit_logs` entity types: `website_product_variant` (actions
  `page365_inventory_applied`, `page365_photo_copied`) and `page365_inventory_run`
  (`page365_inventory_apply`).

## Page365 inventory schedule — run columns, switch, closer (added 2026-09-30)

Migration `20260930100000_page365_inventory_schedule.sql`. Rules: docs/PAGE365-IMPORT.md "SCHEDULE".

- `page365_inventory_runs` new columns: `lease_holder text`, `lease_until timestamptz` (one
  reader per run), `auto_apply_state` (CHECK `applied | off | not_ready | window_passed |
  superseded`, NULL on manual runs), `auto_applied / auto_apply_changed / auto_apply_skipped
  integer`, `auto_apply_at` (closed once), `notified_at` (the one bell), `pruned_at`
  (retention). Index `(source, created_at DESC)`. `source` was already `manual | schedule`.
- `system_settings.page365_inventory_auto_apply` — JSON true/false; written ONLY by
  `set_page365_inventory_auto_apply(boolean, boolean)` (authenticated, `manage_website_catalog`
  inside, audit `system_setting` / `set_page365_inventory_auto_apply`); read by
  `get_page365_inventory_auto_apply()`; `trg_guard_page365_inventory_auto_apply` (BEFORE UPDATE
  OR DELETE on system_settings) refuses any other change unless `app.allow_page365_auto_apply_change`
  = on (set only inside the RPC).
- Service role only: `page365_inventory_lease(uuid, text, integer)`,
  `page365_inventory_release(uuid, text)`, `page365_inventory_auto_apply_run(uuid)`,
  `page365_inventory_retention(integer)`.
- New `audit_logs` actions: `page365_inventory_auto_applied` (entity `website_product_variant`,
  performed_by NULL), `page365_inventory_auto_apply` (entity `page365_inventory_run`),
  `set_page365_inventory_auto_apply` (entity `system_setting`).
- New `staff_notifications.type`: `page365_inventory_run_failed`, `page365_inventory_auto_applied`
  (metadata `run_id`, plus `applied` / `codes` or `status` / `error`).
- pg_cron `page365-inventory-schedule` `2-59/5 * * * *` → `page365-inventory-fetch`
  `{action:"schedule"}`, Vault key `email_queue_service_role_key`.

## Page365 hide-follow — presence, hide rows, run counts (added 2026-10-01)

Migration `20261001100000_page365_hide_follow.sql`. Rules: docs/PAGE365-IMPORT.md "HIDE-FOLLOW".

- `page365_product_presence` (PK `website_product_id` → `website_products` ON DELETE CASCADE):
  `code`, `first_seen_at/_run_id`, `last_seen_at/_run_id`, `hidden_at`, `hidden_run_id`,
  `hidden_by` (NULL = schedule), `hidden_source` (`manual | schedule`), `updated_at`. Run ids
  are NOT foreign keys (retention prunes runs). RLS: SELECT for `manage_website_catalog`;
  written only by `page365_inventory_follow` / `page365_inventory_hide_item`. Kept out of
  `website_products` on purpose: `trg_website_products_revalidate_upd` (per statement since
  2026-10-25, migration 20261230200000) fires on every update of that table, and a
  last-seen stamp per product every 30 minutes would revalidate the storefront for every
  product it touched, every run.
- `page365_inventory_items.hide_snapshot jsonb` (`{variant_id: stock_qty}` at the read) and
  `back_in_page365 boolean NOT NULL DEFAULT false`. Category CHECK
  `page365_inventory_items_category_check` adds `hide`.
- `page365_inventory_runs.hidden_count integer NOT NULL DEFAULT 0`, `hide_notified_at`.
- Trigger `trg_page365_inventory_follow` (AFTER UPDATE OF status, WHEN fetching → ready) →
  `page365_inventory_follow_trg()` → `page365_inventory_follow(uuid)` (service role).
- `page365_inventory_hide_item(uuid,uuid,uuid,text)` service role only;
  `page365_inventory_hide(uuid,uuid[])` authenticated + `manage_website_catalog`.
- Redefined from its live body (md5 `f742ccfd…` → `21eb5605…`):
  `page365_inventory_auto_apply_run`. Pinned unchanged: `page365_inventory_finish`,
  `page365_inventory_apply`, `page365_inventory_retention`, `website_publish_products`.
- Bell type `page365_inventory_hidden`; audit actions `page365_inventory_hidden` (per
  product), `page365_inventory_hide` (per staff call), `page365_inventory_follow_failed`.

## Page365 quick fetch — run kind, listed products, reader lease (added 2026-10-02)

Migration `20261002100000_page365_quick_fetch.sql`. Rules: docs/PAGE365-IMPORT.md "QUICK FETCH".

- `page365_inventory_runs.kind text NOT NULL DEFAULT 'full'` CHECK `quick | full` (every run
  before PR 3c is full; the edge function always sets it), `listed_total integer` (quick runs:
  listings not opened), `auto_increased integer` (increases among `auto_applied`).
  `products_total` = pages to open (quick) / every listing (full); `page365_count` = the LIST
  count in both — the shrink guard's basis.
- `page365_inventory_products.status` CHECK adds `listed` (quick runs: on the list, page not
  opened; never claimed, never open, never an error).
- `page365_inventory_reader` (one row, `id boolean PK CHECK (id)`, `lease_holder`,
  `lease_until`): the Create-drafts refresh's lease. RLS on, service role only.
- `system_settings.page365_inventory_full_hour_pht` (JSON number, default 2 = 02:00 PHT =
  03:00 JST): the nightly full read's hour. The auto-apply switch's DESCRIPTION was updated;
  its value was never written.
- New, service role only: `page365_inventory_plan_quick(uuid)`, `page365_inventory_next_kind()`,
  `page365_inventory_refresh_product(uuid,jsonb,text)`, `page365_inventory_reader_lease(text,integer)`,
  `page365_inventory_reader_release(text)`.
- Redefined from their live bodies (md5 before → after): `page365_inventory_finish`
  `9d0be949…` → `6bf16430…`; `page365_inventory_auto_apply_run` `21eb5605…` → `d9d251fb…`;
  `page365_inventory_create_drafts` `8e30c58f…` → `9ae1eb47…`. Pinned unchanged: claim,
  store_product, apply, lease, retention, follow, hide_item.
- New item notes: `gone_from_page365` (fresh read: listing/variant left Page365). New
  create_drafts reasons: `not_full_fetch`, `not_fresh`, `gone_from_page365`.

## Page365 schedule interval + time-safe hide (added 2026-10-03)

Migration `20261003100000_page365_interval.sql`. Rules: docs/PAGE365-IMPORT.md "INTERVAL".

- `system_settings.page365_inventory_interval_minutes` — JSON NUMBER, only `5 | 10 | 20 | 30`
  (table CHECK `system_settings_page365_interval_check`; a JSON string is refused). Seeded 30.
  Trigger `trg_guard_page365_inventory_interval` (`guard_page365_inventory_interval()`,
  bypass GUC `app.allow_page365_interval_change`) refuses UPDATE/DELETE of the value outside
  the setter. `updated_by_user_id` / `updated_at` stamped by the setter.
- `set_page365_inventory_interval(p_minutes integer, p_expected integer DEFAULT NULL)` →
  jsonb (`ok, changed, minutes, old_minutes` | `error`: user_identity_required,
  permission_denied, invalid_interval, setting_missing, stale). authenticated;
  `manage_website_catalog` checked inside. Audit: `audit_logs` action
  `set_page365_inventory_interval`, entity_type `system_setting`, old/new `minutes`.
- `get_page365_inventory_interval()` → jsonb (`minutes, allowed, updated_at,
  updated_by_user_id, updated_by_name, last_scheduled_at, reading ('schedule'|'manual'|null),
  next_check_at, can_change`). authenticated + service role; `manage_website_catalog`.
- `page365_inventory_interval_minutes()` → integer (30 if missing). Service role only.
- `page365_inventory_follow` redefined from live (md5 9c99a035… → 6e265684…): step (d) adds
  `pr.last_seen_at <= v_run.created_at - interval '30 minutes'`. Nothing else changed.

## Page365 drafts — source columns and publish rules (added 2026-09-28)

Migration `20260929100000_page365_inventory_drafts.sql`. Rules: docs/PAGE365-IMPORT.md "DRAFTS".

- `page365_inventory_products.list_category_id bigint`, `list_category text`,
  `list_description text` — from the catalogue LIST at fetch start (no reviews there).
- `website_products.page365_product_id bigint`, `page365_variant_id bigint`,
  `page365_category text`; unique `(page365_product_id, page365_variant_id) WHERE
  page365_product_id IS NOT NULL`. NULL = made in the Hub.
- Functions: `page365_inventory_create_drafts(uuid, uuid[])` and
  `website_publish_products(uuid[])` (authenticated, permission-checked inside);
  `website_product_publish_missing(uuid)` (authenticated + service role);
  `page365_category_for / _metals_from_text / _clean_description` (service role only).
- Trigger `trg_page365_draft_publish_guard` BEFORE INSERT OR UPDATE OF status ON
  website_products — Page365 drafts only.
- `website_products.item_kind text NOT NULL DEFAULT 'jewelry'`, CHECK
  `website_products_item_kind_check` (`jewelry | watch | other`). **A metal stamp is required
  ONLY for jewelry** (owner decision 2026-09-28): CHECK `website_products_metals_nonempty`
  (every product) was REPLACED by `website_products_metals_jewelry`
  (`item_kind <> 'jewelry' OR cardinality(metals) >= 1`); `website_products_metals_values`
  (the stamp list) is unchanged. The publish check (`website_product_publish_missing`) and
  the draft guard ask for `metal` only on jewelry. `sync_website_product_metals()` (the
  karat bridge, redefined from its live 20260912142545 body, md5-guarded) refills `metals`
  from `karat` for jewelry only and sets `karat` NULL when there is no stamp. The
  spreadsheet importer stays jewelry-only (it needs a jewelry type and a weight): watches
  are created in the product dialog or by Create drafts (a Page365 listing whose name or
  category carries the whole word "watch"/"watches" is drafted as `watch`).
- "Don't sync with Page365" (PR 2): `page365_inventory_create_drafts` skips a code whose
  Hub product has `page365_sync_disabled` (`sync_disabled`, read live), so a switched-off
  code is never created or synced.

## Page365 inventory PR 2 — switch, mode, unpaid-invoice holds (added 2026-09-28)

Migration `20260928100000_page365_inventory_pr2.sql`. Rules: docs/PAGE365-IMPORT.md "PR 2".

- `website_products.page365_sync_disabled boolean NOT NULL DEFAULT false` — "Don't sync with
  Page365". Guard + audit trigger `trg_page365_sync_switch` →
  `page365_sync_switch_guard()` (BEFORE INSERT OR UPDATE OF the column; a signed-in user
  without `manage_website_catalog` gets 42501; audit `website_product` /
  `page365_sync_switched`). Any staff can still write the rest of the row (RLS unchanged).
- `system_settings.page365_stock_mode` (`inventory_sync` seeded | `invoice`) and
  `page365_hold_unpaid_invoices` (`true` seeded). Both read with `value #>> '{}'`; seeded
  only when absent.
- `page365_stock_lines.stock_state` CHECK now `none | held | released | page365_master |
  absorbed` (named `page365_stock_lines_stock_state_check`).
- `page365_inventory_items.category` CHECK adds `not_synced` (named
  `page365_inventory_items_category_check`). `invoice_holds` now means #195 held lines in
  `invoice` mode, else unpaid imported invoice quantity.
- `page365_invoice_holds(uuid) → integer` — service role only.
- Redefined from their live bodies (md5 of `prosrc` guarded before and proven after):
  `page365_apply_stock`, `page365_inventory_finish`, `page365_inventory_apply`,
  `page365_inventory_record_photo`. `page365_stock_follow_order` asserted unchanged.
- NEVER re-run 20260926120000 or 20260927100000 after this file: their CREATE OR REPLACE
  would silently put the pre-PR 2 bodies back. (Re-running PR 2 afterwards repairs it —
  its guard accepts the "before" bodies.)

## Web payment reminders — ledger, switch, bell (added 2026-10-04)

- `web_payment_reminders` (migration 20261004100000): one row per reminder,
  `UNIQUE (entity_type, entity_id, deadline)`, columns reference / email / lang /
  currency / amount captured under the claim's row lock, status claimed → sent |
  skipped | failed | suppressed. RLS: staff SELECT; written only by the
  service-role `claim_` / `finish_web_payment_reminder`.
- `system_settings.web_payment_reminders_mode` ("off" | "owner_only" | "on",
  fail-closed) and `web_payment_reminders_owner_addresses` (JSON array of
  addresses / "@domain"): guarded by `trg_guard_web_payment_reminders`; the only
  writer is `set_web_payment_reminders` (admin role, audited).
- Staff bell type `web_reservation_expiring` (48h unconfirmed web reservation;
  `metadata.entity_id` is the dedupe key; `cash_order_id` / `account_id` link it).
- `email_send_log` gained the expression index `idx_email_send_log_reference`
  on `(metadata->>'reference')` for `get_order_email_history`.

## Media cut-outs — tables, switch, keying (added 2026-10-05)

Migration 20261006100000_media_cutouts.sql; rules in docs/MEDIA-CUTOUTS.md.

- `website_media_cutouts` — PK `source_url` (the photo's public promotions URL;
  CHECK: under `promotions/website/`, not under `derived/`). `id uuid UNIQUE`
  exists only as `audit_logs.entity_id`. NO foreign key to
  `website_product_media`: join on `m.url = c.source_url` (index
  `idx_website_product_media_url`). `job_state` = machinery
  (queued/submitted/ready/processing/done/error); `status` = verdict
  (pending/ok/auto_fixed/needs_review/approved/rejected/failed). File paths are
  bucket-relative (`website/derived/<sha32>/r<run>/…`), not URLs.
- `website_media_cutout_usage` — provider submissions per PHT month
  (`media_cutout_month()`), `bell_80_at`.
- `website_media_cutout_lease` — single row (id = 1): the tick lease and the
  last tick's summary.
- Settings `media_cutout_mode` (JSON string) and `media_cutout_monthly_cap`
  (JSON number); read with `#>> '{}'`; guarded by
  `trg_guard_media_cutout_settings` (bypass GUC
  `app.allow_media_cutout_settings_change`, set only inside
  `set_media_cutout_settings`).
- Not in `types.ts` until Lovable regenerates it — the Hub calls every RPC
  through `callUntypedRpc` (src/lib/media-cutouts.ts).
- Staff notification type: `media_cutout_cap_near` (→ Website → Photos).
- Audit rows: `system_setting / set_media_cutout_settings`,
  `system_setting / add_media_cutout_test_batch`,
  `website_media_cutout / review_media_cutout:<action>`.


## Product reviews (PR-R1, 2026-09-30 — live)

Original staged SQL: docs/sql/20261020100000_product_reviews_r1.sql. The
public-schema tables and policies are recorded in the record_live_only_*
migrations; the storage policies below are live (checked 2026-10-18).

- `review_invites` — one personal review link per ORDER (exactly one of
  cash_order_id / layaway_account_id), created by staff from a COMPLETED order.
  Only `token_hash` (sha256 hex) is stored, never the raw token. 30-day expiry;
  `used_at` set by the website function when the review is claimed; `revoked_at`
  when staff "Make a new link". One open invite per order (partial unique index).
- `product_reviews` — one per invite. status pending → approved | rejected;
  approved ↔ hidden. `upload_paths` = private bucket paths; `photo_urls` = public
  copies, filled only on approval, emptied on hide. `body_ja` required to approve;
  `body_en` only when `original_language = 'ja'`. Public API returns approved only.
- `message_lines` — random Copy Message lines (message_type, part
  opening|closing|full). Seeded: 8 'review_invite' / 'full' lines with
  {first_name}, {piece}, {link}.
- Buckets: `review-uploads` (PRIVATE, customer photos pre-approval, no public
  policy) and `review-photos` (PUBLIC, approved copies). 5 MB, jpeg/png/webp.
  Storage policies, all `TO authenticated` and gated on `moderate_reviews`:
  `review-uploads` SELECT; `review-photos` SELECT, INSERT, UPDATE, DELETE.
  Approve copies photos with `upload(..., { upsert: true })`, which needs
  SELECT + INSERT + UPDATE on the target bucket — the bucket being public does
  NOT count for RLS. The SELECT policy ("Moderators can read review photos",
  migration 20261224100000) was missing until 2026-10-18 and every photo
  approval failed; Hide's remove() also needs it to see the files. Never drop it.
- Permissions: `send_review_invite` (admin, staff, csr) — "Copy review message"
  on completed orders; `moderate_reviews` (admin) — Website → Reviews and the
  translate-review function. Matrix module "Reviews".
- Staff notification type `review_submitted` (→ Website → Reviews).
  Audit rows: `product_review / approve | reject | hide | show`.
- Website API: GET /reviews, GET /review-invite/:token, POST /review-invite/:token.

## Article comments (2026-10-16)

Owner plan 2026-10-16 18:47 JST, C1–C8. Migration
`supabase/migrations/20261222100000_website_post_comments.sql`. Workspace:
docs/WEBSITE-WORKSPACE.md §9b; API: `supabase/contracts/api.md` "Article comments".

- `website_post_comments` — `post_id` (→ website_posts, ON DELETE CASCADE),
  `customer_id` (→ customers), `auth_user_id`, `body` (1–1000 chars after
  btrim), `lang` en|ja (the site she wrote on), `status` pending | approved |
  rejected | hidden (default pending), `reply_body` / `reply_by` / `reply_at`,
  `moderated_by` / `moderated_at`, `deleted_at` (author soft delete),
  `created_at` / `updated_at` (`set_updated_at`). Indexes `(post_id, status,
  created_at DESC)` and `(customer_id, created_at DESC)`.
- RLS: `moderate_reviews` holders SELECT and UPDATE; no anon or customer
  policy — the `website` function writes with the service role.
- `moderate_post_comment(p_id uuid, p_action text, p_reply text DEFAULT NULL)`
  SECURITY DEFINER, EXECUTE `authenticated` only (revoked from PUBLIC, anon).
  Checks `has_permission(auth.uid(), 'moderate_reviews')` first. Actions:
  approve (pending → approved), reject (pending → rejected), hide (approved →
  hidden), show (hidden → approved), reply (any live state, 1–1000 chars).
  Returns `{ ok, comment }` or `{ error }`: user_identity_required,
  permission_denied, bad_action, not_found, comment_deleted, reply_invalid,
  invalid_transition (+ status). One `audit_logs` row per action:
  `post_comment` / approve | reject | hide | show | reply, old and new row.
- Revalidation: `trg_website_post_comments_revalidate` (AFTER UPDATE, WHEN an
  approved row is involved and status / body / reply / deleted_at changed) →
  the existing `notify_website_revalidate()` → tag `content`.
- Staff bell `comment_submitted` (title "New article comment", metadata
  `{ comment_id, post_id, link }`) — inserted by the website function after a
  POST, non-blocking, exactly like `review_submitted`. Not in the staff bell
  email list (neither is `review_submitted`).
- Permission: `moderate_reviews` (admin) — no new key.
- Website API: `GET` / `POST /content/posts/:slug/comments`,
  `PATCH` / `DELETE /content/posts/:slug/comments/:id`. Rules in
  `supabase/functions/_shared/post-comments.ts` (body 1–1000, 5 per customer
  per rolling 24 h counting non-deleted rows, open only on a published article,
  public shape = first name + body + date + reply).

## message_lines (Random Copy Message lines, 2026-10-01)

- Table `public.message_lines` (message_type, part, body, active, sort). Only the opening/closing words of Copy Message / Messenger prefills come from it; line sort=1 of each pool = today's text = the code fallback (src/lib/message-lines.ts FALLBACK). Read by the Hub via an untyped cast (not in generated types).
- 25 types / 37 pools: payment_received:opening, payment_received_multi:opening, thanks_trust:closing, thanks_business:closing, accounts_all_completed:opening, new_account_split_payment:opening+closing, contact_us:closing, settlement_contact:closing, extension_closing:closing, portal_activation:opening+closing, portal_link_share:full, portal_setup_invite:full, reminder_upcoming:opening+closing, reminder_due_today:opening, reminder_grace:opening, thanks_choosing:closing, reminder_overdue:opening+closing, penalty_p1..penalty_p8:opening+closing.
- Placeholders: {name} {first_name} {invoice} {due_date} {days_ago} {link}. Required-once per pool: portal_link_share/portal_setup_invite {link}; reminder_upcoming/due_today {invoice},{due_date}; reminder_grace/overdue {invoice},{due_date},{days_ago}; penalty_p2..p8 openings {invoice},{due_date}. Any other {token} or a missing/duplicated required one → line skipped.
- Picked once per page/dialog open (useStablePicker) so preview = copy.
- Seed: docs/sql/20261001100000_message_lines_seed.sql — applied 2026-10-01 02:10 JST (222 rows + 8 review_invite).
- EDITOR (2026-10-01): Hub → Settings → Message lines (admin; src/components/settings/MessageLinesTab.tsx, pure helpers src/lib/message-lines-admin.ts). Pools are fixed to what the code reads (37 + review_invite:full); lines are added, edited or switched off — NEVER deleted (no DELETE policy; a line a customer received stays traceable). LINE 1 OF EVERY POOL IS LOCKED (owner decision 2026-10-01) — today's wording = the code FALLBACK; the editor refuses to edit or switch it off. Save is refused with the reason when the readers' isValidLine would skip the line (same rule, with words). Every write logs audit_logs entity_type 'message_line' (create / update / activate / deactivate) with the old and new text, and invalidates the ['message_lines'] cache so the next Copy Message uses it. RLS: SELECT staff, UPDATE admin, INSERT admin (20261022100000_message_lines_admin_insert.sql). review_invite placeholders: {first_name} {piece} {link} ({link} required).

## Website sale price (2026-10-15, migration 20261216100000_website_sale_price.sql)

- Column `website_product_variants.sale_price_jpy integer NULL` — the optional
  sale price, whole yen. NULL = not on sale. `price_jpy` stays the FULL price of
  record (Page365 `hub_price_jpy`, the publish guard and every import read it).
- CHECK `website_variants_sale_below_price`: `sale_price_jpy IS NULL OR
  (sale_price_jpy > 0 AND sale_price_jpy < price_jpy)`. It also refuses lowering
  `price_jpy` to or below an existing sale: change or clear the sale first.
- `public.website_variant_price_jpy(website_product_variants)` (SQL, STABLE,
  invoker; EXECUTE authenticated + service_role) is THE single place the price
  the customer pays is decided: the sale price while set and below the full
  price, else `price_jpy`. TS mirror `effectivePriceJpy()` in
  `supabase/functions/_shared/website-down-payments.ts`; keep them identical
  (src/test/website-sale-price.test.ts).
- Wire shape (`website` function, `shapeProduct`): `price_jpy` = the effective
  price; `full_price_jpy` (integer | null) = the full price, only while
  `on_sale` (boolean) is true; `sale_price_jpy` is never sent. `price_php` and
  the down payments follow the effective price. Readers on the effective price:
  `POST /checkout/quote` (unit price → the draft via `checkout_quotes.items`),
  `GET /me/points-preview`, `cart_reminder_candidates`, the newsletter
  (`_shared/newsletter/render.tsx`), and the `create_web_draft_atomic` fallback
  when a quote line carries no unit price. `materialize_web_draft_atomic`
  copies the draft lines' unit price and is unchanged.
- Editors: Hub → Website → Catalog → Edit product → "Sale price (¥)" per
  variant (blank = no sale; Save refused while invalid, `saleError` in
  `src/components/website/product-form.ts`); the catalog list's "from" price is
  the effective price. Upload sheet column `hub_sale_price` (Upload!AK, after
  the Hub columns — `price` is in Page365's own A–X block); blank keeps the
  existing sale, and the import stops with a plain message when a new `price`
  is not above the kept sale. No sale end date in v1.
- `trg_website_variants_revalidate_upd` (per statement since 2026-10-25, migration
  20261230200000) fires on any variant UPDATE, so a sale change revalidates the
  storefront with no trigger change.

## Rules moved from CLAUDE.md (2026-10-02, verbatim)

Moved out of CLAUDE.md on 2026-10-02 to keep it under 100 KB. Text is verbatim (only the 2-space CLAUDE.md indent removed); CLAUDE.md keeps the one-line rules and a pointer here.

### Loyalty Product Amount (JPY) on account creation

- Loyalty Product Amount (JPY) is REQUIRED when the selected customer has a loyalty tier (any tier), on BOTH layaway and cash-order creation. Enforced on two layers: frontend UX (NewAccount.tsx / NewCashOrder.tsx) and the authoritative edge function (create-layaway-account / create-cash-order return 400 LOYALTY_AMOUNT_REQUIRED). Optional for non-members. After creation it is editable in Manage Invoice (layaway EditAccountDialog and cash CashOrderDetail) with permission edit_loyalty_amount (admin + per-user override), and only until the order earns points: trg_guard_loyalty_jpy_amount refuses a signed-in user's change without the permission or once an 'earned' loyalty_transactions row exists for the order (service-role callers — redemption net-spend RPCs, shopify-webhook, derive_order_loyalty_jpy — are not gated). A Manage Invoice total change does NOT update it automatically; the field shows a "Use ¥Y" nudge (total − shipping, PHP ÷ rate) instead. Correcting an order that already earned points is a separate path (#19751 is the known case).

### carry-over and accept-underpayment edge functions (CARRY-OVER RULES)

carry-over edge function (updated 2026-04-19):
  Endpoint: /functions/v1/carry-over

  total_due_amount formula:
    CORRECT: total_due_amount = existing_total_due_amount + shortfall
    WRONG:   total_due_amount = base_installment_amount + shortfall
    This preserves all previous Keep reductions on the destination row.
  Body: { schedule_row_id, account_id }
  Auth: Bearer token + confirm_payment permission via checkPermission (matrix-driven; overrides respected)
  Steps:
    1. Validates source row status === 'partially_paid'
    2. Validates source row paid_amount > 0
    3. Computes shortfall from source.paid_amount (NOT SUM of allocations)
       shortfall = ceiling (base + penalty + carried) - paid_amount
    4. Finds next row by installment_number + 1
    5. Marks source row as 'paid' with paid_amount preserved
    6. Writes carried_amount = shortfall to next row, clears carried_by_payment_id
    7. Reverts step 5 if step 6 fails
  Net effect: source row closes as paid, next row carries the shortfall

accept-underpayment edge function:
  Purpose: Records AUDIT LOG only when staff acknowledges an underpayment
  What it does NOT do: Does NOT write carried_amount, does NOT mark source
  row as paid, does NOT touch next row
  Net DB effect: Zero row changes — audit log entry only

### customer_addresses ids are load-bearing (the replace_customer_addresses incident)

`customer_addresses` ids are load-bearing: `cash_orders.ship_to_address_id`
and `checkout_quotes.ship_to_address_id` are both ON DELETE SET NULL, so
deleting a row blanks the shipping address on every order and quote pointing
at it — silently, with no error and nothing in any log. The original
`replace_customer_addresses` did exactly that on EVERY checkout that sent an
address (DELETE-then-INSERT with fresh uuids), and the storefront calls it on
every one.

### THE TWO STORES HAVE NOT DIVERGED (customer addresses)

THE TWO STORES HAVE NOT DIVERGED, and that is worth keeping true. The Hub
reads the flat columns on `customers`; the storefront reads
`customer_addresses`. As of 2026-09-15 the drift is zero — the flat columns
hold a COUNTRY in `location` and nothing else (879 rows), the table holds 1
real row, and the 2026-09-10 backfill that manufactured 871 junk "addresses"
from `location` was reverted the same day (20260910160000). Convergence is
filed in docs/PENDING.md, not done. Never seed `customer_addresses` from the
flat columns again.

### Help Center screenshots — markdown reference, resolution and how to add one

Markdown files in src/help-content/ reference screenshots by filename only:

![alt text](Landing_page)

Help.tsx's `img` component override on ReactMarkdown resolves relative filenames to the bucket's public URL via:

supabase.storage.from('brand-assets').getPublicUrl(filename).data.publicUrl

Absolute URLs (http://, https://, or /) pass through unchanged.

All images are wrapped in a click-to-zoom lightbox (shadcn Dialog, 95vw/95vh max).

To add a new screenshot for any Help section:
1. Upload the file to the `brand-assets` bucket via Supabase Storage UI (no file extension)
2. Reference it in markdown using just the filename (no extension)
3. No code change required for the image to render

### Customer Message Templates — SINGLE / SPLIT / FULLY PAID / BATCH PAYMENT

SINGLE PAYMENT:
Thank you for your payment. ₱ [amount] has been received.
Inv # [invoiceNumber]
View your updated account and payment schedule here:
🔗 [portalLink]
🔐 Your portal PIN is the last 4 digits of your mobile number on file: [pin]   (only when [portalLink] is a token link — see PORTAL LINK RULE)
Next payment: [nextDueMonth] — ₱ [nextMonthAmount]
Thank you for your continued trust in Cha Jewels! 🧡

---

SPLIT PAYMENT (2+ accounts same customer):
Thank you for your payment. A total of ₱ [totalAmount]
has been received across [N] accounts:
  Inv #[num] — [label]: ₱ [amount]
  Inv #[num] — [label]: ₱ [amount]
View your accounts here:
🔗 [portalLink]
🔐 Your portal PIN is the last 4 digits of your mobile number on file: [pin]   (only when [portalLink] is a token link — see PORTAL LINK RULE)
Next payments:
  [label] — [nextDueMonth]: ₱ [nextDueAmount]
  [label] — [nextDueMonth]: ₱ [nextDueAmount]
Thank you for your continued trust in Cha Jewels! 🧡

---

FULLY PAID:
Same as single but replace next payment line with:
🎉 Your layaway is now fully paid! Thank you!

---

BATCH PAYMENT (individual account after multi-invoice):
Your account has been updated.
Inv # [invoiceNumber]
View your account here:
🔗 [portalLink]
Thank you for your continued trust in Cha Jewels! 🧡

### CHART TERMINOLOGY — metric definitions

Consistent labels across the Finance dashboard. The underlying metrics are unchanged — only the labels were standardized.

"Collected" / "Total Collected" = cash actually received, bucketed by PAYMENT DATE.
  Source: get_monthly_analytics.collected_jpy (SUM payments by date_paid) and
  get_collection_analytics.collected. Shown in: Overview Monthly Performance bar/stat,
  and the Analytics "Collected vs Sales" chart.

"Paid vs Due" chart = collection efficiency against the schedule.
  "Paid" = collected_due (payments allocated to each month's installments, bucketed by
  DUE month, capped at expected). "Due" = expected. Drives Best Month / Average Rate.
  (Formerly mislabeled "Collected vs Expected", which collided with the cash "Collected".)

"Penalties Collected" = penalty_fees WHERE status='paid'. Same metric on both Overview
  and Analytics (Overview's former "Penalties Paid" was renamed to match).

Forfeited — two DIFFERENT metrics, do not conflate:
  "Total Forfeited" (Overview) = remaining balance LOST on forfeited/final_forfeited accounts.
  "Recovered (Forfeited)" (Analytics) = cash COLLECTED from forfeited accounts before
  forfeiture (6-month window, excludes final_settlement).

### REALTIME SYNC — publication, mount and invalidation

supabase_realtime publication now contains: payments,
payment_allocations, layaway_schedule, layaway_accounts, penalty_fees,
payment_submissions, account_services, financial_alerts,
loyalty_members, loyalty_transactions, staff_notifications,
service_jobs, trade_ins (2026-07-05 — the last two were repairs of
SYNC_TABLES entries that had never been published, so their
subscriptions were dead).

useRealtimeSync (src/hooks/useRealtimeSync.ts) is rendered once at the
App root (inside AuthProvider/PermissionsProvider, sibling of Routes,
via the RealtimeSyncMount wrapper in src/App.tsx) and is gated on the
internal-user predicate (session && roles.length > 0 — the same signal
ProtectedRoute admits internal admin/staff/finance/csr users with). The
customer portal and unauthenticated visitors never open a channel.

On any postgres_changes event from the SYNC_TABLES it invalidates
REALTIME_INVALIDATE_KEYS — the union of CORE_KEYS, PAYMENT_KEYS,
MONITORING_KEYS, SUBMISSION_KEYS, SERVICES_KEYS, LOYALTY_KEYS,
NOTIFICATION_KEYS, plus 'account' and 'customer-detail'
— debounced 250ms so a burst of writes coalesces into one refetch
round. Every actively-rendered internal dashboard card refetches live
without a manual reload.

### TEAM MEMBER LIFECYCLE

Members are created via create-team-member (auth user + user_roles row).

Deactivate / reactivate go through the same function:
  action: 'deactivate' | 'reactivate'  (admin/manage_team gated)
- deactivate: profiles.status='inactive' + auth ban (ban_duration set);
  user_roles row KEPT so the member stays listed and reactivatable, and
  historical attribution (created_by_user_id, audit logs, etc.) is
  preserved. Self-deactivation is blocked.
- reactivate: profiles.status='active' + auth unban.

Effect on session: re-login is blocked immediately; any live session
dies on next token refresh.

user_status enum = active | inactive | suspended.

There is no hard delete — it would orphan ~40 attribution columns,
most without FKs. Deactivate is the supported delete-equivalent.

create-team-member stamps user_metadata.is_team_member=true on the
auth user; the on_auth_user_created → handle_new_user trigger inserts
a profiles row ONLY when
`COALESCE(NEW.raw_user_meta_data->>'is_team_member','false') = 'true'`
(key present AND value true), so self-signup customers (Phase B) never
get a profile and never leak into team lists (Bug #151).

Session idle-timeout (2026-05-26): 2h inactivity auto sign-out with a
5-minute warning modal, enforced in AuthContext for ALL authenticated
sessions — both the internal app and the customer portal. Resets on
mouse/key/click/scroll/touch. Frontend-enforced (Supabase Auth
otherwise keeps sessions alive via token refresh).

### FILL-PAYMENT-TRACKING — dated changes (2026-06-06 to 2026-09-11)

2026-06-06: `fill-payment-tracking` now also generates the monthly
tax-declaration file (`申告用フォーマット_MM Month YYYY`) into the
Tax Account Drive folder from the same source upload — Overseas
tab columns B/D/E, Japan tab columns B/D/G (Deposit date /
Customer / Amount), non-blocking relative to the tracking output.

2026-07-06: on success, fill-payment-tracking upserts its output sheet ID into system_settings.payment_tracking_sheet_id so append-payment-tracking always targets the newest generated sheet.

2026-07-06: pre-cohort payment months are totalled into the first month column (merged by column), not dropped — Bug #246.

2026-09-11: append-payment-tracking is now a per-invoice REWRITE (not additive). It locates the invoice across every sheet in system_settings.payment_tracking_sheets ([{id, cohort:"YYYY-MM"}], newest first) and rewrites G..(TOTAL-1) from get_tracking_for_invoices. Body: { invoice_number }. fill-payment-tracking prepends each generated sheet to that array; the scalar payment_tracking_sheet_id is kept for compatibility only. Callers must await the call (isolate shutdown killed unawaited appends).

### DOMAIN ARCHITECTURE — FORBIDDEN PATTERNS

FORBIDDEN PATTERNS (these are recurring violations):
  - Telling a customer to visit app.chajewelsjp.com for any reason
  - Suggesting app.chajewelsjp.com/portal/... as a test URL
  - Including app.chajewelsjp.com in customer-facing emails, share
    buttons, marketing copy, QR codes, or print materials
  - Internal staff using portal.chajewelsjp.com for their work
  - Mixing the two in walkthroughs or screenshots

### ACCOUNT-SCOPE COVERAGE — canonical examples

Trade Program, staff_notifications triggers, and Finance Overview
KPIs are the canonical examples — see TRADE PROGRAM section above
(both tables carry `is_trade`) and the staff_notifications trigger
inventory in docs/SYSTEM-STATUS.md (2026-06-05 entry).

## extension_requests anon token policies — dropped (2026-10-02)

The two `anon` policies "Token customers can insert/view own extension_requests"
tested the token against `customer_portal_tokens`, which has RLS on and no anon
policy — so for anon the EXISTS was always empty and both failed closed (the
Bug #165 pattern). They never granted anything; the portal writes through
`request-extension` and reads through `customer-portal` (service role). Dropped
in migration 20261025100000 so the table no longer carries a policy that only
looks like an anon write path. `extension_requests.portal_token` stays.

## Website revalidation — reviews and loyalty tiers (2026-10-18)

- `notify_website_revalidate()` branches: `product_reviews` → tag `reviews` +
  product slug (via `website_product_id`); `loyalty_tiers` → tag `loyalty`.
  Migration `20261225100000_revalidate_reviews_loyalty.sql`.
- Triggers: `trg_product_reviews_revalidate_ins` / `_upd` / `_del` (only rows
  that are, or were, `status = 'approved'`); `trg_loyalty_tiers_revalidate`
  (every row change). The existing `update_product_reviews_updated_at` is
  unchanged.

## Expenses ledger (2026-10-25)

- Tables `expense_categories` (8 `group_key`s, 28 seeded rows, optional unique `system_key`),
  `expense_vendors` (name unique on `lower(btrim(name))`), `expenses`. Migration
  `20261230100000_expenses_ledger.sql`; full rules in docs/EXPENSES.md.
- `expenses.amount_jpy` is set ONLY by the trigger `expenses_before_write`:
  JPY → `round(amount)`, PHP → `round(amount / php_jpy_rate)` with the rate stored in
  `fx_php_per_jpy` (`expenses_currency_rate` CHECK: JPY ⇒ NULL, PHP ⇒ NOT NULL). Recomputed on
  insert and on every write while the row is a draft (including the approve write).
- Approved rows are immutable except the transition to `void`; void rows are immutable;
  DELETE always raises — the trigger fires for every role, service role included.
- Unique partial index `expenses_source_ref_uq` on `(source, source_ref)` WHERE source_ref
  IS NOT NULL — automatic bookings (payroll month, email id) must set it.
- `receipt_path` CHECK: `LIKE id::text || '/%'` (bucket `expense-receipts`, private).
- No INSERT/UPDATE/DELETE policies on the three tables: writes go through
  `upsert_expense` / `attach_expense_receipt` / `approve_expense` / `void_expense`
  (SECURITY DEFINER, `has_permission`, one `audit_logs` row each). Not yet in
  src/integrations/supabase/types.ts — the Hub calls them through a cast `callRpc`.

## Expenses — Mark as paid (Phase 2, 2026-10-25)

- `expenses.details jsonb NULL` (CHECK object) — breakdown behind an automatic booking; locked with
  the row once approved. `expenses_source_ref_uq` is now `WHERE source_ref IS NOT NULL AND status
  <> 'void'` — a voided booking can be re-booked.
- `timesheet_monthly_history.month_key` is the PRIMARY KEY (baseline line 1485, confirmed on live
  2026-10-25); `book_payroll_month` upserts with `ON CONFLICT (month_key)`. Live months are now
  WRITTEN to this table on each payroll booking (supersedes "live months come from entries, NOT
  this table" above for booked months — the Hub's Cost Master still computes live; the table is
  the snapshot of what was PAID).
- RPCs: `book_payroll_month(date, date, jsonb)`, `book_commission_month(date, date, jsonb)`
  (approve_expenses; each books ONE approved PHP expense via internal
  `expenses_book_auto_month`, advisory-locked per source+month, two audit_logs rows;
  payroll also upserts the history row), `get_booked_months(text)` (manage or approve). Not in
  types.ts — called through the cast `callRpc` (coupon precedent).

## General ledger (Expenses Phase 2b, 2026-10-25)

- Migration `20270101100000_general_ledger_core.sql` (applied NOWHERE yet; branch feat/expenses). Full rules in
  docs/EXPENSES.md "Phase 2b".
- `gl_accounts` (code text PK `^[1-6][0-9]{3}$`, kind asset | liability | equity | revenue | cogs | expense, contra,
  currency_hint, active, system_key). ONE Sales account 4100 — there is no 4110 (owner D2). Seed-only plus
  `upsert_gl_account` (admin_settings); never deleted; system_key accounts cannot be deactivated.
- `gl_payment_method_map` (spelling PK = lower(btrim(method)), account_code FK, kind bank | cash | clearing | cod |
  non_cash | suspense). `gl_method_account(method, currency)`: kind cash → 1010 for JPY rows, 1020 for PHP rows;
  unknown spelling → 1190.
- `expense_categories.gl_account_code text NULL FK` (seeded for the 28 categories). `expenses.paid_from text NULL FK`
  — the ONLY column an APPROVED expense may change (`expenses_before_write` re-stated in 2b with that allowance;
  `set_expense_paid_from`: drafts need manage or approve, approved rows need approve_expenses).
- `system_settings` keys `fiscal_year_start_month` ("4" — April–March, owner 2026-10-26) and `ledger_start_date` (JSON null until the owner sets it
  with `set_ledger_start`; first of a month; frozen once any journal exists). `gl_fiscal_year(date)` = the year the
  April–March year ENDS (June 2026 → 2027; start month 1 → calendar year).
- `gl_periods` (period_start date PK = first of month, fiscal_year, status open | closed, closed_at/by, note); rows are
  created lazily by `gl_period_for(date)`. `gl_posting_date(d)` returns d unless d's month ≤ the LAST closed month,
  then the first day after the last closed month.
- `gl_journals` (journal_no identity, entry_date, period_start FK, source_date, kind auto | manual | opening |
  reversal, source_type, source_id, source_version = md5(source_date || lines jsonb), description, status posted |
  reversed, reverses / reversed_by, reason, posted_by NULL = engine, total_jpy = Σ debit_jpy). Partial unique index
  `gl_journals_live_source_uq (source_type, source_id) WHERE kind = 'auto' AND status = 'posted'`.
- `gl_journal_lines` (journal_id FK, line_no, account_code FK, debit / credit numeric(15,2) exactly one > 0,
  currency, fx_php_per_jpy (PHP only), debit_jpy / credit_jpy numeric(15,0), memo, customer_id, account_id,
  cash_order_id, expense_id). Deferred constraint trigger `gl_journals_balanced`: ≥ 2 lines and Σ debit_jpy =
  Σ credit_jpy. Row triggers refuse UPDATE/DELETE on lines and any journal UPDATE except posted → reversed +
  reversed_by (compared as jsonb minus those two keys); statement triggers refuse TRUNCATE; INSERT/UPDATE/DELETE/
  TRUNCATE revoked from PUBLIC/anon/authenticated. SELECT policies on all six gl_* tables: view_ledger.
- `gl_posting_runs` (trigger cron | manual | migration, run_by, posted, reversed, moved, skipped).
- Engine: `gl_current_events(p_until)` (internal; the event sets are listed in docs/EXPENSES.md) and
  `gl_post_pending(p_dry, p_trigger, p_user_id)` (SECURITY DEFINER, revoked from authenticated/anon, service_role
  may execute; `pg_advisory_xact_lock(hashtext('gl_post_pending'))`; temp table `gl_events_tmp` ON COMMIT DROP).
  Fingerprint = md5(event date (blank for close events) || accounts:sides:amounts:currencies) — memos and
  descriptions are NOT fingerprinted, so cosmetic edits never repost. Each event is posted in a sub-block;
  failures are counted in `gl_posting_runs.failed` with the error in `note`. Reversals are dated today (JST) and
  carry the ORIGINAL yen per line ('jpy' key honoured by `gl_write_journal`).
- STORE CREDIT IS RECORDED TWICE BY THE HUB: `redeem_store_credit_atomic` writes a `payments` / `cash_payments`
  row (method `store_credit`) AND a `store_credit_transactions` `redeemed` row with account_id / cash_order_id.
  The ledger posts Hub-linked redemptions from the PAYMENT row only; `store_credit_use` covers expiries and
  off-Hub redemptions (no plan / order). `final_forfeited` is set by the auto-forfeit edge function WITHOUT
  updating `forfeited_at` (close events therefore fall back to `updated_at` and exclude the date from their
  fingerprint).
  `gl_write_journal` balances a PHP journal whose lines round apart by adjusting the last credit line's yen when the
  difference is ≤ the number of lines.
- pg_cron job `gl-post-pending`, `40 15 * * *` (00:40 JST), `SELECT public.gl_post_pending(false, 'cron', NULL)`;
  scheduled only where the `cron` schema exists.
- RPCs (all REVOKE PUBLIC/anon, GRANT authenticated; not in types.ts — cast `callRpc`): `get_ledger_status(boolean)`,
  `get_chart_of_accounts(date)`, `get_ledger(date, date, text, text, text, text, int, int)`,
  `get_trial_balance(date, date)`, `get_paid_from_accounts()`, `gl_post_now()`, `post_manual_journal(jsonb)`,
  `reverse_journal(uuid, text)`, `close_period(date, text)`, `reopen_period(date, text)`, `set_ledger_start(date)`,
  `set_payment_method_map(text, text, text)`, `upsert_gl_account(jsonb)`, `set_expense_paid_from(uuid, text)`.
- Permission keys `view_ledger`, `post_journal`, `close_period` (admin true; staff, finance, csr, live_agent false).
- Live-data facts the engine relies on (read 2026-10-25): `layaway_accounts.total_paid` = Σ non-void payments on every
  plan (0 differences); 1,750 payments have no `payment_allocations` row (so only penalty allocations are used, the
  rest reduces the receivable); `payments` has an RLS UPDATE policy for authenticated (voids/edits are direct table
  writes — hence the derived design); `account_status` includes `final_forfeited`; `store_credit_lot_status`
  active | consumed | expired | voided; `store_credit_txn_type` issued | redeemed | expired | voided | adjusted;
  `cash_orders.refund_status` ∈ refund_issued | refund_pending | store_credit_issued | no_refund.

## Recurring bills + prepaid (Expenses Phase 3, 2026-10-25)

- Migration `20270102100000_expenses_recurring_prepaid.sql` (applied NOWHERE; branch feat/expenses). Rules in
  docs/EXPENSES.md "Phase 3".
- `expense_recurring_bills` (id, name, category_id FK, vendor_id FK NULL, description, currency JPY|PHP, amount,
  payment_method (Phase 1 enum), paid_from FK gl_accounts NULL, frequency monthly|quarterly|yearly, due_day 1–28,
  starts_on, ends_on NULL, spread_months 2–36 NULL, active, notes, next_due_on, last_generated_on, created_by/at,
  updated_at). RLS SELECT manage|approve; writes revoked; DELETE/TRUNCATE refused by trigger. RPCs:
  `upsert_recurring_bill(jsonb)`, `set_recurring_bill_active(uuid, boolean)`, `get_recurring_bills()`,
  `generate_recurring_now(uuid, date)` (manage; approve may read); internal `expenses_generate_recurring(date, uuid)`
  and `expenses_create_recurring_draft(bill, date, uuid)`; helpers `recurring_first_due(date, smallint)`,
  `recurring_next_due(date, text)`.
- Recurring drafts: `expenses.source = 'recurring'`, `source_ref = '<bill id>:<due date>'` (unique among non-void rows
  via `expenses_source_ref_uq`), `details.kind = 'recurring_bill'`.
- `expenses.prepaid_months smallint NULL CHECK 2..36` — ADDED BY THE 2b MIGRATION FILE (20270101100000) next to
  `paid_from`; set by `set_expense_prepaid(uuid, integer)` on drafts only; locked after approval. Ledger events in
  the 2b file: E6 debits 1400 when prepaid_months is set; `expense_amortisation` (source_id =
  `md5(expense_id || ':' || 'YYYY-MM')::uuid`, dated at each month end ≤ today) releases 1/N to the category.
- pg_cron `expenses-recurring`, `20 15 * * *` (00:20 JST) → `expenses_generate_recurring(NULL, NULL)`.

## Emailed bills (Expenses Phase 4, 2026-10-26)

- Migration `20270103100000_expenses_email_bills.sql` (applied NOWHERE; branch feat/expenses) + edge function
  `expenses-email-bills` (deployed NOWHERE; separate Lovable prompt). Rules in docs/EXPENSES.md "Phase 4".
- system_settings `expenses_email_enabled` ("false" as JSON string) and `expenses_email_mailbox`
  ("sales@chajewelsjp.com"). Holding category `expense_categories.system_key = 'uncategorised'` (group office,
  gl 6900): trigger `expenses_refuse_uncategorised_approval` (BEFORE UPDATE OF status) raises `category_required`.
- `expense_email_messages` (gmail_message_id PK, thread_id, mailbox, from_email, from_name, subject, received_at,
  status drafted|matched|needs_review|skipped|dismissed|error, confidence, extracted jsonb, attachments jsonb,
  expense_id FK, matched_expense_id FK, error, reviewed_by/at, created_at/updated_at) and `expense_email_runs`
  (id, started_at, finished_at, trigger cron|manual, looked_at, drafted, matched, needs_review, skipped, errors,
  note). RLS SELECT manage|approve; table writes revoked. Because of the FK, `TRUNCATE public.expenses` now fails
  with feature_not_supported before the Phase 1 guard fires (harness accepts both).
- Service-role RPCs (refuse when auth.uid() is set): `expenses_email_record(jsonb)`, `expenses_create_email_draft(jsonb)`,
  `expenses_email_match_recurring(text, uuid, numeric, text, date)`, `expenses_email_attach_to_draft(uuid, text,
  numeric, text)`, `expenses_email_run(jsonb)`, `expenses_email_context()`. Owner RPCs: `get_email_bills(int)`,
  `email_bill_make_expense(text, jsonb)`, `email_bill_dismiss(text)`, `set_email_bills_enabled(boolean)`.
- Email drafts: `expenses.source = 'email'`, `source_ref = <gmail message id>`; attachments in `expense-receipts`
  under `<expense id>/…` (drafts) or `email/<message id>/…` (needs review, copied by the client on Make expense).
- pg_cron `expenses-email-bills`, `7,37 * * * *` → net.http_post functions/v1/expenses-email-bills with the vault
  `email_queue_service_role_key` (scheduled only when cron + vault schemas exist).

## Cost of goods / inventory (Expenses Phase 5, 2026-10-26)

- Migration `20270104100000_expenses_cost_of_goods.sql` (applied NOWHERE; branch feat/expenses). Rules in docs/EXPENSES.md "Phase 5".
- `sale_costs` (sale_type 'layaway'|'cash_order', sale_id, cost_jpy numeric(15,0) ≥ 0, note, set_by, set_at, created_at; PK (sale_type,
  sale_id)). RLS SELECT view_ledger; table writes revoked; RPCs `set_sale_cost(text, uuid, numeric, text)` and `import_sale_costs(jsonb)`
  (manage_expenses). Audit entity `sale_cost`.
- `sale_item_costs` (item_table, item_id PK, sale_type, sale_id, variant_id, quantity, cost_jpy numeric(15,0)) — FINANCE-ONLY snapshot of a
  sale line's unit cost (RLS SELECT view_ledger; writes revoked). The item tables carry NO cost column (customers / CSR read them). Filled by
  AFTER INSERT/UPDATE trigger `sale_items_snapshot_cost` (SECURITY DEFINER; quantity follows the line, cost never changes), by
  `variant_cost_snapshot_catchup` on website_product_variants (AFTER INSERT OR UPDATE OF cost_basis) and by the migration backfill.
  `gl_sale_costs()` (internal) = effective cost; source `trade_in` when the sale's invoice is a trade-in's resold_invoice_number.
- `trade_ins.resold_at timestamptz` — trigger `trade_ins_track_resold`: INSERT may carry a date; a flip to Sold stamps now(); otherwise kept;
  cleared (with resold_invoice_number) when not Sold. `trade_ins.resold_invoice_number text` — set in TradeInDialog when Sold.
- `gl_post_pending` fingerprint (2b file) now blanks the date for `cogs_return` as well as the close events.
- `expense_categories.gl_account_code`: "Inventory purchases…" → '1300', system_key 'trade_in' → '1310' (were 5100 / 5500 in 2b).
- gl_accounts added: 1104, 1195, 2700, 2750, 2800, 2900, 6950 (accountant's chart; opening balance F6).
- `gl_current_events(date)` = `gl_base_events(date)` (the 2b body, renamed once via `ALTER FUNCTION … RENAME` guarded by to_regprocedure)
  UNION ALL `gl_cogs_events(date)` (cogs_sale, cogs_return, trade_in_received, trade_in_resold; source ids md5-derived uuids).
- RPCs (authenticated, permission inside): `get_sales_costs(date)`, `get_inventory_valuation()`, `fc_real_profit(date, date)` — view_ledger.
- Fiscal year: `fiscal_year_start_month` seed is now "4" (April–March, owner 2026-10-26) — changed in the 2b migration file since it is unapplied.

## Clearing / transfers / peso revaluation (Expenses Phase 6, 2026-10-26)

- Migration `20270105100000_expenses_clearing_fx.sql` (applied NOWHERE; branch feat/expenses). Rules in docs/EXPENSES.md "Phase 6".
- `php_jpy_rate_history` (effective_from PK, rate, set_by, created_at) — RLS SELECT view_ledger; filled by trigger
  `system_settings_php_jpy_rate_log` (AFTER INSERT OR UPDATE on system_settings; audit entity 'system_setting' / md5('php_jpy_rate')::uuid)
  and `set_php_jpy_rate(numeric, date)` (admin_settings). `gl_rate_at(date)` internal.
- `provider_settlements` (provider square|paidy|stripe|cod_carrier, received_on, period_from/to, amount_received_jpy, fees_jpy,
  adjustments_jpy, bank_account FK gl_accounts, reference, note, created_by, voided_at/by/reason) — RLS SELECT view_ledger; writes via
  `record_provider_settlement(jsonb)` / `void_provider_settlement(uuid, text)` (post_journal). `gl_clearing_account(provider)` → 1130/1131/1132/1140.
- `fund_transfers` (transfer_on, from_account/amount/currency, to_account/amount/currency, fee_amount/currency/account, reference, note,
  voided…) — RLS SELECT view_ledger; `record_fund_transfer(jsonb)` / `void_fund_transfer(uuid, text)` (post_journal).
- `gl_current_events` = base ∪ cogs ∪ `gl_clearing_events` (square_fee, settlement_payout, settlement_fee, settlement_adjustment,
  fund_transfer, fx_revaluation). fx_revaluation reads posted PHP lines of asset/liability accounts up to each month end; source id
  md5('fxrev:<account>:<YYYY-MM>')::uuid.
- Trigger `expenses_auto_fee_guard` on expenses (BEFORE INSERT OR UPDATE OF category_id): system_keys square_fees / paidy_fees /
  stripe_fees raise `category_booked_automatically` (check_violation). `expenses_email_context` re-stated to exclude them.
- Reads: `get_clearing_summary(int)`, `get_fx_revaluation(date)`, `get_rate_history()` — view_ledger.
- `gl_post_settled(text, uuid)` (internal) = gl_post_pending up to 3 passes; `gl_post_now` re-stated to use it; cron `gl-post-pending` re-scheduled to it.
- Transfer endpoints: active asset accounts with code < '1130' (bank / cash only).

## Statements / 税理士 pack (Expenses Phase 7, 2026-10-26)

- Migration `20270106100000_expenses_statements.sql` (applied NOWHERE; branch feat/expenses). Rules in docs/EXPENSES.md "Phase 7".
- `gl_accounts.name_ja text NULL` (CHECK 1–60 chars) seeded for every account; `upsert_gl_account(jsonb)` re-stated: accepts `name_ja`
  on insert and update (key present → set / clear; absent → unchanged); error `invalid_name_ja`.
- system_settings `statement_flag_pct` ("15") / `statement_flag_jpy` ("100000"); `gl_statement_flags()` internal; `set_statement_flags(numeric, numeric)`
  (admin_settings; errors invalid_pct / invalid_amount; audit entity 'gl_setting' action 'set_statement_flags').
- `get_receivable_ageing(date)` (view_ledger): reads layaway_schedule (status pending / partially_paid / overdue, total_due_amount − paid_amount > 0)
  joined to live non-test layaway_accounts ordered on/before as_of, pending non-test cash_orders, gl lines of 1200 / 1210; yen at `gl_rate()`;
  due_date ≥ as_of = not due; as_of clamped to today (`requested_as_of` returned).
- `get_statements(date, date)` (view_ledger; range ≤ 1100 days): one aggregate over gl_journal_lines per account (current / prior / prior-year
  movements, PHP-only movements, balances at `to` and `from − 1`, balances before the fiscal-year start, fx_revaluation movements) →
  income_statement.lines[], balance_sheet.lines[] + totals, cash_flow.lines[] + tie-out, ageing, currency_checks (reads customers.country),
  outside_hub. Internal helpers `gl_stmt_pick`, `gl_stmt_kind_sum`, `gl_stmt_line` (revoked from authenticated).
- `get_journal_export(date, date, integer)` (view_ledger): ≤ 20,000 flat lines per call ordered by journal_no, line_no; `tax_flag` export /
  domestic by line currency on revenue-kind lines except 4400 / 4500 / 4900 / 4950.
- Client: `/finance/tax-pack` route (PermissionsContext → view_ledger), `src/lib/csv.ts` gained `csvText` / `downloadCsv(…, { bom, exactName })`.

## Controls (Expenses Phase 8, 2026-10-26)

- Migration `20270107100000_expenses_controls.sql` (applied NOWHERE; branch feat/expenses). Rules in docs/EXPENSES.md "Phase 8"; go-live in docs/EXPENSES-GO-LIVE.md.
- Trigger `expenses_before_period_lock` (BEFORE INSERT OR UPDATE on expenses, before `expenses_before_write`): closed-month dates refused for manual
  rows (`period_closed` check_violation); void and paid_from-only pass; non-manual inserts moved to `gl_posting_date(expense_date)` with a note.
- `gl_period_is_closed(date)`, `gl_is_money_account(text)` (active asset, code < '1130'), `gl_account_currency(text)`, `gl_unmapped_methods(date)`,
  `gl_expenses_without_paid_from(date)`, `gl_unreconciled_accounts(date)`, `gl_close_readiness(date, boolean)`, `gl_auto_match(text, date, uuid)`,
  `gl_run_completeness_check(text, uuid)` — internal (revoked from authenticated; the check also granted to service_role for cron).
- View `gl_live_money_lines` (posted, non-reversal lines; signed_amount / signed_jpy; kind; entry_date = SOURCE date, posted_on = ledger date) — revoked from authenticated.
- `gl_pending_counts(date)` internal: what the engine would post / reverse for events dated ≤ the date (same version formula as gl_post_pending).
- `get_close_readiness(date)` view_ledger (pending events = warning; errors = failed run / no rate / unbalanced / duplicate); `close_period` re-stated (gl_post_settled, non-ok stops → readiness → `ledger_errors` when errors > 0; note + audit carry the counts).
- `get_bank_reconciliation` returns `in_transit_native` (unmatched Hub entries dated in the last 5 days of the month); sign-off compares statement closing with ledger − in transit. Import errors: cash_has_no_statement, invalid_file, no_lines, too_many_lines, duplicate_file, invalid_line (nothing written), invalid_profile.
- `gl_check_runs` (ran_at, trigger cron|manual, run_by, errors, warnings, issues jsonb, bell_rung, duration_ms) — RLS SELECT view_ledger; `run_ledger_check()`
  post_journal; `get_ledger_checks(int)` view_ledger; cron `gl-completeness-check` '10 16 * * *'. Bell row type `ledger_check` in staff_notifications (counts only).
- `bank_import_profiles` (account_code PK, delimiter, header_rows, date_col, date_format ymd|dmy|mdy, description_col, in_col, out_col, signed_col, balance_col,
  encoding utf-8|shift_jis), `bank_statement_imports` (account_code, file_name, file_sha256 — unique per account while not voided, encoding, rows_in_file,
  inserted, skipped, period_from/to, imported_by/at, voided_at/by/reason), `bank_statement_lines` (import_id, account_code, line_no, booked_on, description,
  amount signed native ≠ 0, balance_after, raw, matched_journal_line_id unique, match_kind auto|manual|ignored, matched_by/at, ignore_reason),
  `bank_reconciliations` (PK account_code + month_start; statement_closing, ledger_closing_native/jpy, difference, unmatched_statement/ledger, status open|reconciled,
  note, reconciled_by/at) — all RLS SELECT view_ledger, writes via RPCs (post_journal): import_bank_statement(jsonb), void_bank_import(uuid, text),
  auto_match_bank_lines(text, date), match_bank_line(uuid, uuid), unmatch_bank_line(uuid), ignore_bank_line(uuid, text), sign_off_reconciliation(text, date, numeric, text),
  reopen_reconciliation(text, date, text); read get_bank_reconciliation(text, date) view_ledger.
- `get_ledger_status` re-stated: + `last_check`; periods carry `reconciled_accounts` / `unreconciled_accounts`.
- Client: Ledger tabs `bankrec`, `checks` (URL `?tab=ledger&view=…&month=&account=`), readiness dialog on Months, `ledger_check` bell route in StaffNotificationBell.

