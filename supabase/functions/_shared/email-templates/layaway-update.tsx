/// <reference types="npm:@types/react@18.3.1" />
/* eslint-disable react-refresh/only-export-components -- an email template, never hot-reloaded; the subject helper lives beside it like every other template */
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Link, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import { formatDeadline, formatMoney } from '../storefront-email.ts'
import { Panel, Row, WORDS, block, blockGutter, button, buttonWrap, container, footer, h1, headerBar, main, muted, rule, text, wordmark } from './order-shared.tsx'
import { LAYAWAY_WORDS } from './layaway-shared.tsx'

/**
 * ONE SMALL UPDATE ABOUT A WEB LAYAWAY (payment lifecycle H4, spec §5 B / C).
 *
 *   rejected        a reviewer rejected a payment on the plan (her message shown).
 *   needs_info      a reviewer marked a payment "needs clarification".
 *   deadline_moved  staff moved the deposit deadline (set-account-deadlines).
 *   shipped         staff entered a tracking number (notify-shipped).
 *
 * WEB layaways only (source_channel 'web'), sent by _shared/order-update-email.ts;
 * a Hub-created plan keeps its portal email. Links go to the storefront plan
 * page (/account/layaway/:id), never the portal.
 *
 * ENGLISH ONLY (owner rule: no layaway email is ever sent in Japanese — subject
 * or body). There is no language prop; development/layaway-english.test.ts
 * fails on any Japanese character. The staff message is rendered as TEXT.
 */
export type LayawayUpdateVariant = 'rejected' | 'needs_info' | 'deadline_moved' | 'shipped'

export interface LayawayUpdateEmailProps {
  variant: LayawayUpdateVariant
  reference: string
  currency: 'JPY' | 'PHP'
  /** The payment the update is about, in the plan's currency; null = no amount line. */
  amount?: number | null
  message?: string | null
  /** The (new) deadline, ISO. */
  deadline?: string | null
  /** Clock for the deadline; defaults from the currency (yen → JST, pesos → PHT). */
  region?: 'JP' | 'OVERSEAS'
  courier?: string | null
  trackingNumber?: string | null
  trackingUrl?: string | null
  planUrl: string
}

const SUBJECT: Record<LayawayUpdateVariant, string> = {
  rejected: 'We could not accept your payment',
  needs_info: 'We need to check your payment',
  deadline_moved: 'Your payment deadline has changed',
  shipped: 'Your layaway piece has shipped',
}

export const layawayUpdateSubject = (variant: LayawayUpdateVariant, reference: string) =>
  `${SUBJECT[variant]} — Cha Jewels layaway ${reference}`

export const LayawayUpdateEmail = (p: LayawayUpdateEmailProps) => {
  const region = p.region ?? (p.currency === 'PHP' ? 'OVERSEAS' : 'JP')
  const when = formatDeadline(p.deadline ?? null, region, 'en')
  const message = String(p.message ?? '').trim()
  const hasAmount = typeof p.amount === 'number' && Number.isFinite(p.amount) && p.amount > 0
  const amount = hasAmount ? formatMoney(p.amount as number, p.currency) : ''
  const courier = String(p.courier ?? '').trim()
  const tracking = String(p.trackingNumber ?? '').trim()

  let heading: string
  let intro: string
  let next: string | null = null
  switch (p.variant) {
    case 'rejected':
      heading = 'We could not accept your payment'
      intro = hasAmount
        ? `We could not accept your payment of ${amount} for layaway plan ${p.reference}.`
        : `We could not accept your latest payment for layaway plan ${p.reference}.`
      next = 'Please read the message from our team, then submit your payment again from your plan page or reply to this email.'
      break
    case 'needs_info':
      heading = 'We need to check your payment'
      intro = `We need to check something about your payment for layaway plan ${p.reference}.`
      next = 'Please read the message below and reply to this email.'
      break
    case 'deadline_moved':
      heading = when ? `We have moved your payment deadline to ${when}` : 'We have moved your payment deadline'
      intro = `The payment deadline for layaway plan ${p.reference} has changed.`
      break
    default:
      heading = 'Your layaway piece has shipped'
      intro = `We have shipped the piece on layaway plan ${p.reference}. It is on its way to you.`
  }

  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>{layawayUpdateSubject(p.variant, p.reference)}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={headerBar}>
            <Text style={wordmark}>Cha Jewels</Text>
          </Section>
          <Heading style={h1}>{heading}</Heading>
          <Text style={text}>{intro}</Text>
          {next && <Text style={text}>{next}</Text>}
          {message && (
            <Panel gutter={blockGutter} box={block}>
              <Text style={{ ...muted, margin: '0 0 4px' }}>Message from our team</Text>
              <Text style={{ ...text, margin: 0, whiteSpace: 'pre-line' as const }}>{message}</Text>
            </Panel>
          )}
          <Panel gutter={blockGutter} box={block}>
            {/* Row is a table, not flex — Gmail drops display:flex. See order-shared. */}
            <Row k={LAYAWAY_WORDS.reference} v={p.reference} />
            {p.variant !== 'shipped' && hasAmount && <Row k="Amount" v={amount} />}
            {p.variant === 'deadline_moved' && when && <Row k="New payment deadline" v={when} emphasis />}
            {p.variant === 'shipped' && courier && <Row k="Courier" v={courier} />}
            {p.variant === 'shipped' && tracking && <Row k="Tracking number" v={tracking} mono />}
          </Panel>
          {p.variant === 'shipped' && p.trackingUrl && (
            <Text style={text}>
              Track your parcel: <Link href={p.trackingUrl}>{p.trackingUrl}</Link>
            </Text>
          )}
          <Section style={buttonWrap}>
            <Button style={button} href={p.planUrl}>{LAYAWAY_WORDS.viewPlan}</Button>
          </Section>
          <Hr style={rule} />
          <Text style={muted}>{WORDS.help.en}</Text>
          <Text style={footer}>{WORDS.footer.en}</Text>
        </Container>
      </Body>
    </Html>
  )
}

export default LayawayUpdateEmail
