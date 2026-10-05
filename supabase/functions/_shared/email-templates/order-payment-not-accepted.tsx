/// <reference types="npm:@types/react@18.3.1" />
/* eslint-disable react-refresh/only-export-components -- an email template, never hot-reloaded; the subject helper lives beside it like every other template */
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import { formatDeadline, orderMoney, type Lang } from '../storefront-email.ts'
import { Panel, Row, WORDS, block, blockGutter, button, buttonWrap, container, footer, h1, h2, headerBar, main, muted, rule, text, wordmark, type OrderCurrency } from './order-shared.tsx'

/**
 * A PAYMENT ON A WEB ORDER WAS NOT ACCEPTED (owner 2026-10-05, after the Paidy
 * live test: a Hub Reject on a cash / web order sent the customer nothing, and
 * Paidy itself never emails a cancellation — "販売店で確定されずキャンセルと
 * なった場合、ペイディからキャンセル情報のメールは送信されません").
 *
 * Sent by _shared/payment-rejected-email.ts whenever a cash-order submission
 * becomes 'rejected': a reviewer's Reject (with the reviewer's message, which
 * the Reject dialog tells staff the customer will see), or Paidy / Square
 * ending the authorisation on their side (no staff message — those notes are
 * internal English).
 *
 * Says what she needs and nothing more: which payment, that a Paidy or card
 * one charged NOTHING, what is still owed and by when, and the order link to
 * pay again. Transactional — no products, no offers.
 *
 * Language: the customer's, Japanese first then English, like every order email.
 */
export type NotAcceptedMethod = 'transfer' | 'paidy' | 'card'
export type NotAcceptedKind = 'staff' | 'provider_ended'

export interface OrderPaymentNotAcceptedProps {
  lang: Lang
  reference: string
  method: NotAcceptedMethod
  kind: NotAcceptedKind
  /** The submitted amount, in the order's currency. */
  amount: number
  currency: OrderCurrency
  /** The reviewer's message (kind 'staff' only); null/empty = none shown. */
  reason: string | null
  /** Still owed and payable: null when the order is no longer open. */
  remaining: number | null
  transferDueAt: string | null
  region: 'JP' | 'OVERSEAS'
  orderUrl: string | null
}

export const orderPaymentNotAcceptedSubject = (reference: string) =>
  `お支払いを確認できませんでした ${reference} / We could not accept your payment — Cha Jewels order ${reference}`

const METHOD = {
  ja: { transfer: 'お振込', paidy: 'あと払い（ペイディ）', card: 'クレジットカード' },
  en: { transfer: 'bank transfer', paidy: 'Paidy (あと払い)', card: 'card' },
} as const

const COPY = {
  ja: {
    heading: 'お支払いを確認できませんでした',
    intro: (ref: string, m: string, a: string) => `ご注文番号 ${ref} について、${m}でのお支払い（${a}）を確認できませんでした。`,
    paidy: 'ペイディのお申込みは取り消されました。このお申込みについて、ペイディからのご請求は発生しません。',
    card: 'カードの与信（仮売上）は取り消されました。このお支払いでのご請求は発生しません。',
    transfer: 'お振込の控えをご確認のうえ、ご注文ページから再度ご提出いただくか、このメールにご返信ください。',
    paidyEnded: 'ペイディでのお手続きが完了しなかったため、お申込みは取り消されました。ご請求は発生しません。',
    cardEnded: 'カードの与信（仮売上）が取り消されたため、ご請求は発生しません。',
    reason: '担当者からのメッセージ',
    remaining: 'お支払い金額',
    deadline: (when: string) => `お支払い期限：${when}`,
    again: 'ご注文ページから、もう一度お支払いいただけます。',
    closed: 'このご注文は現在お支払いを受け付けておりません。ご不明な点はこのメールにご返信ください。',
  },
  en: {
    heading: 'We could not accept your payment',
    intro: (ref: string, m: string, a: string) => `We could not accept your ${m} payment (${a}) for order ${ref}.`,
    paidy: 'Your Paidy payment was cancelled — Paidy will not bill you for it.',
    card: 'The hold on your card was released — nothing was charged.',
    transfer: 'Please check your transfer receipt and upload it again on your order page, or reply to this email.',
    paidyEnded: 'Your Paidy payment was not completed, so it was cancelled — Paidy will not bill you for it.',
    cardEnded: 'The hold on your card was released — nothing was charged.',
    reason: 'Message from our team',
    remaining: 'Amount to pay',
    deadline: (when: string) => `Pay by: ${when}`,
    again: 'You can pay again from your order page.',
    closed: 'This order is no longer open for payment. If you have any questions, reply to this email.',
  },
} as const

const Block = ({ lang, p, primary }: { lang: Lang; p: OrderPaymentNotAcceptedProps; primary: boolean }) => {
  const c = COPY[lang]
  const ended = p.kind === 'provider_ended'
  const note = p.method === 'paidy' ? (ended ? c.paidyEnded : c.paidy)
    : p.method === 'card' ? (ended ? c.cardEnded : c.card)
    : c.transfer
  const reason = p.kind === 'staff' ? String(p.reason ?? '').trim() : ''
  const open = p.remaining !== null && p.remaining > 0
  const when = open ? formatDeadline(p.transferDueAt, p.region, lang) : ''
  return (
    <>
      <Heading style={primary ? h1 : h2}>{c.heading}</Heading>
      <Text style={text}>{c.intro(p.reference, METHOD[lang][p.method], orderMoney(p.amount, p.currency))}</Text>
      <Text style={{ ...text, fontWeight: 'bold' as const }}>{note}</Text>
      {reason && (
        <Panel gutter={blockGutter} box={block}>
          <Text style={{ ...muted, margin: '0 0 4px' }}>{c.reason}</Text>
          <Text style={{ ...text, margin: 0 }}>{reason}</Text>
        </Panel>
      )}
      {open ? (
        <>
          <Panel gutter={blockGutter} box={block}>
            {/* Row is a table, not flex — Gmail drops display:flex. See order-shared. */}
            <Row k={WORDS.reference[lang]} v={p.reference} />
            <Row k={c.remaining} v={orderMoney(p.remaining as number, p.currency)} emphasis />
          </Panel>
          {when && <Text style={{ ...text, fontWeight: 'bold' as const }}>{c.deadline(when)}</Text>}
          <Text style={text}>{c.again}</Text>
        </>
      ) : (
        <Text style={muted}>{c.closed}</Text>
      )}
      {p.orderUrl && (
        <Section style={buttonWrap}>
          <Button style={button} href={p.orderUrl}>{WORDS.viewOrder[lang]}</Button>
        </Section>
      )}
    </>
  )
}

export const OrderPaymentNotAcceptedEmail = (p: OrderPaymentNotAcceptedProps) => (
  <Html lang={p.lang} dir="ltr">
    <Head />
    <Preview>{orderPaymentNotAcceptedSubject(p.reference)}</Preview>
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

export default OrderPaymentNotAcceptedEmail
