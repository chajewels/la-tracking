/// <reference types="npm:@types/react@18.3.1" />
/* eslint-disable react-refresh/only-export-components -- an email template, never hot-reloaded; the subject helper lives beside it like every other template */
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Link, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import { formatDeadline, formatMoney } from '../storefront-email.ts'
import { Panel, Row, WORDS, block, blockGutter, button, buttonWrap, container, footer, h1, headerBar, main, muted, rule, text, wordmark } from './order-shared.tsx'
import { LAYAWAY_WORDS, formatDueDate } from './layaway-shared.tsx'

/**
 * ONE SMALL UPDATE ABOUT A WEB LAYAWAY (payment lifecycle H4, spec §5 B / C).
 *
 *   rejected        a reviewer rejected a payment on the plan (her message shown).
 *   needs_info      a reviewer marked a payment "needs clarification".
 *   deadline_moved  staff moved the deposit deadline (set-account-deadlines).
 *   shipped         staff entered a tracking number (notify-shipped).
 *
 * Email addendum B (2026-10-06, items 2-4) — every routine plan event, so a web
 * customer never gets the Hub's portal email:
 *   payment_received_details  she (website) or the portal filed a payment — not
 *                             confirmed yet (submit-payment, website /layaway/:id/pay).
 *   instalment_reminder       an instalment is coming up / due / overdue
 *                             (send-reminders; reminderKind picks the copy).
 *   penalty_applied           a late payment fee was added (penalty-engine).
 *   penalty_escalation        the plan is seriously overdue (penalty-engine).
 *   penalty_waived            staff waived late payment fees (approve-waiver).
 *   payment_voided            staff reversed a recorded payment (void-payment).
 *   reactivated               a forfeited plan was reactivated with a new
 *                             settle-by date (reactivate-account).
 * Every figure is the one the caller passes from the Hub's records; this file
 * only formats.
 *
 * WEB layaways only (source_channel 'web'), sent by _shared/order-update-email.ts;
 * a Hub-created plan keeps its portal email. Links go to the storefront plan
 * page (/account/layaway/:id), never the portal.
 *
 * ENGLISH ONLY (owner rule: no layaway email is ever sent in Japanese — subject
 * or body). There is no language prop; development/layaway-english.test.ts
 * fails on any Japanese character. The staff message is rendered as TEXT.
 */
export type LayawayUpdateVariant =
  | 'rejected' | 'needs_info' | 'deadline_moved' | 'shipped'
  | 'payment_received_details' | 'instalment_reminder' | 'penalty_applied' | 'penalty_escalation'
  | 'penalty_waived' | 'payment_voided' | 'reactivated'

/** Which instalment reminder (send-reminders' stage, as the Hub template reads it). */
export type LayawayReminderKind = 'upcoming' | 'due_today' | 'overdue' | 'grace_period'

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
  /** Instalment due date, yyyy-mm-dd (from the schedule). */
  dueDate?: string | null
  /** A date-only deadline, yyyy-mm-dd: grace end, waiver pay-by, extension end. */
  dateDeadline?: string | null
  /** The Hub's stored remaining balance after the event. */
  remaining?: number | null
  /** Σ non-waived late payment fees on the plan (penalty_* variants). */
  totalPenalty?: number | null
  daysOverdue?: number | null
  reminderKind?: LayawayReminderKind | null
  /** yyyy-mm-dd the customer says she paid (payment_received_details). */
  paymentDate?: string | null
}

const SUBJECT: Record<LayawayUpdateVariant, string> = {
  rejected: 'We could not accept your payment',
  needs_info: 'We need to check your payment',
  deadline_moved: 'Your payment deadline has changed',
  shipped: 'Your layaway piece has shipped',
  payment_received_details: 'We received your payment details',
  instalment_reminder: 'Your next layaway payment is coming up',
  penalty_applied: 'A late payment fee has been added',
  penalty_escalation: 'Your layaway plan is seriously overdue',
  penalty_waived: 'We have waived a late payment fee',
  payment_voided: 'A payment on your plan has been reversed',
  reactivated: 'Your plan has been reactivated',
}

const REMINDER_SUBJECT: Record<LayawayReminderKind, string> = {
  upcoming: 'Your next layaway payment is coming up',
  due_today: 'Your layaway payment is due today',
  overdue: 'Your layaway payment is overdue',
  grace_period: 'Your layaway payment is overdue',
}

export const layawayUpdateSubject = (
  variant: LayawayUpdateVariant, reference: string, reminderKind?: LayawayReminderKind | null,
) =>
  `${variant === 'instalment_reminder' && reminderKind ? REMINDER_SUBJECT[reminderKind] : SUBJECT[variant]} — Cha Jewels layaway ${reference}`

const money = (n: number | null | undefined, currency: 'JPY' | 'PHP') =>
  typeof n === 'number' && Number.isFinite(n) ? formatMoney(n, currency) : ''
const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`

export const LayawayUpdateEmail = (p: LayawayUpdateEmailProps) => {
  const region = p.region ?? (p.currency === 'PHP' ? 'OVERSEAS' : 'JP')
  const when = formatDeadline(p.deadline ?? null, region, 'en')
  const message = String(p.message ?? '').trim()
  const hasAmount = typeof p.amount === 'number' && Number.isFinite(p.amount) && p.amount > 0
  const amount = hasAmount ? formatMoney(p.amount as number, p.currency) : ''
  const courier = String(p.courier ?? '').trim()
  const tracking = String(p.trackingNumber ?? '').trim()
  const due = p.dueDate ? formatDueDate(p.dueDate) : ''
  const dateDeadline = p.dateDeadline ? formatDueDate(p.dateDeadline) : ''
  const remaining = money(p.remaining, p.currency)
  const totalPenalty = money(p.totalPenalty, p.currency)
  const overdueDays = typeof p.daysOverdue === 'number' && Number.isFinite(p.daysOverdue) && p.daysOverdue > 0 ? p.daysOverdue : 0
  const paidOn = p.paymentDate ? formatDueDate(p.paymentDate) : ''
  const kind: LayawayReminderKind = p.reminderKind ?? 'upcoming'

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
    case 'payment_received_details':
      heading = 'We received your payment details'
      intro = hasAmount
        ? `Thank you. We received the details of your payment of ${amount} for layaway plan ${p.reference}.`
        : `Thank you. We received the details of your latest payment for layaway plan ${p.reference}.`
      next = 'Our team will check it against our account. It is not on your plan until we confirm it; we will email you again as soon as we do.'
      break
    case 'instalment_reminder':
      if (kind === 'upcoming') {
        heading = due ? `Your next payment is due on ${due}` : 'Your next payment is coming up'
        intro = `A friendly reminder: the next payment on layaway plan ${p.reference} is due${due ? ` on ${due}` : ' soon'}.`
        next = 'You can pay and upload your receipt from your plan page.'
      } else if (kind === 'due_today') {
        heading = 'Your layaway payment is due today'
        intro = `The payment on layaway plan ${p.reference} is due today${due ? `, ${due}` : ''}.`
        next = 'You can pay and upload your receipt from your plan page.'
      } else {
        heading = 'Your layaway payment is overdue'
        intro = `The payment on layaway plan ${p.reference} was due${due ? ` on ${due}` : ''}${overdueDays ? ` (${days(overdueDays)} ago)` : ''}.`
        next = kind === 'grace_period' && dateDeadline
          ? `Please pay by ${dateDeadline} to avoid a late payment fee.`
          : 'Please pay as soon as you can to keep your plan in good standing.'
      }
      break
    case 'penalty_applied':
      heading = 'A late payment fee has been added to your plan'
      intro = `The payment on layaway plan ${p.reference}${due ? ` due on ${due}` : ''} is ${overdueDays ? `${days(overdueDays)} ` : ''}overdue, so ${hasAmount ? `a late payment fee of ${amount} has` : 'a late payment fee has'} been added under the layaway terms.`
      next = 'Please pay as soon as you can to avoid further fees.'
      break
    case 'penalty_escalation':
      heading = 'Your layaway plan is seriously overdue'
      intro = `The payment on layaway plan ${p.reference}${due ? ` due on ${due}` : ''} is ${overdueDays ? `now ${days(overdueDays)} ` : 'still '}overdue.`
      next = 'Please pay now, or reply to this email so we can help. A plan that stays unpaid can be forfeited under the layaway terms.'
      break
    case 'penalty_waived':
      heading = 'We have waived a late payment fee'
      intro = hasAmount
        ? `We have waived ${amount} in late payment fees on layaway plan ${p.reference}.`
        : `We have waived late payment fees on layaway plan ${p.reference}.`
      next = dateDeadline
        ? `Please settle the overdue payment by ${dateDeadline}; after that date the waived fee is added back.`
        : null
      break
    case 'payment_voided':
      heading = 'A payment on your plan has been reversed'
      intro = hasAmount
        ? `We have reversed a payment of ${amount} on layaway plan ${p.reference}. It no longer counts towards your plan.`
        : `We have reversed a payment on layaway plan ${p.reference}. It no longer counts towards your plan.`
      next = 'If you think this is a mistake, please reply to this email.'
      break
    case 'reactivated':
      heading = 'Your plan has been reactivated'
      intro = `Good news: layaway plan ${p.reference} has been reactivated.`
      next = dateDeadline
        ? `This is a one-time extension. Please settle the remaining balance by ${dateDeadline}; after that date the plan is closed for good.`
        : 'This is a one-time extension. Please settle the remaining balance before the extension ends.'
      break
    default:
      heading = 'Your layaway piece has shipped'
      intro = `We have shipped the piece on layaway plan ${p.reference}. It is on its way to you.`
  }
  const isNew = !['rejected', 'needs_info', 'deadline_moved', 'shipped'].includes(p.variant)

  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>{layawayUpdateSubject(p.variant, p.reference, p.reminderKind)}</Preview>
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
              <Text style={{ ...muted, margin: '0 0 4px' }}>{p.variant === 'payment_voided' ? 'Reason' : 'Message from our team'}</Text>
              <Text style={{ ...text, margin: 0, whiteSpace: 'pre-line' as const }}>{message}</Text>
            </Panel>
          )}
          <Panel gutter={blockGutter} box={block}>
            {/* Row is a table, not flex — Gmail drops display:flex. See order-shared. */}
            <Row k={LAYAWAY_WORDS.reference} v={p.reference} />
            {!isNew && p.variant !== 'shipped' && hasAmount && <Row k="Amount" v={amount} />}
            {p.variant === 'payment_received_details' && hasAmount && <Row k="Amount submitted" v={amount} />}
            {p.variant === 'payment_received_details' && paidOn && <Row k="Payment date" v={paidOn} />}
            {p.variant === 'instalment_reminder' && hasAmount && <Row k="Amount due" v={amount} emphasis />}
            {p.variant === 'penalty_applied' && hasAmount && <Row k="Late payment fee" v={amount} />}
            {p.variant === 'penalty_escalation' && hasAmount && <Row k="Amount due" v={amount} />}
            {(p.variant === 'penalty_applied' || p.variant === 'penalty_escalation') && totalPenalty && <Row k="Total late payment fees" v={totalPenalty} />}
            {(p.variant === 'instalment_reminder' || p.variant === 'penalty_applied' || p.variant === 'penalty_escalation') && due && <Row k="Due date" v={due} />}
            {p.variant === 'instalment_reminder' && kind === 'grace_period' && dateDeadline && <Row k="Pay by, to avoid a fee" v={dateDeadline} />}
            {p.variant === 'penalty_waived' && hasAmount && <Row k="Amount waived" v={amount} />}
            {p.variant === 'payment_voided' && hasAmount && <Row k="Amount reversed" v={amount} />}
            {p.variant === 'penalty_waived' && dateDeadline && <Row k="Pay by" v={dateDeadline} emphasis />}
            {p.variant === 'reactivated' && dateDeadline && <Row k="Settle by" v={dateDeadline} emphasis />}
            {isNew && p.variant !== 'payment_received_details' && p.variant !== 'instalment_reminder' && remaining && <Row k={LAYAWAY_WORDS.remaining} v={remaining} />}
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
