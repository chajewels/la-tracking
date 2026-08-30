/// <reference types="npm:@types/react@18.3.1" />

import * as React from 'npm:react@18.3.1'

import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Text,
} from 'npm:@react-email/components@0.0.22'

interface InviteEmailProps {
  siteName: string
  siteUrl: string
  confirmationUrl: string
}

export const InviteEmail = ({
  siteName,
  siteUrl,
  confirmationUrl,
}: InviteEmailProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>You've been invited to join Cha Jewels</Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>You've been invited ✨</Heading>
        <Text style={text}>
          You've been invited to join <strong>Cha Jewels</strong>. Click the
          button below to accept the invitation and create your account.
        </Text>
        <table
          cellPadding={0}
          cellSpacing={0}
          border={0}
          align="center"
          role="presentation"
          style={{ margin: '24px auto', borderCollapse: 'separate' as const }}
        >
          <tbody>
            <tr>
              <td
                align="center"
                style={{ backgroundColor: '#CEA021', borderRadius: '10px' }}
              >
                <a
                  href={confirmationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: 'inline-block',
                    padding: '12px 24px',
                    fontFamily: "'Montserrat', 'Inter', Arial, sans-serif",
                    fontSize: '14px',
                    fontWeight: 600,
                    color: '#ffffff',
                    textDecoration: 'none',
                    lineHeight: '100%',
                  }}
                >
                  Accept Invitation
                </a>
              </td>
            </tr>
          </tbody>
        </table>
        <Text style={footer}>
          If you weren't expecting this invitation, you can safely ignore this
          email.
        </Text>
      </Container>
    </Body>
  </Html>
)

export default InviteEmail

const main = { backgroundColor: '#ffffff', fontFamily: "'Montserrat', 'Inter', Arial, sans-serif" }
const container = { padding: '30px 25px' }
const h1 = { fontSize: '22px', fontWeight: '600' as const, color: '#0b0b0b', margin: '0 0 20px' }
const text = { fontSize: '14px', color: '#666666', lineHeight: '1.6', margin: '0 0 25px' }
const footer = { fontSize: '12px', color: '#999999', margin: '30px 0 0' }
