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
  newMultiplier?: number
  cumulativeSpendJpy?: number
  remainingPoints?: number
  portalUrl?: string
}

const fmt = (n: number | undefined) => (n != null ? Number(n).toLocaleString('en-US') : '0')

const TIER_BENEFITS: Record<string, string[]> = {
  Radiant: [
    '2× points multiplier',
    'Free international shipping on 4+ items',
    'Priority customer support',
    'Early access to new collections',
  ],
  Elite: [
    'All Radiant benefits',
    '2× points multiplier (continued)',
    'Premium support tier',
  ],
  'Crown VIP': [
    '3× points multiplier',
    'Free international shipping on 3+ items',
    'Mystery gifts with shipments',
    'VIP concierge service',
    'Annual VIP event invitation',
    'Limited edition collection access',
  ],
}

const LoyaltyTierUpgradeEmail = ({
  customerName = 'Valued Customer',
  oldTier = 'Glimmer',
  newTier = 'Radiant',
  newMultiplier = 1.5,
  cumulativeSpendJpy = 0,
  remainingPoints = 0,
  portalUrl,
}: Props) => {
  const benefits = TIER_BENEFITS[newTier] ?? []
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>You've reached {newTier} on Cha Jewels Loyalty</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={headerBar}>
            <Text style={brandText}>💎 {SITE_NAME}</Text>
          </Section>
          <Heading style={{ ...h1, color: '#a37e1f' }}>🎉 Tier Upgrade!</Heading>
          <Text style={greeting}>Hi {customerName},</Text>
          <Text style={text}>
            Congratulations! You've reached <strong>{newTier}</strong>!
          </Text>

          <Section style={upgradeBox}>
            <Text style={upgradeArrow}>{oldTier} → {newTier}</Text>
            <Text style={upgradeMult}>Your new multiplier: {newMultiplier}× points</Text>
          </Section>

          {benefits.length > 0 && (
            <Section style={benefitsBox}>
              <Text style={benefitsTitle}>Benefits Unlocked</Text>
              {benefits.map((b, i) => (
                <Text key={i} style={benefitRow}>◆ {b}</Text>
              ))}
            </Section>
          )}

          <Section style={statsBox}>
            <Text style={statsRow}><strong>Lifetime spend:</strong> ¥{fmt(cumulativeSpendJpy)}</Text>
            <Text style={statsRow}><strong>Points balance:</strong> {fmt(remainingPoints)} pts</Text>
          </Section>

          {portalUrl && (
            <Section style={{ textAlign: 'center' as const, margin: '24px 0' }}>
              <Button style={{ ...button, backgroundColor: '#D4AF37' }} href={portalUrl}>
                View My Tier Benefits
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
  component: LoyaltyTierUpgradeEmail,
  subject: (data: Record<string, any>) =>
    `🎉 You've reached ${data.newTier || 'a new tier'}, ${data.customerName || 'Valued Customer'}!`,
  displayName: 'Loyalty Tier Upgrade',
  previewData: {
    customerName: 'Maria Santos',
    oldTier: 'Glimmer',
    newTier: 'Radiant',
    newMultiplier: 1.5,
    cumulativeSpendJpy: 1050000,
    remainingPoints: 10500,
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
const upgradeBox = { background: 'linear-gradient(135deg, #fff4dc 0%, #fef3c7 50%, #fff4dc 100%)', border: '2px solid #D4AF37', borderRadius: '12px', padding: '20px', margin: '8px 24px 16px', textAlign: 'center' as const }
const upgradeArrow = { fontSize: '22px', fontWeight: 'bold' as const, color: '#a37e1f', letterSpacing: '0.06em', margin: '0' }
const upgradeMult = { fontSize: '14px', color: '#a37e1f', margin: '8px 0 0' }
const benefitsBox = { backgroundColor: '#fffaf0', border: '1px solid #f3e6c0', borderRadius: '12px', padding: '16px 20px', margin: '8px 24px 16px' }
const benefitsTitle = { fontSize: '13px', fontWeight: 'bold' as const, color: '#a37e1f', letterSpacing: '0.12em', textTransform: 'uppercase' as const, margin: '0 0 8px' }
const benefitRow = { fontSize: '13px', color: '#1a1a2e', margin: '4px 0', lineHeight: '1.5' }
const statsBox = { backgroundColor: '#f8f6f0', borderRadius: '8px', padding: '12px 20px', margin: '0 24px 16px' }
const statsRow = { fontSize: '13px', color: '#1a1a2e', margin: '4px 0', lineHeight: '1.5' }
const button = { color: '#1a1500', padding: '12px 28px', borderRadius: '8px', fontSize: '14px', fontWeight: 'bold' as const, textDecoration: 'none', display: 'inline-block' as const }
const hr = { borderColor: '#e5e7eb', margin: '24px' }
const footer = { fontSize: '12px', color: '#9ca3af', padding: '0 24px', margin: '0 0 8px', lineHeight: '1.5' }
const footerBrand = { fontSize: '11px', color: '#d4af37', textAlign: 'center' as const, padding: '0 24px 24px', margin: '0', fontWeight: 'bold' as const }
