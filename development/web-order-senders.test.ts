/**
 * WHICH EMAIL A PAYMENT REVIEW SENDS (payment lifecycle H5, spec §5 B and C).
 *
 * routeSubmissionEmail is the one decision review-payment-submission makes
 * for a rejected / needs-clarification review:
 *   - a cash order's REJECT keeps sendCashPaymentRejectedEmail (method-aware,
 *     web and Hub alike) — never a second email;
 *   - a WEB cash order's needs-clarification gets the website "needs info"
 *     email; a Hub cash order's gets nothing (unchanged);
 *   - a WEB layaway's reject / needs-clarification gets the website layaway
 *     update (English) INSTEAD of the Hub portal template;
 *   - a Hub layaway keeps the Hub template;
 *   - a confirm is never routed here (it has its own existing path).
 *
 * Run: deno test --config development/deno.ci.json --allow-read --allow-env development/web-order-senders.test.ts
 */
import { reviewEmailKey, routeSubmissionEmail, shortHash } from '../supabase/functions/_shared/order-update-email.ts'

const assertEq = (a: unknown, b: unknown, msg: string) => {
  if (a !== b) throw new Error(`${msg}: expected ${String(b)}, got ${String(a)}`)
}

Deno.test('cash + rejected → cash_rejected (web and Hub alike)', () => {
  assertEq(routeSubmissionEmail({ action: 'rejected', isCashOrder: true, isWeb: true }), 'cash_rejected', 'web cash reject')
  assertEq(routeSubmissionEmail({ action: 'rejected', isCashOrder: true, isWeb: false }), 'cash_rejected', 'hub cash reject')
})

Deno.test('web cash + needs_clarification → order_needs_info', () => {
  assertEq(routeSubmissionEmail({ action: 'needs_clarification', isCashOrder: true, isWeb: true }), 'order_needs_info', 'web cash needs info')
})

Deno.test('Hub cash + needs_clarification → none (unchanged)', () => {
  assertEq(routeSubmissionEmail({ action: 'needs_clarification', isCashOrder: true, isWeb: false }), 'none', 'hub cash needs info')
})

Deno.test('web layaway + rejected / needs_clarification → layaway_update', () => {
  assertEq(routeSubmissionEmail({ action: 'rejected', isCashOrder: false, isWeb: true }), 'layaway_update', 'web layaway reject')
  assertEq(routeSubmissionEmail({ action: 'needs_clarification', isCashOrder: false, isWeb: true }), 'layaway_update', 'web layaway needs info')
})

Deno.test('Hub layaway + rejected / needs_clarification → hub_template', () => {
  assertEq(routeSubmissionEmail({ action: 'rejected', isCashOrder: false, isWeb: false }), 'hub_template', 'hub layaway reject')
  assertEq(routeSubmissionEmail({ action: 'needs_clarification', isCashOrder: false, isWeb: false }), 'hub_template', 'hub layaway needs info')
})

Deno.test('confirmed → none, every combination', () => {
  for (const isCashOrder of [true, false]) {
    for (const isWeb of [true, false]) {
      assertEq(routeSubmissionEmail({ action: 'confirmed', isCashOrder, isWeb }), 'none', `confirmed cash=${isCashOrder} web=${isWeb}`)
    }
  }
})

Deno.test('shortHash: deterministic 8-hex FNV-1a; empty string hashes too', () => {
  assertEq(shortHash('Please send the receipt'), shortHash('Please send the receipt'), 'same text, same hash')
  assertEq(/^[0-9a-f]{8}$/.test(shortHash('x')), true, '8 hex chars')
  assertEq(shortHash(''), '811c9dc5', 'FNV-1a offset basis for empty input')
  assertEq(shortHash('a'), 'e40c292c', 'FNV-1a("a") reference value')
})

Deno.test('reviewEmailKey: a retry with the same text dedupes; a follow-up question sends', () => {
  const a = reviewEmailKey('needs_info', 'sub-1', 'Which bank did you send from?')
  assertEq(a, reviewEmailKey('needs_info', 'sub-1', 'Which bank did you send from?'), 'same text → same key')
  assertEq(a === reviewEmailKey('needs_info', 'sub-1', 'Please also send the receipt'), false, 'different text → different key')
  assertEq(a === reviewEmailKey('rejected', 'sub-1', 'Which bank did you send from?'), false, 'variant is part of the key')
  assertEq(a === reviewEmailKey('needs_info', 'sub-2', 'Which bank did you send from?'), false, 'submission is part of the key')
  assertEq(reviewEmailKey('needs_info', 'sub-1', null), reviewEmailKey('needs_info', 'sub-1', ''), 'null message = empty')
  assertEq(a.startsWith('needs_info-sub-1-'), true, 'readable prefix')
})
