/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Html, Preview, Text, Section, Hr, Link,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'

import { INTERNAL_SITE_NAME as SITE_NAME, INTERNAL_FOOTER as FOOTER_LINE } from './brand.ts'

/**
 * RESERVE-FIRST (A2). Internal: web-reservation-sweep sends this to
 * sales@chajewelsjp.com listing every web reservation that is still
 * unconfirmed 24 hours after checkout and has not been chased before. Each
 * reservation is listed once, ever — reservation_reminded_at is stamped after
 * the send is accepted. Links go to the Hub (app.chajewelsjp.com — internal
 * only, never a customer).
 */
export interface AwaitingReservation {
  kind: 'cash_order' | 'layaway'
  reference: string
  customerName: string
  amount: string
  ageHours: number
  autoCancelAt: string
  hubUrl: string
}

interface Props {
  reservations?: AwaitingReservation[]
}

const WebReservationsAwaitingEmail = ({ reservations = [] }: Props) => {
  const n = reservations.length
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>{`${n} web reservation${n === 1 ? '' : 's'} still waiting for confirmation`}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={headerBar}>
            <Text style={brandText}>💎 {SITE_NAME}</Text>
          </Section>
          <Heading style={h1}>{n === 1 ? 'A web reservation is still waiting' : `${n} web reservations are still waiting`}</Heading>
          <Text style={text}>
            {n === 1 ? 'This customer has' : 'These customers have'} been waiting more than 24 hours
            for someone to confirm the piece. They have no payment details until you do. Each
            one is cancelled automatically, and the customer told, 72 hours after checkout.
          </Text>
          {reservations.map((r) => (
            <Section key={r.reference} style={card}>
              <Text style={cardTitle}>
                <Link href={r.hubUrl} style={link}>{r.reference}</Link>
                {' · '}{r.kind === 'layaway' ? 'Layaway' : 'Paid in full'}
              </Text>
              <Text style={cardLine}>{r.customerName} · {r.amount}</Text>
              <Text style={cardLine}>Waiting {r.ageHours}h · auto-cancels {r.autoCancelAt}</Text>
            </Section>
          ))}
          <Text style={text}>Open each one in the Hub and press Confirm or Can’t supply.</Text>
          <Hr style={hr} />
          <Text style={footerBrand}>{FOOTER_LINE}</Text>
        </Container>
      </Body>
    </Html>
  )
}

export const template = {
  /** Staff mail: Hub identity. See brand.ts. */
  audience: 'internal' as const,
  component: WebReservationsAwaitingEmail,
  to: 'sales@chajewelsjp.com',
  subject: (data: Record<string, any>) => {
    const n = Array.isArray(data.reservations) ? data.reservations.length : 0
    return `⏳ ${n} web reservation${n === 1 ? '' : 's'} waiting over 24h — confirm or decline`
  },
  displayName: 'Web reservations awaiting confirmation (internal)',
  previewData: {
    reservations: [
      {
        kind: 'cash_order', reference: 'CJ-W-000123', customerName: 'Maria Santos', amount: '¥72,980',
        ageHours: 26, autoCancelAt: 'Sep 26 14:05 PHT', hubUrl: 'https://app.chajewelsjp.com/cash-orders/00000000-0000-0000-0000-000000000123',
      },
      {
        kind: 'layaway', reference: 'CJ-W-000124', customerName: 'Aiko Tanaka', amount: '₱126,000 over 8 months',
        ageHours: 31, autoCancelAt: 'Sep 26 09:40 PHT', hubUrl: 'https://app.chajewelsjp.com/accounts/00000000-0000-0000-0000-000000000124',
      },
    ],
  },
} satisfies TemplateEntry

const main = { backgroundColor: '#ffffff', fontFamily: "'Montserrat', 'Inter', Arial, sans-serif" }
const container = { padding: '0', maxWidth: '560px', margin: '0 auto' }
const headerBar = { borderTop: '4px solid #C9A227', padding: '24px 24px 8px', textAlign: 'center' as const }
const brandText = { fontSize: '18px', fontWeight: 'bold' as const, color: '#1a1a2e', margin: '0', letterSpacing: '0.5px' }
const h1 = { fontSize: '20px', fontWeight: 'bold' as const, color: '#1a1a2e', textAlign: 'center' as const, margin: '16px 24px 8px' }
const text = { fontSize: '14px', color: '#55575d', lineHeight: '1.6', padding: '0 24px', margin: '0 0 16px' }
const card = { margin: '0 24px 12px', padding: '12px 16px', border: '1px solid #C9A227', borderRadius: '6px' }
const cardTitle = { fontSize: '15px', fontWeight: 'bold' as const, color: '#1a1a2e', margin: '0 0 4px' }
const cardLine = { fontSize: '13px', color: '#55575d', margin: '0 0 2px' }
const link = { color: '#1a1a2e', textDecoration: 'underline' }
const hr = { borderColor: '#e5e7eb', margin: '24px' }
const footerBrand = { fontSize: '11px', color: '#C9A227', textAlign: 'center' as const, padding: '0 24px 24px', margin: '0', fontWeight: 'bold' as const }
