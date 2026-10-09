// Square QC close-out (2026-10-09) — the edge-function side. The database side is
// proven by development/sql/square-qc-adverse-2026-10-09.sql (27/27 on the local copy).
import { createPaymentBody, squareErrorKind } from '../supabase/functions/_shared/square.ts'
import { terminateRefusalMessage } from '../supabase/functions/_shared/terminate-refusals.ts'
import { locationUsable, preflightPassed, webhookKeyNames } from '../supabase/functions/_shared/square-preflight-rules.ts'

const assert = (ok: unknown, msg = 'assertion failed') => { if (!ok) throw new Error(msg) }
const assertEquals = (a: unknown, b: unknown) => assert(JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`)
const code = (path: string) =>
  Deno.readTextFileSync(new URL(path, import.meta.url)).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')

Deno.test('M1: CreatePayment no longer sends statement_description_identifier (Dashboard descriptor instead)', () => {
  const body = createPaymentBody({ env: 'sandbox', sourceId: 'cnon:abc', amountJpy: 1000, locationId: 'L', idempotencyKey: 'k', referenceId: 'r', note: '' })
  assert(!('statement_description_identifier' in body))
})

Deno.test('L2: only an authentication 403 is "auth"; other 403 refusals are client errors', () => {
  assertEquals(squareErrorKind(403, 'AUTHENTICATION_ERROR', 'FORBIDDEN'), 'auth')
  assertEquals(squareErrorKind(403, 'AUTHENTICATION_ERROR', 'INSUFFICIENT_SCOPES'), 'auth')
  assertEquals(squareErrorKind(403, 'INVALID_REQUEST_ERROR', 'INSUFFICIENT_SCOPES'), 'auth')
  assertEquals(squareErrorKind(403, 'INVALID_REQUEST_ERROR', 'BAD_REQUEST'), 'client')
  assertEquals(squareErrorKind(401, 'AUTHENTICATION_ERROR', 'UNAUTHORIZED'), 'auth')
})

Deno.test('F-02: card_disputed has a plain-English staff message', () => {
  const m = terminateRefusalMessage('card_disputed')
  assert(m && /chargeback/i.test(m))
})

Deno.test('M2 / F-14: preflight location must be ACTIVE + JPY + JP; webhook key names per environment', () => {
  assert(locationUsable({ status: 'ACTIVE', currency: 'JPY', country: 'JP', card_processing: true }))
  // DOC-7: an ACTIVE yen location Square has not activated for cards fails.
  assert(!locationUsable({ status: 'ACTIVE', currency: 'JPY', country: 'JP', card_processing: false }))
  assert(!locationUsable({ status: 'ACTIVE', currency: 'JPY', country: 'JP' }))
  assert(!locationUsable({ status: 'ACTIVE', currency: 'JPY', country: 'US' }))
  assert(!locationUsable(null))
  assertEquals(webhookKeyNames('production'), ['SQUARE_PRODUCTION_WEBHOOK_SIGNATURE_KEY'])
  const old = {
    environment: 'production' as const, token: { state: 'ok' as const, status: 200, code: null, secret: 'X' },
    locations: ['L'], location_configured: 'L', location_match: true, app_id_family: 'production' as const,
    events: { state: 'ok' as const, status: 200, code: null, first_page: 0, window_days: 28 },
  }
  assert(!preflightPassed(old), 'a report without the new checks never passes')
})

Deno.test('F-01: the reviewer refuses Clarify on a card or Paidy submission', () => {
  const src = code('../supabase/functions/review-payment-submission/index.ts')
  assert(src.includes('action === "needs_clarification" && (submission.square_payment_id || submission.paidy_payment_id)'))
  assert(src.includes('code: "provider_submission_no_clarify"'))
})

Deno.test('F-06: a void Square confirmed but the Hub could not record is not a rejection', () => {
  const src = code('../supabase/functions/review-payment-submission/index.ts')
  assert(src.includes('if (!voidApplied) {'))
  assert(src.includes('error: "card_void_unrecorded"'))
})

Deno.test('F-05 / F-12: the replay reads the hold and its latest submission', () => {
  const src = code('../supabase/functions/website/index.ts')
  assert(src.includes('const answerAuthorized = async (squarePaymentId: unknown) =>'))
  assert(src.includes('.eq("square_payment_id", hold.id).order("created_at", { ascending: false }).limit(1).maybeSingle()'))
  assert(!src.includes('.eq("square_payments.square_payment_id", attempt.square_payment_id).maybeSingle()'))
})

Deno.test('F-11 / D-QC4: a card-chosen order shows transfer when card is not offered for a set-up reason', () => {
  const src = code('../supabase/functions/website/index.ts')
  assert(src.includes('const cardFallsBackToTransfer = isWebOrder && chosenMethod === "card" && !lock && !blockedByCard'))
  assert(src.includes('chosenMethod === "transfer" || cardFallsBackToTransfer'))
})

Deno.test('F-07 / F-09: reconcile retries the Paidy-conflict void and skips a retired environment', () => {
  const src = code('../supabase/functions/square-reconcile/index.ts')
  assert(src.includes('String(row.exception_note ?? "").startsWith("paidy_in_progress")'))
  assert(src.includes('const noteEnv = (where: string, e: unknown, rowEnv: SquareEnvironment | null) =>'))
})

Deno.test('F-10: recording a refund outside Square re-reads Square first', () => {
  const src = code('../supabase/functions/mark-refund-issued/index.ts')
  const record = src.indexOf('if (isExceptionMethod(method)) {\n      const resync = await resyncOrderRefunds(supabase, orderId);')
  const rpcAt = src.indexOf('supabase.rpc("mark_web_order_refund_issued_atomic"')
  assert(record > 0 && record < rpcAt)
})
