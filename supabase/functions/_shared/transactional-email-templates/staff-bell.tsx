/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Html, Preview, Text, Section, Hr, Link,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'
import { INTERNAL_SITE_NAME as SITE_NAME, INTERNAL_FOOTER as FOOTER_LINE } from './brand.ts'

/**
 * STAFF BELL EMAIL (V11b, owner 2026-10-08). Internal: staff-bell-emails sends
 * one of these per (bell, recipient) for the bell types in
 * system_settings.staff_bell_email_types — to Brenda and every admin. The body
 * is the bell's own text; the link goes to the Hub (app.* — staff only, never
 * a customer). English only.
 */
interface Props {
  title?: string
  body?: string
  bellType?: string
  invoiceNumber?: string | null
  when?: string
  hubUrl?: string
}

const StaffBellEmail = ({ title = '', body = '', bellType = '', invoiceNumber = null, when = '', hubUrl = '' }: Props) => (
  <Html>
    <Head />
    <Preview>{title}</Preview>
    <Body style={main}>
      <Container style={container}>
        <Section style={headerBar}>
          <Text style={brandText}>💎 {SITE_NAME}</Text>
        </Section>
        <Heading style={h1}>{title}</Heading>
        <Section style={card}>
          <Text style={cardLine}>{body}</Text>
        </Section>
        <Text style={meta}>
          {bellType}{invoiceNumber ? ` · ${invoiceNumber}` : ''}{when ? ` · ${when}` : ''}
        </Text>
        {hubUrl ? (
          <Text style={text}>
            <Link href={hubUrl} style={link}>Open in the Hub</Link>
          </Text>
        ) : null}
        <Text style={text}>
          You receive this because this bell type is on the staff email list (Hub → Settings). The bell is also in the Hub for every member.
        </Text>
        <Hr style={hr} />
        <Text style={footerBrand}>{FOOTER_LINE}</Text>
      </Container>
    </Body>
  </Html>
)

export const template = {
  /** Staff mail: Hub identity. See brand.ts. */
  audience: 'internal' as const,
  component: StaffBellEmail,
  subject: (data: Record<string, any>) => `[Hub bell] ${data.title ?? ''}${data.invoiceNumber ? ` · ${data.invoiceNumber}` : ''}`,
  displayName: 'Staff bell (internal)',
  previewData: {
    title: 'Card refund on an order that already has store credit',
    body: 'CJ-W-900069 · ¥8,563 refunded in Square (completed) but this order was cancelled with STORE CREDIT. The customer is being paid back twice: void the store-credit lot (Settings → Store Credit) or reverse the Square refund.',
    bellType: 'card_refund_after_credit',
    invoiceNumber: 'TEST-900069',
    when: '08 Oct 2026, 17:33 JST',
    hubUrl: 'https://app.chajewelsjp.com/website?tab=settings',
  },
} satisfies TemplateEntry

const main = { backgroundColor: '#ffffff', fontFamily: "'Montserrat', 'Inter', Arial, sans-serif" }
const container = { padding: '0', maxWidth: '560px', margin: '0 auto' }
const headerBar = { borderTop: '4px solid #C9A227', padding: '24px 24px 8px', textAlign: 'center' as const }
const brandText = { fontSize: '18px', fontWeight: 'bold' as const, color: '#1a1a2e', margin: '0', letterSpacing: '0.5px' }
const h1 = { fontSize: '20px', fontWeight: 'bold' as const, color: '#1a1a2e', textAlign: 'center' as const, margin: '16px 24px 8px' }
const text = { fontSize: '14px', color: '#55575d', lineHeight: '1.6', padding: '0 24px', margin: '0 0 16px' }
const meta = { fontSize: '12px', color: '#8a8d93', padding: '0 24px', margin: '0 0 12px' }
const card = { margin: '0 24px 12px', padding: '12px 16px', border: '1px solid #C9A227', borderRadius: '6px' }
const cardLine = { fontSize: '14px', color: '#1a1a2e', lineHeight: '1.6', margin: '0' }
const link = { color: '#1a1a2e', textDecoration: 'underline' }
const hr = { borderColor: '#e5e7eb', margin: '24px' }
const footerBrand = { fontSize: '11px', color: '#C9A227', textAlign: 'center' as const, padding: '0 24px 24px', margin: '0', fontWeight: 'bold' as const }
