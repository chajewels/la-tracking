# Cha Jewels Layaway System — Claude Code Context

## Account Creation Rules

- Downpayment is NEVER marked paid at creation
- `dp_paid` always starts at 0; `total_paid = 0` on new accounts
- DP is only marked paid after payment submission is validated by staff
- Never bypass the payment validation flow
- The "Downpayment Paid" input field does NOT exist on the creation form
- DP redistribution into installments is NOT supported (removed)

## Git Workflow

- Commit and push all changes directly to **main** branch
- Do NOT create feature branches unless explicitly asked

## Project Overview

Jewelry layaway management system built with:

- React + TypeScript
- Tailwind CSS
- Supabase (database + edge functions)
- Vite

## Key Files to Read First

- src/lib/business-rules.ts (calculation engine)
- src/components/AccountDetail.tsx (main account view)
- src/components/MultiInvoicePaymentDialog.tsx (split payment)
- supabase/functions/ (edge functions)

## Core Calculation Rules (NEVER change these)

All values come from computeLayaway() in business-rules.ts

  totalLAAmount = baseLA + non-waived penalties + services
  totalPaid = downPayment + Σ(actualPaid of PAID/PARTIAL months)
  remainingBalance = totalLAAmount - totalPaid

## Display Rules (NEVER break these)

### Dates

  Schedule list → always show due_date (when payment is due)
  Payment History → always show created_at (when payment was made)
  NEVER mix these two

### Amounts

  - Drop .00 on whole numbers: ₱3,956 not ₱3,956.00
  - Keep 2 decimals when non-zero: ₱22,103.27
  - Always use ₱ symbol
  - Comma separators: ₱22,103.27
  - Never show ₱0 penalties

### Customer Message Templates

  SINGLE PAYMENT:
  Thank you for your payment. ₱ [amount] has been received.
  Inv # [invoiceNumber]
  View your updated account and payment schedule here:
  🔗 [portalLink]
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

## Monthly Row Display Rules

  IF penalty > 0 AND not waived:
    ✅ Nth month Mon YY: ₱ [base] + ₱ [penalty] (Penalty) = ₱ [total] (PAID)
  IF no penalty or waived:
    ✅ Nth month Mon YY: ₱ [base] (PAID)
  Never show "+ ₱0 (Penalty)"

## Test Accounts (DO NOT DELETE OR MODIFY)

  TEST-001 — Locked benchmark (general baseline)
             Never modify data. All 9 verify checks must always be green.

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

  TEST-004 — Split payment testing (can record payments)
  TEST-005 — Split payment testing (can record payments)

## Verification Rule

After ANY change to calculation or display logic:
  1. Open TEST-001 in the app → Verify Calculations → all 9 green ✅
  2. Open TEST-002 in the app → Verify Calculations → all 9 green ✅
  3. Open TEST-003 in the app → Verify Calculations → all 9 green ✅
  4. If any check is red, the change broke something

There are 9 verify checks (not 7 — count was updated):
  1. activePenalties (non-waived)
  2. totalLAAmount (base + penalties + svc)
  3. amountPaid (DP + paid months)
  4. remainingBalance (totalLA - paid)
  5. monthsRemaining
  6. sumOfPendingMonths ≈ remainingBalance
  7. DP + sumBases = principalTotal
  8. downPayment recorded and marked paid
  9. nextPaymentDate uses due_date not payment date

## Payment Recording Rules

Every payment operation must update ALL 3 tables atomically:
  1. payments table — insert actual cash received
  2. schedule_items — update paid_amount and status
  3. penalty_fees — update status if penalty was paid

Never update one without the others.
Use edge functions with transactions to ensure atomicity.
If any of the 3 updates fail, roll back all of them.

## Ghost Amount Prevention

When completing a partially_paid month:
  - Set paid_amount = total_due_amount exactly
  - Set status = 'paid'
  - Never carry over excess to next month
  - Next month stays pending with paid_amount = 0

## Known Issues

  DP payments may be recorded with various payment_type values
  depending on how they were imported. Always check multiple fields
  when identifying DP payments:
    - payment_type === 'downpayment' or 'dp'
    - is_downpayment === true
    - reference_number starts with 'DP-'
    - remarks contains 'down' or 'dp' (case-insensitive)

## Known Fixed Bugs (do not reintroduce)

  - DP must never be counted twice in totalPaid
  - Waived penalties must be excluded from totalLAAmount
  - Partial months must be included in totalPaid
  - sumOfPendingMonths uses full scheduledTotal for pending,
    remaining amount for partial months
  - Split payment session tracking is per-account only
  - DP must never appear in split payment session list
  - Grand Total must include DP + base + penalties + services
