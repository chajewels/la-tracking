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
  currency?: string
  remainingBalance?: string
  totalPaid?: string
  isFullyPaid?: boolean
  portalUrl?: string
}

const CashPaymentConfirmedEmail = ({
  customerName = 'Valued Customer',
  invoiceNumber = '00000',
  amountPaid = '0',
  currency = 'JPY',
  remainingBalance = '0',
  totalPaid = '0',
  isFullyPaid = false,
  portalUrl,
}: Props) => {
  const symbol = currency === 'PHP' ? '₱' : '¥'
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>
        {isFullyPaid
          ? `Cash order INV #${invoiceNumber} fully paid`
          : `Payment confirmed for cash order INV #${invoiceNumber}`}
      </Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={headerBar}>
            <Text style={brandText}>💎 {SITE_NAME}</Text>
          </Section>

          {isFullyPaid ? (
            <>
              <Heading style={{ ...h1, color: '#16a34a' }}>🎉 Order Fully Paid!</Heading>
              <Text style={greeting}>Hi {customerName},</Text>
              <Text style={text}>
                Your payment of <strong>{symbol} {amountPaid}</strong> for cash
                order <strong>INV #{invoiceNumber}</strong> has been confirmed.
                Your order is now fully paid!
              </Text>
              <Section style={successBox}>
                <Text style={successRow}><strong>Total Paid:</strong> {symbol} {totalPaid}</Text>
                <Text style={{ ...successRow, color: '#16a34a', fontWeight: 'bold' as const }}>
                  Status: COMPLETED ✅
                </Text>
              </Section>
              <Text style={text}>
                Thank you for choosing {SITE_NAME}! We'll be in touch regarding
                delivery or pickup.
              </Text>
            </>
          ) : (
            <>
              <Heading style={{ ...h1, color: '#16a34a' }}>✅ Payment Confirmed</Heading>
              <Text style={greeting}>Hi {customerName},</Text>
              <Text style={text}>
                Your payment of <strong>{symbol} {amountPaid}</strong> for cash
                order <strong>INV #{invoiceNumber}</strong> has been confirmed.
              </Text>
              <Section style={balanceBox}>
                <Text style={balanceRow}><strong>Amount Confirmed:</strong> {symbol} {amountPaid}</Text>
                <Text style={balanceRow}><strong>Total Paid:</strong> {symbol} {totalPaid}</Text>
                <Text style={{ ...balanceRow, color: '#15803d', fontWeight: 'bold' as const }}>
                  <strong>Remaining Balance:</strong> {symbol} {remainingBalance}
                </Text>
              </Section>
              <Text style={text}>
                Your remaining balance can be paid anytime through the portal.
              </Text>
            </>
          )}

          {portalUrl && (
            <Section style={{ textAlign: 'center' as const, margin: '24px 0' }}>
              <Button style={{ ...button, backgroundColor: '#16a34a' }} href={portalUrl}>
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
  component: CashPaymentConfirmedEmail,
  subject: (data: Record<string, any>) =>
    `✅ Payment Confirmed — INV #${data.invoiceNumber || ''}`,
  displayName: 'Cash Payment Confirmed',
  previewData: {
    customerName: 'Maria Santos',
    invoiceNumber: '19012',
    amountPaid: '45,000',
    currency: 'PHP',
    remainingBalance: '30,000',
    totalPaid: '45,000',
    isFullyPaid: false,
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
const balanceBox = { backgroundColor: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '12px', padding: '16px 20px', margin: '8px 24px 16px' }
const balanceRow = { fontSize: '13px', color: '#1a1a2e', margin: '4px 0', lineHeight: '1.5' }
const successBox = { backgroundColor: '#f0fdf4', border: '2px solid #16a34a', borderRadius: '12px', padding: '16px 20px', margin: '8px 24px 16px' }
const successRow = { fontSize: '14px', color: '#1a1a2e', margin: '4px 0', lineHeight: '1.5' }
const button = { color: '#ffffff', padding: '12px 28px', borderRadius: '8px', fontSize: '14px', fontWeight: 'bold' as const, textDecoration: 'none', display: 'inline-block' as const }
const hr = { borderColor: '#e5e7eb', margin: '24px' }
const footer = { fontSize: '12px', color: '#9ca3af', padding: '0 24px', margin: '0 0 8px', lineHeight: '1.5' }
const footerBrand = { fontSize: '11px', color: '#d4af37', textAlign: 'center' as const, padding: '0 24px 24px', margin: '0', fontWeight: 'bold' as const }
