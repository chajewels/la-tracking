## Test Accounts (DO NOT DELETE OR MODIFY)

  TEST-001 — Locked benchmark (general baseline)
             Never modify data. All checks must always be green.
             Purpose: catches regressions in core calculation formula.

             Setup:
               Currency: PHP | Base LA: ₱26,000 | DP: ₱6,000 (paid)
               3 months | All months PAID
               No penalties

             Expected verify values (all must be green):
               activePenalties:    0
               totalLAAmount:      26,000
               amountPaid:         26,000
               remainingBalance:   0
               monthsRemaining:    0
               sumOfPendingMonths: 0
               DP + sumBases:      26,000   (6,000 + 20,000)
               downPayment:        6,000
               status:             completed (verified 2026-05-19)

  TEST-002 — Locked benchmark (waived penalty + forfeit lifecycle)
             Never modify data. Frozen state below is the new baseline.
             Purpose: catches bugs where waived penalties still affect
             totalLAAmount or remainingBalance; also pins post-forfeit
             totals so the auto-forfeit / penalty-cap path stays auditable.

             Setup:
               Currency: PHP | Base LA: ₱20,000 | DP: ₱6,000 (paid)
               3 months | Month 1 Jan 22 2026 PAID | Month 2 Feb 22 2026 PAID
               Month 3 Mar 22 2026 was PENDING → cancelled on forfeit 2026-06-05
               Penalty: ₱500 on Month 2, status=waived (penalty_amount on
                        schedule row = 0)
               Penalty: 6 × ₱500 on Month 3, status=unpaid (final-month cap
                        ₱3,000 reached before auto-forfeit fired)

             Frozen verify values (re-baselined 2026-06-12, post-forfeit):
               activePenalties:    3,000    (6 × 500 unwaived on M3)
               totalLAAmount:      23,000   (20,000 + 3,000 activePenalties)
               amountPaid:         15,334   (6,000 + 4,667 + 4,667)
               remainingBalance:   7,666    (23,000 − 15,334)
               monthsRemaining:    0        (M3 cancelled by PATH 2 forfeit)
               sumOfPendingMonths: 0        (no pending/overdue rows)
               DP + sumBases:      20,000   (6,000 + 14,000)
               downPayment:        6,000    (ref: DP-TEST-002)
               waivedPenalties:    500
               status:             forfeited (auto-forfeit cron, 2026-06-05)

  TEST-003 — Locked benchmark (bulk import DP recognition + final_settlement)
             Never modify data. Frozen state below is the new baseline.
             Purpose: catches bugs where bulk import downpayments are not
             recognized by the verify check or totalPaid calculation; also
             pins the PATH 3 final_settlement lifecycle (6th-penalty trigger
             without schedule cancellation).

             Setup:
               Currency: PHP | Base LA: ₱15,000 | DP: ₱4,500 (paid)
               3 months | Month 1 Feb 22 2026 PAID
               Month 2 Mar 22 2026 → overdue
               Month 3 Apr 22 2026 → overdue (final month — accrued 6 penalty
                                              events to the ₱3,000 cap)
               DP payment remarks: "Downpayment (bulk import)"
               (contains 'down' → recognized by isDownpaymentPayment)
               Penalties: 6 × ₱500 on Month 3, status=unpaid (final-month cap)
               Penalties waived: 0

             Frozen verify values (re-baselined 2026-06-12, post-settlement):
               activePenalties:    3,000    (6 × 500 unwaived on M3)
               totalLAAmount:      18,000   (15,000 + 3,000 activePenalties)
               amountPaid:         8,000    (4,500 + 3,500)
               remainingBalance:   10,000   (18,000 − 8,000)
               monthsRemaining:    2        (M2 + M3 stay overdue per
                                             final_settlement rules)
               sumOfPendingMonths: 10,000   (M2 base 3,500 + M3 base 3,500
                                             + M3 penalty 3,000)
               DP + sumBases:      15,000   (4,500 + 10,500)
               downPayment:        4,500    (remarks contains 'down')
               waivedPenalties:    0
               status:             final_settlement (PATH 3, 6th-penalty
                                                     trigger)

  Baseline freeze (2026-06-12): TEST-001/002/003 are excluded from
  penalty-engine accrual as of commit 79e53c4, and all three now sit in
  terminal/settlement statuses outside the cron's processing filters, so
  these figures are stable. TEST-004/TEST-005 intentionally still accrue
  penalties (live penalty-testing scaffolds). Note: auto-forfeit-settlement
  has no test exclusion — it forfeited TEST-002 on 2026-06-05; if a locked
  benchmark is ever reset to active for regression testing, account for
  that cron or add a matching exclusion first.

  TEST-004 — Split payment testing (can record payments)
             2026-05-18: now also the layaway loyalty-redemption
             fixture. Member 0ab9c522-7dac-496e-9ff2-efbc34632c67
             (CJ-2026-05088, Test Customer, customer_id
             4201767c-…) has ONE confirmed layaway loyalty
             redemption: 08d1d0e0, shipping_fee, 1000 pts, ₱420
             discount applied (synthetic payment 2e9b3bf2,
             allocation e022cfa1). Post-redemption TEST-004 state:
             total_amount=15,000, total_paid=13,420,
             remaining=2,580, status=overdue, schedule row 3
             paid_amount=1,920. Treat as a known baseline — do
             not "correct" these values; they reflect the
             verified Phase B Patch 2 redemption application.
  TEST-005 — Split payment testing (can record payments)
  TEST-007 — Cash order Bug #99 smoke test (¥1M, Test Customer Glimmer→Radiant)
  TEST-008_ELITE — Layaway DP restore lifecycle (Bug #66 + Bug #99 restore-loyalty test fixture)
  TEST-4567 — created 2026-06-12 under Test Customer to verify the live
              loyalty award path post-Bug #223. End-to-end run: DP
              confirmed → +2,200 pts at 0.77s latency; payment voided →
              lot revoked cleanly; account forfeited. Originally created
              with a purely numeric invoice (4567), which leaked into
              every KPI (Dashboard forfeited_accounts, Finance
              totalForfeitedCollected, reporting RPCs) because the
              canonical regex filter `^[0-9]+$` treats numeric invoices
              as real. Renamed to `TEST-4567` across layaway_accounts,
              loyalty_transactions, loyalty_point_lots, payments
              (reference_number `DP-TEST-4567`), and staff_notifications.
              This incident is what motivated the customers.is_test
              flag + enforce_test_invoice_prefix() trigger pair on
              layaway_accounts and cash_orders — see docs/SCHEMA-FACTS.md
              "Test-customer enforcement" and the CLAUDE.md TEST ACCOUNT
              EXCLUSION section's 2026-06-12 amendment for the new
              "every new test customer MUST be flagged is_test = true"
              rule that prevents this class of leak.

