/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import type { Lang } from '../storefront-email.ts'
import { ItemsTable, WORDS, button, buttonWrap, container, footer, h1, h2, headerBar, main, muted, notice, rule, text, wordmark, type OrderEmailItem, type OrderCurrency, type PayMethod, subjectFor } from './order-shared.tsx'

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
  /** The order's settlement currency; shippingJpy/totalJpy are in it. Absent = yen. */
  currency?: OrderCurrency
  orderUrl: string | null
  /**
   * Website orders PR 6: a DRAFT checkout. Shipping may not be known yet
   * (shippingJpy null) and staff may add a service or a discount when they
   * confirm, so the total is provisional. Absent reads exactly as before.
   */
  provisional?: boolean
  /** Points the customer chose at checkout (held until staff confirm), order currency. Absent/0 = none. */
  pointsApplied?: number
  /**
   * The method she chose at checkout (payment lifecycle H3). Absent = transfer.
   * Paidy / card never read "bank details will follow".
   */
  method?: PayMethod
  /** Cash on delivery fee (already in totalJpy), its own line. Absent/0 = none. */
  codFee?: number
}

export const orderReservedSubject = (reference: string, lang: Lang) =>
  subjectFor(lang, `ご注文を承りました ${reference}`, `We have your Cha Jewels order ${reference}`)

const COPY = {
  ja: {
    heading: 'ご注文を承りました',
    intro: (ref: string) => `ご注文番号 ${ref} を承りました。ありがとうございます。ただいまスタッフがお品物を確認しております。`,
    next: '確認が取れ次第、お支払い方法とお振込先をメールでご案内いたします。',
    nothingYet: '現時点でお支払いの必要はございません。お振込先はご案内メールと、アカウントページのご注文詳細でお知らせします。',
    provisional: '送料とご依頼のサービス料金は、確認の際に加算いたします。確定した合計金額はご案内メールでお知らせします。',
  },
  en: {
    heading: 'We have your order',
    intro: (ref: string) => `Thank you — we have received order ${ref}. Our staff are now confirming your piece.`,
    next: 'As soon as it is confirmed we will email you how to pay and where to send the transfer.',
    nothingYet: 'There is nothing to pay yet. The payment details will be in that email and on this order in your account.',
    provisional: 'Shipping, and any service you asked for, are added when we confirm. The final total will be in that email.',
  },
} as const

/** Paidy / card: what happens after staff confirm, with no bank words. */
const OTHER_COPY = {
  ja: {
    next: {
      paidy: '確認が取れ次第、メールでお知らせします。その後、ご注文ページの「ペイディで支払う」からお支払いいただけます。',
      card: '確認が取れ次第、メールでお知らせします。その後、ご注文ページの「カードで支払う」からお支払いいただけます。',
      cod: '確認が取れ次第、メールでお知らせし、発送いたします。お支払いはお届け時に配達員へ（代金引換）。',
    },
    nothingYet: '現時点でお支払いの必要はございません。',
  },
  en: {
    next: {
      paidy: 'As soon as it is confirmed we will email you, and you can then pay with Paidy from your order page.',
      card: 'As soon as it is confirmed we will email you, and you can then pay by card from your order page.',
      cod: 'As soon as it is confirmed we will email you and ship it. You pay the courier when it arrives (cash on delivery).',
    },
    nothingYet: 'There is nothing to pay yet.',
  },
} as const

const Block = ({ lang, p, primary }: { lang: Lang; p: OrderReservedProps; primary: boolean }) => {
  const base = COPY[lang]
  const other = p.method === 'paidy' || p.method === 'card' || p.method === 'cod' ? p.method : null
  const c = other ? { ...base, next: OTHER_COPY[lang].next[other], nothingYet: OTHER_COPY[lang].nothingYet } : base
  return (
    <>
      <Heading style={primary ? h1 : h2}>{c.heading}</Heading>
      <Text style={text}>{c.intro(p.reference)}</Text>
      <ItemsTable items={p.items} shippingJpy={p.shippingJpy} totalJpy={p.totalJpy} lang={lang} currency={p.currency} pointsApplied={p.pointsApplied} codFee={p.codFee} />
      {p.provisional && <Text style={muted}>{c.provisional}</Text>}
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
    <Preview>{orderReservedSubject(p.reference, p.lang)}</Preview>
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
