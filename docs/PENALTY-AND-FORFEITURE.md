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
- Since 2026-10-20 (owner rule R2) STAFF reactivation follows the SAME window
  and refuses with the SAME message — see "Extension end date and final
  forfeiture" below. One helper: _shared/extension-rules.ts extensionWindowOpen.

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

## Extension end date and final forfeiture (owner rules 2026-10-20)

Owner confirmation 2026-10-20, applied GOING FORWARD to every account. No
existing account data was changed. Supersedes Bug #108 ("extension = 1 month
from reactivation") and retires the extension-month penalty-cap path. The rules
live in ONE file, `supabase/functions/_shared/extension-rules.ts`, imported by
reactivate-account, request-extension, penalty-engine, auto-forfeit-settlement
and, from src/, by `canReactivate` (business-rules.ts), AccountDetail and
CustomerPortal. Regression tests: `src/test/extension-rules.test.ts` (CI).

**R1 — End date.** `extension_end_date` = the PHT (Asia/Manila) calendar day of
`layaway_accounts.forfeited_at` + 1 month, same day-of-month, clamped to the
last day of the target month (Jan 31 → Feb 28, or Feb 29 in a leap year; Mar 31
→ Apr 30). Never the reactivation date or the extension-request date, so
reactivating later never adds days. Forfeited 2026-10-01 → ends 2026-11-01.
`forfeited_at` NULL → reactivate-account refuses 409 `forfeited_at_missing`.
The same value is the Extension Month row's due_date (reactivate_layaway_atomic,
unchanged).

**R2 — Reactivation window.** Staff reactivation is allowed only while whole
days elapsed since `forfeited_at` are <= 7 — the same computation as the
customer's extension request (`floor((now − forfeited_at) / 24h) <= 7`, i.e. the
window closes exactly 8 × 24 h after forfeiture). Outside it, reactivate-account
answers 403 `window_closed` with the customer's own words: "The extension request
window has closed. Please contact us directly for assistance." The Hub hides the
Reactivate button outside the window and shows that line instead. Whenever the
reactivation happens, the end date is always R1.

**R3 — Penalties.** The normal penalty cycle continues through the extension
with no reset (two penalties per installment cycle: the due date — or +7 while
grace is unconsumed — and due + 14). The account-scoped penalty-engine run at
reactivation still applies everything already due, including the installment
due on the forfeiture day. penalty-engine creates NO penalty — new, or a waived
one reinstated to unpaid — for an `extension_active` account on or after its
`extension_end_date` (`today` is PHT). The check sits right after the
frozen-submission skip and before every cap and trigger, so the CLEAN
+₱1,000 / ¥2,000 final-installment bump applies only before the end date. The
crons keep their order (penalty engine 00:05 → auto-forfeit 00:10 UTC).

**R4 — Final forfeiture ON the end date.** auto-forfeit-settlement
final-forfeits an `extension_active` account when today (PHT) >= its
`extension_end_date`. The 00:10 UTC run is 08:10 PHT / 09:10 JST, and at that
moment the UTC date equals the PHT date. Before 2026-10-20 the check was
`end + "T23:59:59Z" < now`, which made the first final forfeit land the day
AFTER the end date (17325: end 2026-07-04, final-forfeited 2026-07-05 00:10).
The frozen-submission skip (INVARIANT 12) still comes first: an account with a
pending submission on its end date is final-forfeited on the first run after the
submission is resolved.

**R5 — Extension-month penalty cap retired.** The old path summed penalties
only on the Extension Month row (installment = plan + 1), which is created with
base 0; penalty-engine Guard 1 (`paid_amount < base_installment_amount`) always
drops a base-0 row, so the row was never charged and the path could never fire
(all five reactivated accounts with such a row had zero penalties on it on
2026-10-20). Under R3 + R4 the end date governs alone, so the path was removed,
not repaired. The Extension Month row itself stays (Bug #106).

**R6 — Customer wording.** Every customer-facing "until / settle by {date}"
shows `extension_end_date − 1 day` (`customerSettleByDate`), because the account
final-forfeits on the morning of the end date: the AccountDetail copy message,
the `extension-granted` email ("Settle By"), the web `layaway-update`
reactivated email ("open until"), and reactivate-account's response / toast
text. The internal Hub badge ("Extension until …") still shows the end date.

**Independence.** penalty-engine and auto-forfeit-settlement still never call
each other; each reads `extension_end_date` itself.

**Not changed by this.** Invoice 18788 (forfeited 2026-09-20, end 2026-10-20)
is left to the code already deployed: it final-forfeits at the 2026-10-21
00:10 UTC run, and its 2026-10-20 penalty stays (owner decision).

## Same-day settlement after final forfeiture (owner rule R7, 2026-10-20)

**Rule.** A `final_forfeited` layaway can still be settled ONCE, IN FULL, if the
customer's payment WITH proof is SUBMITTED on the final forfeiture date — the
PHT (Asia/Manila) calendar day of the account's latest `final_forfeited`
audit row. Staff may CONFIRM it later; confirmation is not limited to that day.
Anything else stays refused: FINAL_FORFEITED still blocks negotiation and
reactivation.

**Before (≤ 2026-10-20).** A final-forfeited plan could not take any payment:
record-payment, RecordPaymentModal and `canAcceptPayment` all exclude the status.
A customer who paid on the morning of the end date had no way back.

**After.** Hub → the account → **Same-day settlement** (shown only on that
day, only to `record_payment`). One dialog: the amount, that day's penalty (if
any), method, date, reference, sender, proof. The reviewer confirms it in
Payment Submissions as usual (`confirm_payment`, admin / finance). No new
permission key.

**The amount** = `total_amount` + non-waived penalties (including that day's) −
non-voided payments: exactly `allocate_payment_atomic`'s remaining formula, so
confirming it completes the account (status `completed`). Full amount only — a
partial or larger amount is refused (`amount_mismatch` at submit,
`settlement_not_full` at confirm).

**That day's penalty.** Charged exactly as the penalty engine would have charged
it that day: same installment, same next `stage:cycle` slot, same amount, the
same caps (incl. the CLEAN extension bump), guards and waiver grace. If the
engine would not have charged anything that day (e.g. the installment is at its
cap, or no trigger falls on that day), nothing is charged. Only the slot dated
that day is considered; an earlier slot the engine never charged is NOT
back-charged. If the engine already charged that day's slot before the final
forfeiture, that penalty is simply part of the amount.

To guarantee "same as the engine", the engine's trigger-date builder, cap and
per-row loop moved verbatim into `supabase/functions/_shared/penalty-schedule.ts`
(`buildTriggerDates`, `penaltyCapFor`, `planItemPenalties`). penalty-engine
imports them — no rule change; `src/test/penalty-schedule.test.ts` compares the
helper with the engine's former inline code (every cap combination + 3,000
seeded random rows). The R7 planner is `_shared/final-forfeit-settlement.ts`.

**Same-day auto-waive.** The live trigger `trg_auto_waive_same_day` waives every
unpaid penalty dated the submission's (JST) day when a submission is inserted.
For R7 the owner's rule wins: the RPC inserts the submission BEFORE the new
penalty row, and undoes, in the same transaction, any auto-waive that trigger
made for THIS submission (penalty back to `unpaid`, the auto waiver request
`rejected`, audit `auto_waiver_reverted`). Every other submission keeps the
auto-waive exactly as before.

**One per account.** A second settlement is refused (`already_settled`) unless
the earlier one was REJECTED; a rejected settlement frees the slot, still on the
same day only. Its penalty stays (it was charged that day; a retry finds the
slot taken and does not charge it twice). A pending submission of any kind
refuses it (`submission_pending`, INVARIANT 12).

**Web plans.** The pieces released at forfeiture are re-held in the same
transaction before anything else is written, or the call refuses `out_of_stock`
and writes nothing. If the settlement is REJECTED, review-payment-submission
calls `release_final_forfeit_settlement_hold`, which puts the pieces back on
sale (account still `final_forfeited`; idempotent; only a hold this settlement
took).

**Loyalty.** When the confirmed settlement completes the account,
review-payment-submission calls restore-loyalty-points on the account's latest
`revoked` transaction (the final-forfeit revoke) with
`trigger_event: "account_reactivated"` — the same call reactivate-account makes.
Non-blocking.

**Pieces.**
- Migration `20261226100000_final_forfeit_same_day_settlement.sql` (owner applies):
  `settle_final_forfeited_same_day_atomic` (one transaction; refusals first;
  `p_preview` writes nothing) and `release_final_forfeit_settlement_hold`. Both
  SECURITY DEFINER, service_role only.
- Edge function `settle-final-forfeited` (requireAuth + `record_payment`,
  `verify_jwt = true`).
- review-payment-submission: the full-amount check before the confirm CAS flip,
  the loyalty restore, the release on reject.
- Hub: `src/components/accounts/FinalForfeitSettlement.tsx` on AccountDetail.
- `payment_submissions.submission_type = 'final_forfeit_settlement'`.

**Independence.** settle-final-forfeited calls neither penalty-engine nor
auto-forfeit-settlement; it imports the engine's helpers only.

**Tests.** `src/test/final-forfeit-settlement.test.ts`,
`src/test/penalty-schedule.test.ts` (CI), and the SQL acceptance on a throwaway
Postgres with the live triggers copied verbatim:
`development/sql/final-forfeit-settlement.sh` (36 checks).
