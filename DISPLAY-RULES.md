# Cha Jewels — Display Rules

# READ THIS BEFORE CHANGING ANY UI COMPONENT

## DATES — Most Important Rule

ALWAYS show the installment DUE DATE,
never the payment recorded date.

  Schedule list → due_date (when payment is due)
  Payment History → created_at (when payment was made)

These are two different things. Never mix them.

## AMOUNTS

- Drop .00 on whole numbers: ₱3,956 not ₱3,956.00
- Keep 2 decimals when non-zero: ₱22,103.27
- Always use ₱ symbol, never PHP or $
- Comma separators: ₱22,103.27

## CUSTOMER MESSAGE TEMPLATES

Three templates only — all short format:

  SINGLE:

  Thank you for your payment. ₱ [amount]
  has been received.

  Inv # [number]

  View your account: 🔗 [portalLink]

  Next payment: [month] — ₱ [amount]

  Thank you for your continued trust
  in Cha Jewels! 🧡

  SPLIT (2+ accounts):

  Thank you for your payment. A total of
  ₱ [total] has been received across [N] accounts:

    Inv #[num] — [label]: ₱ [amount]

  View your accounts: 🔗 [portalLink]

  Next payments:

    [label] — [month]: ₱ [amount]

  Thank you for your continued trust
  in Cha Jewels! 🧡

  FULLY PAID:

  Same as single but replace next payment with:

  🎉 Your layaway is now fully paid! Thank you!

  BATCH PAYMENT (multi-invoice on individual account):

  Your account has been updated.

  Inv # [number]

  View your account: 🔗 [portalLink]

  Thank you for your continued trust
  in Cha Jewels! 🧡

## CALCULATIONS — Never override these

All amounts come from computeLayaway() in
business-rules.ts. Never recalculate locally.

  totalLAAmount = base + non-waived penalties + fees
  totalPaid = DP + Σ(actualPaid of paid/partial months)
  remainingBalance = totalLAAmount - totalPaid

## TEST ACCOUNTS

TEST-001 — locked benchmark, never modify
TEST-003 — split payment testing
TEST-004 — split payment testing

After ANY change, open TEST-001 and confirm
all 7 verify checks are green.
