/// <reference types="npm:@types/react@18.3.1" />
/* eslint-disable react-refresh/only-export-components -- an email template, never hot-reloaded; the subject helper lives beside it like every other template */
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import { formatMoney } from '../storefront-email.ts'
import { Panel, Row, WORDS, block, blockGutter, button, buttonWrap, container, footer, h1, headerBar, main, muted, rule, text, wordmark } from './order-shared.tsx'
import { LAYAWAY_WORDS } from './layaway-shared.tsx'

/**
 * RECEIPT READY for a WEBSITE PLAN (docs/RECEIPTS.md). ENGLISH ONLY (owner
 * rule: no layaway email is ever in Japanese; no lang prop). Sent once by the
 * website-receipt-emails sweep. Links to the plan in My Account ONLY: never
 * to the PDF, never an attachment. The receipt itself carries no layaway
 * wording; neither does this email beyond the plan link.
 */
export interface LayawayReceiptReadyEmailProps {
  reference: string
  receiptNumber: string
  currency: 'JPY' | 'PHP'
  total: number
  planUrl: string
}

export const layawayReceiptReadySubject = (reference: string) =>
  `Your receipt is ready — Cha Jewels ${reference}`

export const LayawayReceiptReadyEmail = (p: LayawayReceiptReadyEmailProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>{layawayReceiptReadySubject(p.reference)}</Preview>
    <Body style={main}>
      <Container style={container}>
        <Section style={headerBar}>
          <Text style={wordmark}>Cha Jewels</Text>
        </Section>
        <Heading style={h1}>Your receipt is ready</Heading>
        <Text style={text}>{`${p.reference} is fully paid, and we have issued your receipt. Thank you.`}</Text>
        <Text style={text}>
          You can download the receipt (PDF) from your page in My Account, and change the name and description on it there.
        </Text>
        <Panel gutter={blockGutter} box={block}>
          <Row k={LAYAWAY_WORDS.reference} v={p.reference} />
          <Row k="Receipt number" v={p.receiptNumber} mono />
          <Row k="Amount received (tax included)" v={formatMoney(p.total, p.currency)} emphasis />
        </Panel>
        <Section style={buttonWrap}>
          <Button style={button} href={p.planUrl}>View in My Account</Button>
        </Section>
        <Hr style={rule} />
        <Text style={muted}>{WORDS.help.en}</Text>
        <Text style={footer}>{WORDS.footer.en}</Text>
      </Container>
    </Body>
  </Html>
)

export default LayawayReceiptReadyEmail
