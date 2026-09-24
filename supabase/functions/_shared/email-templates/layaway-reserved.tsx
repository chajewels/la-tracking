/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import { WORDS, button, buttonWrap, container, footer, h1, headerBar, main, muted, notice, rule, text, wordmark } from './order-shared.tsx'
import { LAYAWAY_WORDS, PlanSummary } from './layaway-shared.tsx'

/**
 * RESERVE-FIRST (A2). Sent by the `website` function when a layaway checkout
 * succeeds with system_settings.web_reservation_mode on.
 *
 * ENGLISH ONLY (owner decision 2026-09-23: layaway emails are English only),
 * whatever language the storefront was in.
 *
 * No bank details, no deadline and NO SCHEDULE: the schedule is re-dated to
 * the confirmation day when staff confirm (A1), so any dates shown now would be
 * wrong by the time they matter. The plan's shape — total, deposit, term — is
 * fixed, so that is shown.
 */
export interface LayawayReservedProps {
  reference: string
  currency: 'JPY' | 'PHP'
  totalAmount: number
  deposit: number
  termMonths: number
  planUrl: string | null
}

export const layawayReservedSubject = (reference: string) =>
  `We have your layaway request — Cha Jewels ${reference}`

export const LayawayReservedEmail = (p: LayawayReservedProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>{layawayReservedSubject(p.reference)}</Preview>
    <Body style={main}>
      <Container style={container}>
        <Section style={headerBar}>
          <Text style={wordmark}>Cha Jewels</Text>
        </Section>
        <Heading style={h1}>We have your layaway request</Heading>
        <Text style={text}>
          Thank you — we have received your layaway request under reference {p.reference}, and
          our staff are now confirming your piece.
        </Text>
        <PlanSummary
          reference={p.reference} totalAmount={p.totalAmount} deposit={p.deposit}
          termMonths={p.termMonths} currency={p.currency} lang="en"
        />
        <Text style={text}>
          As soon as it is confirmed we will email you the deposit, where to send it and your
          payment schedule. The schedule starts from the day we confirm.
        </Text>
        <Text style={notice}>
          There is nothing to pay yet. The payment details will be in that email and on this plan
          in your account.
        </Text>
        {p.planUrl && (
          <Section style={buttonWrap}>
            <Button style={button} href={p.planUrl}>{LAYAWAY_WORDS.viewPlan.en}</Button>
          </Section>
        )}
        <Hr style={rule} />
        <Text style={muted}>{WORDS.help.en}</Text>
        <Text style={footer}>{WORDS.footer.en}</Text>
      </Container>
    </Body>
  </Html>
)

export default LayawayReservedEmail
