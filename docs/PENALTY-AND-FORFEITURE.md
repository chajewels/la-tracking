<!-- Moved VERBATIM from CLAUDE.md on 2026-09-24 to bring it under the
     Claude Code load limit. CLAUDE.md keeps every rule from these sections
     as a rules block with a pointer here; this file keeps the full text.
     Read it when a task touches this area. -->

  ACCOUNT-SCOPED RUN (added 2026-09-20, owner decision). penalty-engine accepts
  an optional body { account_id: uuid } and then evaluates that ONE account.
  The narrowing is a single .eq("account_id", …) on the overdue-item query and
  NOTHING ELSE: same statuses, same Guard 1 / Guard 2, same freeze guard (an
  account with a pending submission is still skipped — INVARIANT 12), same
  caps and reactivation cap bump, same stage:cycle idempotency. A scoped run is
  therefore a strict subset of the nightly run and can never create a penalty
  the nightly run would not have created the same day — only sooner. No body,
  or no account_id, is byte-for-byte the previous behaviour. The response
  carries { scope: "account" | "all", account_id } plus a `created` array of
  the rows written.

  NO RULE CHANGED HERE — ONLY WHEN THE RULES ARE EVALUATED. The amounts, the
  caps, the grace reset and the trigger schedule are all untouched.

  reactivate-account CALLS IT for the reactivated account, after the account
  update, the Extension Month row and the extension_requests block have all
  succeeded (the engine reads status, is_reactivated and the un-cancelled
  schedule rows, so it must not run before those are written). The call is
  non-blocking: a failure is logged and reactivation still succeeds, because
  the engine is idempotent and the nightly run picks up anything missed.
  Why it exists: a forfeited account sits in a status the engine does not
  select, so reactivation is the moment it re-enters scope — and the next cron
  can be up to ~24h away. Invoice 18788 was reactivated at 04:16 UTC on
  2026-09-20 with installment 6 (due that day) carrying no penalty, because the
  account had been in `final_settlement` since 2026-09-03 and was invisible to
  every cron run in between, including the one four hours earlier.


  Fixture forensic note (2026-05-18): the fixture's account-side state remains
  intact and matches PATH 3 expectations. Loyalty-side data (loyalty_member,
  loyalty_point_lot, loyalty_transactions) was subsequently removed from the
  database between 2026-05-15 and 2026-05-18. The only migration in the
  20260515-20260518 window (20260516010044) drops three loyalty auto-award
  DB triggers and does not delete any rows. The data wipe was therefore not
  migration-driven — most likely a manual SQL cleanup, edge function call, or
  direct admin action, with no audit trail captured in session history. Admin
  UI for customer CJ-2026-05456 ("Test Path3 Customer") confirms "Not enrolled"
  in the Loyalty tab as of 2026-05-18. The 2026-05-15 empirical verification
  stands as proof of record; re-verification on this fixture is not possible
  without rebuilding the loyalty side.

