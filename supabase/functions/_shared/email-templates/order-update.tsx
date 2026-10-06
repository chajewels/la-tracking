/// <reference types="npm:@types/react@18.3.1" />
/* eslint-disable react-refresh/only-export-components -- an email template, never hot-reloaded; the subject helper lives beside it like every other template */
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Link, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import { formatDeadline, orderMoney, type Lang } from '../storefront-email.ts'
import { Panel, Row, WORDS, block, blockGutter, button, buttonWrap, container, footer, h1, h2, headerBar, main, muted, rule, text, wordmark, type OrderCurrency, subjectFor } from './order-shared.tsx'

/**
 * ONE SMALL UPDATE ABOUT A WEB ORDER (payment lifecycle H4, spec §5 B and D2).
 *
 *   needs_info        staff marked her payment "needs clarification" — the
 *                     reviewer's message is shown, she replies to this email.
 *   deadline_moved    staff moved the payment deadline (set-account-deadlines).
 *   shipped           staff entered a tracking number (notify-shipped):
 *                     courier, tracking number, tracking link.
 *   details_received  staff recorded a payment she told them about; it waits
 *                     for a reviewer's Confirm.
 *
 * Sent ONLY for website orders by _shared/order-update-email.ts; a Hub order
 * keeps its Hub email. Language: the customer's, Japanese first then English;
 * an English email is English only. The staff message is rendered as TEXT —
 * React escapes it; never dangerouslySetInnerHTML.
 */
export type OrderUpdateVariant = 'needs_info' | 'deadline_moved' | 'shipped' | 'details_received'

export interface OrderUpdateEmailProps {
  lang: Lang
  variant: OrderUpdateVariant
  reference: string
  currency: OrderCurrency
  /** The payment the update is about, in the order's currency; null = no amount line. */
  amount?: number | null
  /** Staff message (needs_info, optional elsewhere); plain text. */
  message?: string | null
  /** The (new) payment deadline, ISO. */
  deadline?: string | null
  region: 'JP' | 'OVERSEAS'
  courier?: string | null
  trackingNumber?: string | null
  trackingUrl?: string | null
  orderUrl: string | null
}

const SUBJECT = {
  needs_info: { ja: 'お支払いについて確認させてください', en: 'We need to check your payment' },
  deadline_moved: { ja: 'お支払い期限を変更しました', en: 'Your payment deadline has changed' },
  shipped: { ja: '発送しました', en: 'Your order has shipped' },
  details_received: { ja: 'お支払いのご連絡を受け付けました', en: 'We have received your payment details' },
} as const

export const orderUpdateSubject = (variant: OrderUpdateVariant, reference: string, lang: Lang) =>
  subjectFor(lang, `${SUBJECT[variant].ja} ${reference}`, `${SUBJECT[variant].en} — Cha Jewels order ${reference}`)

const COPY = {
  ja: {
    needsInfoHeading: 'お支払いについて確認させてください',
    needsInfoIntro: (ref: string) => `ご注文番号 ${ref} のお支払いについて、確認させていただきたいことがあります。`,
    needsInfoAsk: '下記のメッセージをご確認のうえ、このメールにご返信ください。',
    deadlineHeading: (when: string) => (when ? `お支払い期限を ${when} に変更しました` : 'お支払い期限を変更しました'),
    deadlineIntro: (ref: string) => `ご注文番号 ${ref} のお支払い期限を変更しました。`,
    newDeadline: '新しいお支払い期限',
    shippedHeading: '発送しました',
    shippedIntro: (ref: string) => `ご注文番号 ${ref} の商品を発送しました。お届けまでもうしばらくお待ちください。`,
    courier: '配送業者',
    tracking: 'お問い合わせ番号',
    trackLink: '配送状況を確認する',
    receivedHeading: 'お支払いのご連絡を受け付けました',
    receivedIntro: (ref: string) => `ご注文番号 ${ref} について、お支払いのご連絡を受け付けました。確認後にあらためてご連絡します。`,
    amount: 'お支払い金額',
    message: '担当者からのメッセージ',
  },
  en: {
    needsInfoHeading: 'We need to check your payment',
    needsInfoIntro: (ref: string) => `We need to check something about your payment for order ${ref}.`,
    needsInfoAsk: 'Please read the message below and reply to this email.',
    deadlineHeading: (when: string) => (when ? `We have moved your payment deadline to ${when}` : 'We have moved your payment deadline'),
    deadlineIntro: (ref: string) => `The payment deadline for order ${ref} has changed.`,
    newDeadline: 'New payment deadline',
    shippedHeading: 'Your order has shipped',
    shippedIntro: (ref: string) => `We have shipped order ${ref}. It is on its way to you.`,
    courier: 'Courier',
    tracking: 'Tracking number',
    trackLink: 'Track your parcel',
    receivedHeading: 'We have received your payment details',
    receivedIntro: (ref: string) => `We have received your payment details for order ${ref}. We will check them and contact you again.`,
    amount: 'Amount',
    message: 'Message from our team',
  },
} as const

const Block = ({ lang, p, primary }: { lang: Lang; p: OrderUpdateEmailProps; primary: boolean }) => {
  const c = COPY[lang]
  const H = { style: primary ? h1 : h2 }
  const message = String(p.message ?? '').trim()
  const hasAmount = typeof p.amount === 'number' && Number.isFinite(p.amount) && p.amount > 0
  const when = formatDeadline(p.deadline ?? null, p.region, lang)
  const tracking = String(p.trackingNumber ?? '').trim()
  const courier = String(p.courier ?? '').trim()

  let heading: string
  let intro: string
  switch (p.variant) {
    case 'needs_info': heading = c.needsInfoHeading; intro = c.needsInfoIntro(p.reference); break
    case 'deadline_moved': heading = c.deadlineHeading(when); intro = c.deadlineIntro(p.reference); break
    case 'shipped': heading = c.shippedHeading; intro = c.shippedIntro(p.reference); break
    default: heading = c.receivedHeading; intro = c.receivedIntro(p.reference)
  }

  return (
    <>
      <Heading {...H}>{heading}</Heading>
      <Text style={text}>{intro}</Text>
      {p.variant === 'needs_info' && <Text style={text}>{c.needsInfoAsk}</Text>}
      {message && (
        <Panel gutter={blockGutter} box={block}>
          <Text style={{ ...muted, margin: '0 0 4px' }}>{c.message}</Text>
          <Text style={{ ...text, margin: 0, whiteSpace: 'pre-line' as const }}>{message}</Text>
        </Panel>
      )}
      <Panel gutter={blockGutter} box={block}>
        {/* Row is a table, not flex — Gmail drops display:flex. See order-shared. */}
        <Row k={WORDS.reference[lang]} v={p.reference} />
        {p.variant !== 'shipped' && hasAmount && <Row k={c.amount} v={orderMoney(p.amount as number, p.currency)} />}
        {p.variant === 'deadline_moved' && when && <Row k={c.newDeadline} v={when} emphasis />}
        {p.variant === 'shipped' && courier && <Row k={c.courier} v={courier} />}
        {p.variant === 'shipped' && tracking && <Row k={c.tracking} v={tracking} mono />}
      </Panel>
      {p.variant === 'shipped' && p.trackingUrl && (
        <Text style={text}>
          {c.trackLink}: <Link href={p.trackingUrl}>{p.trackingUrl}</Link>
        </Text>
      )}
      {p.orderUrl && (
        <Section style={buttonWrap}>
          <Button style={button} href={p.orderUrl}>{WORDS.viewOrder[lang]}</Button>
        </Section>
      )}
    </>
  )
}

export const OrderUpdateEmail = (p: OrderUpdateEmailProps) => (
  <Html lang={p.lang} dir="ltr">
    <Head />
    <Preview>{orderUpdateSubject(p.variant, p.reference, p.lang)}</Preview>
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

export default OrderUpdateEmail
