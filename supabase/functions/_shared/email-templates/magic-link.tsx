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

interface MagicLinkEmailProps {
  siteName: string
  confirmationUrl: string
}

export const MagicLinkEmail = ({
  siteName,
  confirmationUrl,
}: MagicLinkEmailProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>Your login link for Cha Jewels</Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>Your login link</Heading>
        <Text style={text}>
          Click the button below to log in to Cha Jewels. This link will expire
          shortly.
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
                  Log In
                </a>
              </td>
            </tr>
          </tbody>
        </table>
        <Text style={footer}>
          If you didn't request this link, you can safely ignore this email.
        </Text>
      </Container>
    </Body>
  </Html>
)

export default MagicLinkEmail

const main = { backgroundColor: '#ffffff', fontFamily: "'Montserrat', 'Inter', Arial, sans-serif" }
const container = { padding: '30px 25px' }
const h1 = { fontSize: '22px', fontWeight: '600' as const, color: '#0b0b0b', margin: '0 0 20px' }
const text = { fontSize: '14px', color: '#666666', lineHeight: '1.6', margin: '0 0 25px' }
const footer = { fontSize: '12px', color: '#999999', margin: '30px 0 0' }
