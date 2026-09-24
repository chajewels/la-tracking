/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import type { Lang } from '../storefront-email.ts'
import { ItemsTable, WORDS, button, buttonWrap, container, footer, h1, h2, headerBar, main, muted, notice, rule, text, wordmark, type OrderEmailItem } from './order-shared.tsx'

/**
 * RESERVE-FIRST (A2). Sent by web-reservation-sweep when nobody confirmed a
 * web order reservation within 72 hours and the order was cancelled. Polite,
 * and it does not blame the customer: the delay was ours. No payment details
 * were ever shown, so nothing was paid and the email says so.
 *
 * Staff "Can't supply" on a cash order uses order-cancelled.tsx with the
 * reason instead (decline-web-reservation).
 */
export interface OrderReservationLapsedProps {
  lang: Lang
  reference: string
  items: OrderEmailItem[]
  shippingJpy: number | null
  totalJpy: number
  shopUrl: string | null
}

export const orderReservationLapsedSubject = (reference: string) =>
  `ご注文のご案内 ${reference} / We could not confirm your Cha Jewels order ${reference}`

const COPY = {
  ja: {
    heading: 'お品物の確認が間に合いませんでした',
    intro: (ref: string) => `ご注文番号 ${ref} につきまして、72時間以内にお品物の確認を完了することができず、ご注文をキャンセルとさせていただきました。お待たせしてしまい、誠に申し訳ございません。`,
    nothingOwed: 'お支払いは発生しておりません。ご請求はございません。',
    again: 'お品物をご希望の場合は、改めてオンラインストアからご注文いただくか、このメールにご返信ください。スタッフがご案内いたします。',
    shop: 'オンラインストアを見る',
  },
  en: {
    heading: 'We could not confirm your piece in time',
    intro: (ref: string) => `We were not able to confirm the piece on order ${ref} within 72 hours, so we have cancelled the order. We are sorry for the wait.`,
    nothingOwed: 'Nothing was paid and nothing is owed.',
    again: 'If you would still like the piece, you are welcome to order it again from the online store, or reply to this email and we will help.',
    shop: 'Visit the store',
  },
} as const

const Block = ({ lang, p, primary }: { lang: Lang; p: OrderReservationLapsedProps; primary: boolean }) => {
  const c = COPY[lang]
  return (
    <>
      <Heading style={primary ? h1 : h2}>{c.heading}</Heading>
      <Text style={text}>{c.intro(p.reference)}</Text>
      <ItemsTable items={p.items} shippingJpy={p.shippingJpy} totalJpy={p.totalJpy} lang={lang} />
      <Text style={notice}>{c.nothingOwed}</Text>
      <Text style={text}>{c.again}</Text>
      {p.shopUrl && (
        <Section style={buttonWrap}>
          <Button style={button} href={p.shopUrl}>{c.shop}</Button>
        </Section>
      )}
    </>
  )
}

export const OrderReservationLapsedEmail = (p: OrderReservationLapsedProps) => (
  <Html lang={p.lang} dir="ltr">
    <Head />
    <Preview>{orderReservationLapsedSubject(p.reference)}</Preview>
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

export default OrderReservationLapsedEmail
