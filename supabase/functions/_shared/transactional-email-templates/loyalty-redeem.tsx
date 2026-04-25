/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Html, Preview, Text, Section, Hr, Button,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'

const SITE_NAME = 'Cha Jewels Hub'

interface Props {
  customerName?: string
  pointsRedeemed?: number
  valueAppliedJpy?: number
  valueAppliedPhp?: number | null
  redemptionType?: 'new_order_discount' | 'shipping_fee' | 'service_fee' | string
  invoiceNumber?: string
  remainingPoints?: number
  portalUrl?: string
}

const fmt = (n: number | undefined) => (n != null ? Number(n).toLocaleString('en-US') : '0')

const formatRedemptionType = (t: string | undefined) => {
  switch (t) {
    case 'new_order_discount':
      return 'New Order Discount'
    case 'shipping_fee':
      return 'Shipping Fee'
    case 'service_fee':
      return 'Service Fee'
    default:
      return t || 'Redemption'
  }
}

const LoyaltyRedeemEmail = ({
  customerName = 'Valued Customer',
  pointsRedeemed = 0,
  valueAppliedJpy = 0,
  valueAppliedPhp = null,
  redemptionType = 'new_order_discount',
  invoiceNumber = '00000',
  remainingPoints = 0,
  portalUrl,
}: Props) => {
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>Redemption confirmed: {fmt(pointsRedeemed)} points used</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={headerBar}>
            <Text style={brandText}>💎 {SITE_NAME}</Text>
          </Section>
          <Heading style={{ ...h1, color: '#057a55' }}>✓ Redemption Confirmed!</Heading>
          <Text style={greeting}>Hi {customerName},</Text>
          <Text style={text}>
            Your redemption request has been approved and applied!
          </Text>

          <Section style={detailsBox}>
            <Text style={detailRow}><strong>Points redeemed:</strong> {fmt(pointsRedeemed)}</Text>
            <Text style={detailRow}>
              <strong>Value applied:</strong> ¥{fmt(valueAppliedJpy)}
              {valueAppliedPhp != null && (
                <span style={detailSubdued}>{' '}(equivalent to ₱{fmt(valueAppliedPhp)})</span>
              )}
            </Text>
            <Text style={detailRow}><strong>Applied to:</strong> INV #{invoiceNumber}</Text>
            <Text style={detailRow}><strong>Type:</strong> {formatRedemptionType(redemptionType)}</Text>
          </Section>

          <Section style={balanceBox}>
            <Text style={balanceText}>
              <strong>New points balance:</strong> {fmt(remainingPoints)} pts
            </Text>
          </Section>

          <Text style={closing}>
            Thank you for being a Cha Jewels Loyalty member!
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
  component: LoyaltyRedeemEmail,
  subject: (data: Record<string, any>) =>
    `✓ Redemption confirmed: ${fmt(data.pointsRedeemed)} points used`,
  displayName: 'Loyalty Redemption Confirmed',
  previewData: {
    customerName: 'Maria Santos',
    pointsRedeemed: 2000,
    valueAppliedJpy: 2000,
    valueAppliedPhp: 840,
    redemptionType: 'new_order_discount',
    invoiceNumber: '19015',
    remainingPoints: 450,
    portalUrl: 'https://portal.chajewelsjp.com/loyalty?token=demo',
  },
} satisfies TemplateEntry

const main = { backgroundColor: '#ffffff', fontFamily: "'Montserrat', 'Inter', Arial, sans-serif" }
const container = { padding: '0', maxWidth: '560px', margin: '0 auto' }
const headerBar = { borderTop: '4px solid #D4AF37', padding: '24px 24px 8px', textAlign: 'center' as const }
const brandText = { fontSize: '18px', fontWeight: 'bold' as const, color: '#1a1a2e', margin: '0', letterSpacing: '0.5px' }
const h1 = { fontSize: '20px', fontWeight: 'bold' as const, textAlign: 'center' as const, margin: '16px 24px 8px' }
const greeting = { fontSize: '15px', color: '#1a1a2e', padding: '0 24px', margin: '16px 0 4px' }
const text = { fontSize: '14px', color: '#55575d', lineHeight: '1.6', padding: '0 24px', margin: '0 0 16px' }
const detailsBox = { backgroundColor: '#f0fdf4', border: '1px solid #6ee7b7', borderRadius: '12px', padding: '16px 20px', margin: '8px 24px 16px' }
const detailRow = { fontSize: '13px', color: '#1a1a2e', margin: '4px 0', lineHeight: '1.5' }
const detailSubdued = { color: '#55575d', fontWeight: 'normal' as const }
const balanceBox = { backgroundColor: '#ecfdf5', borderRadius: '8px', padding: '12px 20px', margin: '0 24px 16px', textAlign: 'center' as const }
const balanceText = { fontSize: '14px', color: '#057a55', margin: '0' }
const closing = { fontSize: '14px', color: '#55575d', textAlign: 'center' as const, padding: '0 24px', margin: '8px 0', fontStyle: 'italic' as const }
const button = { color: '#1a1500', padding: '12px 28px', borderRadius: '8px', fontSize: '14px', fontWeight: 'bold' as const, textDecoration: 'none', display: 'inline-block' as const }
const hr = { borderColor: '#e5e7eb', margin: '24px' }
const footer = { fontSize: '12px', color: '#9ca3af', padding: '0 24px', margin: '0 0 8px', lineHeight: '1.5' }
const footerBrand = { fontSize: '11px', color: '#d4af37', textAlign: 'center' as const, padding: '0 24px 24px', margin: '0', fontWeight: 'bold' as const }
