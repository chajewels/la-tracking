/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import { formatDeadline, formatMoney, type Lang } from '../storefront-email.ts'
import { WORDS, button, buttonWrap, container, footer, h1, h2, headerBar, main, muted, notice, rule, text, wordmark } from './order-shared.tsx'

/**
 * Sent by auto-expire-cash-orders when the deposit on a web layaway never
 * arrived and the hold lapsed. Nothing was paid — that is the only state this
 * email can be sent in — so it says the piece is back on sale and invites the
 * customer to start again, without any hint of a debt.
 */
export interface LayawayExpiredProps {
  lang: Lang
  reference: string
  currency: 'JPY' | 'PHP'
  totalAmount: number
  deposit: number
  transferDueAt: string | null
  region: 'JP' | 'OVERSEAS'
  shopUrl: string | null
}

export const layawayExpiredSubject = (reference: string) =>
  `お取り置き期限のご案内 ${reference} / Layaway hold released — Cha Jewels ${reference}`

const COPY = {
  ja: {
    heading: 'お取り置きの期限が過ぎました',
    intro: (ref: string, due: string) =>
      due
        ? `ご予約番号 ${ref} のお申込金を ${due} までに確認できませんでした。お取り置きを解除いたしました。`
        : `ご予約番号 ${ref} のお申込金を期限までに確認できませんでした。お取り置きを解除いたしました。`,
    nothingOwed: 'お支払いは発生しておりません。ご請求はございません。',
    again: 'お品物は再び販売しております。改めてご予約いただけますので、ご希望の際はオンラインストアからお手続きください。',
  },
  en: {
    heading: 'Your hold has been released',
    intro: (ref: string, due: string) =>
      due
        ? `We did not receive the deposit for ${ref} by ${due}, so we have released the hold.`
        : `We did not receive the deposit for ${ref} by the deadline, so we have released the hold.`,
    nothingOwed: 'Nothing was paid and nothing is owed.',
    again: 'The piece is back on sale. You are welcome to reserve it again from the online store if you would still like it.',
  },
} as const

const Block = ({ lang, p, primary }: { lang: Lang; p: LayawayExpiredProps; primary: boolean }) => {
  const c = COPY[lang]
  return (
    <>
      <Heading style={primary ? h1 : h2}>{c.heading}</Heading>
      <Text style={text}>{c.intro(p.reference, formatDeadline(p.transferDueAt, p.region, lang))}</Text>
      <Text style={notice}>{c.nothingOwed}</Text>
      <Text style={muted}>
        {formatMoney(p.totalAmount, p.currency)} · {formatMoney(p.deposit, p.currency)}
      </Text>
      <Text style={text}>{c.again}</Text>
      {p.shopUrl && (
        <Section style={buttonWrap}>
          <Button style={button} href={p.shopUrl}>{lang === 'ja' ? 'オンラインストアを見る' : 'Visit the store'}</Button>
        </Section>
      )}
    </>
  )
}

export const LayawayExpiredEmail = (p: LayawayExpiredProps) => (
  <Html lang={p.lang} dir="ltr">
    <Head />
    <Preview>{layawayExpiredSubject(p.reference)}</Preview>
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

export default LayawayExpiredEmail
