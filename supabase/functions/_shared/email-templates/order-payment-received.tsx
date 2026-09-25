/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import { orderMoney, type Lang } from '../storefront-email.ts'
import { ItemsTable, WORDS, button, buttonWrap, container, footer, h1, h2, headerBar, main, muted, rule, text, wordmark, type OrderEmailItem, type OrderCurrency } from './order-shared.tsx'

/**
 * Sent by review-payment-submission when a CSR confirms the transfer for a
 * web order and the order is fully paid. Says the money arrived and what
 * happens next (shipping), with the link to the order page.
 */
export interface OrderPaymentReceivedProps {
  lang: Lang
  reference: string
  items: OrderEmailItem[]
  shippingJpy: number | null
  totalJpy: number
  /** The order's settlement currency; shippingJpy/totalJpy are in it. Absent = yen. */
  currency?: OrderCurrency
  /** In the order's currency, like totalJpy. */
  amountReceivedJpy: number
  orderUrl: string | null
}

export const orderPaymentReceivedSubject = (reference: string) =>
  `お支払いを確認しました ${reference} / Payment received — Cha Jewels order ${reference}`

const COPY = {
  ja: {
    heading: 'お支払いを確認しました',
    intro: (ref: string, amt: string) => `ご注文番号 ${ref} のお振込 ${amt} を確認いたしました。ありがとうございます。`,
    shipping: 'これより発送の準備に入ります。発送が完了しましたら、追跡番号をメールとご注文ページでお知らせします。ご注文ページの「発送済み」表示もあわせてご確認ください。',
  },
  en: {
    heading: 'Payment received',
    intro: (ref: string, amt: string) => `We have received your transfer of ${amt} for order ${ref}. Thank you.`,
    shipping: 'We are now preparing your shipment. When it leaves us, we will send the tracking number by email and show it on your order page, where the status changes to "Shipped".',
  },
} as const

const Block = ({ lang, p, primary }: { lang: Lang; p: OrderPaymentReceivedProps; primary: boolean }) => {
  const c = COPY[lang]
  return (
    <>
      <Heading style={primary ? h1 : h2}>{c.heading}</Heading>
      <Text style={text}>{c.intro(p.reference, orderMoney(p.amountReceivedJpy, p.currency))}</Text>
      <ItemsTable items={p.items} shippingJpy={p.shippingJpy} totalJpy={p.totalJpy} lang={lang} currency={p.currency} />
      <Text style={text}>{c.shipping}</Text>
      {p.orderUrl && (
        <Section style={buttonWrap}>
          <Button style={button} href={p.orderUrl}>{WORDS.viewOrder[lang]}</Button>
        </Section>
      )}
    </>
  )
}

export const OrderPaymentReceivedEmail = (p: OrderPaymentReceivedProps) => (
  <Html lang={p.lang} dir="ltr">
    <Head />
    <Preview>{orderPaymentReceivedSubject(p.reference)}</Preview>
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

export default OrderPaymentReceivedEmail
