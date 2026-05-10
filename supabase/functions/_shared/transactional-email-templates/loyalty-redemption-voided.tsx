/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Html, Preview, Text, Section, Hr, Button,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'

const SITE_NAME = 'Cha Jewels Hub'

interface Props {
  customerName?: string
  pointsRefunded?: number
  voidReason?: string
  redemptionType?: 'new_order_discount' | 'shipping_fee' | 'service_fee' | 'catalog_reward' | string
  invoiceNumber?: string
  newRemainingPoints?: number
  voidedAt?: string
  portalUrl?: string
}

const fmt = (n: number | undefined) =>
  n != null ? Number(n).toLocaleString('en-US') : '0'

const formatRedemptionType = (t: string | undefined) => {
  switch (t) {
    case 'new_order_discount':
      return 'New Order Discount'
    case 'shipping_fee':
      return 'Shipping Fee'
    case 'service_fee':
      return 'Service Fee'
    case 'catalog_reward':
      return 'Catalog Reward'
    default:
      return t || 'Redemption'
  }
}

const formatPHT = (iso: string | undefined) => {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return ''
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(d) + ' PHT'
  } catch {
    return ''
  }
}

// Truncate void reason to keep email body clean. Mirrors the
// 300-char cap used by buildRedemptionCancelledNotification in
// _shared/loyalty-notification-templates.ts.
const truncateReason = (s: string | undefined, max = 300) => {
  if (!s) return ''
  if (s.length <= max) return s
  return s.slice(0, max - 1).trimEnd() + '…'
}

const LoyaltyRedemptionVoidedEmail = ({
  customerName = 'Valued Customer',
  pointsRefunded = 0,
  voidReason = '',
  redemptionType = 'new_order_discount',
  invoiceNumber = '00000',
  newRemainingPoints = 0,
  voidedAt = '',
  portalUrl,
}: Props) => {
  const safeReason = truncateReason(voidReason)
  const voidedAtDisplay = formatPHT(voidedAt)

  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>Redemption voided — {fmt(pointsRefunded)} points refunded</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={headerBar}>
            <Text style={brandText}>💎 {SITE_NAME}</Text>
          </Section>
          <Heading style={h1}>Redemption Voided</Heading>
          <Text style={greeting}>Hi {customerName},</Text>
          <Text style={text}>
            Your loyalty redemption has been voided. The points used for this
            redemption have been refunded back to your balance.
          </Text>

          <Section style={detailsBox}>
            <Text style={detailRow}>
              <strong>Type:</strong> {formatRedemptionType(redemptionType)}
            </Text>
            <Text style={detailRow}>
              <strong>Original invoice:</strong> INV #{invoiceNumber}
            </Text>
            {voidedAtDisplay && (
              <Text style={detailRow}>
                <strong>Voided on:</strong> {voidedAtDisplay}
              </Text>
            )}
            {safeReason && (
              <Text style={detailRow}>
                <strong>Reason:</strong> {safeReason}
              </Text>
            )}
          </Section>

          <Section style={balanceBox}>
            <Text style={balanceText}>
              <strong>+{fmt(pointsRefunded)} points refunded</strong>
            </Text>
            <Text style={balanceSubtext}>
              New balance: {fmt(newRemainingPoints)} pts
            </Text>
          </Section>

          <Text style={closing}>
            If you have any questions about this void, please reach out via
            Messenger or email us — we're happy to help.
          </Text>

          {portalUrl && (
            <Section style={{ textAlign: 'center' as const, margin: '24px 0' }}>
              <Button style={{ ...button, backgroundColor: '#D4AF37' }} href={portalUrl}>
                View My Loyalty Dashboard
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
  component: LoyaltyRedemptionVoidedEmail,
  subject: (data: Record<string, any>) =>
    `Redemption voided — ${fmt(data.pointsRefunded)} points refunded`,
  displayName: 'Loyalty Redemption Voided',
  previewData: {
    customerName: 'Maria Santos',
    pointsRefunded: 2000,
    voidReason: 'Customer cancelled the order before fulfillment',
    redemptionType: 'new_order_discount',
    invoiceNumber: '19015',
    newRemainingPoints: 2450,
    voidedAt: '2026-05-10T09:30:00.000Z',
    portalUrl: 'https://portal.chajewelsjp.com/loyalty?token=demo',
  },
} satisfies TemplateEntry

const main = { backgroundColor: '#ffffff', fontFamily: "'Montserrat', 'Inter', Arial, sans-serif" }
const container = { padding: '0', maxWidth: '560px', margin: '0 auto' }
const headerBar = { borderTop: '4px solid #D4AF37', padding: '24px 24px 8px', textAlign: 'center' as const }
const brandText = { fontSize: '18px', fontWeight: 'bold' as const, color: '#1a1a2e', margin: '0', letterSpacing: '0.5px' }
const h1 = { fontSize: '20px', fontWeight: 'bold' as const, textAlign: 'center' as const, margin: '16px 24px 8px', color: '#1a1a2e' }
const greeting = { fontSize: '15px', color: '#1a1a2e', padding: '0 24px', margin: '16px 0 4px' }
const text = { fontSize: '14px', color: '#55575d', lineHeight: '1.6', padding: '0 24px', margin: '0 0 16px' }
const detailsBox = { backgroundColor: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '12px', padding: '16px 20px', margin: '8px 24px 16px' }
const detailRow = { fontSize: '13px', color: '#1a1a2e', margin: '4px 0', lineHeight: '1.5' }
const balanceBox = { backgroundColor: '#ecfdf5', borderRadius: '8px', padding: '12px 20px', margin: '0 24px 16px', textAlign: 'center' as const }
const balanceText = { fontSize: '15px', color: '#057a55', margin: '0 0 4px' }
const balanceSubtext = { fontSize: '13px', color: '#55575d', margin: '0' }
const closing = { fontSize: '14px', color: '#55575d', textAlign: 'center' as const, padding: '0 24px', margin: '8px 0', fontStyle: 'italic' as const }
const button = { color: '#1a1500', padding: '12px 28px', borderRadius: '8px', fontSize: '14px', fontWeight: 'bold' as const, textDecoration: 'none', display: 'inline-block' as const }
const hr = { borderColor: '#e5e7eb', margin: '24px' }
const footer = { fontSize: '12px', color: '#9ca3af', padding: '0 24px', margin: '0 0 8px', lineHeight: '1.5' }
const footerBrand = { fontSize: '11px', color: '#d4af37', textAlign: 'center' as const, padding: '0 24px 24px', margin: '0', fontWeight: 'bold' as const }
