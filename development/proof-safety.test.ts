/**
 * PROOF SAFETY (payment lifecycle H11, qc-audit P1-1 / P2-4).
 *
 * 1. isAllowedProofUrl — only https://<our host>/storage/v1/object/(public|sign)/payment-proofs/<path>.
 * 2. acceptedProofType — upload-proof's allow-list + magic bytes.
 * 3. Source assertions (comments stripped): every proof_url writer calls the
 *    validator; submit-cash-payment's customer path refuses web cash orders;
 *    upload-proof never honours a client upsert.
 *
 * Run: deno test --config development/deno.ci.json --allow-read --allow-env development/proof-safety.test.ts
 */
import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  acceptedProofType,
  isAllowedProofUrl,
  sniffProofKind,
} from '../supabase/functions/_shared/proof-url.ts'

const HOST = 'abcdefghijklmnop.supabase.co'
const ctx = { host: HOST }
const ok = (p: string) => `https://${HOST}/storage/v1/object/public/payment-proofs/${p}`

Deno.test('accepts every live producer shape', () => {
  // upload-proof (portal + storefront)
  assert(isAllowedProofUrl(ok('0b1c2d3e-0000-4000-8000-123456789abc/web-1759700000000-slip.jpg'), ctx))
  assert(isAllowedProofUrl(ok('0b1c2d3e-0000-4000-8000-123456789abc/1759700000000_19144_Cash.png'), ctx))
  // Hub staff dialogs (getPublicUrl encodes with encodeURI) and bulk-import folder
  assert(isAllowedProofUrl(ok('0b1c2d3e-0000-4000-8000-123456789abc/Myrna%20Tanaka_19144_M1_2026-06-15_abc.jpeg'), ctx))
  // a raw space (one legacy row) is refused for NEW writes, like the DB guard
  assertEquals(isAllowedProofUrl(ok('0b1c2d3e-0000-4000-8000-123456789abc/Myrna Tanaka_19144.jpeg'), ctx), false)
  assertEquals(isAllowedProofUrl(ok('a/slip..jpg'), ctx), false)
  assert(isAllowedProofUrl(ok('bulk-import/batch-1/Staff_BulkImport_2026-10-01_x.jpg'), ctx))
  // legacy one-segment and "undefined" folder rows
  assert(isAllowedProofUrl(ok('12345_DP1_2026.jpg'), ctx))
  assert(isAllowedProofUrl(ok('undefined/file.jpg'), ctx))
  // signed form
  assert(isAllowedProofUrl(`https://${HOST}/storage/v1/object/sign/payment-proofs/a/b.jpg?token=x.y.z`, ctx))
  // host compare is case-insensitive; surrounding whitespace tolerated
  assert(isAllowedProofUrl(`  https://${HOST.toUpperCase()}/storage/v1/object/public/payment-proofs/a/b.pdf `, ctx))
})

Deno.test('refuses scripts, data and plain http', () => {
  assertEquals(isAllowedProofUrl('javascript:alert(1)//x.pdf', ctx), false)
  assertEquals(isAllowedProofUrl(' JavaScript:alert(1)', ctx), false)
  assertEquals(isAllowedProofUrl('data:text/html;base64,PHNjcmlwdD4=', ctx), false)
  assertEquals(isAllowedProofUrl(ok('a/b.jpg').replace('https://', 'http://'), ctx), false)
  assertEquals(isAllowedProofUrl('//' + HOST + '/storage/v1/object/public/payment-proofs/a/b.jpg', ctx), false)
})

Deno.test('refuses other hosts, lookalikes, credentials and ports', () => {
  assertEquals(isAllowedProofUrl('https://evil.example/storage/v1/object/public/payment-proofs/a/b.jpg', ctx), false)
  assertEquals(isAllowedProofUrl(`https://${HOST}.evil.example/storage/v1/object/public/payment-proofs/a/b.jpg`, ctx), false)
  assertEquals(isAllowedProofUrl(`https://other.supabase.co/storage/v1/object/public/payment-proofs/a/b.jpg`, ctx), false)
  assertEquals(isAllowedProofUrl(`https://user:pw@${HOST}/storage/v1/object/public/payment-proofs/a/b.jpg`, ctx), false)
  assertEquals(isAllowedProofUrl(`https://${HOST}:8443/storage/v1/object/public/payment-proofs/a/b.jpg`, ctx), false)
})

Deno.test('refuses other buckets, other storage routes and path traversal', () => {
  assertEquals(isAllowedProofUrl(`https://${HOST}/storage/v1/object/public/brand-assets/a/b.jpg`, ctx), false)
  assertEquals(isAllowedProofUrl(`https://${HOST}/storage/v1/object/authenticated/payment-proofs/a/b.jpg`, ctx), false)
  assertEquals(isAllowedProofUrl(`https://${HOST}/storage/v1/object/public/payment-proofs/`, ctx), false)
  assertEquals(isAllowedProofUrl(`https://${HOST}/storage/v1/object/public/payment-proofs/../brand-assets/x.html`, ctx), false)
  assertEquals(isAllowedProofUrl(`https://${HOST}/storage/v1/object/public/payment-proofs/%2e%2e/brand-assets/x.html`, ctx), false)
  assertEquals(isAllowedProofUrl(`https://${HOST}/storage/v1/object/public/payment-proofs/a%2f..%2fb.jpg`, ctx), false)
  assertEquals(isAllowedProofUrl(`https://${HOST}/storage/v1/object/public/payment-proofs/a//b.jpg`, ctx), false)
  assertEquals(isAllowedProofUrl(`https://${HOST}/storage/v1/object/public/payment-proofs/a\\b.jpg`, ctx), false)
  assertEquals(isAllowedProofUrl(`https://${HOST}/functions/v1/x?u=/storage/v1/object/public/payment-proofs/a.jpg`, ctx), false)
})

Deno.test('refuses non-strings, blanks, and a missing host (fails closed)', () => {
  assertEquals(isAllowedProofUrl(undefined, ctx), false)
  assertEquals(isAllowedProofUrl(42, ctx), false)
  assertEquals(isAllowedProofUrl('   ', ctx), false)
  assertEquals(isAllowedProofUrl(ok('a/b.jpg'), { host: '' }), false)
  assertEquals(isAllowedProofUrl(ok('a/b.jpg') + '\n', ctx), true) // trimmed
  assertEquals(isAllowedProofUrl(ok('a/\u0000b.jpg'), ctx), false)
})

const bytes = (...xs: (number | string)[]) => {
  const out: number[] = []
  for (const x of xs) {
    if (typeof x === 'number') out.push(x)
    else for (const c of x) out.push(c.charCodeAt(0))
  }
  while (out.length < 16) out.push(0)
  return new Uint8Array(out)
}
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0)
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
const PDF = bytes('%PDF-1.7')
const WEBP = bytes('RIFF', 0, 0, 0, 0, 'WEBP')
const HEIC = bytes(0, 0, 0, 0x18, 'ftypheic')
const HEIF = bytes(0, 0, 0, 0x18, 'ftypmif1')
const HTML = bytes('<html><script>')
const SVG = bytes('<svg xmlns=')
const GIF = bytes('GIF89a')

Deno.test('magic bytes: each allowed kind is recognised, others are not', () => {
  assertEquals(sniffProofKind(JPEG), 'jpeg')
  assertEquals(sniffProofKind(PNG), 'png')
  assertEquals(sniffProofKind(PDF), 'pdf')
  assertEquals(sniffProofKind(WEBP), 'webp')
  assertEquals(sniffProofKind(HEIC), 'heic')
  assertEquals(sniffProofKind(HEIF), 'heic')
  assertEquals(sniffProofKind(HTML), null)
  assertEquals(sniffProofKind(SVG), null)
  assertEquals(sniffProofKind(GIF), null)
  assertEquals(sniffProofKind(new Uint8Array([0xff, 0xd8])), null)
})

Deno.test('claimed type must be allowed and agree with the bytes', () => {
  assertEquals(acceptedProofType('image/jpeg', JPEG), 'image/jpeg')
  assertEquals(acceptedProofType('image/jpg', JPEG), 'image/jpeg')
  assertEquals(acceptedProofType('image/png', PNG), 'image/png')
  assertEquals(acceptedProofType('image/webp', WEBP), 'image/webp')
  assertEquals(acceptedProofType('image/heic', HEIC), 'image/heic')
  assertEquals(acceptedProofType('image/heif', HEIF), 'image/heic')
  assertEquals(acceptedProofType('application/pdf', PDF), 'application/pdf')
  // blank / octet-stream claims are judged by the bytes
  assertEquals(acceptedProofType('', HEIC), 'image/heic')
  assertEquals(acceptedProofType('application/octet-stream', JPEG), 'image/jpeg')
  // mismatches and disallowed types
  assertEquals(acceptedProofType('image/png', JPEG), null)
  assertEquals(acceptedProofType('text/html', HTML), null)
  assertEquals(acceptedProofType('image/jpeg', HTML), null)
  assertEquals(acceptedProofType('image/svg+xml', SVG), null)
  assertEquals(acceptedProofType('text/html', JPEG), null)
  assertEquals(acceptedProofType('image/gif', GIF), null)
  assertEquals(acceptedProofType('', HTML), null)
})

// ── source assertions ──────────────────────────────────────────────────────
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
const src = (f: string) => strip(Deno.readTextFileSync(new URL(`../supabase/functions/${f}`, import.meta.url)))

const WRITERS = [
  'submit-cash-payment/index.ts',
  'submit-payment/index.ts',
  'record-payment/index.ts',
  'record-multi-payment/index.ts',
  'edit-payment-submission/index.ts',
  'website/index.ts',
]

for (const f of WRITERS) {
  Deno.test(`${f} validates proof_url with the shared validator`, () => {
    const s = src(f)
    assert(/import \{[^}]*isOwnProofUrl[^}]*\} from "\.\.\/_shared\/proof-url\.ts"/.test(s), `${f}: import missing`)
    assert(/isOwnProofUrl\(/.test(s), `${f}: call missing`)
    assert(/invalid_proof_url|INVALID_PROOF_URL/.test(s), `${f}: refusal missing`)
  })
}

Deno.test('submit-cash-payment customer path refuses web cash orders', () => {
  const s = src('submit-cash-payment/index.ts')
  assert(/"web_order_staff_only"/.test(s))
  assert(/source_channel === "web"/.test(s))
})

Deno.test('upload-proof ignores upsert and checks the file', () => {
  const s = src('upload-proof/index.ts')
  assertEquals(/form\.get\("upsert"\)/.test(s), false)
  assert(/upsert: false/.test(s))
  assert(/acceptedProofType\(/.test(s))
  assert(/"unsupported_file"/.test(s))
})

// ── H11 fix round 1 (R15): migration source assertions (SQL comments stripped) ──
const sql = Deno.readTextFileSync(new URL('../supabase/migrations/20261111100000_payment_lifecycle.sql', import.meta.url))
  .split('\n').map((l) => l.replace(/--.*$/, '')).join('\n')

Deno.test('migration: INSERT policy recreated staff-only, customer UPDATE policy dropped', () => {
  assert(/DROP POLICY IF EXISTS "Authenticated users can insert submissions" ON public\.payment_submissions;/.test(sql))
  const create = /CREATE POLICY "Authenticated users can insert submissions" ON public\.payment_submissions\s+FOR INSERT TO authenticated\s+WITH CHECK \(\(SELECT public\.is_staff\(\(SELECT auth\.uid\(\)\)\)\)\);/
  assert(create.test(sql), 'staff-only INSERT policy missing')
  assert(/DROP POLICY IF EXISTS "Session customers can cancel own cash order submissions" ON public\.payment_submissions;/.test(sql))
  // no policy text in this migration grants a customer branch
  assertEquals(/CREATE POLICY[^;]*auth_user_id/.test(sql), false)
})

Deno.test('migration: proof-link trigger is pinned, revoked and checked', () => {
  assert(/CREATE OR REPLACE FUNCTION public\.guard_payment_submission_proof_url\(\)\s+RETURNS trigger\s+LANGUAGE plpgsql\s+SET search_path = public/.test(sql))
  assert(sql.includes(String.raw`'^https://pfoicalpzdcmyxzvwyhz\.supabase\.co/storage/v1/object/(public|sign)/payment-proofs/[^/?#]'`))
  assert(/position\('\.\.' IN NEW\.proof_url\) > 0/.test(sql))
  assert(sql.includes(String.raw`NEW.proof_url ~ '[[:space:][:cntrl:]\\]'`))
  assert(/TG_OP = 'INSERT' OR NEW\.proof_url IS DISTINCT FROM OLD\.proof_url/.test(sql))
  assert(/RAISE EXCEPTION 'invalid_proof_url'\s+USING ERRCODE = 'check_violation'/.test(sql))
  assert(/REVOKE ALL ON FUNCTION public\.guard_payment_submission_proof_url\(\) FROM PUBLIC, anon, authenticated;/.test(sql))
  assert(/CREATE TRIGGER trg_guard_payment_submission_proof_url\s+BEFORE INSERT OR UPDATE OF proof_url ON public\.payment_submissions\s+FOR EACH ROW EXECUTE FUNCTION public\.guard_payment_submission_proof_url\(\);/.test(sql))
  // post-checks
  assert(/tgname = 'trg_guard_payment_submission_proof_url'/.test(sql))
  assert(/proconfig @> ARRAY\['search_path=public'\]/.test(sql))
  assert(/a customer branch still allows writes to payment_submissions/.test(sql))
  // the trigger must not touch existing rows
  assertEquals(/UPDATE public\.payment_submissions/.test(sql), false)
})

Deno.test('edge twin agrees with the DB guard on the character rules', () => {
  assertEquals(isAllowedProofUrl(ok('a/b c.jpg'), ctx), false)
  assertEquals(isAllowedProofUrl(ok('a/slip..jpg'), ctx), false)
  assertEquals(isAllowedProofUrl(ok('a/%2E%2E/b.jpg'), ctx), false)
  assertEquals(isAllowedProofUrl(ok('a/%5cb.jpg'), ctx), false)
  assertEquals(isAllowedProofUrl(ok('a/b%20c.jpg'), ctx), true)
})

Deno.test('submit-payment stores the trimmed proof_url', () => {
  assert(/proof_url: proof_url\.trim\(\),/.test(src('submit-payment/index.ts')))
})
