/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Html, Preview, Text, Section, Hr, Button,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'

const SITE_NAME = 'Cha Jewels Hub'

interface Props {
  customerName?: string
  invoiceNumber?: string
  amountPaid?: string
  paymentDate?: string
  paymentMethod?: string
  referenceNumber?: string
  currency?: string
  portalUrl?: string
}

const CashPaymentSubmittedEmail = ({
  customerName = 'Valued Customer',
  invoiceNumber = '00000',
  amountPaid = '0',
  paymentDate = 'N/A',
  paymentMethod = 'N/A',
  referenceNumber,
  currency = 'JPY',
  portalUrl,
}: Props) => {
  const symbol = currency === 'PHP' ? '₱' : '¥'
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>Payment submitted for cash order INV #{invoiceNumber}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={headerBar}>
            <Text style={brandText}>💎 {SITE_NAME}</Text>
          </Section>
          <Heading style={{ ...h1, color: '#d97706' }}>⏳ Payment Submitted</Heading>
          <Text style={greeting}>Hi {customerName},</Text>
          <Text style={text}>
            Your payment of <strong>{symbol} {amountPaid}</strong> for cash
            order <strong>INV #{invoiceNumber}</strong> has been submitted and
            is under review.
          </Text>
          <Section style={infoBox}>
            <Text style={infoText}>
              We'll confirm your payment shortly. You'll receive another email
              once it's confirmed.
            </Text>
          </Section>
          <Section style={detailsBox}>
            <Text style={detailRow}><strong>Invoice:</strong> #{invoiceNumber}</Text>
            <Text style={detailRow}><strong>Amount:</strong> {symbol} {amountPaid}</Text>
            <Text style={detailRow}><strong>Payment Date:</strong> {paymentDate}</Text>
            {referenceNumber && (
              <Text style={detailRow}><strong>Reference #:</strong> {referenceNumber}</Text>
            )}
            <Text style={detailRow}><strong>Payment Method:</strong> {paymentMethod}</Text>
          </Section>
          {portalUrl && (
            <Section style={{ textAlign: 'center' as const, margin: '24px 0' }}>
              <Button style={{ ...button, backgroundColor: '#d97706' }} href={portalUrl}>
                View My Order
              </Button>
            </Section>
          )}
          <Hr style={hr} />
          <Text style={footer}>
            For questions, contact us via Messenger or email us at sales@chajewelsjp.com
          </Text>
          <Text style={footerBrand}>{SITE_NAME} · Payment & Loyalty Management</Text>
        </Container>
      </Body>
    </Html>
  )
}

export const template = {
  component: CashPaymentSubmittedEmail,
  subject: (data: Record<string, any>) =>
    `⏳ Payment Submitted — INV #${data.invoiceNumber || ''}`,
  displayName: 'Cash Payment Submitted',
  previewData: {
    customerName: 'Maria Santos',
    invoiceNumber: '19012',
    amountPaid: '45,000',
    paymentDate: 'April 24, 2026',
    paymentMethod: 'GCash',
    referenceNumber: 'GC240424-0017',
    currency: 'PHP',
    portalUrl: 'https://portal.chajewelsjp.com/portal?invoice=19012',
  },
} satisfies TemplateEntry

const main = { backgroundColor: '#ffffff', fontFamily: "'Montserrat', 'Inter', Arial, sans-serif" }
const container = { padding: '0', maxWidth: '560px', margin: '0 auto' }
const headerBar = { borderTop: '4px solid #D4AF37', padding: '24px 24px 8px', textAlign: 'center' as const }
const brandText = { fontSize: '18px', fontWeight: 'bold' as const, color: '#1a1a2e', margin: '0', letterSpacing: '0.5px' }
const h1 = { fontSize: '20px', fontWeight: 'bold' as const, textAlign: 'center' as const, margin: '16px 24px 8px' }
const greeting = { fontSize: '15px', color: '#1a1a2e', padding: '0 24px', margin: '16px 0 4px' }
const text = { fontSize: '14px', color: '#55575d', lineHeight: '1.6', padding: '0 24px', margin: '0 0 16px' }
const infoBox = { backgroundColor: '#fffbeb', border: '1px solid #fde68a', borderRadius: '12px', padding: '12px 20px', margin: '8px 24px 16px' }
const infoText = { fontSize: '13px', color: '#92400e', margin: '0', lineHeight: '1.5' }
const detailsBox = { backgroundColor: '#f8f6f0', borderRadius: '12px', padding: '16px 20px', margin: '8px 24px 16px' }
const detailRow = { fontSize: '13px', color: '#1a1a2e', margin: '4px 0', lineHeight: '1.5' }
const button = { color: '#ffffff', padding: '12px 28px', borderRadius: '8px', fontSize: '14px', fontWeight: 'bold' as const, textDecoration: 'none', display: 'inline-block' as const }
const hr = { borderColor: '#e5e7eb', margin: '24px' }
const footer = { fontSize: '12px', color: '#9ca3af', padding: '0 24px', margin: '0 0 8px', lineHeight: '1.5' }
const footerBrand = { fontSize: '11px', color: '#d4af37', textAlign: 'center' as const, padding: '0 24px 24px', margin: '0', fontWeight: 'bold' as const }
