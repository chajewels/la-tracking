/// <reference types="npm:@types/react@18.3.1" />
/* eslint-disable react-refresh/only-export-components -- an email template, never hot-reloaded; the subject helper lives beside it like every other template */
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import { orderMoney, type Lang } from '../storefront-email.ts'
import { Panel, Row, WORDS, block, blockGutter, button, buttonWrap, container, footer, h1, headerBar, main, muted, rule, text, wordmark, type OrderCurrency, subjectFor } from './order-shared.tsx'

/**
 * RECEIPT READY (領収書) for a WEBSITE ORDER (docs/RECEIPTS.md).
 *
 * Sent once by the website-receipt-emails sweep when a receipt is issued.
 * Links to the order in My Account ONLY: never to the PDF, never an
 * attachment. Language: the customer's (emailLang), Japanese first then
 * English; an English email is English only. A web layaway uses
 * layaway-receipt-ready.tsx instead (English only, owner rule).
 */
export interface ReceiptReadyEmailProps {
  lang: Lang
  reference: string
  receiptNumber: string
  currency: OrderCurrency
  total: number
  orderUrl: string
}

export const receiptReadySubject = (reference: string, lang: Lang) =>
  subjectFor(lang, `領収書を発行しました ${reference}`, `Your receipt is ready — Cha Jewels order ${reference}`)

const COPY = {
  ja: {
    heading: '領収書を発行しました',
    intro: (ref: string) => `ご注文番号 ${ref} のお支払いがすべて完了しましたので、領収書を発行しました。`,
    how: 'マイアカウントのご注文ページから、領収書（PDF）をダウンロードできます。宛名と但し書きもそちらで変更できます。',
    receipt: '領収書番号',
    total: '領収金額（税込）',
    button: 'マイアカウントで見る',
  },
  en: {
    heading: 'Your receipt is ready',
    intro: (ref: string) => `Your order ${ref} is fully paid, and we have issued your receipt.`,
    how: 'You can download the receipt (PDF) from the order page in My Account, and change the name and description on it there.',
    receipt: 'Receipt number',
    total: 'Amount received (tax included)',
    button: 'View in My Account',
  },
} as const

const Block = ({ lang, p, primary }: { lang: Lang; p: ReceiptReadyEmailProps; primary: boolean }) => {
  const c = COPY[lang]
  return (
    <>
      <Heading style={h1}>{c.heading}</Heading>
      <Text style={text}>{c.intro(p.reference)}</Text>
      <Text style={text}>{c.how}</Text>
      <Panel gutter={blockGutter} box={block}>
        <Row k={WORDS.reference[lang]} v={p.reference} />
        <Row k={c.receipt} v={p.receiptNumber} mono />
        <Row k={c.total} v={orderMoney(p.total, p.currency)} emphasis />
      </Panel>
      {primary && (
        <Section style={buttonWrap}>
          <Button style={button} href={p.orderUrl}>{c.button}</Button>
        </Section>
      )}
    </>
  )
}

export const ReceiptReadyEmail = (p: ReceiptReadyEmailProps) => (
  <Html lang={p.lang} dir="ltr">
    <Head />
    <Preview>{receiptReadySubject(p.reference, p.lang)}</Preview>
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

export default ReceiptReadyEmail
