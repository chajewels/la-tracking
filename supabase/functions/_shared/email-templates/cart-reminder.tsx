/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Img, Link, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import type { Lang } from '../storefront-email.ts'
import { COMPANY_ADDRESS, COMPANY_NAME } from '../transactional-email-templates/brand.ts'
import { Panel, Row, block, blockGutter, button, buttonWrap, container, footer, h1, headerBar, label, main, muted, notice, rule, text, wordmark } from './order-shared.tsx'
import { STOREFRONT_REPLY_TO } from '../storefront-email.ts'
import { percentFromFraction, pesos, yen, yenWithPesos, type PlanFigures, type ReminderForm } from '../cart-reminder-rules.ts'

/**
 * CART REMINDER (stages A/B, docs/CART-REMINDERS.md). PROMOTIONAL: sent only
 * to a customer who ticked the cart-reminder box, once per cart cycle, by
 * cart-reminder-sweep through sendStorefrontEmail.
 *
 * ONE LANGUAGE PER EMAIL (owner decision D5) — never the order emails'
 * "Japanese first, English below". That is what makes the Japanese rule
 * unbreakable: a Japanese reminder has no English block to carry a layaway
 * line into it. The JAPANESE form never mentions layaway, a deposit or a
 * reserve figure in any stage (owner rule 2026-09-25); the English form shows
 * only figures the Hub produced (down_payment_* / layaway_quote) — never a
 * percentage or a conversion computed here.
 *
 * Every money figure on a line is the Hub's: price_jpy is the catalogue yen,
 * price_php is variantPricePhp at send time, the reserve line is the
 * variant's down_payment_jpy / down_payment_php / down_payment_pct, and the
 * stage-B plan panel is layaway_quote. A figure the Hub did not supply is
 * simply not printed.
 *
 * Mandatory display for advertising mail (特定電子メール法 §4): sender name,
 * the full postal address, the opt-out notice and link, a contact address.
 * The order emails' short footer is NOT enough here — hence COMPANY_ADDRESS.
 */

export interface CartReminderItem {
  name: string
  name_ja?: string | null
  size?: string | null
  stone?: string | null
  qty: number
  image_url?: string | null
  price_jpy: number
  /** The Hub's catalogue peso for this piece at send time; absent = no rate. */
  price_php?: number | null
  down_payment_jpy?: number | null
  down_payment_php?: number | null
  down_payment_pct?: number | null
}

export interface CartReminderProps {
  lang: Lang
  /** Which money form the email takes — decided by reminderForm(), never here. */
  form: ReminderForm
  items: CartReminderItem[]
  /** Stage B layaway only: the Hub's plan for the available pieces. */
  plan?: PlanFigures | null
  /** web_reservation_mode: adds "we reserve it for you and confirm before you pay". */
  reserveFirst: boolean
  /** Stage B: she reached checkout this cycle — the email says that step reserved nothing. */
  reachedCheckout: boolean
  cartUrl: string
  unsubscribeUrl: string
}

export const cartReminderSubject = (lang: Lang) =>
  lang === 'ja' ? 'Cha Jewels｜カートに商品が残っています' : 'Still in your cart at Cha Jewels'

const COPY = {
  ja: {
    heading: 'カートに商品が残っています',
    intro: 'chajewelsjp.comのカートに次の商品が残っています。',
    itemsLabel: 'カートの商品',
    sizeLabel: 'サイズ',
    stoneLabel: '石',
    pesoNote: '₱は本日のレートによる目安です。正確な金額はご注文手続きの際にご確認いただけます。',
    pesoAtCheckout: 'ペソでの金額はご注文手続きの際にご案内します。',
    noHold: 'カートに入れただけでは商品は確保されません。一点物のため、先にご注文いただいた方へのご案内となります。',
    reserveFirst: 'ご注文いただくと商品をお取り置きし、お支払い前に当店から確認のご連絡をいたします。',
    checkoutNoHold: '先ほどのご注文手続きでは、商品はまだ確保されていません。',
    viewCart: 'カートを見る',
    continueCheckout: 'ご注文手続きへ進む',
    why: 'このメールは、カートのお知らせの受信をご希望いただいたお客様にお送りしています。',
    stop: '配信停止',
    ordersUnaffected: '（ご注文に関するメールは引き続きお届けします）',
    help: 'ご不明な点は、このメールにご返信ください。',
  },
  en: {
    heading: 'Pieces in your cart',
    intro: 'You left these in your cart at chajewelsjp.com.',
    itemsLabel: 'In your cart',
    sizeLabel: 'Size',
    stoneLabel: 'Stone',
    pesoNote: 'Peso amounts are at today’s rate; the exact amount is confirmed at checkout.',
    pesoAtCheckout: 'The peso amount is shown at checkout.',
    noHold: 'Your cart does not hold these pieces — each one-of-a-kind piece goes to whoever orders first.',
    reserveFirst: 'When you order, we reserve it for you and confirm before you pay.',
    checkoutNoHold: 'Your earlier checkout did not reserve anything.',
    viewCart: 'View your cart',
    continueCheckout: 'Continue to checkout',
    why: 'You’re receiving this because you asked for cart reminders.',
    stop: 'Stop cart reminders',
    ordersUnaffected: 'Your order emails are not affected.',
    help: 'Questions? Reply to this email.',
  },
} as const

/** Stage B plan panel words — English only; the Japanese form never renders it. */
const PLAN = {
  label: 'Your layaway plan',
  deposit: 'Deposit',
  monthly: (n: number) => `Monthly × ${n}`,
  lastMonth: 'Last month',
  total: 'Total',
  interest: '0% interest. Final figures are confirmed at checkout.',
} as const

const itemName = (i: CartReminderItem, lang: Lang) => (lang === 'ja' && i.name_ja ? i.name_ja : i.name)

/** The price printed beside a line, per form. The Hub's figures only. */
function linePrice(i: CartReminderItem, form: ReminderForm, lang: Lang, plan: PlanFigures | null | undefined): string {
  const php = i.price_php ?? null
  switch (form) {
    case 'stage_a':
      return lang === 'ja' ? yen(i.price_jpy) : yenWithPesos(i.price_jpy, php)
    case 'full_jpy':
      return yen(i.price_jpy)
    case 'full_php':
      return php === null || !Number.isFinite(php) ? yen(i.price_jpy) : pesos(php)
    case 'layaway':
      return plan?.currency === 'PHP' ? yenWithPesos(i.price_jpy, php) : yen(i.price_jpy)
  }
}

/** EN stage A only: the Hub's reserve line, and only when BOTH deposits exist. */
function reserveLine(i: CartReminderItem): string | null {
  const jpy = i.down_payment_jpy ?? null
  const php = i.down_payment_php ?? null
  // The Hub's down_payment_pct is a SHARE (0.30), not a percentage: convert,
  // never round it (the 2026-10-01 acceptance email read "0% down").
  const pct = percentFromFraction(i.down_payment_pct)
  if (jpy === null || php === null || !Number.isFinite(jpy) || !Number.isFinite(php) || jpy <= 0 || php <= 0) return null
  const pctText = pct !== null ? ` — ${pct}% down —` : ' —'
  return `Or reserve with ${yenWithPesos(jpy, php)}${pctText} and pay the rest monthly at 0% interest.`
}

const planMoney = (n: number, c: PlanFigures['currency']) => (c === 'PHP' ? pesos(n) : yen(n))

const ItemLine = ({ i, lang, form, plan }: { i: CartReminderItem; lang: Lang; form: ReminderForm; plan: PlanFigures | null | undefined }) => {
  const c = COPY[lang]
  const details = [i.size ? `${c.sizeLabel} ${i.size}` : null, i.stone ? `${c.stoneLabel} ${i.stone}` : null].filter(Boolean).join(' · ')
  const reserve = lang === 'en' && form === 'stage_a' ? reserveLine(i) : null
  return (
    <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} style={lineTable}>
      <tbody>
        <tr>
          <td width="84" style={imgCell}>
            {i.image_url
              ? <Img src={i.image_url} alt="" width={72} height={72} style={img} />
              : <div style={imgBlank} />}
          </td>
          <td style={nameCell}>
            <Text style={nameText}>{itemName(i, lang)}{i.qty > 1 ? ` × ${i.qty}` : ''}</Text>
            {details && <Text style={detailText}>{details}</Text>}
            <Text style={priceText}>{linePrice(i, form, lang, plan)}</Text>
            {reserve && <Text style={reserveText}>{reserve}</Text>}
          </td>
        </tr>
      </tbody>
    </table>
  )
}

export const CartReminderEmail = (p: CartReminderProps) => {
  const lang: Lang = p.lang === 'en' ? 'en' : 'ja'
  // A Japanese email NEVER takes the layaway form, whatever the caller passed.
  const form: ReminderForm = lang === 'ja' && p.form === 'layaway' ? 'stage_a' : p.form
  const plan = form === 'layaway' ? (p.plan ?? null) : null
  const c = COPY[lang]
  const anyPhp = p.items.some((i) => i.price_php !== null && i.price_php !== undefined)
  const button_ = p.reachedCheckout ? c.continueCheckout : c.viewCart
  // Japanese sentences run on without a space; English ones take one.
  const sp = lang === 'ja' ? '' : ' '
  return (
    <Html lang={lang} dir="ltr">
      <Head />
      <Preview>{cartReminderSubject(lang)}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={headerBar}>
            <Text style={wordmark}>Cha Jewels</Text>
          </Section>
          <Heading style={h1}>{c.heading}</Heading>
          <Text style={text}>{c.intro}</Text>

          <Panel gutter={blockGutter} box={block}>
            <Text style={label}>{c.itemsLabel}</Text>
            {p.items.map((i, idx) => <ItemLine key={idx} i={i} lang={lang} form={form} plan={plan} />)}
          </Panel>
          {form === 'full_php' && <Text style={muted}>{anyPhp ? c.pesoNote : c.pesoAtCheckout}</Text>}

          {plan && (
            <Panel gutter={blockGutter} box={block}>
              <Text style={label}>{PLAN.label}</Text>
              <Row k={PLAN.deposit} v={planMoney(plan.deposit, plan.currency)} />
              <Row k={PLAN.monthly(plan.termMonths)} v={planMoney(plan.monthly, plan.currency)} />
              {plan.lastMonth !== plan.monthly && <Row k={PLAN.lastMonth} v={planMoney(plan.lastMonth, plan.currency)} />}
              <Row k={PLAN.total} v={planMoney(plan.total, plan.currency)} emphasis />
              <Text style={{ ...muted, margin: '8px 0 0' }}>{PLAN.interest}</Text>
            </Panel>
          )}

          <Text style={notice}>
            {c.noHold}{p.reserveFirst ? `${sp}${c.reserveFirst}` : ''}{p.reachedCheckout ? `${sp}${c.checkoutNoHold}` : ''}
          </Text>

          <Section style={buttonWrap}>
            <Button style={button} href={p.cartUrl}>{button_}</Button>
          </Section>

          <Hr style={rule} />
          <Text style={muted}>{c.help}</Text>
          <Text style={muted}>
            {c.why}{sp}<Link href={p.unsubscribeUrl} style={link}>{c.stop}</Link>{lang === 'ja' ? c.ordersUnaffected : `. ${c.ordersUnaffected}`}
          </Text>
          <Text style={footer}>
            {COMPANY_NAME}<br />
            {COMPANY_ADDRESS[lang]}<br />
            {STOREFRONT_REPLY_TO}
          </Text>
        </Container>
      </Body>
    </Html>
  )
}

const lineTable = { borderCollapse: 'collapse' as const, width: '100%', borderBottom: '1px solid #eee7d8' }
const imgCell = { padding: '10px 12px 10px 0', verticalAlign: 'top' as const, width: '84px' }
const img = { width: '72px', height: '72px', borderRadius: '6px', objectFit: 'cover' as const, display: 'block' as const, border: '1px solid #e6dfd0' }
const imgBlank = { width: '72px', height: '72px', borderRadius: '6px', backgroundColor: '#f6f4ef', border: '1px solid #e6dfd0' }
const nameCell = { padding: '10px 0', verticalAlign: 'top' as const, wordBreak: 'break-word' as const, overflowWrap: 'anywhere' as const }
const nameText = { fontSize: '15px', fontWeight: 'bold' as const, color: '#1a1a2e', margin: '0 0 2px', lineHeight: '1.5' }
const detailText = { fontSize: '13px', color: '#6b6b6b', margin: '0 0 2px', lineHeight: '1.5' }
const priceText = { fontSize: '14px', color: '#1a1a2e', margin: '0', lineHeight: '1.5' }
const reserveText = { fontSize: '12px', color: '#6b6b6b', margin: '4px 0 0', lineHeight: '1.5' }
const link = { color: '#1a1a2e', textDecoration: 'underline' }

export default CartReminderEmail
