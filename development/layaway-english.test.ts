/**
 * LAYAWAY EMAILS ARE ENGLISH ONLY — SUBJECT AND BODY (owner rule, 2026-09-27).
 *
 * The owner's inbox showed layaway emails with Japanese subjects and bodies
 * (「ご契約終了のお知らせ CJ-W-900013 / Layaway plan closed」, 「分割予約を承りました
 * … Layaway reserved」, 「お取り置き期限のご案内 … Layaway hold released」). Every
 * layaway template now has no `lang` prop and no Japanese copy. This file
 * renders every layaway email (every variant, yen and peso, HTML and plain
 * text) and every layaway subject, and fails on any Japanese character.
 *
 * Transfer-account DETAILS (bank name, branch, account holder) are the
 * business's stored data, printed verbatim so the customer can transfer; they
 * are not copy. They are rendered here in Japanese and stripped before the
 * check, so the test proves the Japanese can come from nowhere else — not the
 * method's label_ja / note_ja, not a date, not a word.
 *
 * The one other exception is the REGISTERED company name in the footer
 * (COMPANY_NAME, the full-width registered name, owner acceptance 2026-09-24) —
 * a legal name in every customer email, not layaway copy (the same exception
 * docs/WEB-PAYMENT-REMINDERS.md records for the deposit reminder).
 *
 * Run: deno test --config development/deno.ci.json --allow-read --allow-env development/layaway-english.test.ts
 */
import * as React from 'npm:react@18.3.1'
import { renderEmail } from '../supabase/functions/_shared/render-email.ts'
import { COMPANY_NAME } from '../supabase/functions/_shared/transactional-email-templates/brand.ts'
import { LayawayPlanCreatedEmail, layawayPlanCreatedSubject, layawayReadySubject } from '../supabase/functions/_shared/email-templates/layaway-plan-created.tsx'
import { LayawayReservedEmail, layawayReservedSubject } from '../supabase/functions/_shared/email-templates/layaway-reserved.tsx'
import { LayawayDeclinedEmail, layawayDeclinedSubject } from '../supabase/functions/_shared/email-templates/layaway-declined.tsx'
import { LayawayDepositDueEmail, layawayDepositDueSubject } from '../supabase/functions/_shared/email-templates/layaway-deposit-due.tsx'
import { LayawayExpiredEmail, layawayExpiredSubject } from '../supabase/functions/_shared/email-templates/layaway-expired.tsx'
import { LayawayForfeitedEmail, layawayForfeitedSubject } from '../supabase/functions/_shared/email-templates/layaway-forfeited.tsx'
import { LayawayPaymentReceivedEmail, layawayPaymentReceivedSubject } from '../supabase/functions/_shared/email-templates/layaway-payment-received.tsx'

/** Hiragana, katakana, CJK ideographs, CJK punctuation, full-width forms. */
const JAPANESE = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/

// Stored account details — data, printed verbatim (see the header).
const BANK_DATA = ['三菱UFJ銀行', '立石支店 (123)', '普通', 'カ）チャジュエルズ']
const methods = [
  {
    id: 'bank', method_type: 'bank', label_ja: '銀行振込', label_en: 'Bank transfer',
    bank: { name: BANK_DATA[0], branch: BANK_DATA[1], account_type: BANK_DATA[2], account_number: '1234567', account_holder: BANK_DATA[3] },
    wallet: null, note_ja: '振込手数料はお客様のご負担となります。', note_en: 'Transfer fees are paid by the customer.',
  },
  {
    id: 'gcash', method_type: 'gcash', label_ja: 'GCash（ジーキャッシュ）', label_en: 'GCash',
    bank: null, wallet: { number: '0917 123 4567', name: 'Cha Jewels' }, note_ja: 'お名前をご記入ください', note_en: null,
  },
]
const schedule = [
  { installment_number: 1, due_date: '2026-10-24', amount: 28000, paid: true },
  { installment_number: 2, due_date: '2026-11-24', amount: 28000 },
  { installment_number: 3, due_date: '2026-12-24', amount: 28000 },
]
const due = '2026-09-27T05:00:00.000Z'
const planUrl = 'https://www.chajewelsjp.com/account/layaway/x'
const shopUrl = 'https://www.chajewelsjp.com'
const ref = 'CJ-W-900013'
// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- templates take heterogeneous props
const el = (c: React.ComponentType<any>, p: Record<string, unknown>) => React.createElement(c, p)

type Case = { file: string; name: string; subject: string; element: React.ReactElement }

function cases(): Case[] {
  const out: Case[] = []
  for (const currency of ['JPY', 'PHP'] as const) {
    const plan = { reference: ref, currency, totalAmount: 120000, deposit: 36000, termMonths: 3 }
    for (const region of ['JP', 'OVERSEAS'] as const) {
      for (const variant of ['placed', 'ready'] as const)
        out.push({ file: 'layaway-plan-created.tsx', name: `plan-created ${currency} ${region} ${variant}`, subject: variant === 'ready' ? layawayReadySubject(ref) : layawayPlanCreatedSubject(ref), element: el(LayawayPlanCreatedEmail, { ...plan, schedule, methods, transferDueAt: due, region, planUrl, variant }) })
      out.push({ file: 'layaway-deposit-due.tsx', name: `deposit-due ${currency} ${region}`, subject: layawayDepositDueSubject(ref), element: el(LayawayDepositDueEmail, { reference: ref, currency, deposit: 36000, methods, transferDueAt: due, region, planUrl }) })
      for (const transferDueAt of [due, null])
        out.push({ file: 'layaway-expired.tsx', name: `expired ${currency} ${region} due=${!!transferDueAt}`, subject: layawayExpiredSubject(ref), element: el(LayawayExpiredEmail, { reference: ref, currency, totalAmount: 120000, deposit: 36000, transferDueAt, region, shopUrl }) })
    }
    out.push({ file: 'layaway-reserved.tsx', name: `reserved ${currency}`, subject: layawayReservedSubject(ref), element: el(LayawayReservedEmail, { ...plan, planUrl }) })
    for (const isDeposit of [true, false])
      for (const last of [false, true])
        out.push({ file: 'layaway-payment-received.tsx', name: `payment-received ${currency} deposit=${isDeposit} paidInFull=${last}`, subject: layawayPaymentReceivedSubject(ref, isDeposit), element: el(LayawayPaymentReceivedEmail, { reference: ref, currency, isDeposit, amountReceived: 36000, remaining: last ? 0 : 84000, schedule, nextDueDate: last ? null : '2026-11-24', nextDueAmount: last ? null : 28000, planUrl }) })
    for (const final of [false, true])
      out.push({ file: 'layaway-forfeited.tsx', name: `forfeited ${currency} final=${final}`, subject: layawayForfeitedSubject(ref), element: el(LayawayForfeitedEmail, { reference: ref, currency, totalAmount: 120000, totalPaid: 36000, planUrl, final }) })
  }
  for (const kind of ['declined', 'lapsed'] as const)
    out.push({ file: 'layaway-declined.tsx', name: `declined ${kind}`, subject: layawayDeclinedSubject(ref, kind), element: el(LayawayDeclinedEmail, { reference: ref, kind, reason: 'The piece did not pass our final inspection.', shopUrl }) })
  return out
}

const CASES = cases()
const withoutBankData = (s: string) => [...BANK_DATA, COMPANY_NAME].reduce((acc, d) => acc.split(d).join(''), s)
const TEMPLATE_DIR = new URL('../supabase/functions/_shared/email-templates/', import.meta.url)

Deno.test('no layaway email subject contains Japanese', () => {
  const bad = CASES.filter((c) => JAPANESE.test(c.subject)).map((c) => `${c.name}: ${c.subject}`)
  if (bad.length) throw new Error(`Japanese in layaway subjects:\n${bad.join('\n')}`)
})

Deno.test('no layaway email body contains Japanese (HTML and plain text; stored account details excepted)', async () => {
  const bad: string[] = []
  for (const c of CASES) {
    const html = await renderEmail(c.element)
    const text = await renderEmail(c.element, { plainText: true })
    for (const [kind, out] of [['html', html], ['text', text]] as const) {
      const m = withoutBankData(out).match(JAPANESE)
      if (m) bad.push(`${c.name} (${kind}): …${withoutBankData(out).slice(Math.max(0, m.index! - 20), m.index! + 20)}…`)
    }
    if (!/<html[^>]*\blang="en"/.test(html)) bad.push(`${c.name}: <html> is not lang="en"`)
  }
  if (bad.length) throw new Error(`Japanese in ${bad.length} layaway emails:\n${bad.join('\n')}`)
})

Deno.test('every layaway template file is covered here, and none holds a Japanese character', async () => {
  const covered = new Set(CASES.map((c) => c.file))
  const problems: string[] = []
  for await (const e of Deno.readDir(TEMPLATE_DIR)) {
    if (!/^layaway-.*\.tsx$/.test(e.name)) continue
    const src = await Deno.readTextFile(new URL(e.name, TEMPLATE_DIR))
    if (JAPANESE.test(src)) problems.push(`${e.name}: Japanese character in source`)
    if (/\blang\s*[?]?:\s*Lang\b/.test(src)) problems.push(`${e.name}: has a lang: Lang prop`)
    if (e.name !== 'layaway-shared.tsx' && !covered.has(e.name)) problems.push(`${e.name}: no case in this test`)
  }
  if (problems.length) throw new Error(problems.join('\n'))
})

Deno.test('no function passes a lang to a layaway email', async () => {
  const root = new URL('../supabase/functions/', import.meta.url)
  const offenders: string[] = []
  const walk = async (dir: URL, rel: string) => {
    for await (const e of Deno.readDir(dir)) {
      if (e.name === 'node_modules') continue
      if (e.isDirectory) await walk(new URL(`${e.name}/`, dir), `${rel}${e.name}/`)
      else if (/\.(ts|tsx)$/.test(e.name)) {
        const src = await Deno.readTextFile(new URL(e.name, dir))
        for (const m of src.matchAll(/createElement\(Layaway\w+Email,\s*\{([^}]*)\}/g))
          if (/\blang\b/.test(m[1])) offenders.push(`${rel}${e.name}`)
      }
    }
  }
  await walk(root, '')
  if (offenders.length) throw new Error(`lang passed to a layaway email in: ${offenders.join(', ')}`)
})
