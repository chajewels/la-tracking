/**
 * QC money/safety fixes (payment lifecycle H10, qc-audit P2-1 / P2-2 / P2-3).
 *
 * 1. webLayawaySubmissionIsDeposit — a website layaway report is the DEPOSIT
 *    while the DP portion paid (+ DP reports still pending) is below
 *    downpayment_amount. DP detection mirrors allocate_payment_atomic
 *    (reference_number LIKE 'DP-%' OR remarks ILIKE '%down%') for payments and
 *    review-payment-submission's submissionIsDP for pending submissions.
 * 2. Source assertions on the migration's patched bodies (comments stripped):
 *    the reminder skips a locked cash order, terminate refuses Paidy money.
 * 3. terminateRefusalMessage — plain-English 409 text for staff.
 *
 * Run: deno test --config development/deno.ci.json --allow-read --allow-env development/qc-safety.test.ts
 */
import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  isDpPayment,
  isDpSubmission,
  webLayawaySubmissionIsDeposit,
} from '../supabase/functions/_shared/layaway-deposit-rules.ts'
import { terminateRefusalMessage } from '../supabase/functions/_shared/terminate-refusals.ts'

const dpPay = (amount: number) => ({ amount_paid: amount, reference_number: null, remarks: 'Payment submitted: Downpayment submitted from the website (CJ-W-1). Submission #abcd1234' })
const instPay = (amount: number) => ({ amount_paid: amount, reference_number: null, remarks: 'Payment submitted: Payment submitted from the website (CJ-W-1). Submission #abcd1234' })
const pointsDp = (amount: number) => ({ amount_paid: amount, reference_number: 'LOYALTY-9f1', remarks: 'Loyalty redemption applied to downpayment' })

Deno.test('no deposit paid -> the report is the deposit', () => {
  assertEquals(webLayawaySubmissionIsDeposit({ downpaymentAmount: 30000, payments: [], pendingSubmissions: [] }), true)
})

Deno.test('deposit part-paid -> the next report is still the deposit (P2-1)', () => {
  assertEquals(webLayawaySubmissionIsDeposit({ downpaymentAmount: 30000, payments: [dpPay(10000)], pendingSubmissions: [] }), true)
})

Deno.test('deposit fully paid -> the next report is an instalment', () => {
  assertEquals(webLayawaySubmissionIsDeposit({ downpaymentAmount: 30000, payments: [dpPay(10000), dpPay(20000)], pendingSubmissions: [] }), false)
})

Deno.test('points-only deposit fully covering -> instalment', () => {
  assertEquals(webLayawaySubmissionIsDeposit({ downpaymentAmount: 30000, payments: [pointsDp(30000)], pendingSubmissions: [] }), false)
})

Deno.test('points partly covering the deposit -> still the deposit', () => {
  assertEquals(webLayawaySubmissionIsDeposit({ downpaymentAmount: 30000, payments: [pointsDp(5000)], pendingSubmissions: [] }), true)
})

Deno.test('instalment payments never count toward the deposit', () => {
  assertEquals(webLayawaySubmissionIsDeposit({ downpaymentAmount: 30000, payments: [instPay(30000)], pendingSubmissions: [] }), true)
})

Deno.test('a pending part-deposit report: a second report is still the deposit', () => {
  const pending = [{ submitted_amount: 10000, submission_type: 'downpayment', reference_number: null, notes: 'Downpayment submitted from the website (CJ-W-1)' }]
  assertEquals(webLayawaySubmissionIsDeposit({ downpaymentAmount: 30000, payments: [], pendingSubmissions: pending }), true)
})

Deno.test('a pending report covering the whole deposit: the next report is an instalment', () => {
  const pending = [{ submitted_amount: 30000, submission_type: 'downpayment', reference_number: null, notes: null }]
  assertEquals(webLayawaySubmissionIsDeposit({ downpaymentAmount: 30000, payments: [], pendingSubmissions: pending }), false)
})

Deno.test('a pending non-DP report does not count toward the deposit', () => {
  const pending = [{ submitted_amount: 30000, submission_type: 'single', reference_number: null, notes: 'Payment submitted from the website (CJ-W-1)' }]
  assertEquals(webLayawaySubmissionIsDeposit({ downpaymentAmount: 30000, payments: [], pendingSubmissions: pending }), true)
})

Deno.test('numeric strings from PostgREST are summed as money', () => {
  assertEquals(webLayawaySubmissionIsDeposit({ downpaymentAmount: '30000.00', payments: [{ ...dpPay(0), amount_paid: '29999.99' }], pendingSubmissions: [] }), true)
  assertEquals(webLayawaySubmissionIsDeposit({ downpaymentAmount: '30000.00', payments: [{ ...dpPay(0), amount_paid: '30000.00' }], pendingSubmissions: [] }), false)
})

Deno.test('no deposit on the plan -> instalment', () => {
  assertEquals(webLayawaySubmissionIsDeposit({ downpaymentAmount: 0, payments: [], pendingSubmissions: [] }), false)
})

Deno.test('isDpPayment mirrors allocate_payment_atomic (LIKE DP-% is case-sensitive, ILIKE %down%)', () => {
  assertEquals(isDpPayment({ amount_paid: 1, reference_number: 'DP-123', remarks: null }), true)
  assertEquals(isDpPayment({ amount_paid: 1, reference_number: 'dp-123', remarks: null }), false)
  assertEquals(isDpPayment({ amount_paid: 1, reference_number: null, remarks: 'DOWNpayment' }), true)
  assertEquals(isDpPayment({ amount_paid: 1, reference_number: null, remarks: 'markdown' }), true) // ILIKE '%down%' as SQL does
  assertEquals(isDpPayment({ amount_paid: 1, reference_number: null, remarks: 'instalment' }), false)
})

Deno.test('isDpSubmission mirrors review-payment-submission submissionIsDP', () => {
  assertEquals(isDpSubmission({ submitted_amount: 1, submission_type: 'downpayment', reference_number: null, notes: null }), true)
  assertEquals(isDpSubmission({ submitted_amount: 1, submission_type: 'single', reference_number: 'dp-9', notes: null }), true)
  assertEquals(isDpSubmission({ submitted_amount: 1, submission_type: 'single', reference_number: null, notes: 'the DP for May' }), true)
  assertEquals(isDpSubmission({ submitted_amount: 1, submission_type: 'single', reference_number: null, notes: 'Payment submitted from the website' }), false)
})

Deno.test('terminate refusals map to plain English for staff', () => {
  assertEquals(terminateRefusalMessage('paidy_payment_unresolved'), 'Reject or record the Paidy payment first')
  assert(terminateRefusalMessage('card_payment_unresolved')?.includes('card payment'))
  assertEquals(terminateRefusalMessage('already_terminal'), null)
})

// ---------------------------------------------------------------------------
// Migration source assertions (comments stripped so prose cannot satisfy them).
// ---------------------------------------------------------------------------
const MIG = new URL('../supabase/migrations/20261111100000_payment_lifecycle.sql', import.meta.url)
const code = Deno.readTextFileSync(MIG)
  .split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n')

const patchFor = (sig: string) => {
  const i = code.indexOf(`pg_temp.cj_patch('${sig}'`)
  assert(i >= 0, `no cj_patch for ${sig}`)
  const j = code.indexOf('$n$)));', i)
  assert(j > i, `unterminated cj_patch for ${sig}`)
  return code.slice(i, j)
}

Deno.test('migration: the reminder never offers a cash order under a payment lock', () => {
  const p = patchFor('public.web_payment_reminder_eligible(text,uuid)')
  assert(p.includes("'a6283f61ccdb12cdf4b3522e87e10fb7'"), 'md5 guard is the live body read for H10')
  assert(/AND public\.cash_order_payment_lock\(o\.id\) IS NULL/.test(p))
  assert(!/cash_order_payment_lock\(a\.id\)/.test(p), 'layaway branch has no lock concept')
})

Deno.test('migration: terminate_web_order_atomic refuses Paidy money for every caller', () => {
  const p = patchFor('public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)')
  assert(p.includes("'7ca713d878fd2b115d10ba7560eeb0d9'"), 'md5 guard is the live body read for H10')
  assert(/coalesce\(public\.cash_order_payment_lock\(p_order_id\), ''\) LIKE 'paidy%'/.test(p))
  assert(p.includes("'reason', 'paidy_payment_unresolved'"))
  // Not conditioned on the caller: no v_is_system / p_outcome in the new guard.
  const guard = p.slice(p.indexOf("cash_order_payment_lock(p_order_id)"), p.indexOf("'paidy_payment_unresolved'"))
  assert(!/v_is_system|p_outcome/.test(guard))
})

Deno.test('migration: post-check asserts both patches landed', () => {
  assert(code.includes("'public.web_payment_reminder_eligible(text,uuid)', 'cash_order_payment_lock(o.id) IS NULL'"))
  assert(code.includes("'public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)', 'paidy_payment_unresolved'"))
})
