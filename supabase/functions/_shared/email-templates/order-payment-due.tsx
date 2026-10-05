/// <reference types="npm:@types/react@18.3.1" />
/* eslint-disable react-refresh/only-export-components -- an email template, never hot-reloaded; the subject helper lives beside it like every other template */
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import { formatDeadline, orderMoney, type Lang } from '../storefront-email.ts'
import { MethodCards, Panel, Row, WORDS, block, blockGutter, button, buttonWrap, container, footer, h1, h2, headerBar, main, muted, rule, text, wordmark, type OrderEmailMethod, type OrderCurrency, type PayMethod, subjectFor } from './order-shared.tsx'

/**
 * STAGE D PAYMENT REMINDER for a confirmed web ORDER (docs/WEB-PAYMENT-
 * REMINDERS.md), sent once by web-payment-reminder-sweep when the transfer
 * deadline is near and nothing has arrived: 6 hours before a 24-hour deadline,
 * 24 hours before a 72-hour one.
 *
 * Transactional, about the customer's own order: the amount still owed in the
 * order's currency, the deadline, how to pay, and what happens if it passes.
 *
 * METHOD-AWARE (payment lifecycle H3): `method` is the one she chose. Transfer
 * → every transfer method for the currency and the transfer wording; Paidy /
 * card → no bank details and no bank or transfer wording at all, the order
 * page's "Pay with Paidy" / "Pay by card" button instead (`methods` is []). NOTHING ELSE — no products, no offers, no
 * layaway. A promotion here would make it a 特定電子メール and need consent.
 *
 * Language: the customer's, Japanese first then English — the same rule as
 * every other order email (a customer who ordered in English reads English).
 */
export interface OrderPaymentDueProps {
  lang: Lang
  reference: string
  /** The order's settlement currency; `amount` is in it. */
  currency: OrderCurrency
  /** cash_orders.remaining_balance at the moment the reminder was claimed. */
  amount: number
  /**
   * The method she chose (cash_orders.payment_method via publicMethod).
   * Absent = transfer. Paidy / card: `methods` must be [] — no bank details,
   * the order page's Paidy / card button instead (payment lifecycle H3).
   */
  method?: PayMethod
  methods: OrderEmailMethod[]
  transferDueAt: string
  region: 'JP' | 'OVERSEAS'
  orderUrl: string | null
}

export const orderPaymentDueSubject = (reference: string, lang: Lang) =>
  subjectFor(lang, `お支払い期限のご案内 ${reference}`, `Payment reminder — Cha Jewels order ${reference}`)

const COPY = {
  ja: {
    heading: 'お支払い期限のご案内',
    intro: (ref: string, when: string) =>
      `ご注文番号 ${ref} のお振込期限は ${when} です。まだお振込がお済みでない場合は、下記のお振込先へ期限までにお振込をお願いいたします。`,
    amount: 'お振込金額',
    payHeading: 'お振込先',
    deadline: (when: string) => `お振込期限：${when}`,
    deadlineNote: '期限を過ぎたご注文は自動的にキャンセルとなり、商品は再び販売されます。',
    already: 'すでにお振込済みの場合は、お振込の控えをこのメールにご返信ください。行き違いの際はご容赦ください。',
  },
  en: {
    heading: 'Your payment is due soon',
    intro: (ref: string, when: string) =>
      `This is a reminder that payment for order ${ref} is due by ${when}. If you have not transferred yet, please send the amount below to one of these accounts before the deadline.`,
    amount: 'Amount to transfer',
    payHeading: 'Where to transfer',
    deadline: (when: string) => `Transfer by: ${when}`,
    deadlineNote: 'After the deadline the order is cancelled automatically and the piece goes back on sale.',
    already: 'Already paid? Please reply to this email with your transfer receipt. If our messages crossed, please ignore this one.',
  },
} as const

/** Paidy / card: the same reminder without a single bank word — she pays from the order page. */
const BUTTON_NAME = {
  ja: { paidy: '「ペイディで支払う」', card: '「カードで支払う」' },
  en: { paidy: '"Pay with Paidy"', card: '"Pay by card"' },
} as const
const OTHER_COPY = {
  ja: {
    intro: (ref: string, when: string, b: string) =>
      `ご注文番号 ${ref} のお支払い期限は ${when} です。まだお支払いがお済みでない場合は、ご注文ページの${b}から期限までにお手続きをお願いいたします。`,
    amount: WORDS.amountDue.ja,
    payHeading: 'お支払い方法',
    how: { paidy: 'あと払い（ペイディ）：ご注文ページの「ペイディで支払う」からお進みください。', card: 'クレジットカード・デビットカード（日本円）：ご注文ページの「カードで支払う」からお進みください。' },
    deadline: (when: string) => `お支払い期限：${when}`,
    already: 'すでにお手続き済みの場合は、行き違いですのでご容赦ください。',
  },
  en: {
    intro: (ref: string, when: string, b: string) =>
      `This is a reminder that payment for order ${ref} is due by ${when}. If you have not paid yet, choose ${b} on your order page before the deadline.`,
    amount: WORDS.amountDue.en,
    payHeading: 'How to pay',
    how: { paidy: 'Paidy (あと払い): choose "Pay with Paidy" on your order page.', card: 'Card (charged in yen): choose "Pay by card" on your order page.' },
    deadline: (when: string) => `Pay by: ${when}`,
    already: 'Already paid? If our messages crossed, please ignore this one.',
  },
} as const

const Block = ({ lang, p, primary }: { lang: Lang; p: OrderPaymentDueProps; primary: boolean }) => {
  const c = COPY[lang]
  const when = formatDeadline(p.transferDueAt, p.region, lang)
  const other = p.method === 'paidy' || p.method === 'card' ? p.method : null
  const o = OTHER_COPY[lang]
  return (
    <>
      <Heading style={primary ? h1 : h2}>{c.heading}</Heading>
      <Text style={text}>{other ? o.intro(p.reference, when, BUTTON_NAME[lang][other]) : c.intro(p.reference, when)}</Text>
      <Panel gutter={blockGutter} box={block}>
        {/* Row is a table, not flex — Gmail drops display:flex. See order-shared. */}
        <Row k={WORDS.reference[lang]} v={p.reference} />
        <Row k={other ? o.amount : c.amount} v={orderMoney(p.amount, p.currency)} emphasis />
      </Panel>
      <Text style={{ ...text, fontWeight: 'bold' as const }}>{other ? o.payHeading : c.payHeading}</Text>
      {other ? <Text style={text}>{o.how[other]}</Text> : <MethodCards methods={p.methods} lang={lang} />}
      <Text style={{ ...text, fontWeight: 'bold' as const }}>{other ? o.deadline(when) : c.deadline(when)}</Text>
      <Text style={muted}>{c.deadlineNote}</Text>
      <Text style={muted}>{other ? o.already : c.already}</Text>
      {p.orderUrl && (
        <Section style={buttonWrap}>
          <Button style={button} href={p.orderUrl}>{WORDS.viewOrder[lang]}</Button>
        </Section>
      )}
    </>
  )
}

export const OrderPaymentDueEmail = (p: OrderPaymentDueProps) => (
  <Html lang={p.lang} dir="ltr">
    <Head />
    <Preview>{orderPaymentDueSubject(p.reference, p.lang)}</Preview>
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

export default OrderPaymentDueEmail
