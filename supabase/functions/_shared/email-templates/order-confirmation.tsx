/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import { formatDeadline, orderMoney, type Lang } from '../storefront-email.ts'
import { ItemsTable, MethodCards, WORDS, button, buttonWrap, container, footer, h1, h2, headerBar, main, muted, rule, text, wordmark, type OrderEmailItem, type OrderEmailMethod, type OrderCurrency, type PayMethod, METHOD_NAME, subjectFor } from './order-shared.tsx'

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
  /**
   * Website orders PR 6: the courier staff chose on the review screen
   * ("Pabitbit", "Yamato Transport"…). Absent = no line, as before.
   */
  courier?: string | null
  /**
   * Paidy ato-barai (2026-10-03): true when the Hub offers 『あと払い（ペイディ）』
   * on this order (switch on, yen, Japanese delivery address). One line under
   * the transfer methods pointing at the order page; the figures are unchanged.
   */
  paidy?: boolean
  /**
   * C1 (owner 2026-10-05): the method the customer chose at checkout. Once
   * staff confirm, the email shows ONLY that one: 'transfer' (or absent) the
   * accounts as before; 'paidy' / 'card' no bank details, a pointer to the
   * order page instead.
   */
  chosenMethod?: 'transfer' | 'paidy' | 'card' | 'cod'
  /** Points used at checkout, already taken off (order currency). Absent/0 = none. */
  pointsApplied?: number
  /**
   * Cash on delivery (owner plan 2026-10-10): the 代引手数料, already in the
   * total, shown on its own line. With chosenMethod 'cod' the email says the
   * piece ships and is paid to the courier on delivery — no bank details, no
   * deadline lines.
   */
  codFee?: number
  /**
   * Payment lifecycle H3: the method was just changed (by staff, or by her
   * after a rejected payment). Heading 「お支払い方法を変更しました」 and an
   * old → new line, then the NEW method's instructions (chosenMethod).
   * `from` unknown (no audit row) → the heading still says it changed, no
   * old → new line, so the subject and heading always agree.
   */
  methodChanged?: { from?: PayMethod | null }
}

/** C1: how to pay when the customer chose Paidy or card (no bank details). */
export const CHOSEN_METHOD_LINE = {
  paidy: {
    ja: 'お支払い方法：あと払い（ペイディ）。ご注文ページの「ペイディで支払う」から、期限までにお手続きください。',
    en: 'You chose Paidy (あと払い). Choose "Pay with Paidy" on your order page before the deadline.',
  },
  card: {
    ja: 'お支払い方法：クレジットカード・デビットカード（日本円でのお支払い）。ご注文ページの「カードで支払う」から、期限までにお手続きください。',
    en: 'You chose to pay by card (charged in yen). Choose "Pay by card" on your order page before the deadline.',
  },
} as const

/** Cash on delivery: no deadline — it ships, and she pays the courier on delivery. */
export const COD_COPY = {
  ja: {
    intro: (ref: string) => `ご注文番号 ${ref} のお品物を確認いたしました。お支払いは代金引換です。準備ができしだい発送いたします。`,
    line: (amt: string) => `お品物のお届け時に、配達員へ ${amt}（代引手数料を含む）をお支払いください。それまでにお支払いいただくものはありません。`,
  },
  en: {
    intro: (ref: string) => `We have confirmed your piece for order ${ref}. You chose cash on delivery, so we ship it as soon as it is ready.`,
    line: (amt: string) => `Please pay ${amt} (the cash on delivery fee included) to the courier when your parcel arrives. There is nothing to pay before then.`,
  },
} as const

const PAY_BY = {
  ja: { heading: 'お支払い方法', deadline: (when: string) => `お支払い期限：${when}` },
  en: { heading: 'How to pay', deadline: (when: string) => `Pay by: ${when}` },
} as const

/** The 'ready' opening line when the customer chose Paidy or card. */
const READY_INTRO_NOT_TRANSFER = {
  ja: (ref: string) => `ご注文番号 ${ref} のお品物を確認いたしました。下記のお支払い方法で、期限までにお支払いをお願いいたします。お支払いの確認後、発送の準備に入ります。`,
  en: (ref: string) => `We have confirmed your piece for order ${ref}. Please pay with the method below before the deadline. We prepare shipment once the payment is confirmed.`,
} as const

export const PAIDY_LINE = {
  ja: 'あと払い（ペイディ）もご利用いただけます。ご注文ページの「ペイディで支払う」からお進みください（日本国内のお届け先のみ）。',
  en: 'Paidy (あと払い) is also available for this order: pay next month, or in 3 instalments from the Paidy app. Choose "Pay with Paidy" on your order page (delivery addresses in Japan only).',
} as const

export const orderConfirmationSubject = (reference: string, lang: Lang) =>
  subjectFor(lang, `ご注文ありがとうございます ${reference}`, `Your Cha Jewels order ${reference}`)

export const orderMethodChangedSubject = (reference: string, lang: Lang) =>
  subjectFor(lang, `お支払い方法を変更しました ${reference}`, `Your payment method has changed — Cha Jewels order ${reference}`)

const METHOD_CHANGED = {
  ja: { heading: 'お支払い方法を変更しました', line: (from: string, to: string) => `お支払い方法：${from} → ${to}` },
  en: { heading: 'Your payment method has changed', line: (from: string, to: string) => `Payment method: ${from} → ${to}` },
} as const

export const orderReadySubject = (reference: string, lang: Lang) =>
  subjectFor(lang, `お支払いのご案内 ${reference}`, `Your Cha Jewels order ${reference} is ready for payment`)

const COPY = {
  ja: {
    heading: 'ご注文ありがとうございます',
    intro: (ref: string) => `ご注文番号 ${ref} を承りました。下記のお振込先へ、期限までにお振込をお願いいたします。ご入金の確認後、発送の準備に入ります。`,
    payHeading: 'お振込先',
    deadline: (when: string) => `お振込期限：${when}`,
    deadlineNote: '期限を過ぎたご注文は自動的にキャンセルとなり、商品は再び販売されます。',
    courier: (name: string) => `配送：${name}`,
  },
  en: {
    heading: 'Thank you for your order',
    intro: (ref: string) => `We have received order ${ref}. Please transfer the total to one of the accounts below before the deadline. We prepare shipment once the transfer has arrived.`,
    payHeading: 'Where to transfer',
    deadline: (when: string) => `Transfer by: ${when}`,
    deadlineNote: 'After the deadline the order is cancelled automatically and the piece goes back on sale.',
    courier: (name: string) => `Shipping by: ${name}`,
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
  const other = p.chosenMethod === 'paidy' || p.chosenMethod === 'card' ? p.chosenMethod : null
  const cod = p.chosenMethod === 'cod'
  const changed = p.methodChanged ? METHOD_CHANGED[lang] : null
  const collect = p.totalJpy - (p.pointsApplied ?? 0)
  return (
    <>
      <Heading style={primary ? h1 : h2}>{changed ? changed.heading : c.heading}</Heading>
      {changed && p.methodChanged?.from && (
        <Text style={{ ...text, fontWeight: 'bold' as const }}>
          {changed.line(METHOD_NAME[lang][p.methodChanged.from], METHOD_NAME[lang][p.chosenMethod ?? 'transfer'])}
        </Text>
      )}
      <Text style={text}>{cod ? COD_COPY[lang].intro(p.reference) : other ? READY_INTRO_NOT_TRANSFER[lang](p.reference) : c.intro(p.reference)}</Text>
      <ItemsTable items={p.items} shippingJpy={p.shippingJpy} totalJpy={p.totalJpy} lang={lang} currency={p.currency} pointsApplied={p.pointsApplied} codFee={p.codFee} />
      {p.courier && <Text style={muted}>{c.courier(p.courier)}</Text>}
      <Text style={{ ...text, fontWeight: 'bold' as const }}>{cod || other ? PAY_BY[lang].heading : c.payHeading}</Text>
      {cod ? (
        <Text style={text}>{COD_COPY[lang].line(orderMoney(collect, p.currency))}</Text>
      ) : other ? (
        <Text style={text}>{CHOSEN_METHOD_LINE[other][lang]}</Text>
      ) : (
        <>
          <MethodCards methods={p.methods} lang={lang} />
          {p.paidy && <Text style={text}>{PAIDY_LINE[lang]}</Text>}
        </>
      )}
      {!cod && (
        <>
          <Text style={{ ...text, fontWeight: 'bold' as const }}>{other ? PAY_BY[lang].deadline(formatDeadline(p.transferDueAt, p.region, lang)) : c.deadline(formatDeadline(p.transferDueAt, p.region, lang))}</Text>
          <Text style={muted}>{c.deadlineNote}</Text>
        </>
      )}
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
      <Preview>{p.methodChanged ? orderMethodChangedSubject(p.reference, p.lang) : p.variant === 'ready' ? orderReadySubject(p.reference, p.lang) : orderConfirmationSubject(p.reference, p.lang)}</Preview>
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
