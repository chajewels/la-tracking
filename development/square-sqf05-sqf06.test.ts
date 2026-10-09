/**
 * SQF05 / SQF06 (Square go-live counter-check, 2026-10-08), edge + wording side.
 *   SQF05 — mark-refund-issued proves EVERY completed Square refund's email;
 *           the response carries per-refund coverage and the dialog says it.
 *   SQF06 — the "card refund outside Square" exception (owner D-SQF06): the two
 *           methods, admin check in the edge, the evidence object passed to the
 *           SQL, the customer email's method line, and the retired wording
 *           "or reverse the Square refund" (§8).
 * The SQL side is development/sql/sqf06-card-refund-exception-acceptance.sql.
 *
 * Run: deno test --config development/deno.ci.json --allow-read --allow-env development/square-sqf05-sqf06.test.ts
 */
import { customerRefundMethod, EXCEPTION_METHODS, isExceptionMethod, isRefundMethod, REFUND_METHODS } from '../supabase/functions/_shared/refund-issued-rules.ts'

const assert = (ok: unknown, msg: string) => { if (!ok) throw new Error(msg) }
const eq = (a: unknown, b: unknown, msg: string) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`)
const read = (rel: string) => Deno.readTextFile(new URL(`../${rel}`, import.meta.url))
const code = async (rel: string) => (await read(rel)).replace(/^\s*(\*|\/\/).*$/gm, '')

Deno.test('SQF05: every completed refund is proven; the answer counts them (SQV06 shape)', async () => {
  const src = await code('supabase/functions/mark-refund-issued/index.ts')
  // SQV06 superseded the SQF05 counter: one state per COMPLETED refund, then the coverage.
  assert(src.includes('const sent = await refundIssuedEmailSent(supabase, refundReceivedKey(String(row.square_refund_id)));'), 'each completed refund is checked on its own key')
  assert(!src.includes('proven = true; break;'), 'the first proven id no longer vouches for the rest')
  assert(src.includes('email_skipped: coverage.sent === coverage.total ? "provider_refund_already_emailed" : "provider_refund_email_not_confirmed"'), '"already emailed" only when ALL are proven')
  assert(src.includes('refund_emails: coverage, refund_email_sentence: refundEmailSentence(coverage)'), 'per-refund coverage + the sentence in the response')
  const ui = await read('src/components/web-orders/MarkRefundIssuedDialog.tsx')
  assert(ui.includes('d.refund_email_sentence'), 'the dialog shows the edge sentence')
})

Deno.test('SQF06 rules: the two exception methods exist; the customer is told the payout, never "exception"', () => {
  eq([...EXCEPTION_METHODS], ['bank_transfer_exception', 'store_credit_exception'], 'methods')
  assert(isRefundMethod('bank_transfer_exception') && isRefundMethod('store_credit_exception'), 'accepted as refund methods')
  assert(isExceptionMethod('store_credit_exception') && !isExceptionMethod('card') && !isExceptionMethod(null), 'isExceptionMethod')
  eq(customerRefundMethod('bank_transfer_exception'), 'bank_transfer', 'bank transfer in the email')
  eq(customerRefundMethod('store_credit_exception'), 'store_credit', 'store credit in the email')
  eq(customerRefundMethod('card'), 'card', 'plain methods pass through')
  eq(customerRefundMethod('nope'), null, 'unknown → null')
  assert(REFUND_METHODS.length === 7, 'five plain + two exception methods')
})

Deno.test('SQF06 edge: admin check before the SQL, the evidence object forwarded as p_exception, the refusal codes mapped', async () => {
  const src = await code('supabase/functions/mark-refund-issued/index.ts')
  assert(src.includes('if (isExceptionMethod(method) && !(await isAdmin(supabase, ctx.user.id))) return jsonResponse({ error: "admin_only" }, 403);'), 'admin only')
  assert(src.includes('.from("user_roles").select("role").eq("user_id", userId)') && src.includes('.some((r) => r.role === "admin")'), 'reads user_roles')
  assert(src.includes('p_exception: exception,'), 'evidence reaches the SQL')
  assert(src.includes('refundMethod: customerRefundMethod(method),'), 'the email names the payout')
  for (const c of ['admin_only: 403', 'exception_not_triggered: 409', 'exception_evidence_required: 400', 'exception_over_cap: 409', 'exception_nothing_owed: 409', 'exception_lot_mismatch: 409']) assert(src.includes(c), `status ${c}`)
})

Deno.test('SQF06 email: the method line knows store credit', async () => {
  const tpl = await read('supabase/functions/_shared/email-templates/order-update.tsx')
  assert(tpl.includes("store_credit: 'ストアクレジット'") && tpl.includes("store_credit: 'store credit'"), 'JA + EN labels')
  assert(/export type RefundMethod = [^\n]*'store_credit'/.test(tpl), 'type')
})

Deno.test('SQF06 §8: "or reverse the Square refund" is gone from the bell preview and the migration says what to do', async () => {
  const bell = await read('supabase/functions/_shared/transactional-email-templates/staff-bell.tsx')
  assert(!bell.includes('reverse the Square refund'), 'preview')
  assert(bell.includes('void the UNSPENT store-credit lot the same day'), 'preview says what to do')
  const mig = await read('supabase/migrations/20261129100000_sqf02_square_refund_ledger.sql')
  assert(mig.includes("'new', $n$The customer is being paid back twice: void the UNSPENT store-credit lot"), 'record_square_refund patched')
  assert(mig.includes("card_refund_after_exception"), '§7 bell in the same patch')
  const docs = await read('docs/SQUARE.md')
  assert(!docs.includes('reverse the Square refund'), 'docs/SQUARE.md')
})

Deno.test('SQF06 Hub dialog (SQV03 two-step): exception offered to admins only while open; the cap is shown and enforced client-side too', async () => {
  const ui = await read('src/components/web-orders/MarkRefundIssuedDialog.tsx')
  assert(ui.includes("const exceptionOpen = isAdmin && (cardException(card) || !!approval);"), 'admin + trigger (or an open approval)')
  assert(ui.includes('export function cardException(') && ui.includes('f.failedRefunds.length > 0 || f.authorizedOverOneYear'), 'trigger = FAILED/REJECTED refund or authorised over one year (SQV04)')
  assert(ui.includes('export function exceptionCap(') && ui.includes('f.cardCaptured - f.refundedCompleted - f.creditIssued - (f.disputed ?? 0)'), 'cap = captured − completed refunds − credit issued − chargeback (QC F-02/F-17)')
  assert(ui.includes("square_support_ticket: excTicket.trim()") && ui.includes("action: 'approve'"), 'ticket sent with the approval')
  assert(ui.includes("bank_transfer_exception: 'bank transfer (Square exception)'"), 'shown as "bank transfer (Square exception)"')
})
