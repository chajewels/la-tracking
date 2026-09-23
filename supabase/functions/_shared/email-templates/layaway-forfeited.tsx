/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import { formatMoney, type Lang } from '../storefront-email.ts'
import { WORDS, button, buttonWrap, container, footer, h1, h2, headerBar, main, muted, notice, rule, text, wordmark } from './order-shared.tsx'

/**
 * Sent by manual-forfeit when staff forfeit a WEB layaway. The customer of a
 * web plan has only ever dealt with the storefront, so this replaces the Hub's
 * account-forfeited template for them (the same split auto-expire-cash-orders
 * makes between order-expired and cash-order-expired).
 *
 * It says what happened in the storefront's own words ("closed under the plan
 * terms" — lib/plan-status.ts on the site), that the held piece is back on
 * sale, and that a one-time extension can be asked for within the 7-day
 * extension window. It deliberately says nothing about money already paid
 * beyond the figure: what happens to it is a staff conversation, not a promise
 * an automated email should make.
 */
export interface LayawayForfeitedProps {
  lang: Lang
  reference: string
  currency: 'JPY' | 'PHP'
  totalAmount: number
  totalPaid: number
  planUrl: string | null
}

export const layawayForfeitedSubject = (reference: string) =>
  `ご契約終了のお知らせ ${reference} / Layaway plan closed — Cha Jewels ${reference}`

const COPY = {
  ja: {
    heading: 'ご契約を規約により終了いたしました',
    intro: (ref: string) => `ご予約番号 ${ref} の分割払いプランは、規約に基づき終了（失効）となりました。`,
    released: 'お取り置きしていたお品物は解除され、再び販売中となっております。',
    extension: 'お品物がまだ販売中の場合に限り、一度だけ延長をご相談いただける場合がございます。ご希望の際は、7日以内にこのメールへご返信ください。',
    total: 'お支払い総額',
    paid: 'お支払い済み',
    view: 'ご契約内容を確認する',
  },
  en: {
    heading: 'Your layaway plan has been closed',
    intro: (ref: string) => `Your layaway plan ${ref} has been closed under the plan terms (forfeited).`,
    released: 'The piece that was held for you has been released and is back on sale.',
    extension: 'While the piece is still available, you may be able to ask for a one-time extension. To ask, reply to this email within 7 days.',
    total: 'Plan total',
    paid: 'Paid so far',
    view: 'View your plan',
  },
} as const

const Block = ({ lang, p, primary }: { lang: Lang; p: LayawayForfeitedProps; primary: boolean }) => {
  const c = COPY[lang]
  return (
    <>
      <Heading style={primary ? h1 : h2}>{c.heading}</Heading>
      <Text style={text}>{c.intro(p.reference)}</Text>
      <Text style={notice}>{c.released}</Text>
      <Text style={muted}>
        {c.total}: {formatMoney(p.totalAmount, p.currency)} · {c.paid}: {formatMoney(p.totalPaid, p.currency)}
      </Text>
      <Text style={text}>{c.extension}</Text>
      {p.planUrl && (
        <Section style={buttonWrap}>
          <Button style={button} href={p.planUrl}>{c.view}</Button>
        </Section>
      )}
    </>
  )
}

export const LayawayForfeitedEmail = (p: LayawayForfeitedProps) => (
  <Html lang={p.lang} dir="ltr">
    <Head />
    <Preview>{layawayForfeitedSubject(p.reference)}</Preview>
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

export default LayawayForfeitedEmail
