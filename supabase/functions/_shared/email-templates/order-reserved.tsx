/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import type { Lang } from '../storefront-email.ts'
import { ItemsTable, WORDS, button, buttonWrap, container, footer, h1, h2, headerBar, main, muted, notice, rule, text, wordmark, type OrderEmailItem } from './order-shared.tsx'

/**
 * RESERVE-FIRST (A2). Sent by the `website` function when /checkout/pay
 * succeeds with system_settings.web_reservation_mode on. The piece is held,
 * staff have not yet confirmed it, and NOTHING about payment is said: no bank
 * details, no deadline (owner decision 2026-09-23 — bank details are never
 * shown or emailed before confirmation). The "ready — pay now" email follows
 * from confirm-web-order-ready.
 *
 * With the switch off this email is never sent; order-confirmation.tsx is,
 * exactly as before.
 */
export interface OrderReservedProps {
  lang: Lang
  reference: string
  items: OrderEmailItem[]
  shippingJpy: number | null
  totalJpy: number
  orderUrl: string | null
}

export const orderReservedSubject = (reference: string) =>
  `ご注文を承りました ${reference} / We have your Cha Jewels order ${reference}`

const COPY = {
  ja: {
    heading: 'ご注文を承りました',
    intro: (ref: string) => `ご注文番号 ${ref} を承りました。ありがとうございます。ただいまスタッフがお品物を確認しております。`,
    next: '確認が取れ次第、お支払い方法とお振込先をメールでご案内いたします。',
    nothingYet: '現時点でお支払いの必要はございません。お振込先はご案内メールと、アカウントページのご注文詳細でお知らせします。',
  },
  en: {
    heading: 'We have your order',
    intro: (ref: string) => `Thank you — we have received order ${ref}. Our staff are now confirming your piece.`,
    next: 'As soon as it is confirmed we will email you how to pay and where to send the transfer.',
    nothingYet: 'There is nothing to pay yet. The payment details will be in that email and on this order in your account.',
  },
} as const

const Block = ({ lang, p, primary }: { lang: Lang; p: OrderReservedProps; primary: boolean }) => {
  const c = COPY[lang]
  return (
    <>
      <Heading style={primary ? h1 : h2}>{c.heading}</Heading>
      <Text style={text}>{c.intro(p.reference)}</Text>
      <ItemsTable items={p.items} shippingJpy={p.shippingJpy} totalJpy={p.totalJpy} lang={lang} />
      <Text style={text}>{c.next}</Text>
      <Text style={notice}>{c.nothingYet}</Text>
      {p.orderUrl && (
        <Section style={buttonWrap}>
          <Button style={button} href={p.orderUrl}>{WORDS.viewOrder[lang]}</Button>
        </Section>
      )}
    </>
  )
}

export const OrderReservedEmail = (p: OrderReservedProps) => (
  <Html lang={p.lang} dir="ltr">
    <Head />
    <Preview>{orderReservedSubject(p.reference)}</Preview>
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

export default OrderReservedEmail
