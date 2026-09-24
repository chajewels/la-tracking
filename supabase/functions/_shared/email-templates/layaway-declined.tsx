/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import { WORDS, button, buttonWrap, container, footer, h1, headerBar, main, muted, notice, rule, text, wordmark } from './order-shared.tsx'

/**
 * RESERVE-FIRST (A2). A web layaway reservation that ended before staff
 * confirmed it, in one of two ways:
 *
 *   declined  staff pressed "Can't supply" (decline-web-reservation). The
 *             reason they typed is shown — it is the customer's only answer.
 *   lapsed    nobody confirmed it within 72 hours (web-reservation-sweep).
 *             Polite, and it does not blame the customer: the delay was ours.
 *
 * Nothing can have been paid (no payment details were ever shown), so both say
 * so plainly and carry no hint of a debt. ENGLISH ONLY (owner decision
 * 2026-09-23: layaway emails are English only).
 */
export interface LayawayDeclinedProps {
  reference: string
  kind: 'declined' | 'lapsed'
  reason?: string | null
  shopUrl: string | null
}

export const layawayDeclinedSubject = (reference: string, kind: 'declined' | 'lapsed' = 'declined') =>
  kind === 'lapsed'
    ? `We could not confirm your piece in time — Cha Jewels ${reference}`
    : `We are sorry — we cannot supply your piece — Cha Jewels ${reference}`

export const LayawayDeclinedEmail = (p: LayawayDeclinedProps) => {
  const lapsed = p.kind === 'lapsed'
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>{layawayDeclinedSubject(p.reference, p.kind)}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={headerBar}>
            <Text style={wordmark}>Cha Jewels</Text>
          </Section>
          <Heading style={h1}>{lapsed ? 'We could not confirm your piece in time' : 'We are sorry — we cannot supply your piece'}</Heading>
          <Text style={text}>
            {lapsed
              ? `We were not able to confirm the piece on your layaway request ${p.reference} within 72 hours, so we have released the reservation. We are sorry for the wait.`
              : `We have checked the piece on your layaway request ${p.reference} and, unfortunately, we are not able to supply it. We have released the reservation.`}
          </Text>
          {!lapsed && p.reason && (
            <Text style={text}><strong>Reason:</strong> {p.reason}</Text>
          )}
          <Text style={notice}>Nothing was paid and nothing is owed.</Text>
          <Text style={text}>
            {lapsed
              ? 'If you would still like the piece, you are welcome to reserve it again from the online store, or reply to this email and we will help.'
              : 'If you would like help finding something similar, reply to this email — we would be glad to help.'}
          </Text>
          {p.shopUrl && (
            <Section style={buttonWrap}>
              <Button style={button} href={p.shopUrl}>Visit the store</Button>
            </Section>
          )}
          <Hr style={rule} />
          <Text style={muted}>{WORDS.help.en}</Text>
          <Text style={footer}>{WORDS.footer.en}</Text>
        </Container>
      </Body>
    </Html>
  )
}

export default LayawayDeclinedEmail
