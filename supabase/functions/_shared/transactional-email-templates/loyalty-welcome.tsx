/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Html, Preview, Text, Section, Hr, Button,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'

const SITE_NAME = 'Cha Jewels Hub'

interface Props {
  customerName?: string
  enrolledDate?: string
  portalUrl?: string
}

const LoyaltyWelcomeEmail = ({
  customerName = 'Valued Customer',
  enrolledDate = 'today',
  portalUrl,
}: Props) => {
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>Welcome to Cha Jewels Loyalty, {customerName}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={headerBar}>
            <Text style={brandText}>💎 {SITE_NAME}</Text>
          </Section>
          <Heading style={{ ...h1, color: '#a37e1f' }}>💎 Welcome to Cha Jewels Loyalty!</Heading>
          <Text style={greeting}>Hi {customerName},</Text>
          <Text style={text}>
            You're now a Cha Jewels Loyalty member as of <strong>{enrolledDate}</strong>.
            Welcome to a more rewarding way to shop!
          </Text>

          <Section style={tierBox}>
            <Text style={tierLabel}>Your Starting Tier</Text>
            <Text style={tierName}>GLIMMER</Text>
            <Text style={tierMultiplier}>1× points multiplier</Text>
          </Section>

          <Section style={howBox}>
            <Text style={howTitle}>How it works</Text>
            <Text style={howRow}>◆ Earn 100 points per ¥10,000 spent</Text>
            <Text style={howRow}>
              ◆ Reach Radiant (¥1M), Elite (¥4M), or Crown VIP (¥8M) for higher
              multipliers
            </Text>
            <Text style={howRow}>◆ Redeem points on new orders, shipping, or service fees</Text>
            <Text style={howRow}>◆ 1 point = ¥1 value</Text>
          </Section>

          {portalUrl && (
            <Section style={{ textAlign: 'center' as const, margin: '24px 0' }}>
              <Button style={{ ...button, backgroundColor: '#D4AF37' }} href={portalUrl}>
                View My Loyalty Dashboard
              </Button>
            </Section>
          )}

          <Text style={footnote}>
            Make your first eligible purchase to start earning points!
          </Text>

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
  component: LoyaltyWelcomeEmail,
  subject: (data: Record<string, any>) =>
    `💎 Welcome to Cha Jewels Loyalty, ${data.customerName || 'Valued Customer'}!`,
  displayName: 'Loyalty Welcome',
  previewData: {
    customerName: 'Maria Santos',
    enrolledDate: 'April 25, 2026',
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
const tierBox = { backgroundColor: '#fffaf0', border: '1px solid #D4AF37', borderRadius: '12px', padding: '16px 20px', margin: '8px 24px 16px', textAlign: 'center' as const }
const tierLabel = { fontSize: '11px', color: '#a37e1f', letterSpacing: '0.18em', textTransform: 'uppercase' as const, margin: '0 0 6px' }
const tierName = { fontSize: '22px', fontWeight: 'bold' as const, color: '#a37e1f', letterSpacing: '0.12em', margin: '0' }
const tierMultiplier = { fontSize: '13px', color: '#a37e1f', margin: '6px 0 0' }
const howBox = { backgroundColor: '#f8f6f0', borderRadius: '12px', padding: '16px 20px', margin: '8px 24px 16px' }
const howTitle = { fontSize: '13px', fontWeight: 'bold' as const, color: '#1a1a2e', margin: '0 0 8px', letterSpacing: '0.04em' }
const howRow = { fontSize: '13px', color: '#1a1a2e', margin: '4px 0', lineHeight: '1.5' }
const button = { color: '#1a1500', padding: '12px 28px', borderRadius: '8px', fontSize: '14px', fontWeight: 'bold' as const, textDecoration: 'none', display: 'inline-block' as const }
const footnote = { fontSize: '13px', color: '#a37e1f', textAlign: 'center' as const, padding: '0 24px', margin: '8px 0 0', fontStyle: 'italic' as const }
const hr = { borderColor: '#e5e7eb', margin: '24px' }
const footer = { fontSize: '12px', color: '#9ca3af', padding: '0 24px', margin: '0 0 8px', lineHeight: '1.5' }
const footerBrand = { fontSize: '11px', color: '#d4af37', textAlign: 'center' as const, padding: '0 24px 24px', margin: '0', fontWeight: 'bold' as const }
