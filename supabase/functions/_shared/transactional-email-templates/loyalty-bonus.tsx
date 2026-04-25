/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Html, Preview, Text, Section, Hr, Button,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'

const SITE_NAME = 'Cha Jewels Hub'

interface Props {
  customerName?: string
  bonusPoints?: number
  promoName?: string
  promoEndDate?: string
  invoiceNumber?: string
  remainingPoints?: number
  portalUrl?: string
}

const fmt = (n: number | undefined) => (n != null ? Number(n).toLocaleString('en-US') : '0')

const LoyaltyBonusEmail = ({
  customerName = 'Valued Customer',
  bonusPoints = 0,
  promoName = 'Promo',
  promoEndDate = 'soon',
  invoiceNumber = '00000',
  remainingPoints = 0,
  portalUrl,
}: Props) => {
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>Bonus points from {promoName}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={headerBar}>
            <Text style={brandText}>💎 {SITE_NAME}</Text>
          </Section>
          <Heading style={{ ...h1, color: '#057a55' }}>🎁 Bonus Points Awarded!</Heading>
          <Text style={greeting}>Hi {customerName},</Text>
          <Text style={text}>
            Thanks to our <strong>{promoName}</strong> promotion, you earned an extra{' '}
            <strong>{fmt(bonusPoints)} bonus points</strong>!
          </Text>

          <Section style={bonusBox}>
            <Text style={bonusRow}><strong>Promotion:</strong> {promoName}</Text>
            <Text style={bonusRow}><strong>Bonus:</strong> +{fmt(bonusPoints)} pts</Text>
            <Text style={bonusRow}><strong>Applied to:</strong> INV #{invoiceNumber}</Text>
            <Text style={bonusRowEmphasis}><strong>New balance:</strong> {fmt(remainingPoints)} pts</Text>
            <Text style={bonusEnds}><strong>Promo ends:</strong> {promoEndDate}</Text>
          </Section>

          <Section style={noteBox}>
            <Text style={noteText}>
              Promotional bonuses stack with your regular points earning!
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
  component: LoyaltyBonusEmail,
  subject: (data: Record<string, any>) =>
    `🎁 Bonus points from ${data.promoName || 'our promotion'}!`,
  displayName: 'Loyalty Promo Bonus',
  previewData: {
    customerName: 'Maria Santos',
    bonusPoints: 500,
    promoName: 'Spring Bonus',
    promoEndDate: 'May 31, 2026',
    invoiceNumber: '19012',
    remainingPoints: 2000,
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
const bonusBox = { background: 'linear-gradient(135deg, #fffaf0 0%, #ecfdf5 100%)', border: '1px solid #6ee7b7', borderRadius: '12px', padding: '16px 20px', margin: '8px 24px 16px' }
const bonusRow = { fontSize: '13px', color: '#1a1a2e', margin: '4px 0', lineHeight: '1.5' }
const bonusRowEmphasis = { fontSize: '14px', color: '#057a55', margin: '8px 0 4px', lineHeight: '1.5', fontWeight: 'bold' as const }
const bonusEnds = { fontSize: '12px', color: '#55575d', margin: '4px 0 0', fontStyle: 'italic' as const }
const noteBox = { backgroundColor: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '8px', padding: '10px 20px', margin: '0 24px 16px' }
const noteText = { fontSize: '12px', color: '#057a55', margin: '0', textAlign: 'center' as const }
const button = { color: '#1a1500', padding: '12px 28px', borderRadius: '8px', fontSize: '14px', fontWeight: 'bold' as const, textDecoration: 'none', display: 'inline-block' as const }
const hr = { borderColor: '#e5e7eb', margin: '24px' }
const footer = { fontSize: '12px', color: '#9ca3af', padding: '0 24px', margin: '0 0 8px', lineHeight: '1.5' }
const footerBrand = { fontSize: '11px', color: '#d4af37', textAlign: 'center' as const, padding: '0 24px 24px', margin: '0', fontWeight: 'bold' as const }
