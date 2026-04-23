/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Html, Preview, Text, Section, Hr, Button,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'

const SITE_NAME = 'Cha Jewels Hub'

type Stage = 'P3' | 'P4' | 'P5' | 'P6' | 'P7' | 'P8'

interface Props {
  customerName?: string
  invoiceNumber?: string
  stage?: Stage
  dueDate?: string
  amountDue?: string
  penaltyAmount?: string
  remainingBalance?: string
  currency?: string
  daysOverdue?: number
  portalUrl?: string
}

const STAGE_CONFIG: Record<Stage, { headline: string; previewText: (inv: string, days: number) => string; lead: string }> = {
  P3: {
    headline: 'Urgent: Account Overdue',
    previewText: (inv, days) => `Urgent — INV #${inv} is ${days} days overdue`,
    lead:
      'Your layaway account is now significantly overdue. Please settle at ' +
      'your earliest convenience — continued delay will result in additional ' +
      'penalties.',
  },
  P4: {
    headline: 'Escalation Notice',
    previewText: (inv, days) => `Escalation notice — INV #${inv} is ${days} days overdue`,
    lead:
      'This is an escalation notice. Your account remains unpaid and has ' +
      'incurred additional penalties. Immediate action is required to keep ' +
      'your account in good standing.',
  },
  P5: {
    headline: 'URGENT: Payment Required',
    previewText: (inv) => `URGENT — payment required on INV #${inv}`,
    lead:
      'Payment on your account is urgently required. Further delay will ' +
      'trigger additional penalties and move your account closer to forfeiture.',
  },
  P6: {
    headline: 'FINAL WARNING',
    previewText: (inv) => `FINAL WARNING — INV #${inv}`,
    lead:
      'This is a final warning. Your account is at serious risk. You must ' +
      'settle the outstanding balance immediately to prevent forfeiture.',
  },
  P7: {
    headline: 'CRITICAL: Forfeiture Risk',
    previewText: (inv) => `CRITICAL — INV #${inv} at forfeiture risk`,
    lead:
      'Your account is at risk of permanent forfeiture if not settled ' +
      'immediately. Please contact us or settle via the portal today to ' +
      'preserve your account.',
  },
  P8: {
    headline: 'FINAL NOTICE',
    previewText: (inv) => `FINAL NOTICE — INV #${inv}`,
    lead:
      'This is your final notice. Your account is at risk of permanent ' +
      'forfeiture if not settled immediately. Contact us today to discuss ' +
      'options before the account is closed.',
  },
}

const SUBJECT_BY_STAGE: Record<Stage, (inv: string) => string> = {
  P3: (inv) => `🚨 Urgent: Account Overdue — INV #${inv}`,
  P4: (inv) => `🚨 Escalation Notice — INV #${inv}`,
  P5: (inv) => `⛔ URGENT: Payment Required — INV #${inv}`,
  P6: (inv) => `⛔ FINAL WARNING — INV #${inv}`,
  P7: (inv) => `🚨 CRITICAL: Forfeiture Risk — INV #${inv}`,
  P8: (inv) => `🚨 FINAL NOTICE — INV #${inv}`,
}

const PenaltyEscalationEmail = ({
  customerName = 'Valued Customer',
  invoiceNumber = '00000',
  stage = 'P3',
  dueDate = 'N/A',
  amountDue = '0',
  penaltyAmount = '0',
  remainingBalance = '0',
  currency = 'PHP',
  daysOverdue = 0,
  portalUrl,
}: Props) => {
  const symbol = currency === 'PHP' ? '₱' : '¥'
  const cfg = STAGE_CONFIG[stage] || STAGE_CONFIG.P3
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>{cfg.previewText(invoiceNumber, daysOverdue)}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={headerBar}>
            <Text style={brandText}>💎 {SITE_NAME}</Text>
          </Section>
          <Heading style={{ ...h1, color: '#dc2626' }}>{cfg.headline}</Heading>
          <Text style={greeting}>Hi {customerName},</Text>
          <Text style={text}>{cfg.lead}</Text>
          <Section style={detailsBox}>
            <Text style={detailRow}><strong>Invoice:</strong> INV #{invoiceNumber}</Text>
            <Text style={detailRow}><strong>Due Date:</strong> {dueDate}</Text>
            <Text style={detailRow}><strong>Days Overdue:</strong> {daysOverdue}</Text>
            <Text style={detailRow}><strong>Amount Due:</strong> {symbol} {amountDue}</Text>
            <Text style={detailRow}><strong>Penalty Applied:</strong> {symbol} {penaltyAmount}</Text>
            <Text style={detailRow}><strong>Remaining Balance:</strong> {symbol} {remainingBalance}</Text>
          </Section>
          {portalUrl && (
            <Section style={{ textAlign: 'center' as const, margin: '24px 0' }}>
              <Button style={{ ...button, backgroundColor: '#dc2626' }} href={portalUrl}>
                Settle Immediately
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
  component: PenaltyEscalationEmail,
  subject: (data: Record<string, any>) => {
    const stage = (data.stage || 'P3') as Stage
    const inv = data.invoiceNumber || ''
    return (SUBJECT_BY_STAGE[stage] || SUBJECT_BY_STAGE.P3)(inv)
  },
  displayName: 'Penalty escalation',
  previewData: {
    customerName: 'Maria Santos',
    invoiceNumber: '18456',
    stage: 'P5',
    dueDate: 'April 1, 2026',
    amountDue: '4,500',
    penaltyAmount: '500',
    remainingBalance: '18,500',
    currency: 'PHP',
    daysOverdue: 22,
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
const hr = { borderColor: '#e5e7eb', margin: '24px' }
const footer = { fontSize: '12px', color: '#9ca3af', padding: '0 24px', margin: '0 0 8px', lineHeight: '1.5' }
const footerBrand = { fontSize: '11px', color: '#d4af37', textAlign: 'center' as const, padding: '0 24px 24px', margin: '0', fontWeight: 'bold' as const }
