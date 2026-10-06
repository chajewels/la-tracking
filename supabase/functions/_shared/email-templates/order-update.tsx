/// <reference types="npm:@types/react@18.3.1" />
/* eslint-disable react-refresh/only-export-components -- an email template, never hot-reloaded; the subject helper lives beside it like every other template */
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Link, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import { formatDeadline, orderMoney, type Lang } from '../storefront-email.ts'
import { Panel, Row, WORDS, METHOD_NAME, block, blockGutter, button, buttonWrap, container, footer, h1, h2, headerBar, main, muted, notice, rule, text, wordmark, type OrderCurrency, type PayMethod, subjectFor } from './order-shared.tsx'

/**
 * ONE SMALL UPDATE ABOUT A WEB ORDER (payment lifecycle H4, spec §5 B and D2).
 *
 *   needs_info        staff marked her payment "needs clarification" — the
 *                     reviewer's message is shown, she replies to this email.
 *   deadline_moved    staff moved the payment deadline (set-account-deadlines).
 *   shipped           staff entered a tracking number (notify-shipped):
 *                     courier, tracking number, tracking link.
 *   details_received  staff recorded a payment she told them about; it waits
 *                     for a reviewer's Confirm.
 *   payment_filed     SHE paid by Paidy or card on the website and the Hub
 *                     filed it (email addendum 1, 2026-10-06): method, the
 *                     Hub's amount, card brand •last4 and the hold's end date
 *                     (JST) when the stored Square record has them. A card is
 *                     HELD, never "charged" — capture happens on Confirm.
 *   payment_voided    staff voided a recorded payment on her web order
 *   payment_restored  … or restored one (addendum 6): amount, new balance.
 *
 * Sent ONLY for website orders by _shared/order-update-email.ts; a Hub order
 * keeps its Hub email. Language: the customer's, Japanese first then English;
 * an English email is English only. The staff message is rendered as TEXT —
 * React escapes it; never dangerouslySetInnerHTML.
 */
export type OrderUpdateVariant =
  | 'needs_info' | 'deadline_moved' | 'shipped' | 'details_received'
  | 'payment_filed' | 'payment_voided' | 'payment_restored'

export interface OrderUpdateEmailProps {
  lang: Lang
  variant: OrderUpdateVariant
  reference: string
  currency: OrderCurrency
  /** The payment the update is about, in the order's currency; null = no amount line. */
  amount?: number | null
  /** Staff message (needs_info, optional elsewhere); plain text. */
  message?: string | null
  /** The (new) payment deadline, ISO. */
  deadline?: string | null
  region: 'JP' | 'OVERSEAS'
  courier?: string | null
  trackingNumber?: string | null
  trackingUrl?: string | null
  orderUrl: string | null
  /** payment_filed: how she paid ('paidy' | 'card'). */
  method?: PayMethod | null
  /** payment_filed, card: from the stored Square record only (never the browser). */
  cardBrand?: string | null
  cardLast4?: string | null
  /** payment_filed, card: true only when the stored Square record says the money is HELD (status 'authorized'). */
  held?: boolean
  /** payment_filed, card: the hold's end (square_payments.capture_by), shown in JST. */
  holdUntil?: string | null
  /** payment_voided / payment_restored: the Hub's remaining balance after the change. */
  balance?: number | null
}

/** "VISA" → "Visa", "AMERICAN_EXPRESS" → "American Express"; unknown brands title-cased. */
export function cardBrandLabel(brand: string | null | undefined): string {
  const b = String(brand ?? '').trim().toUpperCase()
  if (!b) return ''
  const known: Record<string, string> = {
    VISA: 'Visa', MASTERCARD: 'Mastercard', AMERICAN_EXPRESS: 'American Express', JCB: 'JCB',
    DISCOVER: 'Discover', DISCOVER_DINERS: 'Diners Club', DINERS: 'Diners Club', CHINA_UNIONPAY: 'UnionPay', UNIONPAY: 'UnionPay',
  }
  return known[b] ?? b.toLowerCase().split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

/** "Visa •1234" from the stored brand and last 4; '' when neither is known. */
export function cardLabel(brand: string | null | undefined, last4: string | null | undefined): string {
  const l4 = /^[0-9]{4}$/.test(String(last4 ?? '')) ? String(last4) : ''
  const name = cardBrandLabel(brand)
  return [name, l4 ? `\u2022${l4}` : ''].filter(Boolean).join(' ')
}

const SUBJECT = {
  needs_info: { ja: 'お支払いについて確認させてください', en: 'We need to check your payment' },
  deadline_moved: { ja: 'お支払い期限を変更しました', en: 'Your payment deadline has changed' },
  shipped: { ja: '発送しました', en: 'Your order has shipped' },
  details_received: { ja: 'お支払いのご連絡を受け付けました', en: 'We have received your payment details' },
  payment_filed: { ja: 'お支払いを受け付けました', en: 'We have received your payment' },
  payment_voided: { ja: 'お支払い記録を取り消しました', en: 'A payment record has been cancelled' },
  payment_restored: { ja: 'お支払い記録を復元しました', en: 'A payment record has been restored' },
} as const

export const orderUpdateSubject = (variant: OrderUpdateVariant, reference: string, lang: Lang) =>
  subjectFor(lang, `${SUBJECT[variant].ja} ${reference}`, `${SUBJECT[variant].en} — Cha Jewels order ${reference}`)

const COPY = {
  ja: {
    needsInfoHeading: 'お支払いについて確認させてください',
    needsInfoIntro: (ref: string) => `ご注文番号 ${ref} のお支払いについて、確認させていただきたいことがあります。`,
    needsInfoAsk: '下記のメッセージをご確認のうえ、このメールにご返信ください。',
    deadlineHeading: (when: string) => (when ? `お支払い期限を ${when} に変更しました` : 'お支払い期限を変更しました'),
    deadlineIntro: (ref: string) => `ご注文番号 ${ref} のお支払い期限を変更しました。`,
    newDeadline: '新しいお支払い期限',
    shippedHeading: '発送しました',
    shippedIntro: (ref: string) => `ご注文番号 ${ref} の商品を発送しました。お届けまでもうしばらくお待ちください。`,
    courier: '配送業者',
    tracking: 'お問い合わせ番号',
    trackLink: '配送状況を確認する',
    receivedHeading: 'お支払いのご連絡を受け付けました',
    receivedIntro: (ref: string) => `ご注文番号 ${ref} について、お支払いのご連絡を受け付けました。確認後にあらためてご連絡します。`,
    amount: 'お支払い金額',
    message: '担当者からのメッセージ',
    filedHeading: 'お支払いを受け付けました',
    filedIntro: (ref: string, m: string) => `ご注文番号 ${ref} について、${m}でのお支払いを受け付けました。確認後に改めてご連絡します。`,
    method: 'お支払い方法',
    card: 'カード',
    held: '仮売上（まだ請求されていません）',
    holdState: 'ご請求の状況',
    holdUntil: '仮売上の期限',
    heldNote: 'カードは仮売上の状態で、まだ請求されていません。当店で確認後に確定します。',
    paidyNote: 'ペイディでのお支払いは、当店で確認後に確定します。',
    voidedHeading: 'お支払い記録を取り消しました',
    voidedIntro: (ref: string) => `ご注文番号 ${ref} のお支払い記録を1件取り消しました。`,
    restoredHeading: 'お支払い記録を復元しました',
    restoredIntro: (ref: string) => `ご注文番号 ${ref} のお支払い記録を1件復元しました。`,
    recordAmount: '対象のお支払い金額',
    balance: '残りのお支払い金額',
    paidInFull: 'お支払いは完了しています。',
  },
  en: {
    needsInfoHeading: 'We need to check your payment',
    needsInfoIntro: (ref: string) => `We need to check something about your payment for order ${ref}.`,
    needsInfoAsk: 'Please read the message below and reply to this email.',
    deadlineHeading: (when: string) => (when ? `We have moved your payment deadline to ${when}` : 'We have moved your payment deadline'),
    deadlineIntro: (ref: string) => `The payment deadline for order ${ref} has changed.`,
    newDeadline: 'New payment deadline',
    shippedHeading: 'Your order has shipped',
    shippedIntro: (ref: string) => `We have shipped order ${ref}. It is on its way to you.`,
    courier: 'Courier',
    tracking: 'Tracking number',
    trackLink: 'Track your parcel',
    receivedHeading: 'We have received your payment details',
    receivedIntro: (ref: string) => `We have received your payment details for order ${ref}. We will check them and contact you again.`,
    amount: 'Amount',
    message: 'Message from our team',
    filedHeading: 'We have received your payment',
    filedIntro: (ref: string, m: string) => `We have received your ${m} payment for order ${ref}. We will check it and contact you again.`,
    method: 'Payment method',
    card: 'Card',
    held: 'Held, not charged yet',
    holdState: 'Status',
    holdUntil: 'Hold ends',
    heldNote: 'The amount is held on your card and has not been charged yet. It is charged only once we have checked your order.',
    paidyNote: 'Your Paidy payment is finalised once we have checked your order.',
    voidedHeading: 'A payment record has been cancelled',
    voidedIntro: (ref: string) => `We have cancelled one payment record on order ${ref}.`,
    restoredHeading: 'A payment record has been restored',
    restoredIntro: (ref: string) => `We have restored one payment record on order ${ref}.`,
    recordAmount: 'Payment amount',
    balance: 'Amount still to pay',
    paidInFull: 'Your order is paid in full.',
  },
} as const

/** The method as a row value (sentence-cased in English). */
const METHOD_ROW = {
  ja: METHOD_NAME.ja,
  en: { transfer: 'Bank transfer', paidy: 'Paidy', card: 'Card' },
} as const

const Block = ({ lang, p, primary }: { lang: Lang; p: OrderUpdateEmailProps; primary: boolean }) => {
  const c = COPY[lang]
  const H = { style: primary ? h1 : h2 }
  const message = String(p.message ?? '').trim()
  const hasAmount = typeof p.amount === 'number' && Number.isFinite(p.amount) && p.amount > 0
  const when = formatDeadline(p.deadline ?? null, p.region, lang)
  const tracking = String(p.trackingNumber ?? '').trim()
  const courier = String(p.courier ?? '').trim()

  let heading: string
  let intro: string
  switch (p.variant) {
    case 'needs_info': heading = c.needsInfoHeading; intro = c.needsInfoIntro(p.reference); break
    case 'deadline_moved': heading = c.deadlineHeading(when); intro = c.deadlineIntro(p.reference); break
    case 'shipped': heading = c.shippedHeading; intro = c.shippedIntro(p.reference); break
    case 'payment_filed': heading = c.filedHeading; intro = c.filedIntro(p.reference, METHOD_NAME[lang][p.method ?? 'card']); break
    case 'payment_voided': heading = c.voidedHeading; intro = c.voidedIntro(p.reference); break
    case 'payment_restored': heading = c.restoredHeading; intro = c.restoredIntro(p.reference); break
    default: heading = c.receivedHeading; intro = c.receivedIntro(p.reference)
  }
  const filed = p.variant === 'payment_filed'
  const record = p.variant === 'payment_voided' || p.variant === 'payment_restored'
  const isCard = filed && p.method === 'card'
  const card = isCard ? cardLabel(p.cardBrand, p.cardLast4) : ''
  const held = isCard && p.held === true
  const holdUntil = held && p.holdUntil ? formatDeadline(p.holdUntil, 'JP', lang) : ''
  const hasBalance = record && typeof p.balance === 'number' && Number.isFinite(p.balance)

  return (
    <>
      <Heading {...H}>{heading}</Heading>
      <Text style={text}>{intro}</Text>
      {p.variant === 'needs_info' && <Text style={text}>{c.needsInfoAsk}</Text>}
      {message && (
        <Panel gutter={blockGutter} box={block}>
          <Text style={{ ...muted, margin: '0 0 4px' }}>{c.message}</Text>
          <Text style={{ ...text, margin: 0, whiteSpace: 'pre-line' as const }}>{message}</Text>
        </Panel>
      )}
      <Panel gutter={blockGutter} box={block}>
        {/* Row is a table, not flex — Gmail drops display:flex. See order-shared. */}
        <Row k={WORDS.reference[lang]} v={p.reference} />
        {filed && <Row k={c.method} v={METHOD_ROW[lang][p.method ?? 'card']} />}
        {p.variant !== 'shipped' && hasAmount && <Row k={record ? c.recordAmount : c.amount} v={orderMoney(p.amount as number, p.currency)} />}
        {card && <Row k={c.card} v={card} />}
        {held && <Row k={c.holdState} v={c.held} />}
        {holdUntil && <Row k={c.holdUntil} v={holdUntil} />}
        {hasBalance && (p.balance as number) > 0 && <Row k={c.balance} v={orderMoney(p.balance as number, p.currency)} emphasis />}
        {p.variant === 'deadline_moved' && when && <Row k={c.newDeadline} v={when} emphasis />}
        {p.variant === 'shipped' && courier && <Row k={c.courier} v={courier} />}
        {p.variant === 'shipped' && tracking && <Row k={c.tracking} v={tracking} mono />}
      </Panel>
      {held && <Text style={notice}>{c.heldNote}</Text>}
      {filed && p.method === 'paidy' && <Text style={notice}>{c.paidyNote}</Text>}
      {hasBalance && (p.balance as number) <= 0 && <Text style={text}>{c.paidInFull}</Text>}
      {p.variant === 'shipped' && p.trackingUrl && (
        <Text style={text}>
          {c.trackLink}: <Link href={p.trackingUrl}>{p.trackingUrl}</Link>
        </Text>
      )}
      {p.orderUrl && (
        <Section style={buttonWrap}>
          <Button style={button} href={p.orderUrl}>{WORDS.viewOrder[lang]}</Button>
        </Section>
      )}
    </>
  )
}

export const OrderUpdateEmail = (p: OrderUpdateEmailProps) => (
  <Html lang={p.lang} dir="ltr">
    <Head />
    <Preview>{orderUpdateSubject(p.variant, p.reference, p.lang)}</Preview>
    <Body style={main}>
      <Container style={container}>
        <Section style={headerBar}>
          <Text style={wordmark}>Cha Jewels</Text>
        </Section>
        <Block lang={p.lang} p={p} primary />
        {p.lang === 'ja' && (
          <>
            <Hr style={rule} />
            <Block lang="en" p={p} primary={false} />
          </>
        )}
        <Hr style={rule} />
        <Text style={muted}>{WORDS.help[p.lang]}</Text>
        <Text style={footer}>{WORDS.footer[p.lang]}</Text>
      </Container>
    </Body>
  </Html>
)

export default OrderUpdateEmail
