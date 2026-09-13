/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import type { Lang } from '../storefront-email.ts'
import { ItemsTable, WORDS, button, buttonWrap, container, footer, h1, h2, headerBar, main, muted, notice, rule, text, wordmark, type OrderEmailItem } from './order-shared.tsx'

/**
 * Sent by cancel-cash-order when staff cancel a web order. Carries the reason
 * and, when money had been received, the refund decision — the same two
 * things the customer sees on /account/orders. A lapse (72 hours, no
 * transfer) uses order-expired.tsx instead.
 */
export type RefundStatus = 'refund_issued' | 'refund_pending' | 'no_refund'

export interface OrderCancelledProps {
  lang: Lang
  reference: string
  items: OrderEmailItem[]
  shippingJpy: number | null
  totalJpy: number
  reason: string
  refundStatus: RefundStatus | null
  refundNote: string | null
  orderUrl: string | null
}

export const orderCancelledSubject = (reference: string) =>
  `ご注文がキャンセルされました ${reference} / Your Cha Jewels order ${reference} has been cancelled`

const COPY = {
  ja: {
    heading: 'ご注文がキャンセルされました',
    intro: (ref: string) => `ご注文番号 ${ref} はキャンセルとなりました。`,
    reason: '理由',
    refund: {
      refund_issued: 'お支払いいただいた代金は返金済みです。',
      refund_pending: 'お支払いいただいた代金は返金手続き中です。数日以内にご確認ください。',
      no_refund: 'お支払いいただいた代金は、1年間有効なストアクレジットとしてお客様のアカウントに追加されました。次回のご注文時にスタッフが適用いたします。',
    },
    note: 'スタッフからのご案内',
    view: 'ご注文を見る',
  },
  en: {
    heading: 'Your order has been cancelled',
    intro: (ref: string) => `Order ${ref} has been cancelled.`,
    reason: 'Reason',
    refund: {
      refund_issued: 'The amount you paid has been refunded.',
      refund_pending: 'A refund of the amount you paid is being processed. Please allow a few days.',
      no_refund: 'The amount you paid has been added to your account as store credit, valid for one year. Our staff will apply it to your next order.',
    },
    note: 'A note from our staff',
    view: 'View order',
  },
} as const

const Block = ({ lang, p, primary }: { lang: Lang; p: OrderCancelledProps; primary: boolean }) => {
  const c = COPY[lang]
  return (
    <>
      <Heading style={primary ? h1 : h2}>{c.heading}</Heading>
      <Text style={text}>{c.intro(p.reference)}</Text>
      <Text style={text}><strong>{c.reason}:</strong> {p.reason}</Text>
      <ItemsTable items={p.items} shippingJpy={p.shippingJpy} totalJpy={p.totalJpy} lang={lang} />
      {p.refundStatus && <Text style={notice}>{c.refund[p.refundStatus]}</Text>}
      {p.refundNote && <Text style={text}><strong>{c.note}:</strong> {p.refundNote}</Text>}
      {p.orderUrl && (
        <Section style={buttonWrap}>
          <Button style={button} href={p.orderUrl}>{c.view}</Button>
        </Section>
      )}
    </>
  )
}

export const OrderCancelledEmail = (p: OrderCancelledProps) => (
  <Html lang={p.lang} dir="ltr">
    <Head />
    <Preview>{orderCancelledSubject(p.reference)}</Preview>
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

export default OrderCancelledEmail
