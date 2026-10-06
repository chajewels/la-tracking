/// <reference types="npm:@types/react@18.3.1" />
/* eslint-disable react-refresh/only-export-components -- an email template, never hot-reloaded; the subject helper lives beside it like every other template */
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Link, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import { formatDeadline, formatMoney } from '../storefront-email.ts'
import { Panel, Row, WORDS, block, blockGutter, button, buttonWrap, container, footer, h1, headerBar, main, muted, notice, rule, text, wordmark } from './order-shared.tsx'
import { LAYAWAY_WORDS, formatDueDate } from './layaway-shared.tsx'

/**
 * ONE SMALL UPDATE ABOUT A WEB LAYAWAY (payment lifecycle H4 + addendum §9).
 *
 *   rejected            a reviewer rejected a payment on the plan (her message shown).
 *   needs_info          a reviewer marked a payment "needs clarification".
 *   deadline_moved      staff moved the deposit deadline (set-account-deadlines).
 *   shipped             staff entered a tracking number (notify-shipped).
 *   details_received    §9 #2: a payment was reported — her receipt upload or a
 *                       staff record — and waits for a reviewer.
 *   reminder            §9 #3: an instalment is coming up / due today / overdue /
 *                       in its grace period (send-reminders).
 *   penalty             §9 #3: a late fee was applied; P4–P8 are escalation
 *                       notices (penalty-engine).
 *   penalty_reinstated  §9 #3: a waived late fee came back after its grace window.
 *   penalty_waived      §9 #3: a late fee was waived (approve-waiver).
 *   payment_voided      §9 #3: a payment was voided (void-payment), reason shown.
 *   reactivated         §9 #4: a forfeited plan was reactivated (reactivate-account).
 *
 * WEB layaways only (source_channel 'web'), sent by _shared/order-update-email.ts;
 * a Hub-created plan keeps its portal email. Links go to the storefront plan
 * page (/account/layaway/:id), never the portal.
 *
 * ENGLISH ONLY (owner rule: no layaway email is ever sent in Japanese — subject
 * or body). There is no language prop; development/layaway-english.test.ts
 * fails on any Japanese character. Staff text is rendered as TEXT.
 */
export type LayawayUpdateVariant =
  | 'rejected' | 'needs_info' | 'deadline_moved' | 'shipped'
  | 'details_received' | 'reminder' | 'penalty' | 'penalty_reinstated' | 'penalty_waived' | 'payment_voided' | 'reactivated'

export type ReminderStage = 'upcoming' | 'due_today' | 'overdue' | 'grace_period'
export type PenaltyStage = 'applied' | 'P4' | 'P5' | 'P6' | 'P7' | 'P8'

export interface LayawayUpdateEmailProps {
  variant: LayawayUpdateVariant
  reference: string
  currency: 'JPY' | 'PHP'
  /** The payment / fee the update is about, in the plan's currency; null = no amount line. */
  amount?: number | null
  /** Staff message (rejected / needs_info) or void reason (payment_voided). */
  message?: string | null
  /** The (new) deadline, ISO (deadline_moved), or the extension end (reactivated, YYYY-MM-DD). */
  deadline?: string | null
  /** Clock for the deadline; defaults from the currency (yen → JST, pesos → PHT). */
  region?: 'JP' | 'OVERSEAS'
  courier?: string | null
  trackingNumber?: string | null
  trackingUrl?: string | null
  planUrl: string
  /** reminder: which reminder this is. */
  reminderStage?: ReminderStage | null
  /** reminder / penalty: the instalment's due date, YYYY-MM-DD. */
  dueDate?: string | null
  /** reminder (grace_period): the last day without a late fee, YYYY-MM-DD. */
  graceEnd?: string | null
  daysOverdue?: number | null
  /** penalty: which notice this is. */
  penaltyStage?: PenaltyStage | null
  /** penalty: all late fees on the plan that are not waived. */
  totalPenalty?: number | null
  /** What is still owed on the plan after the change. */
  remaining?: number | null
}

const REMINDER_SUBJECT: Record<ReminderStage, string> = {
  upcoming: 'Your next layaway payment is coming up',
  due_today: 'Your layaway payment is due today',
  overdue: 'Your layaway payment is overdue',
  grace_period: 'Your layaway payment is past due — grace period',
}

const PENALTY_HEADING: Record<PenaltyStage, string> = {
  applied: 'A late fee has been added to your plan',
  P4: 'Your plan is overdue — please pay now',
  P5: 'Your plan is still overdue — please pay now',
  P6: 'Payment is urgently needed on your plan',
  P7: 'Final warning — your plan is at risk',
  P8: 'Final notice — your plan is at risk of forfeiture',
}

const SUBJECT: Record<Exclude<LayawayUpdateVariant, 'reminder' | 'penalty'>, string> = {
  rejected: 'We could not accept your payment',
  needs_info: 'We need to check your payment',
  deadline_moved: 'Your payment deadline has changed',
  shipped: 'Your layaway piece has shipped',
  details_received: 'We have received your payment details',
  penalty_reinstated: 'A waived late fee has been reinstated',
  penalty_waived: 'A late fee has been waived',
  payment_voided: 'A payment on your plan has been voided',
  reactivated: 'Your plan has been reactivated',
}

export const layawayUpdateSubject = (
  variant: LayawayUpdateVariant,
  reference: string,
  opts: { reminderStage?: ReminderStage | null; penaltyStage?: PenaltyStage | null } = {},
) => {
  const head = variant === 'reminder' ? REMINDER_SUBJECT[opts.reminderStage ?? 'upcoming']
    : variant === 'penalty' ? PENALTY_HEADING[opts.penaltyStage ?? 'applied']
    : SUBJECT[variant]
  return `${head} — Cha Jewels layaway ${reference}`
}

/** A YYYY-MM-DD day, or an ISO timestamp's day, as "24 Oct 2026". */
function day(value: string | null | undefined): string {
  if (!value) return ''
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDueDate(value) : ''
}

export const LayawayUpdateEmail = (p: LayawayUpdateEmailProps) => {
  const region = p.region ?? (p.currency === 'PHP' ? 'OVERSEAS' : 'JP')
  const when = p.variant === 'deadline_moved' ? formatDeadline(p.deadline ?? null, region, 'en') : ''
  const message = String(p.message ?? '').trim()
  const money = (n: number) => formatMoney(n, p.currency)
  const hasAmount = typeof p.amount === 'number' && Number.isFinite(p.amount) && p.amount > 0
  const amount = hasAmount ? money(p.amount as number) : ''
  const hasRemaining = typeof p.remaining === 'number' && Number.isFinite(p.remaining)
  const hasTotalPenalty = typeof p.totalPenalty === 'number' && Number.isFinite(p.totalPenalty) && p.totalPenalty > 0
  const courier = String(p.courier ?? '').trim()
  const tracking = String(p.trackingNumber ?? '').trim()
  const stage = p.reminderStage ?? 'upcoming'
  const penaltyStage = p.penaltyStage ?? 'applied'
  const dueDay = day(p.dueDate)
  const graceDay = day(p.graceEnd)
  const extensionDay = p.variant === 'reactivated' ? day(p.deadline) : ''
  const overdue = typeof p.daysOverdue === 'number' && p.daysOverdue > 0 ? p.daysOverdue : null

  let heading: string
  let intro: string
  let next: string | null = null
  let urgent: string | null = null
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
    case 'shipped':
      heading = 'Your layaway piece has shipped'
      intro = `We have shipped the piece on layaway plan ${p.reference}. It is on its way to you.`
      break
    case 'details_received':
      heading = 'We have received your payment details'
      intro = hasAmount
        ? `We have received your payment details of ${amount} for layaway plan ${p.reference}.`
        : `We have received your payment details for layaway plan ${p.reference}.`
      next = 'We will check them and email you again once the payment is confirmed.'
      break
    case 'reminder':
      heading = REMINDER_SUBJECT[stage]
      intro = stage === 'upcoming' ? `This is a reminder that your next payment on layaway plan ${p.reference} is due${dueDay ? ` on ${dueDay}` : ' soon'}.`
        : stage === 'due_today' ? `Your payment on layaway plan ${p.reference} is due today.`
        : stage === 'grace_period' ? `Your payment on layaway plan ${p.reference} is past its due date. You are in the grace period${graceDay ? ` until ${graceDay}` : ''}; please pay before then to avoid a late fee.`
        : `Your payment on layaway plan ${p.reference} is${overdue ? ` ${overdue} days` : ''} overdue. Please pay as soon as you can.`
      next = 'You can submit your payment from your plan page. If you have already paid, please ignore this email.'
      break
    case 'penalty':
      heading = PENALTY_HEADING[penaltyStage]
      intro = penaltyStage === 'applied'
        ? `A late fee${hasAmount ? ` of ${amount}` : ''} has been added to layaway plan ${p.reference} because a payment is${overdue ? ` ${overdue} days` : ''} overdue.`
        : `Layaway plan ${p.reference} is${overdue ? ` ${overdue} days` : ''} overdue and remains unpaid.`
      if (penaltyStage === 'P7' || penaltyStage === 'P8') urgent = 'If the plan stays unpaid, it may be forfeited. Please pay now or reply to this email to talk to us.'
      next = 'You can submit your payment from your plan page.'
      break
    case 'penalty_reinstated':
      heading = 'A waived late fee has been reinstated'
      intro = `A late fee${hasAmount ? ` of ${amount}` : ''} on layaway plan ${p.reference} was waived for a limited time. The payment was not received within that time, so the fee has been reinstated.`
      break
    case 'penalty_waived':
      heading = 'A late fee has been waived'
      intro = `We have waived ${hasAmount ? `${amount} in late fees` : 'a late fee'} on layaway plan ${p.reference}.`
      next = graceDay ? `Please make your payment by ${graceDay} so the waiver stays in place.` : null
      break
    case 'payment_voided':
      heading = 'A payment on your plan has been voided'
      intro = hasAmount
        ? `We have voided a payment of ${amount} on layaway plan ${p.reference}.`
        : `We have voided a payment on layaway plan ${p.reference}.`
      next = 'If you have a question about this, reply to this email.'
      break
    default:
      heading = 'Your plan has been reactivated'
      intro = `Layaway plan ${p.reference} has been reactivated${extensionDay ? ` and is now open until ${extensionDay}` : ''}.`
      next = 'Please complete your payments by that date. You can see your plan and pay from your plan page.'
  }

  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>{layawayUpdateSubject(p.variant, p.reference, { reminderStage: p.reminderStage, penaltyStage: p.penaltyStage })}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={headerBar}>
            <Text style={wordmark}>Cha Jewels</Text>
          </Section>
          <Heading style={h1}>{heading}</Heading>
          <Text style={text}>{intro}</Text>
          {urgent && <Text style={{ ...notice, fontWeight: 'bold' as const }}>{urgent}</Text>}
          {next && <Text style={text}>{next}</Text>}
          {message && p.variant !== 'payment_voided' && (
            <Panel gutter={blockGutter} box={block}>
              <Text style={{ ...muted, margin: '0 0 4px' }}>Message from our team</Text>
              <Text style={{ ...text, margin: 0, whiteSpace: 'pre-line' as const }}>{message}</Text>
            </Panel>
          )}
          <Panel gutter={blockGutter} box={block}>
            {/* Row is a table, not flex — Gmail drops display:flex. See order-shared. */}
            <Row k={LAYAWAY_WORDS.reference} v={p.reference} />
            {p.variant !== 'shipped' && hasAmount && (
              <Row k={p.variant === 'reminder' ? 'Amount due' : p.variant === 'penalty' ? 'Late fee' : p.variant === 'penalty_waived' ? 'Amount waived' : p.variant === 'penalty_reinstated' ? 'Fee reinstated' : 'Amount'} v={amount} />
            )}
            {(p.variant === 'reminder' || p.variant === 'penalty') && dueDay && <Row k="Due date" v={dueDay} />}
            {p.variant === 'reminder' && stage === 'grace_period' && graceDay && <Row k="Grace period ends" v={graceDay} emphasis />}
            {p.variant === 'payment_voided' && message && <Row k="Reason" v={message} />}
            {p.variant === 'penalty' && hasTotalPenalty && <Row k="Total late fees" v={money(p.totalPenalty as number)} />}
            {extensionDay && <Row k="Plan open until" v={extensionDay} emphasis />}
            {hasRemaining && p.variant !== 'shipped' && p.variant !== 'details_received' && (
              <Row k="Remaining balance" v={money(p.remaining as number)} emphasis={p.variant !== 'reactivated'} />
            )}
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
