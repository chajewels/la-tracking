/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Html, Preview, Text, Section, Hr, Button,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'

const SITE_NAME = 'Cha Jewels Hub'

interface Props {
  customerName?: string
  pointsEarned?: number
  spendAmountJpy?: number
  invoiceNumber?: string
  tierName?: string
  tierMultiplier?: number
  remainingPoints?: number
  cumulativeSpendJpy?: number
  portalUrl?: string
}

const fmt = (n: number | undefined) => (n != null ? Number(n).toLocaleString('en-US') : '0')

const LoyaltyEarnedEmail = ({
  customerName = 'Valued Customer',
  pointsEarned = 0,
  spendAmountJpy = 0,
  invoiceNumber = '00000',
  tierName = 'Glimmer',
  tierMultiplier = 1,
  remainingPoints = 0,
  cumulativeSpendJpy = 0,
  portalUrl,
}: Props) => {
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>You earned {fmt(pointsEarned)} loyalty points</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={headerBar}>
            <Text style={brandText}>💎 {SITE_NAME}</Text>
          </Section>
          <Heading style={{ ...h1, color: '#a37e1f' }}>✨ Points Earned!</Heading>
          <Text style={greeting}>Hi {customerName},</Text>
          <Text style={text}>
            You earned <strong>{fmt(pointsEarned)} points</strong> from your purchase!
          </Text>

          <Section style={earnBox}>
            <Text style={earnRow}><strong>Purchase:</strong> ¥{fmt(spendAmountJpy)} (INV #{invoiceNumber})</Text>
            <Text style={earnRow}><strong>Tier:</strong> {tierName} ({tierMultiplier}× multiplier)</Text>
            <Text style={earnRow}><strong>Points earned:</strong> +{fmt(pointsEarned)}</Text>
            <Text style={earnRowEmphasis}><strong>New balance:</strong> {fmt(remainingPoints)} pts</Text>
          </Section>

          <Section style={lifetimeBox}>
            <Text style={lifetimeText}>
              <strong>Lifetime spend:</strong> ¥{fmt(cumulativeSpendJpy)}
            </Text>
          </Section>

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
  component: LoyaltyEarnedEmail,
  subject: (data: Record<string, any>) =>
    `✨ You earned ${fmt(data.pointsEarned)} points, ${data.customerName || 'Valued Customer'}!`,
  displayName: 'Loyalty Points Earned',
  previewData: {
    customerName: 'Maria Santos',
    pointsEarned: 1500,
    spendAmountJpy: 150000,
    invoiceNumber: '19012',
    tierName: 'Glimmer',
    tierMultiplier: 1,
    remainingPoints: 1500,
    cumulativeSpendJpy: 150000,
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
const earnBox = { background: 'linear-gradient(135deg, #fffaf0 0%, #fff4dc 100%)', border: '1px solid #D4AF37', borderRadius: '12px', padding: '16px 20px', margin: '8px 24px 16px' }
const earnRow = { fontSize: '13px', color: '#1a1a2e', margin: '4px 0', lineHeight: '1.5' }
const earnRowEmphasis = { fontSize: '14px', color: '#a37e1f', margin: '8px 0 0', lineHeight: '1.5', fontWeight: 'bold' as const }
const lifetimeBox = { backgroundColor: '#f8f6f0', borderRadius: '8px', padding: '10px 20px', margin: '0 24px 16px' }
const lifetimeText = { fontSize: '12px', color: '#55575d', margin: '0' }
const button = { color: '#1a1500', padding: '12px 28px', borderRadius: '8px', fontSize: '14px', fontWeight: 'bold' as const, textDecoration: 'none', display: 'inline-block' as const }
const hr = { borderColor: '#e5e7eb', margin: '24px' }
const footer = { fontSize: '12px', color: '#9ca3af', padding: '0 24px', margin: '0 0 8px', lineHeight: '1.5' }
const footerBrand = { fontSize: '11px', color: '#d4af37', textAlign: 'center' as const, padding: '0 24px 24px', margin: '0', fontWeight: 'bold' as const }
