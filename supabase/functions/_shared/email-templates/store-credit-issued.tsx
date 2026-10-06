/// <reference types="npm:@types/react@18.3.1" />
/* eslint-disable react-refresh/only-export-components -- an email template, never hot-reloaded; the subject helper lives beside it like every other template */
import * as React from 'npm:react@18.3.1'
import { Body, Container, Head, Heading, Hr, Html, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import { formatMoney, type Lang } from '../storefront-email.ts'
import { Panel, Row, WORDS, block, blockGutter, container, footer, h1, h2, headerBar, main, muted, notice, rule, subjectFor, text, wordmark } from './order-shared.tsx'

/**
 * STORE CREDIT ISSUED (payment lifecycle addendum §9 #13, owner directive
 * 2026-10-06). Sent by issue-store-credit after an admin issues credit by hand
 * (source manual_admin). Every customer — Hub and website.
 *
 * Says what she has and how it works, per the locked policy (CLAUDE.md STORE
 * CREDIT): real money on her account, in ONE currency (yen pays yen orders,
 * pesos pay peso orders — never converted), valid for one year from issue, and
 * applied by our staff to her next order. No link: the credit lives on her
 * account, and staff apply it. The admin's note is internal and never shown.
 */
export interface StoreCreditIssuedProps {
  lang: Lang
  amount: number
  currency: 'JPY' | 'PHP'
  /** Lot expiry, ISO timestamp. */
  expiresAt: string | null
}

export const storeCreditIssuedSubject = (lang: Lang) =>
  subjectFor(lang, 'ストアクレジットを発行しました', 'Store credit has been added to your account — Cha Jewels')

function expiryDay(iso: string | null, lang: Lang): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return lang === 'ja'
    ? new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric' }).format(d)
    : new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', day: 'numeric', month: 'long', year: 'numeric' }).format(d)
}

const COPY = {
  ja: {
    heading: 'ストアクレジットを発行しました',
    intro: (a: string) => `お客様のアカウントに ${a} のストアクレジットを追加しました。`,
    amount: 'ストアクレジット',
    currency: '通貨',
    expires: '有効期限',
    yen: '日本円',
    peso: 'フィリピンペソ',
    how: (cur: string) => `次回のご注文時に、スタッフがお支払いに充当いたします。${cur}のご注文にご利用いただけます（他の通貨には換算されません）。有効期限は発行日から1年間です。`,
  },
  en: {
    heading: 'Store credit has been added to your account',
    intro: (a: string) => `We have added ${a} in store credit to your account.`,
    amount: 'Store credit',
    currency: 'Currency',
    expires: 'Valid until',
    yen: 'Japanese yen',
    peso: 'Philippine peso',
    how: (cur: string) => `Our staff will apply it to your next order. It can be used on orders in ${cur} (it is never converted to another currency) and is valid for one year from the day it was issued.`,
  },
} as const

const Block = ({ lang, p, primary }: { lang: Lang; p: StoreCreditIssuedProps; primary: boolean }) => {
  const c = COPY[lang]
  const amount = formatMoney(p.amount, p.currency)
  const cur = p.currency === 'PHP' ? c.peso : c.yen
  const until = expiryDay(p.expiresAt, lang)
  return (
    <>
      <Heading style={primary ? h1 : h2}>{c.heading}</Heading>
      <Text style={text}>{c.intro(amount)}</Text>
      <Panel gutter={blockGutter} box={block}>
        {/* Row is a table, not flex — Gmail drops display:flex. See order-shared. */}
        <Row k={c.amount} v={amount} emphasis />
        <Row k={c.currency} v={cur} />
        {until && <Row k={c.expires} v={until} />}
      </Panel>
      <Text style={notice}>{c.how(cur)}</Text>
    </>
  )
}

export const StoreCreditIssuedEmail = (p: StoreCreditIssuedProps) => (
  <Html lang={p.lang} dir="ltr">
    <Head />
    <Preview>{storeCreditIssuedSubject(p.lang)}</Preview>
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

export default StoreCreditIssuedEmail
