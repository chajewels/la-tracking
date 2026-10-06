/// <reference types="npm:@types/react@18.3.1" />
/* eslint-disable react-refresh/only-export-components -- an email template, never hot-reloaded; the subject helper lives beside it like every other template */
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Link, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import { formatDeadline, orderMoney, type Lang } from '../storefront-email.ts'
import { METHOD_NAME, Panel, Row, WORDS, block, blockGutter, button, buttonWrap, container, footer, h1, h2, headerBar, main, muted, notice, rule, text, wordmark, type OrderCurrency, type PayMethod, subjectFor } from './order-shared.tsx'

/**
 * ONE SMALL UPDATE ABOUT A WEB ORDER (payment lifecycle H4 + addendum §9).
 *
 *   needs_info         staff marked her payment "needs clarification" — the
 *                      reviewer's message is shown, she replies to this email.
 *   deadline_moved     staff moved the payment deadline (set-account-deadlines).
 *   shipped            staff entered a tracking number (notify-shipped).
 *   details_received   staff recorded a payment she told them about; it waits
 *                      for a reviewer's Confirm.
 *   payment_submitted  §9 #1: she paid by Paidy or card herself; it waits for
 *                      Confirm. A card is a HOLD — 「仮売上（まだ請求されていません）」.
 *   payment_voided     §9 #6: staff voided a payment record (reason shown).
 *   payment_restored   §9 #6: staff restored a voided payment record.
 *   refund_issued      §9 #8: staff marked the refund on a cancelled order paid.
 *   refund_received    §9 #9: a refund made in the Square / Paidy dashboard.
 *
 * Sent ONLY for website orders by _shared/order-update-email.ts; a Hub order
 * keeps its Hub email. Language: the customer's, Japanese first then English;
 * an English email is English only. Staff text is rendered as TEXT — React
 * escapes it; never dangerouslySetInnerHTML. No variant ever names fraud.
 */
export type OrderUpdateVariant =
  | 'needs_info' | 'deadline_moved' | 'shipped' | 'details_received'
  | 'payment_submitted' | 'payment_voided' | 'payment_restored' | 'refund_issued' | 'refund_received'

export type RefundMethod = 'bank_transfer' | 'paidy' | 'card' | 'cash' | 'other'

export interface OrderUpdateEmailProps {
  lang: Lang
  variant: OrderUpdateVariant
  reference: string
  currency: OrderCurrency
  /** The payment / refund the update is about, in the order's currency; null = no amount line. */
  amount?: number | null
  /** Staff message (needs_info) or the void reason (payment_voided); plain text. */
  message?: string | null
  /** The (new) payment deadline, ISO. */
  deadline?: string | null
  region: 'JP' | 'OVERSEAS'
  courier?: string | null
  trackingNumber?: string | null
  trackingUrl?: string | null
  orderUrl: string | null
  /** payment_submitted: how she paid. */
  method?: PayMethod | null
  cardBrand?: string | null
  cardLast4?: string | null
  /** payment_submitted (card): when the hold ends, ISO. */
  holdUntil?: string | null
  /** payment_voided / payment_restored: what is still owed after the change. */
  balance?: number | null
  /** refund_issued / refund_received: how the money goes back. */
  refundMethod?: RefundMethod | null
  /** refund_issued: the day it was sent, YYYY-MM-DD. */
  refundDate?: string | null
}

const SUBJECT = {
  needs_info: { ja: 'お支払いについて確認させてください', en: 'We need to check your payment' },
  deadline_moved: { ja: 'お支払い期限を変更しました', en: 'Your payment deadline has changed' },
  shipped: { ja: '発送しました', en: 'Your order has shipped' },
  details_received: { ja: 'お支払いのご連絡を受け付けました', en: 'We have received your payment details' },
  payment_submitted: { ja: 'お支払いを受け付けました', en: 'We have received your payment' },
  payment_voided: { ja: 'お支払い記録を取り消しました', en: 'A payment record has been cancelled' },
  payment_restored: { ja: 'お支払い記録を復元しました', en: 'A payment record has been restored' },
  refund_issued: { ja: '返金が完了しました', en: 'Your refund has been sent' },
  refund_received: { ja: '返金を受け付けました', en: 'We have processed your refund' },
} as const

export const orderUpdateSubject = (variant: OrderUpdateVariant, reference: string, lang: Lang) =>
  subjectFor(lang, `${SUBJECT[variant].ja} ${reference}`, `${SUBJECT[variant].en} — Cha Jewels order ${reference}`)

const REFUND_METHOD = {
  ja: { bank_transfer: '銀行振込', paidy: 'あと払い（ペイディ）', card: 'クレジットカード', cash: '現金', other: 'その他' },
  en: { bank_transfer: 'bank transfer', paidy: 'Paidy', card: 'card', cash: 'cash', other: 'other' },
} as const

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
    submittedHeading: 'お支払いを受け付けました',
    submittedIntro: (ref: string, m: string) => `ご注文番号 ${ref} について、${m}でのお支払いを受け付けました。確認後に改めてご連絡します。`,
    submittedCard: 'カードの仮売上（まだ請求されていません）です。確認後にご請求が確定します。',
    submittedPaidy: 'ペイディでのお申込みを受け付けました。確認後にお支払いが確定します。',
    method: 'お支払い方法',
    card: 'カード',
    holdUntil: '仮売上の有効期限',
    voidedHeading: 'お支払い記録を取り消しました',
    voidedIntro: (ref: string) => `ご注文番号 ${ref} のお支払い記録を取り消しました。`,
    restoredHeading: 'お支払い記録を復元しました',
    restoredIntro: (ref: string) => `ご注文番号 ${ref} で取り消していたお支払い記録を復元しました。`,
    reason: '理由',
    balance: '現在のお支払い残高',
    refundIssuedHeading: '返金が完了しました',
    refundIssuedIntro: (ref: string) => `キャンセルとなったご注文番号 ${ref} の代金を返金しました。`,
    refundReceivedHeading: '返金を受け付けました',
    refundReceivedIntro: (ref: string) => `ご注文番号 ${ref} について、返金の手続きを行いました。`,
    refundDelay: '反映まで日数がかかる場合があります。',
    refundMethod: '返金方法',
    refundDate: '返金日',
    amount: 'お支払い金額',
    refundAmount: '返金額',
    message: '担当者からのメッセージ',
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
    submittedHeading: 'We have received your payment',
    submittedIntro: (ref: string, m: string) => `We have received your ${m} payment for order ${ref}. We will check it and contact you again.`,
    submittedCard: 'This is a hold on your card — you have not been charged yet. The charge is made only once we confirm your order.',
    submittedPaidy: 'Your Paidy payment has been received. It is completed once we confirm your order.',
    method: 'Payment method',
    card: 'Card',
    holdUntil: 'Card hold valid until',
    voidedHeading: 'A payment record has been cancelled',
    voidedIntro: (ref: string) => `We have cancelled a payment record on order ${ref}.`,
    restoredHeading: 'A payment record has been restored',
    restoredIntro: (ref: string) => `We have restored a payment record on order ${ref} that had been cancelled.`,
    reason: 'Reason',
    balance: 'Balance still to pay',
    refundIssuedHeading: 'Your refund has been sent',
    refundIssuedIntro: (ref: string) => `We have refunded your payment for cancelled order ${ref}.`,
    refundReceivedHeading: 'We have processed your refund',
    refundReceivedIntro: (ref: string) => `We have processed a refund for order ${ref}.`,
    refundDelay: 'It may take a few days for the refund to appear on your statement.',
    refundMethod: 'Refund method',
    refundDate: 'Refund date',
    amount: 'Amount',
    refundAmount: 'Refund amount',
    message: 'Message from our team',
  },
} as const

/** A YYYY-MM-DD day for the reader: 2026年10月6日 / 6 October 2026 (no clock — a day is a day). */
function formatDay(day: string | null | undefined, lang: Lang): string {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return ''
  const [y, m, d] = day.split('-').map(Number)
  if (lang === 'ja') return `${y}年${m}月${d}日`
  const month = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]
  return `${d} ${month} ${y}`
}

const Block = ({ lang, p, primary }: { lang: Lang; p: OrderUpdateEmailProps; primary: boolean }) => {
  const c = COPY[lang]
  const H = { style: primary ? h1 : h2 }
  const message = String(p.message ?? '').trim()
  const hasAmount = typeof p.amount === 'number' && Number.isFinite(p.amount) && p.amount > 0
  const when = formatDeadline(p.deadline ?? null, p.region, lang)
  const tracking = String(p.trackingNumber ?? '').trim()
  const courier = String(p.courier ?? '').trim()
  const method: PayMethod = p.method ?? 'transfer'
  const isCard = p.variant === 'payment_submitted' && method === 'card'
  const holdUntil = isCard ? formatDeadline(p.holdUntil ?? null, p.region, lang) : ''
  const last4 = String(p.cardLast4 ?? '').replace(/\D/g, '').slice(-4)
  const brand = String(p.cardBrand ?? '').replace(/_/g, ' ').trim()
  const cardLine = [brand, last4 ? `•${last4}` : ''].filter(Boolean).join(' ')
  const hasBalance = typeof p.balance === 'number' && Number.isFinite(p.balance)
  const refundDay = formatDay(p.refundDate ?? null, lang)
  const isRefund = p.variant === 'refund_issued' || p.variant === 'refund_received'

  let heading: string
  let intro: string
  let note: string | null = null
  switch (p.variant) {
    case 'needs_info': heading = c.needsInfoHeading; intro = c.needsInfoIntro(p.reference); break
    case 'deadline_moved': heading = c.deadlineHeading(when); intro = c.deadlineIntro(p.reference); break
    case 'shipped': heading = c.shippedHeading; intro = c.shippedIntro(p.reference); break
    case 'payment_submitted':
      heading = c.submittedHeading
      intro = c.submittedIntro(p.reference, METHOD_NAME[lang][method])
      note = method === 'card' ? c.submittedCard : method === 'paidy' ? c.submittedPaidy : null
      break
    case 'payment_voided': heading = c.voidedHeading; intro = c.voidedIntro(p.reference); break
    case 'payment_restored': heading = c.restoredHeading; intro = c.restoredIntro(p.reference); break
    case 'refund_issued': heading = c.refundIssuedHeading; intro = c.refundIssuedIntro(p.reference); note = c.refundDelay; break
    case 'refund_received': heading = c.refundReceivedHeading; intro = c.refundReceivedIntro(p.reference); note = c.refundDelay; break
    default: heading = c.receivedHeading; intro = c.receivedIntro(p.reference)
  }

  return (
    <>
      <Heading {...H}>{heading}</Heading>
      <Text style={text}>{intro}</Text>
      {p.variant === 'needs_info' && <Text style={text}>{c.needsInfoAsk}</Text>}
      {note && <Text style={notice}>{note}</Text>}
      {message && p.variant !== 'payment_voided' && (
        <Panel gutter={blockGutter} box={block}>
          <Text style={{ ...muted, margin: '0 0 4px' }}>{c.message}</Text>
          <Text style={{ ...text, margin: 0, whiteSpace: 'pre-line' as const }}>{message}</Text>
        </Panel>
      )}
      <Panel gutter={blockGutter} box={block}>
        {/* Row is a table, not flex — Gmail drops display:flex. See order-shared. */}
        <Row k={WORDS.reference[lang]} v={p.reference} />
        {p.variant === 'payment_submitted' && <Row k={c.method} v={METHOD_NAME[lang][method]} />}
        {isCard && cardLine && <Row k={c.card} v={cardLine} mono />}
        {p.variant !== 'shipped' && hasAmount && <Row k={isRefund ? c.refundAmount : c.amount} v={orderMoney(p.amount as number, p.currency)} emphasis={isRefund} />}
        {isCard && holdUntil && <Row k={c.holdUntil} v={holdUntil} />}
        {p.variant === 'payment_voided' && message && <Row k={c.reason} v={message} />}
        {(p.variant === 'payment_voided' || p.variant === 'payment_restored') && hasBalance && <Row k={c.balance} v={orderMoney(p.balance as number, p.currency)} emphasis />}
        {isRefund && p.refundMethod && <Row k={c.refundMethod} v={REFUND_METHOD[lang][p.refundMethod]} />}
        {p.variant === 'refund_issued' && refundDay && <Row k={c.refundDate} v={refundDay} />}
        {p.variant === 'deadline_moved' && when && <Row k={c.newDeadline} v={when} emphasis />}
        {p.variant === 'shipped' && courier && <Row k={c.courier} v={courier} />}
        {p.variant === 'shipped' && tracking && <Row k={c.tracking} v={tracking} mono />}
      </Panel>
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
