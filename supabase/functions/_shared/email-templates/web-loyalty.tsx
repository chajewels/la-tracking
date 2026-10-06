/// <reference types="npm:@types/react@18.3.1" />
/* eslint-disable react-refresh/only-export-components -- an email template, never hot-reloaded; the subject helper lives beside it like every other template */
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import type { Lang } from '../storefront-email.ts'
import { Panel, Row, WORDS, block, blockGutter, button, buttonWrap, container, footer, h1, h2, headerBar, main, muted, rule, subjectFor, text, wordmark } from './order-shared.tsx'

/**
 * LOYALTY EMAILS FOR A WEBSITE ORDER / WEBSITE PLAN (payment lifecycle
 * addendum §9 #5, owner directive 2026-10-06).
 *
 *   earned         points were added for the purchase
 *   bonus          a promotion added bonus points
 *   tier_upgrade   the purchase moved her to a higher level
 *   tier_restored  she requalified for the level she had earned
 *
 * Sent by award-loyalty-points INSTEAD of the Hub templates (loyalty-earned,
 * loyalty-bonus, loyalty-tier-upgrade, loyalty-level restored) when the order
 * or plan came from the website: her language (a plan's email is English —
 * the layaway rule), the CJ-W reference she knows, and a button to the
 * website's /loyalty page, never the portal. Same gates, same idempotency keys.
 *
 * The Japanese email never mentions layaway: the copy says "order" / ご注文
 * and the reference alone identifies it.
 */
export type WebLoyaltyVariant = 'earned' | 'bonus' | 'tier_upgrade' | 'tier_restored'

export interface WebLoyaltyEmailProps {
  lang: Lang
  variant: WebLoyaltyVariant
  /** The customer's reference for the order or plan (CJ-W-…). */
  reference: string
  /** Points added by this event (earned / bonus). */
  points?: number | null
  /** Her points balance after the event. */
  balance?: number | null
  /** Level now (earned) or the new level (tier_upgrade / tier_restored). */
  level?: string | null
  previousLevel?: string | null
  multiplier?: number | null
  promoName?: string | null
  /** Promotion end, already formatted for the reader (may be empty). */
  promoEnd?: string | null
  loyaltyUrl: string
}

const SUBJECT = {
  earned: { ja: 'ポイントを付与しました', en: 'You have earned points' },
  bonus: { ja: 'ボーナスポイントを付与しました', en: 'You have earned bonus points' },
  tier_upgrade: { ja: '会員レベルが上がりました', en: 'Your membership level has gone up' },
  tier_restored: { ja: '会員レベルが元に戻りました', en: 'Your membership level is back' },
} as const

export const webLoyaltySubject = (variant: WebLoyaltyVariant, reference: string, lang: Lang) =>
  subjectFor(lang, `${SUBJECT[variant].ja} ${reference}`, `${SUBJECT[variant].en} — Cha Jewels ${reference}`)

const pts = (n: number) => `${Math.max(0, Math.round(Number(n) || 0)).toLocaleString('en-US')} pt`

const COPY = {
  ja: {
    earnedIntro: (ref: string, p: string) => `ご注文番号 ${ref} のお買い上げで ${p} を付与しました。いつもありがとうございます。`,
    bonusIntro: (ref: string, p: string, promo: string) => `${promo ? `「${promo}」の` : ''}ボーナスとして、ご注文番号 ${ref} に ${p} を付与しました。`,
    upgradeIntro: (lvl: string) => `お買い上げ合計により、会員レベルが ${lvl} になりました。`,
    restoredIntro: (lvl: string) => `会員レベルが ${lvl} に戻りました。`,
    points: '付与ポイント',
    balance: '保有ポイント',
    level: '会員レベル',
    previous: '以前のレベル',
    multiplier: 'ポイント倍率',
    promoEnd: 'キャンペーン終了日',
    view: '会員ページを見る',
  },
  en: {
    earnedIntro: (ref: string, p: string) => `Thank you — your purchase on ${ref} has earned you ${p}.`,
    bonusIntro: (ref: string, p: string, promo: string) => `${promo ? `${promo}: ` : ''}we have added ${p} in bonus points for ${ref}.`,
    upgradeIntro: (lvl: string) => `Your lifetime purchases have moved you up to ${lvl}.`,
    restoredIntro: (lvl: string) => `Your membership level is back to ${lvl}.`,
    points: 'Points added',
    balance: 'Your points',
    level: 'Membership level',
    previous: 'Previous level',
    multiplier: 'Points rate',
    promoEnd: 'Promotion ends',
    view: 'View your membership',
  },
} as const

const Block = ({ lang, p, primary }: { lang: Lang; p: WebLoyaltyEmailProps; primary: boolean }) => {
  const c = COPY[lang]
  const level = String(p.level ?? '').trim()
  const previous = String(p.previousLevel ?? '').trim()
  const promo = String(p.promoName ?? '').trim()
  const promoEnd = String(p.promoEnd ?? '').trim()
  const hasPoints = typeof p.points === 'number' && p.points > 0
  const hasBalance = typeof p.balance === 'number' && Number.isFinite(p.balance)
  const hasMultiplier = typeof p.multiplier === 'number' && p.multiplier > 0
  const intro = p.variant === 'earned' ? c.earnedIntro(p.reference, pts(p.points ?? 0))
    : p.variant === 'bonus' ? c.bonusIntro(p.reference, pts(p.points ?? 0), promo)
    : p.variant === 'tier_upgrade' ? c.upgradeIntro(level)
    : c.restoredIntro(level)
  return (
    <>
      <Heading style={primary ? h1 : h2}>{SUBJECT[p.variant][lang]}</Heading>
      <Text style={text}>{intro}</Text>
      <Panel gutter={blockGutter} box={block}>
        {/* Row is a table, not flex — Gmail drops display:flex. See order-shared. */}
        <Row k={WORDS.reference[lang]} v={p.reference} />
        {(p.variant === 'earned' || p.variant === 'bonus') && hasPoints && <Row k={c.points} v={pts(p.points as number)} emphasis />}
        {p.variant === 'bonus' && promoEnd && <Row k={c.promoEnd} v={promoEnd} />}
        {(p.variant === 'tier_upgrade' || p.variant === 'tier_restored') && previous && <Row k={c.previous} v={previous} />}
        {level && <Row k={c.level} v={level} emphasis={p.variant === 'tier_upgrade' || p.variant === 'tier_restored'} />}
        {hasMultiplier && p.variant !== 'bonus' && <Row k={c.multiplier} v={`×${p.multiplier}`} />}
        {hasBalance && <Row k={c.balance} v={pts(p.balance as number)} />}
      </Panel>
      <Section style={buttonWrap}>
        <Button style={button} href={p.loyaltyUrl}>{c.view}</Button>
      </Section>
    </>
  )
}

export const WebLoyaltyEmail = (p: WebLoyaltyEmailProps) => (
  <Html lang={p.lang} dir="ltr">
    <Head />
    <Preview>{webLoyaltySubject(p.variant, p.reference, p.lang)}</Preview>
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

export default WebLoyaltyEmail
