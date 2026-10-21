/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import { formatMoney } from '../storefront-email.ts'
import { WORDS, button, buttonWrap, container, footer, h1, headerBar, main, muted, notice, rule, text, wordmark } from './order-shared.tsx'

/**
 * Sent when staff CANCEL a WEB layaway (cancel-layaway → cancel_layaway_atomic),
 * through _shared/layaway-cancel-email.ts. Hub (non-web) plans get the Hub
 * template transactional-email-templates/layaway-cancelled.tsx instead — the
 * same channel split as the forfeit emails (forfeitEmailKind).
 *
 * Wording approved by the owner 2026-10-21. It never shows the reason staff
 * typed (an internal note), and — like layaway-forfeited — it makes no promise
 * about money already paid beyond the figure: that is a staff conversation.
 * The points line appears only when earned points were actually reversed.
 *
 * ENGLISH ONLY, BY CONSTRUCTION (owner rule 2026-09-27: no layaway email is
 * sent in Japanese — subject or body). There is no `lang` prop and no Japanese
 * copy; development/layaway-english.test.ts fails on any Japanese character.
 */
export interface LayawayCancelledProps {
  reference: string
  currency: 'JPY' | 'PHP'
  totalAmount: number
  totalPaid: number
  planUrl: string | null
  /** Earned loyalty points on this plan were reversed by the cancel. */
  pointsReversed?: boolean
}

export const layawayCancelledSubject = (reference: string) =>
  `Layaway plan cancelled — Cha Jewels ${reference}`

const COPY = {
  heading: 'Your layaway plan has been cancelled',
  intro: (ref: string) => `Your layaway plan ${ref} has been cancelled.`,
  released: 'The piece that was held for you has been released.',
  points: 'The loyalty points earned on this plan have been reversed.',
  questions: 'If you have any questions about this plan or the amount you have paid, reply to this email.',
  total: 'Plan total',
  paid: 'Paid so far',
  view: 'View your plan',
} as const

const Content = ({ p }: { p: LayawayCancelledProps }) => {
  const c = COPY
  return (
    <>
      <Heading style={h1}>{c.heading}</Heading>
      <Text style={text}>{c.intro(p.reference)}</Text>
      <Text style={notice}>{c.released}</Text>
      <Text style={muted}>
        {c.total}: {formatMoney(p.totalAmount, p.currency)} · {c.paid}: {formatMoney(p.totalPaid, p.currency)}
      </Text>
      {p.pointsReversed && <Text style={text}>{c.points}</Text>}
      <Text style={text}>{c.questions}</Text>
      {p.planUrl && (
        <Section style={buttonWrap}>
          <Button style={button} href={p.planUrl}>{c.view}</Button>
        </Section>
      )}
    </>
  )
}

export const LayawayCancelledEmail = (p: LayawayCancelledProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>{layawayCancelledSubject(p.reference)}</Preview>
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

export default LayawayCancelledEmail
