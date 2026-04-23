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
  currency?: string
  remainingBalance?: string
  forfeitureReason?: string
  extensionAvailable?: boolean
  portalUrl?: string
}

const AccountForfeitedEmail = ({
  customerName = 'Valued Customer',
  invoiceNumber = '00000',
  currency = 'PHP',
  remainingBalance = '0',
  forfeitureReason,
  extensionAvailable = false,
  portalUrl,
}: Props) => {
  const symbol = currency === 'PHP' ? '₱' : '¥'
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>Account forfeited for INV #{invoiceNumber}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={headerBar}>
            <Text style={brandText}>💎 {SITE_NAME}</Text>
          </Section>
          <Heading style={{ ...h1, color: '#dc2626' }}>Account Forfeited</Heading>
          <Text style={greeting}>Hi {customerName},</Text>
          <Text style={text}>
            Your layaway account <strong>INV #{invoiceNumber}</strong> has
            been forfeited due to non-payment.
          </Text>
          {forfeitureReason && (
            <Section style={reasonBox}>
              <Text style={reasonLabel}>Reason</Text>
              <Text style={reasonText}>{forfeitureReason}</Text>
            </Section>
          )}
          <Section style={detailsBox}>
            <Text style={detailRow}><strong>Invoice:</strong> INV #{invoiceNumber}</Text>
            <Text style={detailRow}><strong>Remaining Balance:</strong> {symbol} {remainingBalance}</Text>
          </Section>
          {extensionAvailable ? (
            <Text style={text}>
              You may be eligible for a one-time extension. Please contact
              us immediately.
            </Text>
          ) : (
            <Text style={text}>
              This forfeiture is permanent. Please contact us for questions
              about your account.
            </Text>
          )}
          {portalUrl && (
            <Section style={{ textAlign: 'center' as const, margin: '24px 0' }}>
              <Button style={{ ...button, backgroundColor: '#dc2626' }} href={portalUrl}>
                Contact Us
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
  component: AccountForfeitedEmail,
  subject: (data: Record<string, any>) =>
    `🚨 Account Forfeited — INV #${data.invoiceNumber || ''}`,
  displayName: 'Account forfeited',
  previewData: {
    customerName: 'Maria Santos',
    invoiceNumber: '18456',
    currency: 'PHP',
    remainingBalance: '18,500',
    forfeitureReason: 'Account has been overdue for more than 3 months with no successful payments.',
    extensionAvailable: true,
  },
} satisfies TemplateEntry

const main = { backgroundColor: '#ffffff', fontFamily: "'Montserrat', 'Inter', Arial, sans-serif" }
const container = { padding: '0', maxWidth: '560px', margin: '0 auto' }
const headerBar = { borderTop: '4px solid #D4AF37', padding: '24px 24px 8px', textAlign: 'center' as const }
const brandText = { fontSize: '18px', fontWeight: 'bold' as const, color: '#1a1a2e', margin: '0', letterSpacing: '0.5px' }
const h1 = { fontSize: '20px', fontWeight: 'bold' as const, textAlign: 'center' as const, margin: '16px 24px 8px' }
const greeting = { fontSize: '15px', color: '#1a1a2e', padding: '0 24px', margin: '16px 0 4px' }
const text = { fontSize: '14px', color: '#55575d', lineHeight: '1.6', padding: '0 24px', margin: '0 0 16px' }
const reasonBox = { backgroundColor: '#fef2f2', borderRadius: '12px', padding: '16px 20px', margin: '8px 24px 16px', borderLeft: '4px solid #dc2626' }
const reasonLabel = { fontSize: '11px', color: '#6b7280', textTransform: 'uppercase' as const, letterSpacing: '1px', margin: '0 0 4px' }
const reasonText = { fontSize: '14px', color: '#1a1a2e', margin: '0', lineHeight: '1.5' }
const detailsBox = { backgroundColor: '#fef2f2', borderRadius: '12px', padding: '16px 20px', margin: '8px 24px 16px' }
const detailRow = { fontSize: '13px', color: '#1a1a2e', margin: '4px 0', lineHeight: '1.5' }
const button = { color: '#ffffff', padding: '12px 28px', borderRadius: '8px', fontSize: '14px', fontWeight: 'bold' as const, textDecoration: 'none', display: 'inline-block' as const }
const hr = { borderColor: '#e5e7eb', margin: '24px' }
const footer = { fontSize: '12px', color: '#9ca3af', padding: '0 24px', margin: '0 0 8px', lineHeight: '1.5' }
const footerBrand = { fontSize: '11px', color: '#d4af37', textAlign: 'center' as const, padding: '0 24px 24px', margin: '0', fontWeight: 'bold' as const }
