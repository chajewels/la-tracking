<!-- Moved VERBATIM from CLAUDE.md on 2026-09-24 to bring it under the
     Claude Code load limit. CLAUDE.md keeps every rule from these sections
     as a rules block with a pointer here; this file keeps the full text.
     Read it when a task touches this area. -->

  HOW "BORN EXPIRED" IS WRITTEN. Nothing in the Hub expires a lot by its
  date (expiry is the member-level 180-day inactivity sweep), and FIFO spends
  the SOONEST expiry first — so a live lot with a past expires_at would be the
  first thing a redemption consumed. insert_lot_catch_up therefore writes such
  a lot already expired (remaining 0, expired_at now()), and award-loyalty-
  points writes the earned row, a matching 'expired' row (−points) and
  total_points_expired += points, leaving remaining_points unchanged. Counter,
  live lots and ledger net stay equal (loyalty_integrity_report 1 and 2), and
  the spend still counts toward the tier.

  THE CATCH-UP IS A SEPARATE CALL, AFTER THE MOVE COMMITS. The edge function
  calls award-loyalty-points with the service key and body
  { account_id | cash_order_id, catch_up: { order_date } }; catch_up from any
  other caller is refused 403. Without catch_up award-loyalty-points behaves
  exactly as before. The award's own claim (loyalty_award_claims) keeps it
  idempotent. A skip for below_minimum or loyalty_disabled is an expected
  outcome, not a failure; anything else that is not awarded:true rings R9's
  bell.

  CHILD ROWS THAT MOVE WITH THE ORDER: payment_submissions (portal_token
  cleared — it was the old owner's link), extension_requests (portal_token
  cleared), service_jobs (invoice + account_type), service_requests, the
  order's checkout_quotes row, csr_notifications. A cash order's
  ship_to_address_id points into the OLD owner's address book, so it is
  snapshotted via address_snapshot() when the order has no snapshot yet, and
  then set to NULL. One audit_logs row (entity_type 'layaway_account' |
  'cash_order', action 'reassign_owner') carries both customers, the reason,
  the moved counts, the loyalty amount before/after, the award point and the
  catch-up decision.

  PERMISSIONS: role_permissions for reassign_owner already exist live (admin,
  staff = true; finance, csr = false; 4 user overrides = false). This work
  seeded nothing; the function obeys whatever Settings holds. The
  src/lib/role-permissions.ts default for reassign_owner (['admin']) is a
  fallback table only and was not changed.

  R11 MECHANICS (20260924150000_reassign_identity_match.sql): the RPC gained a
  LAST parameter p_allow_unmatched boolean DEFAULT false (the 7-argument
  function was dropped, not overloaded, so a named call is never ambiguous);
  the edge function sends it only for body override:true AND
  reassign_owner_unmatched, and answers 403 override_not_permitted when the
  override is asked for without the permission. The RPC re-checks the
  permission itself. Preview gains matched_on (text[]) and unmatched; the
  audit row gains matched_on, unmatched and override_used.
  reassign_owner_unmatched is seeded admin = true, everyone else false, ON
  CONFLICT DO NOTHING. find_customer_matches is untouched — R11 repeats its
  normalisation inline; the TS mirror is identityMatches() in
  _shared/reassign-owner-rules.ts.


## Paidy orders (owner 2026-10-04, migration 20261104110000)

A cash order with ANY Paidy history — a `paidy_payments` row, a
`paidy_checkout_attempts` row, or a `payment_submissions` row with
`payment_method = 'paidy'` or a `paidy_payment_id` — is refused with code
`paidy_order`: "This order was paid, or started to be paid, with Paidy. A Paidy
order belongs to the customer who signed in and paid, and cannot change owner."
Owner reason: a web order needs a signed-in account, so its owner cannot be
wrong. Layaway plans are never affected (Paidy is cash-order only). Before this
refusal the move failed late with the raw `paidy_submission_locked` exception.
Harness: `harness/paidy-owner-answers/` (R1–R6).

**Card orders (S04, Square QA 2026-10-08, migration 20261118100000).** The same
rule for Square: ANY card history — a `square_card_attempts` row (even one only
reserved, not yet filed), a `square_payments` row, or a `payment_submissions`
row with `payment_method = 'square'` or a `square_payment_id` — is refused with
code `card_order`: "This order was paid, or started to be paid, by card. A card
order belongs to the customer who signed in and paid, and cannot change owner."
The preview shows it too. The order row is locked by both this function and
`reserve_square_attempt`, so a reserve cannot slip in between the check and the
move. Acceptance: development/sql/square-qa-refunds-credit-acceptance.sql.

## Rules moved from CLAUDE.md (2026-10-02, verbatim)

Moved out of CLAUDE.md on 2026-10-02 to keep it under 100 KB. Text is verbatim (only the 2-space CLAUDE.md indent removed); CLAUDE.md keeps the one-line rules and a pointer here.

### R5 — the full refusal list

R5 Also refuse (with a plain-words reason): order already earned by ANY member (all markers from your section F, including an in-flight claim with transaction_id IS NULL, earned rows, order_earn/promo_bonus lots on the invoice incl. consumed/expired/revoked, bonus rows on the invoice); Shopify orders (SH- invoices or Shopify-sourced); split payment submissions covering more than one order; any non-cancelled loyalty redemption on the order; any store credit applied to or issued from the order; status closed (layaway: cancelled, forfeited, final_forfeited; cash: cancelled, expired); crossing is_test in either direction; same owner; not found.

### R6 — catch-up award eligibility and the award point

R6 Catch-up award for the NEW owner when: new owner is enrolled AND award point >= new owner's enrolled_at − grace days (system_settings.loyalty_enrollment_grace_days, default 3). Award point: layaway = earliest non-voided payments.created_at for the account matching the DP rule (reference_number LIKE 'DP-%' OR remarks ILIKE '%down%'), excluding LOYALTY-% rows; fallback = updated_at of the confirmed DP submission; never date_paid. Cash = completed_at; fallback = created_at of the payment that made it fully paid. Orders not yet at their award point: no catch-up (they earn normally later).

### R7 — catch-up specifics

R7 Catch-up specifics: current tier multiplier (ratchet as today), NO promo; emails/notifications as usual; member.last_purchase_at = GREATEST(existing, order_date) and prev_purchase_at shifts only if that value changes; the new lot expires_at = order_date + 180 days; the member's OTHER live lots are only ever extended: GREATEST(expires_at, order_date + 180 days) — never shortened. If order_date + 180 days is already past, still award (spend counts toward tier) — the points are born expired; the preview must say so.

### R11 — identity match and the reassign_owner_unmatched override

R11 IDENTITY MATCH. A reassign is allowed only if the target account matches the CURRENT owner on at least one of: full name, Facebook name (both: lower-case, trim, collapse spaces), mobile (last 10 digits, only when >= 10 digits), email (exact, case-insensitive) — the same normalisation as find_customer_matches. No match → refused: code different_customer_details, message "Different customer details — this order can only move to another account of the same customer. Contact the owner."
   Exception: a user holding the permission reassign_owner_unmatched may move an order with NO matching detail (an order put on the wrong customer), only by explicitly choosing the override and with the required written reason; it is logged as an unmatched reassign. The override bypasses ONLY R11 — every other refusal (R1 points-account rule, earned order, closed status, Shopify, split submissions, redemptions/store credit, test↔real, same owner, loyalty amount) still applies.

### "Section F" note

("Section F" in R5 is the 2026-09-24 investigation report; its markers are
the ones listed in the same rule, all checked by reassign_order_owner_atomic.)
