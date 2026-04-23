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
  penaltyAmount?: string
  currency?: string
  dueDate?: string
  totalPenalty?: string
  remainingBalance?: string
  daysOverdue?: number
  portalUrl?: string
}

const PenaltyAppliedEmail = ({
  customerName = 'Valued Customer',
  invoiceNumber = '00000',
  penaltyAmount = '0',
  currency = 'PHP',
  dueDate = 'N/A',
  totalPenalty = '0',
  remainingBalance = '0',
  daysOverdue = 0,
  portalUrl,
}: Props) => {
  const symbol = currency === 'PHP' ? '₱' : '¥'
  const previewText = `Penalty applied to INV #${invoiceNumber} — ${String(daysOverdue)} days overdue`
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>{previewText}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={headerBar}>
            <Text style={brandText}>💎 {SITE_NAME}</Text>
          </Section>
          <Heading style={{ ...h1, color: '#dc2626' }}>Penalty Applied to Your Account</Heading>
          <Text style={greeting}>Hi {customerName},</Text>
          <Text style={text}>
            A penalty of <strong>{symbol} {penaltyAmount}</strong> has been
            applied to <strong>INV #{invoiceNumber}</strong>. Your payment
            was due on <strong>{dueDate}</strong> ({daysOverdue} days ago).
            Please settle your balance soon to avoid additional penalties.
          </Text>
          <Section style={detailsBox}>
            <Text style={detailRow}><strong>Penalty Amount:</strong> {symbol} {penaltyAmount}</Text>
            <Text style={detailRow}><strong>Total Outstanding Penalties:</strong> {symbol} {totalPenalty}</Text>
            <Text style={detailRow}><strong>Remaining Balance:</strong> {symbol} {remainingBalance}</Text>
            <Text style={detailRow}><strong>Due Date:</strong> {dueDate}</Text>
          </Section>
          {portalUrl && (
            <Section style={{ textAlign: 'center' as const, margin: '24px 0' }}>
              <Button style={{ ...button, backgroundColor: '#dc2626' }} href={portalUrl}>
                Settle Now
              </Button>
            </Section>
          )}
          <Section style={noteBox}>
            <Text style={noteText}>
              Additional penalties will continue to apply until the balance is
              fully settled.
            </Text>
          </Section>
          <Hr style={hr} />
          <Text style={footer}>
            For questions, contact us via Messenger or reply to this email.
          </Text>
          <Text style={footerBrand}>{SITE_NAME} · Payment & Loyalty Management</Text>
        </Container>
      </Body>
    </Html>
  )
}

export const template = {
  component: PenaltyAppliedEmail,
  subject: (data: Record<string, any>) =>
    `⚠️ Penalty Applied — INV #${data.invoiceNumber || ''}`,
  displayName: 'Penalty applied',
  previewData: {
    customerName: 'Maria Santos',
    invoiceNumber: '18456',
    penaltyAmount: '500',
    currency: 'PHP',
    dueDate: 'April 16, 2026',
    totalPenalty: '500',
    remainingBalance: '14,000',
    daysOverdue: 7,
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
const noteBox = { padding: '0 24px', margin: '8px 0 0' }
const noteText = { fontSize: '12px', color: '#6b7280', fontStyle: 'italic' as const, lineHeight: '1.5', margin: '0' }
const button = { color: '#ffffff', padding: '12px 28px', borderRadius: '8px', fontSize: '14px', fontWeight: 'bold' as const, textDecoration: 'none', display: 'inline-block' as const }
const hr = { borderColor: '#e5e7eb', margin: '24px' }
const footer = { fontSize: '12px', color: '#9ca3af', padding: '0 24px', margin: '0 0 8px', lineHeight: '1.5' }
const footerBrand = { fontSize: '11px', color: '#d4af37', textAlign: 'center' as const, padding: '0 24px 24px', margin: '0', fontWeight: 'bold' as const }
