/// <reference types="npm:@types/react@18.3.1" />
/* eslint-disable react-refresh/only-export-components -- an email template, never hot-reloaded; the subject helper lives beside it like every other template */
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import { formatDeadline, formatMoney } from '../storefront-email.ts'
import { MethodCards, Panel, Row, WORDS, block, blockGutter, button, buttonWrap, container, footer, h1, headerBar, main, muted, notice, rule, text, wordmark, type OrderEmailMethod } from './order-shared.tsx'

/**
 * STAGE D DEPOSIT REMINDER for a confirmed web LAYAWAY (docs/WEB-PAYMENT-
 * REMINDERS.md), sent once by web-payment-reminder-sweep when the deposit
 * deadline is near and nothing has arrived.
 *
 * ENGLISH ONLY, BY CONSTRUCTION. There is no `lang` prop and no Japanese copy
 * in this file: nothing layaway-related is ever sent in Japanese (owner rule).
 * src/test/web-payment-reminders.test.ts fails if a Japanese character appears
 * here.
 *
 * Transactional: the deposit in the plan's currency, the deadline, every
 * transfer method for that currency, and what happens if it passes. No
 * products, no offers.
 */
export interface LayawayDepositDueProps {
  reference: string
  currency: 'JPY' | 'PHP'
  /** layaway_accounts.downpayment_amount — nothing has been paid (total_paid = 0). */
  deposit: number
  methods: OrderEmailMethod[]
  transferDueAt: string
  region: 'JP' | 'OVERSEAS'
  planUrl: string | null
}

export const layawayDepositDueSubject = (reference: string) =>
  `Reminder: your layaway deposit is due — Cha Jewels ${reference}`

export const LayawayDepositDueEmail = (p: LayawayDepositDueProps) => {
  const when = formatDeadline(p.transferDueAt, p.region, 'en')
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>{layawayDepositDueSubject(p.reference)}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={headerBar}>
            <Text style={wordmark}>Cha Jewels</Text>
          </Section>
          <Heading style={h1}>Your deposit is due soon</Heading>
          <Text style={text}>
            This is a reminder that the deposit for your layaway {p.reference} is due by {when}. If you have not
            transferred yet, please send the deposit to one of the accounts below before the deadline.
          </Text>
          <Panel gutter={blockGutter} box={block}>
            {/* Row is a table, not flex — Gmail drops display:flex. See order-shared. */}
            <Row k="Reference" v={p.reference} />
            <Row k="Deposit to transfer" v={formatMoney(p.deposit, p.currency)} emphasis />
          </Panel>
          <Text style={{ ...text, fontWeight: 'bold' as const }}>Where to transfer</Text>
          <MethodCards methods={p.methods} lang="en" />
          <Text style={{ ...text, fontWeight: 'bold' as const }}>Transfer by: {when}</Text>
          <Text style={notice}>
            If the deposit does not arrive by the deadline the hold is released and the piece goes back on sale.
          </Text>
          <Text style={muted}>
            Already paid? Upload your transfer receipt from your plan page, or reply to this email. If our messages
            crossed, please ignore this one.
          </Text>
          {p.planUrl && (
            <Section style={buttonWrap}>
              <Button style={button} href={p.planUrl}>View your plan</Button>
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

export default LayawayDepositDueEmail
