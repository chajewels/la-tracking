/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import { formatMoney } from '../storefront-email.ts'
import { WORDS, button, buttonWrap, container, footer, h1, headerBar, main, muted, rule, text, wordmark } from './order-shared.tsx'
import { LAYAWAY_WORDS, ScheduleTable, formatDueDate, type LayawayScheduleRow } from './layaway-shared.tsx'

/**
 * Sent by review-payment-submission when a CSR confirms a transfer on a web
 * layaway. Two moments use the same template: the deposit (which confirms the
 * reservation) and every instalment after it. `isDeposit` picks the wording.
 *
 * ENGLISH ONLY, BY CONSTRUCTION (owner rule 2026-09-27: no layaway email is
 * sent in Japanese — subject or body). There is no `lang` prop and no Japanese
 * copy; development/layaway-english.test.ts fails on any Japanese character.
 */
export interface LayawayPaymentReceivedProps {
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
    ? `Deposit received — Cha Jewels ${reference}`
    : `Payment received — Cha Jewels ${reference}`

const COPY = {
  headingDeposit: 'Deposit received',
  headingInstalment: 'Payment received',
  introDeposit: (ref: string, amt: string) =>
    `We have received your deposit of ${amt} for ${ref}. Your reservation is confirmed.`,
  introInstalment: (ref: string, amt: string) =>
    `We have received your payment of ${amt} for ${ref}. Thank you.`,
  next: (date: string, amt: string) => `Your next payment is ${amt}, due ${date}.`,
  done: 'Your plan is paid in full. We will be in touch when your piece is ready to ship.',
} as const

const Content = ({ p }: { p: LayawayPaymentReceivedProps }) => {
  const c = COPY
  return (
    <>
      <Heading style={h1}>{p.isDeposit ? c.headingDeposit : c.headingInstalment}</Heading>
      <Text style={text}>
        {p.isDeposit
          ? c.introDeposit(p.reference, formatMoney(p.amountReceived, p.currency))
          : c.introInstalment(p.reference, formatMoney(p.amountReceived, p.currency))}
      </Text>
      <Text style={text}>
        {p.nextDueDate && p.nextDueAmount
          ? c.next(formatDueDate(p.nextDueDate), formatMoney(p.nextDueAmount, p.currency))
          : c.done}
      </Text>
      <ScheduleTable rows={p.schedule} currency={p.currency} />
      <Text style={muted}>
        {LAYAWAY_WORDS.remaining}: {formatMoney(p.remaining, p.currency)}
      </Text>
      {p.planUrl && (
        <Section style={buttonWrap}>
          <Button style={button} href={p.planUrl}>{LAYAWAY_WORDS.viewPlan}</Button>
        </Section>
      )}
    </>
  )
}

export const LayawayPaymentReceivedEmail = (p: LayawayPaymentReceivedProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>{layawayPaymentReceivedSubject(p.reference, p.isDeposit)}</Preview>
    <Body style={main}>
      <Container style={container}>
        <Section style={headerBar}>
          <Text style={wordmark}>Cha Jewels</Text>
        </Section>
        <Content p={p} />
        <Hr style={rule} />
        <Text style={muted}>{WORDS.help.en}</Text>
        <Text style={footer}>{WORDS.footer.en}</Text>
      </Container>
    </Body>
  </Html>
)

export default LayawayPaymentReceivedEmail
