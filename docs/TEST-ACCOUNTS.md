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
               status:             active (completed on next reconcile)

  TEST-002 — Locked benchmark (waived penalty)
             Never modify data. All 9 verify checks must always be green.
             Purpose: catches bugs where waived penalties still affect
             totalLAAmount or remainingBalance.

             Setup:
               Currency: PHP | Base LA: ₱20,000 | DP: ₱6,000 (paid)
               3 months | Month 1 Jan 22 2026 PAID | Month 2 Feb 22 2026 PAID
               Month 3 Mar 22 2026 PENDING
               Penalty: ₱500 on Month 2, status=waived
               penalty_amount on schedule row = 0

             Expected verify values (all 9 must be green):
               activePenalties:    0        (waived = excluded)
               totalLAAmount:      20,000
               amountPaid:         15,334   (6,000 + 4,667 + 4,667)
               remainingBalance:   4,666
               monthsRemaining:    1
               sumOfPendingMonths: 4,666
               DP + sumBases:      20,000   (6,000 + 14,000)
               downPayment:        6,000    (ref: DP-TEST-002)
               nextPaymentDate:    2026-03-22

  TEST-003 — Locked benchmark (bulk import DP recognition)
             Never modify data. All 9 verify checks must always be green.
             Purpose: catches bugs where bulk import downpayments are not
             recognized by the verify check or totalPaid calculation.

             Setup:
               Currency: PHP | Base LA: ₱15,000 | DP: ₱4,500 (paid)
               3 months | Month 1 Feb 22 2026 PAID | Month 2 Mar 22 2026 PENDING
               Month 3 Apr 22 2026 PENDING
               DP payment remarks: "Downpayment (bulk import)"
               (contains 'down' → recognized by isDownpaymentPayment)

             Expected verify values (all 9 must be green):
               activePenalties:    0
               totalLAAmount:      15,000
               amountPaid:         8,000    (4,500 + 3,500)
               remainingBalance:   7,000
               monthsRemaining:    2
               sumOfPendingMonths: 7,000
               DP + sumBases:      15,000   (4,500 + 10,500)
               downPayment:        4,500    (remarks contains 'down')
               nextPaymentDate:    2026-03-22

  BENCHMARK DRIFT NOTE (observed 2026-05-21):
    TEST-002 and TEST-003 have drifted +2,000 each from the documented
    "Expected verify values" above — penalty accrual on overdue
    installments since Apr 2026 (TEST-002 remaining 4,666 → 6,666;
    TEST-003 remaining 7,000 → 9,000). Both still PASS audit_account
    (internally consistent; waived penalty still correctly excluded on
    TEST-002). The documented numbers above are STALE — they are not a
    regression. Re-baseline or update the docs — TBD; the locked
    numbers have intentionally NOT been changed pending that decision.

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

