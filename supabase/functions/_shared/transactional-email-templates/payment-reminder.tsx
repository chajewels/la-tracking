/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Html, Preview, Text, Section, Hr, Button,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'

const SITE_NAME = 'Cha Jewels'

interface PaymentReminderProps {
  customerName?: string
  invoiceNumber?: string
  dueDate?: string
  amountDue?: string
  currency?: string
  type?: 'overdue' | 'due_today' | 'upcoming'
  daysOverdue?: number
  portalUrl?: string
}

const PaymentReminderEmail = ({
  customerName = 'Valued Customer',
  invoiceNumber = '00000',
  dueDate = 'N/A',
  amountDue = '0',
  currency = 'PHP',
  type = 'upcoming',
  daysOverdue = 0,
  portalUrl,
}: PaymentReminderProps) => {
  const isOverdue = type === 'overdue'
  const isDueToday = type === 'due_today'

  const previewText = isOverdue
    ? `Payment overdue for INV #${invoiceNumber} — ${daysOverdue} days past due`
    : isDueToday
    ? `Payment due today for INV #${invoiceNumber}`
    : `Upcoming payment reminder for INV #${invoiceNumber}`

  const headerText = isOverdue
    ? 'Payment Overdue'
    : isDueToday
    ? 'Payment Due Today'
    : 'Upcoming Payment Reminder'

  const accentColor = isOverdue ? '#dc2626' : isDueToday ? '#d97706' : '#2563eb'

  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>{previewText}</Preview>
      <Body style={main}>
        <Container style={container}>
          {/* Header */}
          <Section style={{ ...headerBar, borderTopColor: accentColor }}>
            <Text style={brandText}>💎 {SITE_NAME}</Text>
          </Section>

          <Heading style={{ ...h1, color: accentColor }}>{headerText}</Heading>

          <Text style={greeting}>Hi {customerName},</Text>

          {isOverdue && (
            <Text style={text}>
              This is a friendly reminder that your layaway payment for{' '}
              <strong>INV #{invoiceNumber}</strong> was due on{' '}
              <strong>{dueDate}</strong> ({daysOverdue} days ago). Please
              settle at your earliest convenience to avoid additional penalties.
            </Text>
          )}

          {isDueToday && (
            <Text style={text}>
              Just a reminder — your layaway payment for{' '}
              <strong>INV #{invoiceNumber}</strong> is due{' '}
              <strong>today</strong>. Thank you for your prompt payment!
            </Text>
          )}

          {!isOverdue && !isDueToday && (
            <Text style={text}>
              This is a heads-up that your next layaway payment for{' '}
              <strong>INV #{invoiceNumber}</strong> is coming up on{' '}
              <strong>{dueDate}</strong>. Thank you for staying on track!
            </Text>
          )}

          {/* Amount Box */}
          <Section style={amountBox}>
            <Text style={amountLabel}>Amount Due</Text>
            <Text style={amountValue}>
              {currency === 'PHP' ? '₱' : '¥'} {amountDue}
            </Text>
            <Text style={amountSub}>Invoice #{invoiceNumber}</Text>
          </Section>

          {portalUrl && (
            <Section style={{ textAlign: 'center' as const, margin: '24px 0' }}>
              <Button style={{ ...button, backgroundColor: accentColor }} href={portalUrl}>
                View My Account
              </Button>
            </Section>
          )}

          <Hr style={hr} />

          <Text style={footer}>
            If you've already made this payment, please disregard this email.
            For questions, contact us via Messenger or reply to this email.
          </Text>

          <Text style={footerBrand}>
            {SITE_NAME} · Layaway Payment Management
          </Text>
        </Container>
      </Body>
    </Html>
  )
}

export const template = {
  component: PaymentReminderEmail,
  subject: (data: Record<string, any>) => {
    const type = data.type || 'upcoming'
    const inv = data.invoiceNumber || ''
    if (type === 'overdue') return `⚠️ Payment Overdue — INV #${inv}`
    if (type === 'due_today') return `⏰ Payment Due Today — INV #${inv}`
    return `📅 Upcoming Payment — INV #${inv}`
  },
  displayName: 'Payment reminder',
  previewData: {
    customerName: 'Maria Santos',
    invoiceNumber: '18456',
    dueDate: 'March 26, 2026',
    amountDue: '4,500',
    currency: 'PHP',
    type: 'overdue',
    daysOverdue: 5,
  },
} satisfies TemplateEntry

// Styles
const main = { backgroundColor: '#ffffff', fontFamily: "'Montserrat', 'Inter', Arial, sans-serif" }
const container = { padding: '0', maxWidth: '560px', margin: '0 auto' }
const headerBar = {
  borderTop: '4px solid #D4AF37',
  padding: '24px 24px 8px',
  textAlign: 'center' as const,
}
const brandText = {
  fontSize: '18px',
  fontWeight: 'bold' as const,
  color: '#1a1a2e',
  margin: '0',
  letterSpacing: '0.5px',
}
const h1 = {
  fontSize: '20px',
  fontWeight: 'bold' as const,
  textAlign: 'center' as const,
  margin: '16px 24px 8px',
}
const greeting = {
  fontSize: '15px',
  color: '#1a1a2e',
  padding: '0 24px',
  margin: '16px 0 4px',
}
const text = {
  fontSize: '14px',
  color: '#55575d',
  lineHeight: '1.6',
  padding: '0 24px',
  margin: '0 0 16px',
}
const amountBox = {
  backgroundColor: '#f8f6f0',
  borderRadius: '12px',
  padding: '20px',
  margin: '8px 24px 16px',
  textAlign: 'center' as const,
}
const amountLabel = {
  fontSize: '11px',
  color: '#6b7280',
  textTransform: 'uppercase' as const,
  letterSpacing: '1px',
  margin: '0 0 4px',
}
const amountValue = {
  fontSize: '28px',
  fontWeight: 'bold' as const,
  color: '#1a1a2e',
  margin: '0 0 4px',
}
const amountSub = {
  fontSize: '12px',
  color: '#6b7280',
  margin: '0',
}
const button = {
  color: '#ffffff',
  padding: '12px 28px',
  borderRadius: '8px',
  fontSize: '14px',
  fontWeight: 'bold' as const,
  textDecoration: 'none',
  display: 'inline-block' as const,
}
const hr = {
  borderColor: '#e5e7eb',
  margin: '24px',
}
const footer = {
  fontSize: '12px',
  color: '#9ca3af',
  padding: '0 24px',
  margin: '0 0 8px',
  lineHeight: '1.5',
}
const footerBrand = {
  fontSize: '11px',
  color: '#d4af37',
  textAlign: 'center' as const,
  padding: '0 24px 24px',
  margin: '0',
  fontWeight: 'bold' as const,
}
