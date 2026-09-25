/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import { formatDeadline, type Lang } from '../storefront-email.ts'
import { ItemsTable, WORDS, button, buttonWrap, container, footer, h1, h2, headerBar, main, muted, rule, text, wordmark, type OrderEmailItem, type OrderCurrency } from './order-shared.tsx'

/**
 * Sent by auto-expire-cash-orders when the 72-hour transfer deadline passes
 * on a web order. The order is cancelled and the piece is back on sale; the
 * customer can order again if it is still there.
 */
export interface OrderExpiredProps {
  lang: Lang
  reference: string
  items: OrderEmailItem[]
  shippingJpy: number | null
  totalJpy: number
  /** The order's settlement currency; shippingJpy/totalJpy are in it. Absent = yen. */
  currency?: OrderCurrency
  transferDueAt: string
  region: 'JP' | 'OVERSEAS'
  shopUrl: string | null
}

export const orderExpiredSubject = (reference: string) =>
  `ご注文がキャンセルされました ${reference} / Your Cha Jewels order ${reference} has been cancelled`

const COPY = {
  ja: {
    heading: 'ご注文がキャンセルされました',
    intro: (ref: string, when: string) => `ご注文番号 ${ref} は、お振込期限（${when}）までにご入金の確認ができなかったため、自動的にキャンセルとなりました。商品は再び販売されています。`,
    again: 'まだ商品が残っている場合は、改めてご注文いただけます。すでにお振込済みの場合は、このメールにご返信ください。確認のうえ対応いたします。',
    shop: 'ショップを見る',
  },
  en: {
    heading: 'Your order has been cancelled',
    intro: (ref: string, when: string) => `Order ${ref} was cancelled automatically because the transfer had not arrived by the deadline (${when}). The piece is back on sale.`,
    again: 'If it is still available you are welcome to order it again. If you have already transferred, reply to this email and we will sort it out.',
    shop: 'Back to the shop',
  },
} as const

const Block = ({ lang, p, primary }: { lang: Lang; p: OrderExpiredProps; primary: boolean }) => {
  const c = COPY[lang]
  return (
    <>
      <Heading style={primary ? h1 : h2}>{c.heading}</Heading>
      <Text style={text}>{c.intro(p.reference, formatDeadline(p.transferDueAt, p.region, lang))}</Text>
      <ItemsTable items={p.items} shippingJpy={p.shippingJpy} totalJpy={p.totalJpy} lang={lang} currency={p.currency} />
      <Text style={text}>{c.again}</Text>
      {p.shopUrl && (
        <Section style={buttonWrap}>
          <Button style={button} href={p.shopUrl}>{c.shop}</Button>
        </Section>
      )}
    </>
  )
}

export const OrderExpiredEmail = (p: OrderExpiredProps) => (
  <Html lang={p.lang} dir="ltr">
    <Head />
    <Preview>{orderExpiredSubject(p.reference)}</Preview>
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

export default OrderExpiredEmail
