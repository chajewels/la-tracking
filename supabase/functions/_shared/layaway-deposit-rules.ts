/**
 * Is a website layaway payment report the DEPOSIT or an instalment?
 * (payment lifecycle H10, qc-audit P2-1, 2026-10-06)
 *
 * A report is the deposit while the DP portion already on the books, plus DP
 * reports still waiting for a reviewer, is below downpayment_amount. A plan
 * whose deposit was paid only in part therefore keeps filing deposits until
 * the deposit is whole — before this, the second report was filed as an
 * instalment and allocate_payment_atomic waterfalled it into Month 1 while
 * the deposit stayed short.
 *
 * DP detection is NOT a new rule; it mirrors the two existing ones exactly:
 *   - a payment (non-voided — the caller filters) is DP per
 *     allocate_payment_atomic / INVARIANT 11:
 *       reference_number LIKE 'DP-%' OR remarks ILIKE '%down%'
 *     (this includes LOYALTY- points payments whose remarks say downpayment);
 *   - a pending submission is DP per review-payment-submission submissionIsDP:
 *       submission_type = 'downpayment' OR reference starts with 'DP-'
 *       (case-insensitive) OR notes match /\bdown(payment)?\b|\bdp\b/i.
 * Change those, change these.
 *
 * public.layaway_deposit_started is deliberately NOT used here (it is true as
 * soon as any money arrives) and is not changed.
 */

type Money = number | string | null | undefined

export interface DepositPaymentRow {
  amount_paid: Money
  reference_number?: string | null
  remarks?: string | null
}

export interface PendingSubmissionRow {
  submitted_amount: Money
  submission_type?: string | null
  reference_number?: string | null
  notes?: string | null
}

export interface DepositDecisionInput {
  downpaymentAmount: Money
  /** Non-voided payments on the plan. */
  payments: DepositPaymentRow[]
  /** The plan's submissions in status submitted / under_review. */
  pendingSubmissions: PendingSubmissionRow[]
}

/** Integer cents, so sums of NUMERIC(12,2) values never drift. */
const cents = (v: Money): number => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}

/** allocate_payment_atomic: reference_number LIKE 'DP-%' OR remarks ILIKE '%down%'. */
export function isDpPayment(p: DepositPaymentRow): boolean {
  return String(p.reference_number ?? '').startsWith('DP-') ||
    String(p.remarks ?? '').toLowerCase().includes('down')
}

/** review-payment-submission submissionIsDP. */
export function isDpSubmission(s: PendingSubmissionRow): boolean {
  return s.submission_type === 'downpayment' ||
    String(s.reference_number ?? '').toUpperCase().startsWith('DP-') ||
    /\bdown(payment)?\b|\bdp\b/i.test(String(s.notes ?? ''))
}

export function webLayawaySubmissionIsDeposit(i: DepositDecisionInput): boolean {
  const required = cents(i.downpaymentAmount)
  if (required <= 0) return false
  const paid = i.payments.filter(isDpPayment).reduce((t, p) => t + cents(p.amount_paid), 0)
  const reported = i.pendingSubmissions.filter(isDpSubmission).reduce((t, s) => t + cents(s.submitted_amount), 0)
  return paid + reported < required
}
