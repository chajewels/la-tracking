/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Html, Preview, Text, Section, Hr, Button,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'

const SITE_NAME = 'Cha Jewels Hub'

interface Props {
  customerName?: string
  pointsExpired?: number
  oldTier?: string
  newTier?: string
  daysSinceLastPurchase?: number
  portalUrl?: string
}

const fmt = (n: number | undefined) => (n != null ? Number(n).toLocaleString('en-US') : '0')

const LoyaltyExpireDeductEmail = ({
  customerName = 'Valued Customer',
  pointsExpired = 0,
  oldTier = 'Glimmer',
  newTier = 'Glimmer',
  daysSinceLastPurchase = 180,
  portalUrl,
}: Props) => {
  const tierChanged = oldTier !== newTier
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>Your loyalty points have expired</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={headerBar}>
            <Text style={brandText}>💎 {SITE_NAME}</Text>
          </Section>
          <Heading style={{ ...h1, color: '#6b7280' }}>Your Loyalty Points Update</Heading>
          <Text style={greeting}>Hi {customerName},</Text>
          <Text style={text}>
            Due to {daysSinceLastPurchase} days of inactivity, your loyalty points
            have expired{tierChanged ? ' and your tier has been reset' : ''}.
          </Text>

          <Section style={statusBox}>
            <Text style={statusRow}><strong>Points expired:</strong> {fmt(pointsExpired)}</Text>
            {tierChanged && (
              <Text style={statusRow}>
                <strong>Tier change:</strong> {oldTier} → {newTier}
              </Text>
            )}
            <Text style={statusRowEmphasis}><strong>New balance:</strong> 0 pts</Text>
          </Section>

          <Section style={forwardBox}>
            <Text style={forwardTitle}>Don't worry — you can start earning fresh!</Text>
            <Text style={forwardSub}>Your next eligible purchase will:</Text>
            <Text style={forwardRow}>◆ Begin building points toward your new tier</Text>
            <Text style={forwardRow}>◆ Reset your activity timer</Text>
            <Text style={forwardRow}>◆ Restore your earning streak</Text>
          </Section>

          <Text style={closing}>
            We're here whenever you're ready to return to Cha Jewels.
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
  component: LoyaltyExpireDeductEmail,
  subject: (data: Record<string, any>) =>
    `Your loyalty points have expired, ${data.customerName || 'Valued Customer'}`,
  displayName: 'Loyalty Points Expired',
  previewData: {
    customerName: 'Maria Santos',
    pointsExpired: 1850,
    oldTier: 'Radiant',
    newTier: 'Glimmer',
    daysSinceLastPurchase: 195,
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
const statusBox = { backgroundColor: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: '12px', padding: '16px 20px', margin: '8px 24px 16px' }
const statusRow = { fontSize: '13px', color: '#374151', margin: '4px 0', lineHeight: '1.5' }
const statusRowEmphasis = { fontSize: '14px', color: '#1f2937', margin: '8px 0 0', lineHeight: '1.5', fontWeight: 'bold' as const }
const forwardBox = { backgroundColor: '#fffaf0', border: '1px solid #f3e6c0', borderRadius: '12px', padding: '16px 20px', margin: '0 24px 16px' }
const forwardTitle = { fontSize: '14px', fontWeight: 'bold' as const, color: '#a37e1f', margin: '0 0 6px' }
const forwardSub = { fontSize: '13px', color: '#1a1a2e', margin: '0 0 6px' }
const forwardRow = { fontSize: '13px', color: '#1a1a2e', margin: '4px 0', lineHeight: '1.5' }
const closing = { fontSize: '14px', color: '#55575d', textAlign: 'center' as const, padding: '0 24px', margin: '8px 0', fontStyle: 'italic' as const }
const button = { color: '#1a1500', padding: '12px 28px', borderRadius: '8px', fontSize: '14px', fontWeight: 'bold' as const, textDecoration: 'none', display: 'inline-block' as const }
const hr = { borderColor: '#e5e7eb', margin: '24px' }
const footer = { fontSize: '12px', color: '#9ca3af', padding: '0 24px', margin: '0 0 8px', lineHeight: '1.5' }
const footerBrand = { fontSize: '11px', color: '#d4af37', textAlign: 'center' as const, padding: '0 24px 24px', margin: '0', fontWeight: 'bold' as const }
