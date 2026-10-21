/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Html, Preview, Text, Section, Hr, Button,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'

import { CUSTOMER_SITE_NAME as SITE_NAME, CUSTOMER_FOOTER as FOOTER_LINE } from './brand.ts'

/**
 * Sent when staff CANCEL a Hub (non-web) layaway — cancel-layaway, through
 * _shared/layaway-cancel-email.ts. Web plans get the storefront
 * email-templates/layaway-cancelled.tsx instead (same split as forfeit).
 * Wording approved by the owner 2026-10-21: no staff reason, no promise about
 * money paid beyond the figures, points line only when points were reversed.
 * ENGLISH ONLY (owner rule 2026-09-27).
 */
interface Props {
  customerName?: string
  invoiceNumber?: string
  currency?: string
  totalAmount?: string
  totalPaid?: string
  pointsReversed?: boolean
  portalUrl?: string
}

const LayawayCancelledEmail = ({
  customerName = 'Valued Customer',
  invoiceNumber = '00000',
  currency = 'PHP',
  totalAmount = '0',
  totalPaid = '0',
  pointsReversed = false,
  portalUrl,
}: Props) => {
  const symbol = currency === 'PHP' ? '₱' : '¥'
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>Layaway plan cancelled — INV #{invoiceNumber}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={headerBar}>
            <Text style={brandText}>💎 {SITE_NAME}</Text>
          </Section>
          <Heading style={h1}>Your layaway plan has been cancelled</Heading>
          <Text style={greeting}>Hi {customerName},</Text>
          <Text style={text}>
            Your layaway plan <strong>INV #{invoiceNumber}</strong> has been cancelled.
          </Text>
          <Section style={detailsBox}>
            <Text style={detailRow}><strong>Plan total:</strong> {symbol} {totalAmount}</Text>
            <Text style={detailRow}><strong>Paid so far:</strong> {symbol} {totalPaid}</Text>
          </Section>
          {pointsReversed && (
            <Text style={text}>
              The loyalty points earned on this plan have been reversed.
            </Text>
          )}
          <Text style={text}>
            If you have any questions about this plan or the amount you have paid, reply to this email.
          </Text>
          {portalUrl && (
            <Section style={{ textAlign: 'center' as const, margin: '24px 0' }}>
              <Button style={button} href={portalUrl}>
                View your account
              </Button>
            </Section>
          )}
          <Hr style={hr} />
          <Text style={footer}>
            For questions, contact us via Messenger or email us at sales@chajewelsjp.com
          </Text>
          <Text style={footerBrand}>{FOOTER_LINE}</Text>
        </Container>
      </Body>
    </Html>
  )
}

export const template = {
  /** Who reads this. Decides the From name and footer — see brand.ts. */
  audience: 'customer' as const,
  component: LayawayCancelledEmail,
  subject: (data: Record<string, any>) =>
    `Layaway plan cancelled — Cha Jewels INV #${data.invoiceNumber || ''}`,
  displayName: 'Layaway cancelled',
  previewData: {
    customerName: 'Maria Santos',
    invoiceNumber: '18456',
    currency: 'PHP',
    totalAmount: '60,000',
    totalPaid: '18,000',
    pointsReversed: true,
  },
} satisfies TemplateEntry

const main = { backgroundColor: '#ffffff', fontFamily: "'Montserrat', 'Inter', Arial, sans-serif" }
const container = { padding: '0', maxWidth: '560px', margin: '0 auto' }
const headerBar = { borderTop: '4px solid #C9A227', padding: '24px 24px 8px', textAlign: 'center' as const }
const brandText = { fontSize: '18px', fontWeight: 'bold' as const, color: '#1a1a2e', margin: '0', letterSpacing: '0.5px' }
const h1 = { fontSize: '20px', fontWeight: 'bold' as const, textAlign: 'center' as const, margin: '16px 24px 8px', color: '#1a1a2e' }
const greeting = { fontSize: '15px', color: '#1a1a2e', padding: '0 24px', margin: '16px 0 4px' }
const text = { fontSize: '14px', color: '#55575d', lineHeight: '1.6', padding: '0 24px', margin: '0 0 16px' }
const detailsBox = { backgroundColor: '#f9fafb', borderRadius: '12px', padding: '16px 20px', margin: '8px 24px 16px' }
const detailRow = { fontSize: '13px', color: '#1a1a2e', margin: '4px 0', lineHeight: '1.5' }
const button = { backgroundColor: '#C9A227', color: '#ffffff', padding: '12px 28px', borderRadius: '8px', fontSize: '14px', fontWeight: 'bold' as const, textDecoration: 'none', display: 'inline-block' as const }
const hr = { borderColor: '#e5e7eb', margin: '24px' }
const footer = { fontSize: '12px', color: '#9ca3af', padding: '0 24px', margin: '0 0 8px', lineHeight: '1.5' }
const footerBrand = { fontSize: '11px', color: '#C9A227', textAlign: 'center' as const, padding: '0 24px 24px', margin: '0', fontWeight: 'bold' as const }
