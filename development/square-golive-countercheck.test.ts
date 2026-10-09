/**
 * SQUARE GO-LIVE COUNTER-CHECK FIXES (2026-10-09 evening).
 * Project doc: claude/square-golive-countercheck-2026-10-09-evening.md
 *
 *   DOC-7   the production preflight passes only when Square has activated the location for
 *           card payments (LocationCapability CREDIT_CARD_PROCESSING).
 *   CODE-M1 a capture refused because the card network holds or took the money back
 *           (card_disputed) becomes a person's case, never a silent retry.
 *   CODE-M2 the "payment not accepted" email never says "pay by <past date>" / "pay again".
 *   DOC-5   a webhook whose signature does not verify gets 403 (Square's documented answer).
 *   L1      record_square_dispute locks the order first (migration 20261130180000).
 *
 * Run: deno test --config development/deno.ci.json --allow-read --allow-env development/square-golive-countercheck.test.ts
 */
import { locationUsable, preflightPassed } from '../supabase/functions/_shared/square-preflight-rules.ts'

const assert = (ok: unknown, msg: string) => { if (!ok) throw new Error(msg) }
const code = (p: string) => Deno.readTextFileSync(new URL(p, import.meta.url))
/** Code only: comment lines removed, so an assertion never matches an explanation. */
const codeOnly = (p: string) => code(p).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|--)/.test(l)).join('\n')

Deno.test('DOC-7: an ACTIVE yen location in Japan passes only once Square activated it for cards', () => {
  assert(locationUsable({ status: 'ACTIVE', currency: 'JPY', country: 'JP', card_processing: true }), 'activated passes')
  assert(!locationUsable({ status: 'ACTIVE', currency: 'JPY', country: 'JP', card_processing: false }), 'not activated fails')
  assert(!locationUsable({ status: 'ACTIVE', currency: 'JPY', country: 'JP', card_processing: null }), 'unknown fails')
  const base = {
    environment: 'production' as const, token: { state: 'ok' as const, status: 200, code: null, secret: 'SQUARE_PRODUCTION_ACCESS_TOKEN' },
    locations: ['L1'], location_configured: 'L1', location_match: true, app_id_family: 'production' as const,
    events: { state: 'ok' as const, status: 200, code: null, first_page: 0, window_days: 28 }, webhook_key: true,
  }
  assert(preflightPassed({ ...base, location: { status: 'ACTIVE', currency: 'JPY', country: 'JP', card_processing: true } }), 'all ok passes')
  assert(!preflightPassed({ ...base, location: { status: 'ACTIVE', currency: 'JPY', country: 'JP', card_processing: false } }), 'not activated never passes')
})

Deno.test('DOC-7 edge: the preflight reads the location capabilities from ListLocations', () => {
  const src = codeOnly('../supabase/functions/square-preflight/index.ts')
  assert(src.includes('card_processing: Array.isArray(mine.capabilities)'), 'capabilities read')
  assert(src.includes('.includes("CREDIT_CARD_PROCESSING")'), 'the documented capability name')
  assert(codeOnly('../supabase/functions/_shared/square.ts').includes('capabilities?: unknown }>(json, "locations")'), 'typed in listLocations')
})

Deno.test('CODE-M1 edge: card_disputed after a capture is a tracked case, not "Finish recording"', () => {
  const src = codeOnly('../supabase/functions/review-payment-submission/index.ts')
  assert(src.includes('const cannotTake = refunded || ["card_disputed", "order_closed"'), 'card_disputed is a cannot-take refusal')
  assert(src.includes('const disputed = code === "card_disputed";'), 'card_disputed has its own branch')
  assert(src.includes('Do NOT refund it in the Square Dashboard'), 'the chargeback bell never tells staff to refund (double-return risk)')
})

Deno.test('CODE-M1 / L1 migration: md5-guarded patches from live, self-checked', () => {
  const m = code('../supabase/migrations/20261130180000_square_golive_countercheck.sql')
  assert(m.includes("pg_temp.cj_patch('public.finalize_cash_submission_atomic(uuid,uuid,text,date,text)', 'fcb5598404a34fe02d01508b5a7363fd'"), 'finalize guarded by its live md5')
  assert(m.includes("pg_temp.cj_patch('public.decide_square_case(text,uuid,text,text)', 'bc2b1a76fb561a39b5f80200b17e2d3d'"), 'decide guarded by its live md5')
  assert(m.includes("'bfc43e9c9555f3e0053e9d747e34f3fb'"), 'record_square_dispute guarded by its live md5')
  assert(m.includes("IF public.square_order_disputed_jpy(v_order.id) > 0 THEN\n      RETURN jsonb_build_object('error', 'card_disputed'"), 'finalize refuses')
  assert(m.includes("ELSIF public.square_order_disputed_jpy(v_order.id) > 0 THEN\n        v_err := 'card_disputed';"), 'decide refuses')
  assert(m.includes('FROM public.cash_orders WHERE id = v_sq.cash_order_id FOR UPDATE;'), 'dispute locks the order')
  for (const block of m.split("jsonb_build_object('old', ").slice(1)) {
    const text = block.split('));')[0]
    assert(!/^\s*--/m.test(text), 'no comment line inside a patch (Lovable drops them)')
  }
})

Deno.test('DOC-5: a bad webhook signature gets 403', () => {
  const src = codeOnly('../supabase/functions/square-webhook/index.ts')
  assert(src.includes('if (!ok) return jsonResponse({ error: "bad_signature" }, 403);'), '403')
  assert(!src.includes('"bad_signature" }, 401'), 'no 401 left')
})
