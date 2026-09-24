/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import { formatDeadline, formatMoney, type Lang } from '../storefront-email.ts'
import { MethodCards, WORDS, button, buttonWrap, container, footer, h1, h2, headerBar, main, muted, notice, rule, text, wordmark, type OrderEmailMethod } from './order-shared.tsx'
import { LAYAWAY_WORDS, PlanSummary, ScheduleTable, type LayawayScheduleRow } from './layaway-shared.tsx'

/**
 * Sent by the website function when a customer reserves a piece with layaway.
 * The piece is held, nothing is paid yet, and the deposit has a deadline — so
 * this email leads with the deposit and where to send it, and shows the full
 * schedule so the commitment is plain before any money moves.
 */
export interface LayawayPlanCreatedProps {
  lang: Lang
  reference: string
  currency: 'JPY' | 'PHP'
  totalAmount: number
  deposit: number
  termMonths: number
  schedule: LayawayScheduleRow[]
  methods: OrderEmailMethod[]
  transferDueAt: string
  region: 'JP' | 'OVERSEAS'
  planUrl: string | null
  /**
   * RESERVE-FIRST (A2). 'ready' is the email confirm-web-order-ready sends when
   * staff confirm a layaway reservation: the deposit, where to send it, the new
   * deadline and the schedule re-dated from the confirmation day. It is always
   * sent with lang 'en' (owner decision: layaway emails are English only).
   * Absent reads exactly as it always has.
   */
  variant?: 'placed' | 'ready'
}

export const layawayPlanCreatedSubject = (reference: string) =>
  `分割予約を承りました ${reference} / Layaway reserved — Cha Jewels ${reference}`

export const layawayReadySubject = (reference: string) =>
  `Your piece is confirmed — please send your deposit — Cha Jewels ${reference}`

const COPY = {
  ja: {
    heading: '分割予約を承りました',
    intro: (ref: string) => `ご予約番号 ${ref} でお品物をお取り置きしました。ありがとうございます。`,
    deposit: (amt: string, due: string) =>
      `お申込金 ${amt} を ${due} までにお振込ください。ご入金を確認しましたらご予約が確定し、お支払いスケジュールが始まります。`,
    hold: 'お申込金のご入金が期限までにない場合、お取り置きは解除され、お品物は再び販売されます。',
    proof: 'お振込後は、アカウントページから受領証をご提出ください。確認には1営業日ほどいただきます。',
  },
  en: {
    heading: 'Your layaway is reserved',
    intro: (ref: string) => `We are holding your piece under reference ${ref}. Thank you.`,
    deposit: (amt: string, due: string) =>
      `Please transfer the deposit of ${amt} by ${due}. Once we confirm it your reservation is final and the payment schedule begins.`,
    hold: 'If the deposit does not arrive by the deadline the hold is released and the piece goes back on sale.',
    proof: 'After transferring, upload your receipt from your account page. Confirmation usually takes one business day.',
  },
} as const

/** The 'ready' variant: only the heading and the opening line differ. */
const READY_COPY = {
  ja: {
    ...COPY.ja,
    heading: 'お品物のご用意ができました',
    intro: (ref: string) => `ご予約番号 ${ref} のお品物を確認いたしました。お支払いスケジュールは本日から始まります。`,
  },
  en: {
    ...COPY.en,
    heading: 'Your piece is confirmed',
    intro: (ref: string) => `We have confirmed your piece under reference ${ref}. Your payment schedule starts from today.`,
  },
} as const

const Block = ({ lang, p, primary }: { lang: Lang; p: LayawayPlanCreatedProps; primary: boolean }) => {
  const c = p.variant === 'ready' ? READY_COPY[lang] : COPY[lang]
  return (
    <>
      <Heading style={primary ? h1 : h2}>{c.heading}</Heading>
      <Text style={text}>{c.intro(p.reference)}</Text>
      <PlanSummary
        reference={p.reference} totalAmount={p.totalAmount} deposit={p.deposit}
        termMonths={p.termMonths} currency={p.currency} lang={lang}
      />
      <Text style={text}>
        {c.deposit(formatMoney(p.deposit, p.currency), formatDeadline(p.transferDueAt, p.region, lang))}
      </Text>
      <MethodCards methods={p.methods} lang={lang} />
      <Text style={notice}>{c.hold}</Text>
      <Text style={muted}>{c.proof}</Text>
      <ScheduleTable rows={p.schedule} currency={p.currency} lang={lang} />
      {p.planUrl && (
        <Section style={buttonWrap}>
          <Button style={button} href={p.planUrl}>{LAYAWAY_WORDS.viewPlan[lang]}</Button>
        </Section>
      )}
    </>
  )
}

export const LayawayPlanCreatedEmail = (p: LayawayPlanCreatedProps) => (
  <Html lang={p.lang} dir="ltr">
    <Head />
    <Preview>{p.variant === 'ready' ? layawayReadySubject(p.reference) : layawayPlanCreatedSubject(p.reference)}</Preview>
    <Body style={main}>
      <Container style={container}>
        <Section style={headerBar}>
          <Text style={wordmark}>Cha Jewels</Text>
        </Section>
        <Block lang={p.lang} p={p} primary />
        {p.lang === 'ja' && (
          <>
            <Hr style={rule} />
            <Block lang="en" p={p} primary={false} />
          </>
        )}
        <Hr style={rule} />
        <Text style={muted}>{WORDS.help[p.lang]}</Text>
        <Text style={footer}>{WORDS.footer[p.lang]}</Text>
      </Container>
    </Body>
  </Html>
)

export default LayawayPlanCreatedEmail
