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

