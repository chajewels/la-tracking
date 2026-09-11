/// <reference types="npm:@types/react@18.3.1" />

import * as React from 'npm:react@18.3.1'

import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from 'npm:@react-email/components@0.0.22'

/**
 * Sign-in link for chajewelsjp.com CUSTOMERS. Japanese first, then English,
 * Cha Jewels branding — and no mention of the Hub, which is a staff tool the
 * customer has never heard of. The staff templates (signup / invite /
 * recovery …) are untouched; auth-email-hook picks this one only when the
 * link's redirect target is a storefront host.
 *
 * Literal gold hex is deliberate: mail clients cannot read CSS variables
 * (CLAUDE.md, BRAND STYLE STANDARD). Button text is dark on gold — the
 * accessible pairing, not white on gold.
 */
interface StorefrontMagicLinkEmailProps {
  confirmationUrl: string
}

export const StorefrontMagicLinkEmail = ({ confirmationUrl }: StorefrontMagicLinkEmailProps) => (
  <Html lang="ja" dir="ltr">
    <Head />
    <Preview>Cha Jewels サインインリンク / Your Cha Jewels sign-in link</Preview>
    <Body style={main}>
      <Container style={container}>
        <Section style={headerBar}>
          <Text style={wordmark}>Cha Jewels</Text>
        </Section>

        <Heading style={h1}>サインインリンク</Heading>
        <Text style={text}>
          下のボタンを押すと、Cha Jewels にサインインできます。パスワードは不要です。
          このリンクは一定時間で無効になり、1回のみご利用いただけます。
        </Text>
        <Section style={buttonWrap}>
          <Button style={button} href={confirmationUrl}>サインイン</Button>
        </Section>
        <Text style={muted}>
          お心当たりのない場合は、このメールを破棄してください。アカウントに変更はありません。
        </Text>

        <Hr style={rule} />

        <Heading style={h2}>Your sign-in link</Heading>
        <Text style={text}>
          Press the button to sign in to Cha Jewels. No password needed. The link
          expires shortly and works once.
        </Text>
        <Section style={buttonWrap}>
          <Button style={button} href={confirmationUrl}>Sign in</Button>
        </Section>
        <Text style={muted}>
          If you did not request this, you can ignore this email. Nothing changes on your account.
        </Text>

        <Text style={footer}>Cha Jewels Co., Ltd. · 東京都葛飾区立石</Text>
      </Container>
    </Body>
  </Html>
)

export default StorefrontMagicLinkEmail

const main = { backgroundColor: '#f6f4ef', fontFamily: '"Hiragino Sans", "Noto Sans JP", Arial, sans-serif' }
const container = { backgroundColor: '#ffffff', margin: '24px auto', maxWidth: '520px', borderRadius: '8px', overflow: 'hidden' as const }
const headerBar = { borderTop: '4px solid #C9A227', padding: '24px 24px 8px', textAlign: 'center' as const }
const wordmark = { fontSize: '22px', fontWeight: 'bold' as const, color: '#1a1a2e', margin: '0', letterSpacing: '1px' }
const h1 = { fontSize: '20px', fontWeight: 'bold' as const, color: '#1a1a2e', margin: '16px 24px 8px' }
const h2 = { fontSize: '18px', fontWeight: 'bold' as const, color: '#1a1a2e', margin: '8px 24px 8px' }
const text = { fontSize: '14px', color: '#55575d', lineHeight: '1.7', padding: '0 24px', margin: '0 0 16px' }
const muted = { fontSize: '12px', color: '#8a8580', lineHeight: '1.6', padding: '0 24px', margin: '0 0 8px' }
const buttonWrap = { padding: '0 24px', margin: '0 0 16px' }
const button = { backgroundColor: '#C9A227', color: '#1a1a2e', fontSize: '14px', fontWeight: 'bold' as const, padding: '12px 28px', borderRadius: '6px', textDecoration: 'none', display: 'inline-block' as const }
const rule = { borderColor: '#e8e2d4', margin: '8px 24px 16px' }
const footer = { fontSize: '11px', color: '#C9A227', textAlign: 'center' as const, padding: '8px 24px 24px', margin: '0', fontWeight: 'bold' as const }
