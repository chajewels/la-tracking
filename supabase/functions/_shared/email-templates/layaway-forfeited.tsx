/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import { formatMoney, type Lang } from '../storefront-email.ts'
import { WORDS, button, buttonWrap, container, footer, h1, h2, headerBar, main, muted, notice, rule, text, wordmark } from './order-shared.tsx'

/**
 * Sent when a WEB layaway is forfeited — by staff (manual-forfeit) or
 * automatically (auto-forfeit-settlement), through
 * _shared/layaway-forfeit-email.ts. `final` is the permanent variant
 * (final_forfeited: the extension expired or hit its penalty cap): it says the
 * closure is permanent and offers no extension.
 *
 * Originally sent by manual-forfeit only. The customer of a
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
  /** final_forfeited — permanent, no extension on offer. */
  final?: boolean
}

export const layawayForfeitedSubject = (reference: string) =>
  `ご契約終了のお知らせ ${reference} / Layaway plan closed — Cha Jewels ${reference}`

const COPY = {
  ja: {
    heading: 'ご契約を規約により終了いたしました',
    intro: (ref: string) => `ご予約番号 ${ref} の分割払いプランは、規約に基づき終了（失効）となりました。`,
    released: 'お取り置きしていたお品物は解除され、再び販売中となっております。',
    extension: 'お品物がまだ販売中の場合に限り、一度だけ延長をご相談いただける場合がございます。ご希望の際は、7日以内にこのメールへご返信ください。',
    finalHeading: 'ご契約を最終的に終了いたしました',
    finalIntro: (ref: string) => `ご予約番号 ${ref} の分割払いプランは、延長期間の終了により、規約に基づき最終的に終了（失効）となりました。`,
    finalNote: 'この終了は確定となり、延長や再開のお手続きはお受けできません。',
    total: 'お支払い総額',
    paid: 'お支払い済み',
    view: 'ご契約内容を確認する',
  },
  en: {
    heading: 'Your layaway plan has been closed',
    intro: (ref: string) => `Your layaway plan ${ref} has been closed under the plan terms (forfeited).`,
    released: 'The piece that was held for you has been released and is back on sale.',
    extension: 'While the piece is still available, you may be able to ask for a one-time extension. To ask, reply to this email within 7 days.',
    finalHeading: 'Your layaway plan has been permanently closed',
    finalIntro: (ref: string) => `Your layaway plan ${ref} has been permanently closed under the plan terms (forfeited) after its extension ended.`,
    finalNote: 'This closure is final; the plan cannot be extended or reopened.',
    total: 'Plan total',
    paid: 'Paid so far',
    view: 'View your plan',
  },
} as const

const Block = ({ lang, p, primary }: { lang: Lang; p: LayawayForfeitedProps; primary: boolean }) => {
  const c = COPY[lang]
  return (
    <>
      <Heading style={primary ? h1 : h2}>{p.final ? c.finalHeading : c.heading}</Heading>
      <Text style={text}>{p.final ? c.finalIntro(p.reference) : c.intro(p.reference)}</Text>
      <Text style={notice}>{c.released}</Text>
      <Text style={muted}>
        {c.total}: {formatMoney(p.totalAmount, p.currency)} · {c.paid}: {formatMoney(p.totalPaid, p.currency)}
      </Text>
      <Text style={text}>{p.final ? c.finalNote : c.extension}</Text>
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
