/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import { formatDeadline, formatMoney } from '../storefront-email.ts'
import { WORDS, button, buttonWrap, container, footer, h1, headerBar, main, muted, notice, rule, text, wordmark } from './order-shared.tsx'

/**
 * Sent by auto-expire-cash-orders when the deposit on a web layaway never
 * arrived and the hold lapsed. Nothing was paid — that is the only state this
 * email can be sent in — so it says the piece is back on sale and invites the
 * customer to start again, without any hint of a debt.
 *
 * ENGLISH ONLY, BY CONSTRUCTION (owner rule 2026-09-27: no layaway email is
 * sent in Japanese — subject or body). There is no `lang` prop and no Japanese
 * copy; development/layaway-english.test.ts fails on any Japanese character.
 */
export interface LayawayExpiredProps {
  reference: string
  currency: 'JPY' | 'PHP'
  totalAmount: number
  deposit: number
  transferDueAt: string | null
  region: 'JP' | 'OVERSEAS'
  shopUrl: string | null
}

export const layawayExpiredSubject = (reference: string) =>
  `Layaway hold released — Cha Jewels ${reference}`

const COPY = {
  heading: 'Your hold has been released',
  intro: (ref: string, due: string) =>
    due
      ? `We did not receive the deposit for ${ref} by ${due}, so we have released the hold.`
      : `We did not receive the deposit for ${ref} by the deadline, so we have released the hold.`,
  nothingOwed: 'Nothing was paid and nothing is owed.',
  again: 'The piece is back on sale. You are welcome to reserve it again from the online store if you would still like it.',
} as const

const Content = ({ p }: { p: LayawayExpiredProps }) => {
  const c = COPY
  return (
    <>
      <Heading style={h1}>{c.heading}</Heading>
      <Text style={text}>{c.intro(p.reference, formatDeadline(p.transferDueAt, p.region, 'en'))}</Text>
      <Text style={notice}>{c.nothingOwed}</Text>
      <Text style={muted}>
        {formatMoney(p.totalAmount, p.currency)} · {formatMoney(p.deposit, p.currency)}
      </Text>
      <Text style={text}>{c.again}</Text>
      {p.shopUrl && (
        <Section style={buttonWrap}>
          <Button style={button} href={p.shopUrl}>Visit the store</Button>
        </Section>
      )}
    </>
  )
}

export const LayawayExpiredEmail = (p: LayawayExpiredProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>{layawayExpiredSubject(p.reference)}</Preview>
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

export default LayawayExpiredEmail
