/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import { formatMoney } from '../storefront-email.ts'
import { WORDS, button, buttonWrap, container, footer, h1, headerBar, main, muted, notice, rule, text, wordmark } from './order-shared.tsx'

/**
 * Sent when a WEB layaway is forfeited — by staff (manual-forfeit) or
 * automatically (auto-forfeit-settlement), through
 * _shared/layaway-forfeit-email.ts. `final` is the permanent variant
 * (final_forfeited: the extension expired or hit its penalty cap): it says the
 * closure is permanent and offers no extension.
 *
 * Originally sent by manual-forfeit only. The customer of a
 * web plan has only ever dealt with the storefront, so this replaces the Hub's
 * account-forfeited template for them (the same split auto-expire-cash-orders
 * makes between order-expired and cash-order-expired).
 *
 * It says what happened in the storefront's own words ("closed under the plan
 * terms" — lib/plan-status.ts on the site), that the held piece is back on
 * sale, and that a one-time extension can be asked for within the 7-day
 * extension window. It deliberately says nothing about money already paid
 * beyond the figure: what happens to it is a staff conversation, not a promise
 * an automated email should make.
 *
 * ENGLISH ONLY, BY CONSTRUCTION (owner rule 2026-09-27: no layaway email is
 * sent in Japanese — subject or body). There is no `lang` prop and no Japanese
 * copy; development/layaway-english.test.ts fails on any Japanese character.
 */
export interface LayawayForfeitedProps {
  reference: string
  currency: 'JPY' | 'PHP'
  totalAmount: number
  totalPaid: number
  planUrl: string | null
  /** final_forfeited — permanent, no extension on offer. */
  final?: boolean
}

export const layawayForfeitedSubject = (reference: string) =>
  `Layaway plan closed — Cha Jewels ${reference}`

const COPY = {
  heading: 'Your layaway plan has been closed',
  intro: (ref: string) => `Your layaway plan ${ref} has been closed under the plan terms (forfeited).`,
  released: 'The piece that was held for you has been released and is back on sale.',
  extension: 'While the piece is still available, you may be able to ask for a one-time extension. To ask, reply to this email within 7 days.',
  finalHeading: 'Your layaway plan has been permanently closed',
  finalIntro: (ref: string) => `Your layaway plan ${ref} has been permanently closed under the plan terms (forfeited) after its extension ended.`,
  finalNote: 'This closure is final; the plan cannot be extended or reopened.',
  total: 'Plan total',
  paid: 'Paid so far',
  view: 'View your plan',
} as const

const Content = ({ p }: { p: LayawayForfeitedProps }) => {
  const c = COPY
  return (
    <>
      <Heading style={h1}>{p.final ? c.finalHeading : c.heading}</Heading>
      <Text style={text}>{p.final ? c.finalIntro(p.reference) : c.intro(p.reference)}</Text>
      <Text style={notice}>{c.released}</Text>
      <Text style={muted}>
        {c.total}: {formatMoney(p.totalAmount, p.currency)} · {c.paid}: {formatMoney(p.totalPaid, p.currency)}
      </Text>
      <Text style={text}>{p.final ? c.finalNote : c.extension}</Text>
      {p.planUrl && (
        <Section style={buttonWrap}>
          <Button style={button} href={p.planUrl}>{c.view}</Button>
        </Section>
      )}
    </>
  )
}

export const LayawayForfeitedEmail = (p: LayawayForfeitedProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>{layawayForfeitedSubject(p.reference)}</Preview>
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

export default LayawayForfeitedEmail
