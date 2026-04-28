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
  totalAmount?: string
  totalPaid?: string
  remainingBalance?: string
  currency?: string
  expiresAt?: string
  portalUrl?: string
}

const CashOrderExpiredEmail = ({
  customerName = 'Valued Customer',
  invoiceNumber = '00000',
  totalAmount = '0',
  totalPaid = '0',
  remainingBalance = '0',
  currency = 'PHP',
  expiresAt,
  portalUrl,
}: Props) => {
  const symbol = currency === 'PHP' ? '₱' : '¥'
  const formattedExpiresAt = expiresAt
    ? new Date(expiresAt).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : ''
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>Cash order INV #{invoiceNumber} has expired</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={headerBar}>
            <Text style={brandText}>💎 {SITE_NAME}</Text>
          </Section>
          <Heading style={{ ...h1, color: '#dc2626' }}>Cash Order Expired</Heading>
          <Text style={greeting}>Hi {customerName},</Text>
          <Text style={text}>
            Your cash order <strong>INV #{invoiceNumber}</strong> has expired
            {formattedExpiresAt ? <> on <strong>{formattedExpiresAt}</strong></> : null}
            {' '}with an outstanding balance of <strong>{symbol} {remainingBalance}</strong>.
          </Text>
          <Text style={text}>
            Please contact us if you would like to discuss options for
            completing this order.
          </Text>
          <Section style={detailsBox}>
            <Text style={detailRow}><strong>Invoice:</strong> INV #{invoiceNumber}</Text>
            <Text style={detailRow}><strong>Total Order:</strong> {symbol} {totalAmount}</Text>
            <Text style={detailRow}><strong>Amount Paid:</strong> {symbol} {totalPaid}</Text>
            <Text style={{ ...detailRow, color: '#dc2626', fontWeight: 'bold' as const }}>
              <strong>Outstanding Balance:</strong> {symbol} {remainingBalance}
            </Text>
            {formattedExpiresAt && (
              <Text style={detailRow}><strong>Expiration Date:</strong> {formattedExpiresAt}</Text>
            )}
          </Section>
          {portalUrl && (
            <Section style={{ textAlign: 'center' as const, margin: '24px 0' }}>
              <Button style={{ ...button, backgroundColor: '#dc2626' }} href={portalUrl}>
                Contact Us
              </Button>
            </Section>
          )}
          <Text style={noteText}>
            Cash orders that expire with an outstanding balance are forfeited
            per our terms. Please reach out via Messenger or reply to this
            email for assistance.
          </Text>
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
  component: CashOrderExpiredEmail,
  subject: (data: Record<string, any>) =>
    `⚠️ Cash Order Expired — INV #${data.invoiceNumber || ''}`,
  displayName: 'Cash Order Expired',
  previewData: {
    customerName: 'Maria Santos',
    invoiceNumber: '19012',
    totalAmount: '75,000',
    totalPaid: '45,000',
    remainingBalance: '30,000',
    currency: 'PHP',
    expiresAt: '2026-05-15T00:00:00.000Z',
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
const detailsBox = { backgroundColor: '#fef2f2', borderRadius: '12px', padding: '16px 20px', margin: '8px 24px 16px' }
const detailRow = { fontSize: '13px', color: '#1a1a2e', margin: '4px 0', lineHeight: '1.5' }
const button = { color: '#ffffff', padding: '12px 28px', borderRadius: '8px', fontSize: '14px', fontWeight: 'bold' as const, textDecoration: 'none', display: 'inline-block' as const }
const noteText = { fontSize: '12px', color: '#6b7280', lineHeight: '1.6', padding: '0 24px', margin: '0 0 16px', fontStyle: 'italic' as const }
const hr = { borderColor: '#e5e7eb', margin: '24px' }
const footer = { fontSize: '12px', color: '#9ca3af', padding: '0 24px', margin: '0 0 8px', lineHeight: '1.5' }
const footerBrand = { fontSize: '11px', color: '#d4af37', textAlign: 'center' as const, padding: '0 24px 24px', margin: '0', fontWeight: 'bold' as const }
