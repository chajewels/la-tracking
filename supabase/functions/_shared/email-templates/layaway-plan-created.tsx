/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import { formatDeadline, formatMoney } from '../storefront-email.ts'
import { MethodCards, WORDS, button, buttonWrap, container, footer, h1, headerBar, main, muted, notice, rule, text, wordmark, type OrderEmailMethod } from './order-shared.tsx'
import { LAYAWAY_WORDS, PlanSummary, ScheduleTable, type LayawayScheduleRow } from './layaway-shared.tsx'

/**
 * Sent by the website function when a customer reserves a piece with layaway.
 * The piece is held, nothing is paid yet, and the deposit has a deadline — so
 * this email leads with the deposit and where to send it, and shows the full
 * schedule so the commitment is plain before any money moves.
 *
 * ENGLISH ONLY, BY CONSTRUCTION (owner rule 2026-09-27: no layaway email is
 * sent in Japanese — subject or body). There is no `lang` prop and no Japanese
 * copy; development/layaway-english.test.ts fails on any Japanese character.
 */
export interface LayawayPlanCreatedProps {
  reference: string
  currency: 'JPY' | 'PHP'
  totalAmount: number
  deposit: number
  termMonths: number
  schedule: LayawayScheduleRow[]
  methods: OrderEmailMethod[]
  transferDueAt: string
  region: 'JP' | 'OVERSEAS'
  planUrl: string | null
  /**
   * RESERVE-FIRST (A2). 'ready' is the email confirm-web-order-ready sends when
   * staff confirm a layaway reservation: the deposit, where to send it, the new
   * deadline and the schedule re-dated from the confirmation day. It is always
   * English, like every layaway email.
   * Absent reads exactly as it always has.
   */
  variant?: 'placed' | 'ready'
}

export const layawayPlanCreatedSubject = (reference: string) =>
  `Your layaway is reserved — Cha Jewels ${reference}`

export const layawayReadySubject = (reference: string) =>
  `Your piece is confirmed — please send your deposit — Cha Jewels ${reference}`

const COPY = {
  heading: 'Your layaway is reserved',
  intro: (ref: string) => `We are holding your piece under reference ${ref}. Thank you.`,
  deposit: (amt: string, due: string) =>
    `Please transfer the deposit of ${amt} by ${due}. Once we confirm it your reservation is final and the payment schedule begins.`,
  hold: 'If the deposit does not arrive by the deadline the hold is released and the piece goes back on sale.',
  proof: 'After transferring, upload your receipt from your account page. Confirmation usually takes one business day.',
} as const

/** The 'ready' variant: only the heading and the opening line differ. */
const READY_COPY = {
  ...COPY,
  heading: 'Your piece is confirmed',
  intro: (ref: string) => `We have confirmed your piece under reference ${ref}. Your payment schedule starts from today.`,
} as const

const Content = ({ p }: { p: LayawayPlanCreatedProps }) => {
  const c = p.variant === 'ready' ? READY_COPY : COPY
  return (
    <>
      <Heading style={h1}>{c.heading}</Heading>
      <Text style={text}>{c.intro(p.reference)}</Text>
      <PlanSummary
        reference={p.reference} totalAmount={p.totalAmount} deposit={p.deposit}
        termMonths={p.termMonths} currency={p.currency}
      />
      <Text style={text}>
        {c.deposit(formatMoney(p.deposit, p.currency), formatDeadline(p.transferDueAt, p.region, 'en'))}
      </Text>
      <MethodCards methods={p.methods} lang="en" />
      <Text style={notice}>{c.hold}</Text>
      <Text style={muted}>{c.proof}</Text>
      <ScheduleTable rows={p.schedule} currency={p.currency} />
      {p.planUrl && (
        <Section style={buttonWrap}>
          <Button style={button} href={p.planUrl}>{LAYAWAY_WORDS.viewPlan}</Button>
        </Section>
      )}
    </>
  )
}

export const LayawayPlanCreatedEmail = (p: LayawayPlanCreatedProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>{p.variant === 'ready' ? layawayReadySubject(p.reference) : layawayPlanCreatedSubject(p.reference)}</Preview>
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

export default LayawayPlanCreatedEmail
