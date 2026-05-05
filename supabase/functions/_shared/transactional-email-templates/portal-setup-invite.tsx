/// <reference types="npm:@types/react@18.3.1" />

import * as React from 'npm:react@18.3.1'

import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Text,
} from 'npm:@react-email/components@0.0.22'

interface PortalSetupInviteEmailProps {
  customerName: string
  setupUrl: string
  customerEmail: string
}

export const PortalSetupInviteEmail = ({
  customerName,
  setupUrl,
  customerEmail,
}: PortalSetupInviteEmailProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>Your Cha Jewels portal is ready — set up your access</Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>Your Cha Jewels portal is ready</Heading>
        <Text style={greeting}>Hi {customerName},</Text>
        <Text style={text}>
          Cha Jewels has set up email and password access for your customer
          portal. Click the button below to choose your password and sign in.
        </Text>
        <Button style={button} href={setupUrl}>
          Set Up My Portal Access
        </Button>
        <Text style={smallText}>
          This invite was sent to <strong>{customerEmail}</strong>. After
          you set your password, you'll receive a verification email — click
          the link in that email to complete activation. Once verified, you
          can view your layaway accounts, payment schedule, and loyalty
          rewards anytime.
        </Text>
        <Text style={footer}>
          Please don't share this link with others. If you didn't expect
          this invite, you can safely ignore this email.
        </Text>
        <Text style={signature}>
          Thank you for trusting Cha Jewels —<br />
          Everyday Layaway, Cha Jewels All the Way
        </Text>
      </Container>
    </Body>
  </Html>
)

export default PortalSetupInviteEmail

const main = { backgroundColor: '#ffffff', fontFamily: "'Montserrat', 'Inter', Arial, sans-serif" }
const container = { padding: '30px 25px' }
const h1 = { fontSize: '22px', fontWeight: '600' as const, color: '#0b0b0b', margin: '0 0 20px' }
const greeting = { fontSize: '14px', color: '#0b0b0b', lineHeight: '1.6', margin: '0 0 12px' }
const text = { fontSize: '14px', color: '#444444', lineHeight: '1.6', margin: '0 0 22px' }
const smallText = { fontSize: '13px', color: '#666666', lineHeight: '1.6', margin: '20px 0 0' }
const button = { backgroundColor: 'hsl(44, 72%, 47%)', color: '#ffffff', fontSize: '14px', fontWeight: '600' as const, borderRadius: '10px', padding: '12px 24px', textDecoration: 'none', display: 'inline-block', margin: '4px 0 8px' }
const footer = { fontSize: '12px', color: '#999999', margin: '20px 0 0', lineHeight: '1.5' }
const signature = { fontSize: '13px', color: '#444444', margin: '24px 0 0', lineHeight: '1.6' }
