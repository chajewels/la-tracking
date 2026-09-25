/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import { formatDeadline, type Lang } from '../storefront-email.ts'
import { ItemsTable, MethodCards, WORDS, button, buttonWrap, container, footer, h1, h2, headerBar, main, muted, rule, text, wordmark, type OrderEmailItem, type OrderEmailMethod, type OrderCurrency } from './order-shared.tsx'

/**
 * Sent by the `website` function the moment /checkout/pay succeeds. The
 * customer's language first, English below. Everything the payment screen
 * showed is repeated here: items, total, every transfer method as a labelled
 * card, the transfer-name notice, the 72-hour deadline as a date and time,
 * and the link to the order page.
 */
export interface OrderConfirmationProps {
  lang: Lang
  reference: string
  items: OrderEmailItem[]
  shippingJpy: number | null
  totalJpy: number
  /** The order's settlement currency; shippingJpy/totalJpy are in it. Absent = yen. */
  currency?: OrderCurrency
  methods: OrderEmailMethod[]
  transferDueAt: string
  region: 'JP' | 'OVERSEAS'
  orderUrl: string | null
  /**
   * RESERVE-FIRST (A2). 'ready' is the email confirm-web-order-ready sends when
   * staff confirm a reservation: the same items, methods and deadline, headed
   * as "your piece is confirmed". Absent (every caller before A2) reads
   * exactly as it always has.
   */
  variant?: 'placed' | 'ready'
}

export const orderConfirmationSubject = (reference: string) =>
  `ご注文ありがとうございます ${reference} / Your Cha Jewels order ${reference}`

export const orderReadySubject = (reference: string) =>
  `お支払いのご案内 ${reference} / Your Cha Jewels order ${reference} is ready for payment`

const COPY = {
  ja: {
    heading: 'ご注文ありがとうございます',
    intro: (ref: string) => `ご注文番号 ${ref} を承りました。下記のお振込先へ、期限までにお振込をお願いいたします。ご入金の確認後、発送の準備に入ります。`,
    payHeading: 'お振込先',
    deadline: (when: string) => `お振込期限：${when}`,
    deadlineNote: '期限を過ぎたご注文は自動的にキャンセルとなり、商品は再び販売されます。',
  },
  en: {
    heading: 'Thank you for your order',
    intro: (ref: string) => `We have received order ${ref}. Please transfer the total to one of the accounts below before the deadline. We prepare shipment once the transfer has arrived.`,
    payHeading: 'Where to transfer',
    deadline: (when: string) => `Transfer by: ${when}`,
    deadlineNote: 'After the deadline the order is cancelled automatically and the piece goes back on sale.',
  },
} as const

/** The 'ready' variant: only the heading and the opening line differ. */
const READY_COPY = {
  ja: {
    ...COPY.ja,
    heading: 'お品物のご用意ができました',
    intro: (ref: string) => `ご注文番号 ${ref} のお品物を確認いたしました。下記のお振込先へ、期限までにお振込をお願いいたします。ご入金の確認後、発送の準備に入ります。`,
  },
  en: {
    ...COPY.en,
    heading: 'Your piece is confirmed',
    intro: (ref: string) => `We have confirmed your piece for order ${ref}. Please transfer the total to one of the accounts below before the deadline. We prepare shipment once the transfer has arrived.`,
  },
} as const

const Block = ({ lang, p, primary }: { lang: Lang; p: OrderConfirmationProps; primary: boolean }) => {
  const c = p.variant === 'ready' ? READY_COPY[lang] : COPY[lang]
  return (
    <>
      <Heading style={primary ? h1 : h2}>{c.heading}</Heading>
      <Text style={text}>{c.intro(p.reference)}</Text>
      <ItemsTable items={p.items} shippingJpy={p.shippingJpy} totalJpy={p.totalJpy} lang={lang} currency={p.currency} />
      <Text style={{ ...text, fontWeight: 'bold' as const }}>{c.payHeading}</Text>
      <MethodCards methods={p.methods} lang={lang} />
      <Text style={{ ...text, fontWeight: 'bold' as const }}>{c.deadline(formatDeadline(p.transferDueAt, p.region, lang))}</Text>
      <Text style={muted}>{c.deadlineNote}</Text>
      {p.orderUrl && (
        <Section style={buttonWrap}>
          <Button style={button} href={p.orderUrl}>{WORDS.viewOrder[lang]}</Button>
        </Section>
      )}
    </>
  )
}

export const OrderConfirmationEmail = (p: OrderConfirmationProps) => {
  const other: Lang = p.lang === 'ja' ? 'en' : 'ja'
  return (
    <Html lang={p.lang} dir="ltr">
      <Head />
      <Preview>{p.variant === 'ready' ? orderReadySubject(p.reference) : orderConfirmationSubject(p.reference)}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={headerBar}>
            <Text style={wordmark}>Cha Jewels</Text>
          </Section>
          <Block lang={p.lang} p={p} primary />
          {p.lang === 'ja' && (
            <>
              <Hr style={rule} />
              <Block lang={other} p={p} primary={false} />
            </>
          )}
          <Hr style={rule} />
          <Text style={muted}>{WORDS.help[p.lang]}</Text>
          <Text style={footer}>{WORDS.footer[p.lang]}</Text>
        </Container>
      </Body>
    </Html>
  )
}

export default OrderConfirmationEmail
