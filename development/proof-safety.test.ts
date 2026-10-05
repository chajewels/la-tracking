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
  // Hub staff dialogs: unsanitised customer names (spaces) and bulk-import folder
  assert(isAllowedProofUrl(ok('0b1c2d3e-0000-4000-8000-123456789abc/Myrna Tanaka_19144_M1_2026-06-15_abc.jpeg'), ctx))
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
