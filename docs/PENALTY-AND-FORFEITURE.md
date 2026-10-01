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


## Rules moved from CLAUDE.md (2026-10-02, verbatim)

Moved out of CLAUDE.md on 2026-10-02 to keep it under 100 KB. Text is verbatim (only the 2-space CLAUDE.md indent removed); CLAUDE.md keeps the one-line rules and a pointer here.

### Grace period rule (updated 2026-04-13)

### Grace period rule (updated 2026-04-13):
- Grace period (7 days) is NOT permanently consumed.
- It applies when ALL of these are true:
  * Account has an overdue row within 7 days of due date
  * No UNPAID penalties exist on any schedule row
  * No other rows are overdue or partially_paid
- Grace RESETS when account is fully caught up:
  * All schedule rows paid
  * No unpaid penalties on any row
- When fully caught up and goes overdue again → grace applies again
- Waived penalties do NOT count against grace
- Paid penalties do NOT count against grace

Implemented in:
  supabase/functions/penalty-engine/index.ts (week1Offset = graceConsumed ? 0 : 7)
  src/pages/AccountDetail.tsx (isInGracePeriod display)

### Waiver grace period + auto-unwaive (added 2026-08-18)

### Waiver grace period + auto-unwaive (added 2026-08-18):
An approved waiver holds a penalty for penalty_waiver_grace_days
(system_settings, default 7) counted from penalty_fees.penalty_date —
NOT from the approval date. Staff approving a waiver late give the
customer less time, by design; the deadline is anchored to when the
penalty was incurred, not to admin action.

Inside the window: penalty-engine leaves the waived row completely
alone — no increment, no schedule write.

Past the window: penalty-engine reinstates the penalty (status back
to 'unpaid'), sets the linked penalty_waiver_requests row to
'auto_unwaived' (auto_unwaived_at stamped), logs an audit_logs entry,
and emails the customer (penalty-waiver-revoked template).

penalty_date is NEVER rewritten by any of this — it permanently
records when the penalty was originally incurred, not when it was
waived or reinstated.

approve-waiver's confirmation email (penalty-waived template) shows
the same deadline via an optional graceDeadline prop, computed as
min(penalty_date across the batch) + penalty_waiver_grace_days.

### 90-day payment safety guard (clarified 2026-05-15)

### 90-day payment safety guard (clarified 2026-05-15):
The safety guard "last non-voided payment > 90 days ago" applies to BOTH PATH 2
AND PATH 3 (not just PATH 2 as originally documented). Implementation puts this
guard in the per-account loop BEFORE either path check, so any account with a
payment within 90 days is skipped entirely. This is intentional — keeps recently-
paying customers out of auto-forfeit regardless of overdue duration or penalty count.

### PATH 3 empirical verification and loyalty preservation

Empirical verification: confirmed 2026-05-15 on fixture CJ-2026-FORFEIT-PATH3-NEW.
Loyalty preserved per Bug #101 fix — lot stays ACTIVE, no revoke transaction
logged, cumulative_spend_jpy unchanged.

### Extension request window (customer portal)

Extension request window (customer portal):
- Customer can request extension from portal within 7 days of forfeiture
- Reference date: layaway_accounts.forfeited_at (timestamptz column)
- forfeited_at is set by auto-forfeit-settlement (PATH 1 and PATH 2)
  and manual-forfeit edge functions
- After 7 days: hide request button, show message:
  "The extension request window has closed. Please contact us directly
   for assistance."
- Within 7 days: show "Request Extension" button
- Once request submitted: button disabled, shows "Extension Request Pending"
- Extension requests stored in: extension_requests table
- Admin reviews in: CSR Monitoring → Extensions tab

### Penalty trigger schedule (per overdue month)

Cycle 1: week1:1 → due_date + 7 (or +0 if grace consumed), week2:1 → due_date + 14
Cycle 2: week1:2 → due_date + 1 month, week2:2 → due_date + 1 month + 14 days
Cycle 3: week1:3 → due_date + 2 months, week2:3 → due_date + 2 months + 14 days
(Final month only gets Cycles 2 and 3 — non-final months cap at Cycle 1)

### Penalty engine timing and the ACCOUNT-SCOPED RUN

Cron: 00:05 UTC daily (= 8:05 AM PHT)
Due date filter: due_date <= today (includes the due date itself)
Penalties apply ON the due date at 8 AM PHT — the grace period is
the customer's consideration time, not the filter.

ACCOUNT-SCOPED RUN (2026-09-20): penalty-engine accepts { account_id } and
evaluates that one account with IDENTICAL rules (a strict subset of the
nightly run — no rule changed, only when it is evaluated).
reactivate-account calls it (non-blocking) after the reactivation writes.
