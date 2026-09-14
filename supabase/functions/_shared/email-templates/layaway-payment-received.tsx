/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import { formatMoney, type Lang } from '../storefront-email.ts'
import { WORDS, button, buttonWrap, container, footer, h1, h2, headerBar, main, muted, rule, text, wordmark } from './order-shared.tsx'
import { LAYAWAY_WORDS, ScheduleTable, formatDueDate, type LayawayScheduleRow } from './layaway-shared.tsx'

/**
 * Sent by review-payment-submission when a CSR confirms a transfer on a web
 * layaway. Two moments use the same template: the deposit (which confirms the
 * reservation) and every instalment after it. `isDeposit` picks the wording.
 */
export interface LayawayPaymentReceivedProps {
  lang: Lang
  reference: string
  currency: 'JPY' | 'PHP'
  isDeposit: boolean
  amountReceived: number
  remaining: number
  schedule: LayawayScheduleRow[]
  nextDueDate: string | null
  nextDueAmount: number | null
  planUrl: string | null
}

export const layawayPaymentReceivedSubject = (reference: string, isDeposit: boolean) =>
  isDeposit
    ? `お申込金を確認しました ${reference} / Deposit received — Cha Jewels ${reference}`
    : `お支払いを確認しました ${reference} / Payment received — Cha Jewels ${reference}`

const COPY = {
  ja: {
    headingDeposit: 'お申込金を確認しました',
    headingInstalment: 'お支払いを確認しました',
    introDeposit: (ref: string, amt: string) =>
      `ご予約番号 ${ref} のお申込金 ${amt} を確認いたしました。ご予約が確定しました。`,
    introInstalment: (ref: string, amt: string) =>
      `ご予約番号 ${ref} のお支払い ${amt} を確認いたしました。ありがとうございます。`,
    next: (date: string, amt: string) => `次回のお支払いは ${date}、${amt} です。`,
    done: 'お支払いはすべて完了しました。発送のご準備が整いましたらご連絡いたします。',
  },
  en: {
    headingDeposit: 'Deposit received',
    headingInstalment: 'Payment received',
    introDeposit: (ref: string, amt: string) =>
      `We have received your deposit of ${amt} for ${ref}. Your reservation is confirmed.`,
    introInstalment: (ref: string, amt: string) =>
      `We have received your payment of ${amt} for ${ref}. Thank you.`,
    next: (date: string, amt: string) => `Your next payment is ${amt}, due ${date}.`,
    done: 'Your plan is paid in full. We will be in touch when your piece is ready to ship.',
  },
} as const

const Block = ({ lang, p, primary }: { lang: Lang; p: LayawayPaymentReceivedProps; primary: boolean }) => {
  const c = COPY[lang]
  return (
    <>
      <Heading style={primary ? h1 : h2}>{p.isDeposit ? c.headingDeposit : c.headingInstalment}</Heading>
      <Text style={text}>
        {p.isDeposit
          ? c.introDeposit(p.reference, formatMoney(p.amountReceived, p.currency))
          : c.introInstalment(p.reference, formatMoney(p.amountReceived, p.currency))}
      </Text>
      <Text style={text}>
        {p.nextDueDate && p.nextDueAmount
          ? c.next(formatDueDate(p.nextDueDate, lang), formatMoney(p.nextDueAmount, p.currency))
          : c.done}
      </Text>
      <ScheduleTable rows={p.schedule} currency={p.currency} lang={lang} />
      <Text style={muted}>
        {LAYAWAY_WORDS.remaining[lang]}: {formatMoney(p.remaining, p.currency)}
      </Text>
      {p.planUrl && (
        <Section style={buttonWrap}>
          <Button style={button} href={p.planUrl}>{LAYAWAY_WORDS.viewPlan[lang]}</Button>
        </Section>
      )}
    </>
  )
}

export const LayawayPaymentReceivedEmail = (p: LayawayPaymentReceivedProps) => (
  <Html lang={p.lang} dir="ltr">
    <Head />
    <Preview>{layawayPaymentReceivedSubject(p.reference, p.isDeposit)}</Preview>
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

export default LayawayPaymentReceivedEmail
