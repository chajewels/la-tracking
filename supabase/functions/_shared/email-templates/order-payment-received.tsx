/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import { formatDeadline, orderMoney, type Lang } from '../storefront-email.ts'
import { ItemsTable, WORDS, button, buttonWrap, container, footer, h1, h2, headerBar, main, muted, rule, text, wordmark, type OrderEmailItem, type OrderCurrency, type PayMethod, subjectFor } from './order-shared.tsx'

/**
 * Sent by review-payment-submission when a CSR confirms a payment on a web
 * order. Says the money arrived, BY THE METHOD SHE USED (payment lifecycle H3:
 * a Paidy or card buyer was told "your transfer"), and what happens next.
 *
 * Fully paid → the shipping note. PARTLY paid (`remaining > 0`) → what is still
 * to pay and by when, and no shipping promise yet.
 *
 * Points used at checkout are a LOYALTY DISCOUNT, never money received: they
 * show only as the "Points used" line under the total, never in the
 * "we have received ¥X" sentence. When points paid the WHOLE order
 * (amountReceivedJpy 0, confirm-web-draft) the intro says so instead.
 */
export interface OrderPaymentReceivedProps {
  lang: Lang
  reference: string
  items: OrderEmailItem[]
  shippingJpy: number | null
  totalJpy: number
  /** The order's settlement currency; shippingJpy/totalJpy are in it. Absent = yen. */
  currency?: OrderCurrency
  /** In the order's currency, like totalJpy. The money this payment brought in. */
  amountReceivedJpy: number
  orderUrl: string | null
  /** How this payment was made. Absent = transfer (every order before 2026-10-05). */
  method?: PayMethod
  /** Points used at checkout (cash_order_points_paid), order currency. Absent/0 = none. */
  pointsApplied?: number
  /** Still owed after this payment. > 0 = the PARTIAL variant. Absent/null/0 = fully paid. */
  remaining?: number | null
  /** The order's deadline, for the partial variant's "still to pay … by" line. */
  transferDueAt?: string | null
  region?: 'JP' | 'OVERSEAS'
}

export const orderPaymentReceivedSubject = (reference: string, lang: Lang) =>
  subjectFor(lang, `お支払いを確認しました ${reference}`, `Payment received — Cha Jewels order ${reference}`)

const COPY = {
  ja: {
    heading: 'お支払いを確認しました',
    partHeading: 'お支払いの一部を受領しました',
    intro: {
      transfer: (ref: string, amt: string) => `ご注文番号 ${ref} のお振込 ${amt} を確認いたしました。ありがとうございます。`,
      paidy: (ref: string, amt: string) => `ご注文番号 ${ref} のペイディでのお支払い ${amt} を確認いたしました。ありがとうございます。`,
      card: (ref: string, amt: string) => `ご注文番号 ${ref} のカードでのお支払い ${amt} を確認いたしました。ありがとうございます。`,
      cod: (ref: string, amt: string) => `ご注文番号 ${ref} の代金引換でのお支払い ${amt} を、配送業者から受領いたしました。ありがとうございます。`,
    },
    codDone: 'お品物のお受け取り、ありがとうございました。',
    pointsIntro: (ref: string) => `ご注文番号 ${ref} は、ポイントで全額のお支払いが完了しました。ありがとうございます。`,
    partIntro: (ref: string, m: string, amt: string) => `ご注文番号 ${ref} について、${m}でのお支払い ${amt} を確認し、ご注文金額の一部を受領いたしました。ありがとうございます。`,
    stillToPay: (amt: string, when: string) => when ? `残りのお支払い金額 ${amt} を、${when} までにお支払いください。` : `残りのお支払い金額 ${amt} のお支払いをお願いいたします。`,
    partNext: 'ご注文金額のお支払いがすべて確認できましたら、発送の準備に入ります。',
    shipping: 'これより発送の準備に入ります。発送が完了しましたら、追跡番号をメールとご注文ページでお知らせします。ご注文ページの「発送済み」表示もあわせてご確認ください。',
  },
  en: {
    heading: 'Payment received',
    partHeading: 'Part of your payment received',
    intro: {
      transfer: (ref: string, amt: string) => `We have received your transfer of ${amt} for order ${ref}. Thank you.`,
      paidy: (ref: string, amt: string) => `We have received your payment of ${amt} with Paidy for order ${ref}. Thank you.`,
      card: (ref: string, amt: string) => `We have received your card payment of ${amt} for order ${ref}. Thank you.`,
      cod: (ref: string, amt: string) => `The courier has passed on your cash on delivery payment of ${amt} for order ${ref}. Thank you.`,
    },
    codDone: 'Thank you for receiving your parcel.',
    pointsIntro: (ref: string) => `Order ${ref} is fully paid with your loyalty points. Thank you.`,
    partIntro: (ref: string, m: string, amt: string) => `We have received ${amt} by ${m} for order ${ref} — part of the order total. Thank you.`,
    stillToPay: (amt: string, when: string) => when ? `Amount still to pay: ${amt}, by ${when}.` : `Amount still to pay: ${amt}.`,
    partNext: 'We prepare your shipment once the order is paid in full.',
    shipping: 'We are now preparing your shipment. When it leaves us, we will send the tracking number by email and show it on your order page, where the status changes to "Shipped".',
  },
} as const

const PART_METHOD = {
  ja: { transfer: 'お振込', paidy: 'ペイディ', card: 'カード', cod: '代金引換' },
  en: { transfer: 'bank transfer', paidy: 'Paidy', card: 'card', cod: 'cash on delivery' },
} as const

const Block = ({ lang, p, primary }: { lang: Lang; p: OrderPaymentReceivedProps; primary: boolean }) => {
  const c = COPY[lang]
  const method: PayMethod = p.method ?? 'transfer'
  const amt = orderMoney(p.amountReceivedJpy, p.currency)
  const partial = p.remaining !== undefined && p.remaining !== null && p.remaining > 0
  // H5: points paid the WHOLE order (confirm-web-draft) — no money arrived, so
  // never "we have received ¥0 by transfer".
  const pointsOnly = !partial && !(p.amountReceivedJpy > 0) && (p.pointsApplied ?? 0) > 0
  const when = partial && p.transferDueAt ? formatDeadline(p.transferDueAt, p.region ?? 'JP', lang) : ''
  return (
    <>
      <Heading style={primary ? h1 : h2}>{partial ? c.partHeading : c.heading}</Heading>
      <Text style={text}>{partial ? c.partIntro(p.reference, PART_METHOD[lang][method], amt) : pointsOnly ? c.pointsIntro(p.reference) : c.intro[method](p.reference, amt)}</Text>
      <ItemsTable items={p.items} shippingJpy={p.shippingJpy} totalJpy={p.totalJpy} lang={lang} currency={p.currency} pointsApplied={p.pointsApplied} afterPointsLabel={WORDS.totalAfterPoints} />
      {partial ? (
        <>
          <Text style={{ ...text, fontWeight: 'bold' as const }}>{c.stillToPay(orderMoney(p.remaining as number, p.currency), when)}</Text>
          <Text style={text}>{c.partNext}</Text>
        </>
      ) : (
        <Text style={text}>{method === 'cod' ? c.codDone : c.shipping}</Text>
      )}
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
    <Preview>{orderPaymentReceivedSubject(p.reference, p.lang)}</Preview>
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
