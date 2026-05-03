/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Html, Preview, Text, Section, Hr, Button,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'

const SITE_NAME = 'Cha Jewels Hub'

interface Props {
  memberFirstName?: string
  notificationTitle?: string
  notificationBody?: string
  ctaUrl?: string | null
}

const LoyaltyBroadcastEmail = ({
  memberFirstName = 'Valued Member',
  notificationTitle = 'A message from Cha Jewels',
  notificationBody = '',
  ctaUrl,
}: Props) => {
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>{notificationTitle}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={headerBar}>
            <Text style={brandText}>💎 {SITE_NAME}</Text>
          </Section>
          <Heading style={{ ...h1, color: '#a37e1f' }}>{notificationTitle}</Heading>
          <Text style={greeting}>Hi {memberFirstName},</Text>
          <Text style={text}>{notificationBody}</Text>

          {ctaUrl && (
            <Section style={{ textAlign: 'center' as const, margin: '24px 0' }}>
              <Button style={{ ...button, backgroundColor: '#D4AF37' }} href={ctaUrl}>
                Open My Loyalty Portal
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
  component: LoyaltyBroadcastEmail,
  subject: (data: Record<string, any>) =>
    data.notificationTitle || `A message from ${SITE_NAME}`,
  displayName: 'Loyalty Broadcast',
  previewData: {
    memberFirstName: 'Maria',
    notificationTitle: '✨ New Rewards in the VIP Vault',
    notificationBody:
      'We just dropped 3 new exclusive rewards in the VIP Vault — only available this week. Tap below to take a look.',
    ctaUrl: 'https://portal.chajewelsjp.com/loyalty?token=demo',
  },
} satisfies TemplateEntry

const main = { backgroundColor: '#ffffff', fontFamily: "'Montserrat', 'Inter', Arial, sans-serif" }
const container = { padding: '0', maxWidth: '560px', margin: '0 auto' }
const headerBar = { borderTop: '4px solid #D4AF37', padding: '24px 24px 8px', textAlign: 'center' as const }
const brandText = { fontSize: '18px', fontWeight: 'bold' as const, color: '#1a1a2e', margin: '0', letterSpacing: '0.5px' }
const h1 = { fontSize: '20px', fontWeight: 'bold' as const, textAlign: 'center' as const, margin: '16px 24px 8px' }
const greeting = { fontSize: '15px', color: '#1a1a2e', padding: '0 24px', margin: '16px 0 4px' }
const text = { fontSize: '14px', color: '#55575d', lineHeight: '1.6', padding: '0 24px', margin: '0 0 16px' }
const button = { color: '#1a1500', padding: '12px 28px', borderRadius: '8px', fontSize: '14px', fontWeight: 'bold' as const, textDecoration: 'none', display: 'inline-block' as const }
const hr = { borderColor: '#e5e7eb', margin: '24px' }
const footer = { fontSize: '12px', color: '#9ca3af', padding: '0 24px', margin: '0 0 8px', lineHeight: '1.5' }
const footerBrand = { fontSize: '11px', color: '#d4af37', textAlign: 'center' as const, padding: '0 24px 24px', margin: '0', fontWeight: 'bold' as const }
