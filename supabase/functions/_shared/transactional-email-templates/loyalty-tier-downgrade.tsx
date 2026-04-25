/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Html, Preview, Text, Section, Hr, Button,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'

const SITE_NAME = 'Cha Jewels Hub'

interface Props {
  customerName?: string
  oldTier?: string
  newTier?: string
  daysSinceLastPurchase?: number
  remainingPoints?: number
  portalUrl?: string
}

const fmt = (n: number | undefined) => (n != null ? Number(n).toLocaleString('en-US') : '0')

const LoyaltyTierDowngradeEmail = ({
  customerName = 'Valued Customer',
  oldTier = 'Radiant',
  newTier = 'Glimmer',
  daysSinceLastPurchase = 180,
  remainingPoints = 0,
  portalUrl,
}: Props) => {
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>Your loyalty tier has been adjusted</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={headerBar}>
            <Text style={brandText}>💎 {SITE_NAME}</Text>
          </Section>
          <Heading style={{ ...h1, color: '#92400e' }}>Your Loyalty Tier Update</Heading>
          <Text style={greeting}>Hi {customerName},</Text>
          <Text style={text}>
            We've adjusted your loyalty tier from <strong>{oldTier}</strong> to{' '}
            <strong>{newTier}</strong> due to {daysSinceLastPurchase} days of inactivity
            between your purchases.
          </Text>

          <Section style={reassureBox}>
            <Text style={reassureTitle}>Your points balance is preserved</Text>
            <Text style={reassureBalance}>{fmt(remainingPoints)} pts still available</Text>
          </Section>

          <Section style={recoveryBox}>
            <Text style={recoveryTitle}>Make a new eligible purchase to:</Text>
            <Text style={recoveryRow}>◆ Reset your tier downgrade status</Text>
            <Text style={recoveryRow}>◆ Continue earning points at your tier rate</Text>
            <Text style={recoveryRow}>◆ Work back up to your previous tier</Text>
          </Section>

          <Text style={closing}>
            We can't wait to welcome you back to Cha Jewels!
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
  component: LoyaltyTierDowngradeEmail,
  subject: (data: Record<string, any>) =>
    `Your loyalty tier has been adjusted, ${data.customerName || 'Valued Customer'}`,
  displayName: 'Loyalty Tier Downgrade',
  previewData: {
    customerName: 'Maria Santos',
    oldTier: 'Radiant',
    newTier: 'Glimmer',
    daysSinceLastPurchase: 195,
    remainingPoints: 1850,
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
const reassureBox = { backgroundColor: '#fffbeb', border: '1px solid #fde68a', borderRadius: '12px', padding: '16px 20px', margin: '8px 24px 16px', textAlign: 'center' as const }
const reassureTitle = { fontSize: '14px', fontWeight: 'bold' as const, color: '#92400e', margin: '0' }
const reassureBalance = { fontSize: '18px', fontWeight: 'bold' as const, color: '#92400e', margin: '8px 0 0' }
const recoveryBox = { backgroundColor: '#f8f6f0', borderRadius: '12px', padding: '16px 20px', margin: '0 24px 16px' }
const recoveryTitle = { fontSize: '13px', fontWeight: 'bold' as const, color: '#1a1a2e', margin: '0 0 8px' }
const recoveryRow = { fontSize: '13px', color: '#1a1a2e', margin: '4px 0', lineHeight: '1.5' }
const closing = { fontSize: '14px', color: '#55575d', textAlign: 'center' as const, padding: '0 24px', margin: '8px 0', fontStyle: 'italic' as const }
const button = { color: '#1a1500', padding: '12px 28px', borderRadius: '8px', fontSize: '14px', fontWeight: 'bold' as const, textDecoration: 'none', display: 'inline-block' as const }
const hr = { borderColor: '#e5e7eb', margin: '24px' }
const footer = { fontSize: '12px', color: '#9ca3af', padding: '0 24px', margin: '0 0 8px', lineHeight: '1.5' }
const footerBrand = { fontSize: '11px', color: '#d4af37', textAlign: 'center' as const, padding: '0 24px 24px', margin: '0', fontWeight: 'bold' as const }
