/**
 * NO CUSTOMER EMAIL IN FUNCTION LOGS (Lovable scan 2026-10-03, 31 findings).
 *
 * Every "<template> suppressed for <address>" line in an edge function logged
 * the full customer email address. The address belongs in email_send_log and
 * customers, not in retained diagnostics. maskEmail() (_shared/redact.ts)
 * keeps the first and last character and the domain; this test proves the
 * mask and fails if a `suppressed for ${…}` or `email to ${…}` interpolation
 * reappears anywhere under supabase/functions/ without maskEmail().
 *
 * Also guards the Google Sheets text cells (sheetText, _shared/sheets-text.ts):
 * a customer-typed value starting with = + - @ is written as text, never as a
 * formula (same rule as csvEscape in src/lib/csv.ts).
 *
 * Run: deno test --config development/deno.ci.json --allow-read --allow-env development/log-redaction.test.ts
 */
import { assertEquals } from 'jsr:@std/assert@1'
import { maskEmail } from '../supabase/functions/_shared/redact.ts'
import { sheetText } from '../supabase/functions/_shared/sheets-text.ts'

Deno.test('maskEmail keeps only first/last local character and the domain', () => {
  assertEquals(maskEmail('juan.delacruz@gmail.com'), 'j***z@gmail.com')
  assertEquals(maskEmail('ab@x.io'), 'a***@x.io')
  assertEquals(maskEmail('a@x.io'), 'a***@x.io')
  assertEquals(maskEmail(''), '(none)')
  assertEquals(maskEmail(null), '(none)')
  assertEquals(maskEmail(undefined), '(none)')
  assertEquals(maskEmail('  Maria.Santos@yahoo.com  '), 'M***s@yahoo.com')
  assertEquals(maskEmail('not-an-email'), 'n***l')
})

Deno.test('sheetText neutralises formula-leading text and leaves the rest alone', () => {
  assertEquals(sheetText('=HYPERLINK("x")'), "'=HYPERLINK(\"x\")")
  assertEquals(sheetText('+81 90 1234 5678'), "'+81 90 1234 5678")
  assertEquals(sheetText('-not a number'), "'-not a number")
  assertEquals(sheetText('@handle'), "'@handle")
  assertEquals(sheetText('\tTab'), "'\tTab")
  assertEquals(sheetText('Juan dela Cruz'), 'Juan dela Cruz')
  assertEquals(sheetText(null), '')
  assertEquals(sheetText(undefined), '')
})

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`
    if (e.isDirectory) yield* walk(p)
    else if (/\.(ts|tsx)$/.test(e.name)) yield p
  }
}

Deno.test('no edge function interpolates an unmasked email into a log line', async () => {
  const offenders: string[] = []
  const unmasked = /(suppressed for|email to) \$\{(?!maskEmail\()/
  for await (const f of walk('supabase/functions')) {
    const src = await Deno.readTextFile(f)
    src.split('\n').forEach((line, i) => {
      if (unmasked.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`)
    })
  }
  assertEquals(offenders, [])
})
