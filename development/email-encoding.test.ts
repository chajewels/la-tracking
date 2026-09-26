/**
 * EMAIL ENCODING GUARD (2026-09-26, docs/FIXED-BUGS.md "Japanese emails
 * garbled by renderAsync").
 *
 * Renders EVERY email template the edge functions can send — storefront
 * (JA and EN, yen and peso, every variant), layaway, loyalty level, auth, the
 * Hub transactional registry and the newsletter — through the one shared
 * renderer (_shared/render-email.ts), as HTML AND plain text, and fails if any
 * output carries U+FFFD or UTF-8-read-as-Latin-1 mojibake.
 *
 * Also fails if any file under supabase/functions imports renderAsync again,
 * and if a template file is added without a fixture here.
 *
 * Lives OUTSIDE supabase/functions/ so the edge runtime never bundles it.
 * Run: deno test --config development/deno.ci.json --allow-read --allow-env development/email-encoding.test.ts
 */
import * as React from 'npm:react@18.3.1'
import { renderEmail } from '../supabase/functions/_shared/render-email.ts'

import { OrderReservedEmail } from '../supabase/functions/_shared/email-templates/order-reserved.tsx'
import { OrderConfirmationEmail } from '../supabase/functions/_shared/email-templates/order-confirmation.tsx'
import { OrderCancelledEmail } from '../supabase/functions/_shared/email-templates/order-cancelled.tsx'
import { OrderExpiredEmail } from '../supabase/functions/_shared/email-templates/order-expired.tsx'
import { OrderPaymentDueEmail } from '../supabase/functions/_shared/email-templates/order-payment-due.tsx'
import { OrderPaymentReceivedEmail } from '../supabase/functions/_shared/email-templates/order-payment-received.tsx'
import { OrderReservationLapsedEmail } from '../supabase/functions/_shared/email-templates/order-reservation-lapsed.tsx'
import { LayawayReservedEmail } from '../supabase/functions/_shared/email-templates/layaway-reserved.tsx'
import { LayawayPlanCreatedEmail } from '../supabase/functions/_shared/email-templates/layaway-plan-created.tsx'
import { LayawayDeclinedEmail } from '../supabase/functions/_shared/email-templates/layaway-declined.tsx'
import { LayawayDepositDueEmail } from '../supabase/functions/_shared/email-templates/layaway-deposit-due.tsx'
import { LayawayExpiredEmail } from '../supabase/functions/_shared/email-templates/layaway-expired.tsx'
import { LayawayForfeitedEmail } from '../supabase/functions/_shared/email-templates/layaway-forfeited.tsx'
import { LayawayPaymentReceivedEmail } from '../supabase/functions/_shared/email-templates/layaway-payment-received.tsx'
import { LevelWarningEmail, LevelStepdownEmail, LevelRestoredEmail } from '../supabase/functions/_shared/email-templates/loyalty-level.tsx'
import { StorefrontMagicLinkEmail } from '../supabase/functions/_shared/email-templates/storefront-magic-link.tsx'
import { SignupEmail } from '../supabase/functions/_shared/email-templates/signup.tsx'
import { InviteEmail } from '../supabase/functions/_shared/email-templates/invite.tsx'
import { MagicLinkEmail } from '../supabase/functions/_shared/email-templates/magic-link.tsx'
import { RecoveryEmail } from '../supabase/functions/_shared/email-templates/recovery.tsx'
import { EmailChangeEmail } from '../supabase/functions/_shared/email-templates/email-change.tsx'
import { ReauthenticationEmail } from '../supabase/functions/_shared/email-templates/reauthentication.tsx'
import { NewsletterCampaignEmail } from '../supabase/functions/_shared/transactional-email-templates/newsletter-campaign.tsx'
import { TEMPLATES } from '../supabase/functions/_shared/transactional-email-templates/registry.ts'
import { STOREFRONT_PREVIEWS } from '../supabase/functions/_shared/email-templates/preview-registry.ts'

type Fixture = { name: string; file: string; element: React.ReactElement }

const LANGS = ['ja', 'en'] as const
const CURRENCIES = ['JPY', 'PHP'] as const

const items = [
  { title: 'Pearl drop earrings', title_ja: 'パールドロップピアス', qty: 1, line_total_jpy: 68000 },
  { title: 'Akoya pearl necklace 18K', title_ja: 'アコヤ真珠ネックレス 18金 ・ 長さ45cm', qty: 2, line_total_jpy: 245000 },
]
const methods = [
  {
    id: 'bank', method_type: 'bank', label_ja: '銀行振込', label_en: 'Bank transfer',
    bank: { name: '三菱UFJ銀行', branch: '立石支店 (123)', account_type: '普通', account_number: '1234567', account_holder: 'カ）チャジュエルズ' },
    wallet: null, note_ja: '振込手数料はお客様のご負担となります。', note_en: 'Transfer fees are paid by the customer.',
  },
  {
    id: 'gcash', method_type: 'wallet', label_ja: 'GCash', label_en: 'GCash',
    bank: null, wallet: { provider: 'GCash', account_name: 'Cha Jewels', account_number: '0917 123 4567' },
    note_ja: null, note_en: null,
  },
]
const schedule = [
  { installment_number: 1, due_date: '2026-10-24', amount: 28000 },
  { installment_number: 2, due_date: '2026-11-24', amount: 28000 },
  { installment_number: 3, due_date: '2026-12-24', amount: 28000 },
]
const due = '2026-09-27T05:00:00.000Z'
const orderUrl = 'https://www.chajewelsjp.com/account/orders/preview'
const planUrl = 'https://www.chajewelsjp.com/account/layaway/preview'
const shopUrl = 'https://www.chajewelsjp.com'
const base = { reference: 'CJ-W-000123', items, shippingJpy: 4980, totalJpy: 317980 }
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- templates take heterogeneous props
const el = (c: React.ComponentType<any>, p: Record<string, unknown>) => React.createElement(c, p)
const T = '_shared/email-templates/'

function storefrontFixtures(): Fixture[] {
  const out: Fixture[] = []
  const add = (file: string, name: string, element: React.ReactElement) => out.push({ file: T + file, name, element })
  for (const lang of LANGS) {
    for (const currency of CURRENCIES) {
      const k = `${lang}-${currency}`
      add('order-reserved.tsx', `order-reserved ${k}`, el(OrderReservedEmail, { lang, currency, ...base, orderUrl }))
      for (const variant of ['placed', 'ready'])
        for (const region of ['JP', 'OVERSEAS'])
          add('order-confirmation.tsx', `order-confirmation ${k} ${variant} ${region}`, el(OrderConfirmationEmail, { lang, currency, ...base, methods, transferDueAt: due, region, orderUrl, variant }))
      for (const refundStatus of [null, 'refund_issued', 'refund_pending', 'store_credit_issued', 'no_refund'])
        add('order-cancelled.tsx', `order-cancelled ${k} ${refundStatus}`, el(OrderCancelledEmail, { lang, currency, ...base, reason: '最終検品で基準を満たさなかったため / did not pass final inspection', refundStatus, refundNote: refundStatus ? '返金は3営業日以内に反映されます。' : null, orderUrl }))
      add('order-expired.tsx', `order-expired ${k}`, el(OrderExpiredEmail, { lang, currency, ...base, transferDueAt: due, region: 'JP', shopUrl }))
      add('order-payment-due.tsx', `order-payment-due ${k}`, el(OrderPaymentDueEmail, { lang, currency, reference: base.reference, amount: 317980, methods, transferDueAt: due, region: currency === 'PHP' ? 'OVERSEAS' : 'JP', orderUrl }))
      add('order-payment-received.tsx', `order-payment-received ${k}`, el(OrderPaymentReceivedEmail, { lang, currency, ...base, amountReceivedJpy: 317980, orderUrl }))
      add('order-reservation-lapsed.tsx', `order-reservation-lapsed ${k}`, el(OrderReservationLapsedEmail, { lang, currency, ...base, shopUrl }))
      // Layaway: English only (no lang prop); currency is the plan's.
      const plan = { reference: 'CJ-W-000124', currency, totalAmount: 120000, deposit: 36000, termMonths: 3 }
      for (const variant of ['placed', 'ready'])
        add('layaway-plan-created.tsx', `layaway-plan-created ${k} ${variant}`, el(LayawayPlanCreatedEmail, { ...plan, schedule, methods, transferDueAt: due, region: 'JP', planUrl, variant }))
      for (const isDeposit of [true, false])
        add('layaway-payment-received.tsx', `layaway-payment-received ${k} deposit=${isDeposit}`, el(LayawayPaymentReceivedEmail, { reference: plan.reference, currency, isDeposit, amountReceived: 36000, remaining: 84000, schedule, nextDueDate: '2026-10-24', nextDueAmount: 28000, planUrl }))
      for (const final of [false, true])
        add('layaway-forfeited.tsx', `layaway-forfeited ${k} final=${final}`, el(LayawayForfeitedEmail, { reference: plan.reference, currency, totalAmount: 120000, totalPaid: 36000, planUrl, final }))
      add('layaway-expired.tsx', `layaway-expired ${k}`, el(LayawayExpiredEmail, { reference: plan.reference, currency, totalAmount: 120000, deposit: 36000, transferDueAt: due, region: 'JP', shopUrl }))
      if (lang === 'en') {
        add('layaway-reserved.tsx', `layaway-reserved ${currency}`, el(LayawayReservedEmail, { ...plan, planUrl }))
        for (const kind of ['declined', 'lapsed'])
          add('layaway-declined.tsx', `layaway-declined ${currency} ${kind}`, el(LayawayDeclinedEmail, { reference: plan.reference, kind, reason: 'The piece did not pass our final inspection.', shopUrl }))
        add('layaway-deposit-due.tsx', `layaway-deposit-due ${currency}`, el(LayawayDepositDueEmail, { reference: plan.reference, currency, deposit: 36000, methods, transferDueAt: due, region: 'JP', planUrl }))
      }
    }
  }
  // Loyalty level emails are bilingual in one body (JA then EN).
  add('loyalty-level.tsx', 'loyalty-level warning', el(LevelWarningEmail, { customerName: '山田 花子', currentLevel: 'Radiant', nextLowerLevel: 'Glimmer', stepDownAt: new Date('2026-12-01T00:00:00Z'), daysLeft: 30, points: 1200, portalUrl: shopUrl }))
  add('loyalty-level.tsx', 'loyalty-level stepdown', el(LevelStepdownEmail, { customerName: '山田 花子', oldLevel: 'Radiant', newLevel: 'Glimmer', earnedLevel: 'Radiant', regainJpy: 150000, portalUrl: shopUrl }))
  add('loyalty-level.tsx', 'loyalty-level restored', el(LevelRestoredEmail, { customerName: '山田 花子', oldLevel: 'Glimmer', newLevel: 'Radiant', multiplier: 2, points: 1200, portalUrl: shopUrl }))
  // Auth (auth-email-hook).
  const site = { siteName: 'Cha Jewels', siteUrl: shopUrl, confirmationUrl: `${shopUrl}/auth/confirm?token=abc` }
  add('storefront-magic-link.tsx', 'storefront-magic-link', el(StorefrontMagicLinkEmail, { confirmationUrl: site.confirmationUrl }))
  add('signup.tsx', 'signup', el(SignupEmail, { ...site, recipient: 'hanako@example.com' }))
  add('invite.tsx', 'invite', el(InviteEmail, site))
  add('magic-link.tsx', 'magic-link', el(MagicLinkEmail, site))
  add('recovery.tsx', 'recovery', el(RecoveryEmail, site))
  add('email-change.tsx', 'email-change', el(EmailChangeEmail, { ...site, oldEmail: 'a@example.com', email: 'a@example.com', newEmail: 'b@example.com' }))
  add('reauthentication.tsx', 'reauthentication', el(ReauthenticationEmail, { token: '123456' }))
  return out
}

function hubFixtures(): Fixture[] {
  const out: Fixture[] = []
  // Registry entries without previewData get their props here.
  const extraProps: Record<string, Record<string, unknown>> = {
    'portal-setup-invite': { customerName: 'Maria Santos', setupUrl: 'https://portal.chajewelsjp.com/portal/setup?token=demo', customerEmail: 'maria@example.com', customerPin: '4567' },
  }
  for (const [name, entry] of Object.entries(TEMPLATES)) {
    const props = entry.previewData ?? extraProps[name]
    if (!props) throw new Error(`registry template ${name} has no previewData — add props to extraProps so it can be checked`)
    // Aliases (e.g. payment-grace-period reuses payment-reminder.tsx) have no file of their own.
    out.push({ name: `hub ${name}`, file: `_shared/transactional-email-templates/${name}.tsx`, element: el(entry.component, props) })
  }
  // Newsletter in Japanese: a long body is exactly what crossed chunk boundaries.
  const bodyJa = '## 今月のCha Jewels\n\n東京で一点ずつ仕上げた**パール**の新作が3点入荷しました。\n\n- アコヤ真珠のスタッドピアス\n- 18金チェーン 45cm\n- 一点物のダイヤモンドペンダント\n\n詳しくは[ジャーナル](https://chajewelsjp.com/journal)をご覧ください。'.repeat(6)
  const products = [1, 2, 3].map((i) => ({ title: `パールピアス ${i}`, url: `${shopUrl}/p/${i}`, image_url: `${shopUrl}/i/${i}.jpg`, price_label: '¥68,000 / ₱26,000' }))
  for (const lang of LANGS)
    out.push({ name: `hub newsletter-campaign ${lang}`, file: '_shared/transactional-email-templates/newsletter-campaign.tsx', element: el(NewsletterCampaignEmail, { subject: lang === 'ja' ? '9月の新作' : 'New arrivals', lang, bodyMarkdown: lang === 'ja' ? bodyJa : 'Three new **pearl** pieces — ¥68,000 / ₱26,000 🧡', unsubscribeUrl: `${shopUrl}/newsletter/unsubscribe?token=demo`, products, post: null }) })
  return out
}

export const FIXTURES: Fixture[] = [
  ...storefrontFixtures(),
  ...Object.entries(STOREFRONT_PREVIEWS).map(([name, p]) => ({ name: `preview ${name}`, file: 'preview-registry', element: el(p.component, p.previewData) })),
  ...hubFixtures(),
]

// U+FFFD itself, and the byte signatures of UTF-8 decoded as Latin-1 / Windows-1252.
const ch = (n: number) => String.fromCharCode(n)
const range = (a: number, b: number) => `[${ch(a)}-${ch(b)}]`
export const BAD = new RegExp([
  ch(0xfffd), // U+FFFD itself
  ch(0xef) + ch(0xbf) + ch(0xbd), // U+FFFD's UTF-8 bytes read as Latin-1
  ch(0xc3) + range(0x80, 0xbf), // e.g. an accented Latin letter read as Latin-1
  ch(0xe2) + ch(0x20ac) + `(?:${range(0x80, 0xbf)}|${range(0x2018, 0x201e)}|${ch(0x2122)}|${ch(0x153)}|${ch(0x161)})`, // punctuation read as Windows-1252
  ch(0xe3) + range(0x80, 0xbf), // Japanese (E3 lead byte) read as Latin-1
  ch(0xc2) + range(0xa0, 0xbf), // a stray C2 lead byte
].join('|'), 'g')
export const countBad = (s: string) => (s.match(BAD) ?? []).length

Deno.test('every email template renders without U+FFFD or mojibake (HTML and plain text)', async () => {
  const failures: string[] = []
  for (const f of FIXTURES) {
    const html = await renderEmail(f.element)
    const text = await renderEmail(f.element, { plainText: true })
    const n = countBad(html) + countBad(text)
    if (n > 0) failures.push(`${f.name}: ${n} (${[...(html + text).matchAll(BAD)].slice(0, 3).map((m) => JSON.stringify((html + text).slice(Math.max(0, m.index! - 8), m.index! + 8))).join(', ')})`)
    if (!html.includes('<html')) failures.push(`${f.name}: no <html> in output`)
  }
  if (failures.length) throw new Error(`${failures.length} of ${FIXTURES.length} emails broken:\n${failures.join('\n')}`)
})

Deno.test('the renderer never splits a multi-byte character, however long the email', async () => {
  // ~40 KB of 3-byte characters: under a per-chunk decoder this is tens of
  // U+FFFD; under the shared renderer it must be none.
  const big = React.createElement('div', null, ...Array.from({ length: 1500 }, (_, i) => React.createElement('p', { key: i }, `お支払いの場合 ₱¥🧡 ${i}`)))
  const html = await renderEmail(big)
  if (countBad(html) !== 0) throw new Error(`${countBad(html)} broken characters`)
  if (!html.includes('お支払いの場合 ₱¥🧡 1499')) throw new Error('content lost')
})

Deno.test('no edge function imports renderAsync (it splits UTF-8 across stream chunks)', async () => {
  const root = new URL('../supabase/functions/', import.meta.url)
  const offenders: string[] = []
  const walk = async (dir: URL, rel: string) => {
    for await (const e of Deno.readDir(dir)) {
      if (e.name === 'node_modules') continue
      if (e.isDirectory) await walk(new URL(`${e.name}/`, dir), `${rel}${e.name}/`)
      else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) {
        const src = await Deno.readTextFile(new URL(e.name, dir))
        // Code only: an import or a call, not the explanatory comment in render-email.ts.
        if (/^\s*import\s[^\n]*\brenderAsync\b/m.test(src) || /\brenderAsync\s*\(/.test(src.replace(/^\s*(\*|\/\/).*$/gm, ''))) offenders.push(rel + e.name)
      }
    }
  }
  await walk(root, '')
  if (offenders.length) throw new Error(`renderAsync used in: ${offenders.join(', ')} — use renderEmail from _shared/render-email.ts`)
})

Deno.test('every template file has a fixture here', async () => {
  const covered = new Set(FIXTURES.map((f) => f.file))
  const helpers = new Set(['order-shared.tsx', 'layaway-shared.tsx'])
  const missing: string[] = []
  for (const dir of ['email-templates', 'transactional-email-templates']) {
    for await (const e of Deno.readDir(new URL(`../supabase/functions/_shared/${dir}/`, import.meta.url))) {
      if (!e.name.endsWith('.tsx') || helpers.has(e.name)) continue
      if (!covered.has(`_shared/${dir}/${e.name}`)) missing.push(`${dir}/${e.name}`)
    }
  }
  if (missing.length) throw new Error(`templates with no encoding fixture: ${missing.join(', ')}`)
})
