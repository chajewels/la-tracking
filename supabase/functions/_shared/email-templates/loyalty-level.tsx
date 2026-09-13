/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import type { Lang } from '../storefront-email.ts'
import { Row, WORDS, block, button, buttonWrap, container, footer, h1, h2, headerBar, main, muted, notice, rule, text, wordmark } from './order-shared.tsx'

/**
 * Loyalty LEVEL emails — the three communications around the 180-day
 * inactivity step-down (owner decision 2026-09-13). The rule itself is
 * unchanged and lives in loyalty-inactivity-check / award-loyalty-points:
 *
 *   warning   150 days without a purchase: the level steps down in 30 days
 *   stepdown  the day it happens: new level, earned level, spend to regain it
 *   restored  the member requalified: the earned level is back
 *
 * Cha Jewels branding (never "Hub"), Japanese first and English below in one
 * email, sent through sendStorefrontEmail so Reply-To is sales@chajewelsjp.com.
 * Amounts are JPY (loyalty spend is always yen); dates are Japan dates.
 */

const fmtJpy = (n: number) => `¥${Math.max(0, Math.round(Number(n) || 0)).toLocaleString('en-US')}`
const fmtPts = (n: number) => `${Math.max(0, Math.round(Number(n) || 0)).toLocaleString('en-US')} pt`

/** A calendar date in Japan, in the reader's language. */
export function formatLevelDate(d: Date, lang: Lang): string {
  if (lang === 'ja') {
    return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric' }).format(d)
  }
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', day: 'numeric', month: 'long', year: 'numeric' }).format(d)
}

const LEVEL_WORDS = {
  currentLevel: { ja: '現在のレベル', en: 'Current level' },
  newLevel: { ja: '新しいレベル', en: 'New level' },
  earnedLevel: { ja: 'これまでに獲得されたレベル', en: 'Level you earned' },
  regain: { ja: '復帰までのお買い上げ額', en: 'Spend to regain it' },
  stepDownDate: { ja: 'レベルが下がる日', en: 'Step-down date' },
  points: { ja: '保有ポイント', en: 'Your points' },
  multiplier: { ja: 'ポイント倍率', en: 'Points rate' },
  view: { ja: '会員ページを見る', en: 'View your membership' },
  ruleTitle: { ja: 'レベルの仕組み', en: 'How levels work' },
  rule: {
    ja: 'レベルはこれまでのお買い上げ合計で決まります。180日間お買い上げがない場合、レベルは1段階下がります。その後、獲得されたレベルの復帰条件の金額をお買い上げいただくと元のレベルに戻ります。',
    en: 'Your level is set by your lifetime purchases. If 180 days pass without a purchase, it steps down by one level. It comes back once you spend the regain amount for the level you earned.',
  },
} as const

// ─────────────────────────────────────────────────────────── shared frame

function Frame({ lang, preview, children }: { lang: Lang; preview: string; children: React.ReactNode }) {
  return (
    <Html lang={lang} dir="ltr">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={headerBar}>
            <Text style={wordmark}>Cha Jewels</Text>
          </Section>
          {children}
          <Hr style={rule} />
          <Text style={muted}>{WORDS.help[lang]}</Text>
          <Text style={footer}>{WORDS.footer[lang]}</Text>
        </Container>
      </Body>
    </Html>
  )
}

/** Japanese block, a rule, then the English block — every level email reads the same way. */
function Bilingual({ render }: { render: (lang: Lang, primary: boolean) => React.ReactNode }) {
  return (
    <>
      {render('ja', true)}
      <Hr style={rule} />
      {render('en', false)}
    </>
  )
}

const RuleNote = ({ lang }: { lang: Lang }) => (
  <Text style={muted}><strong>{LEVEL_WORDS.ruleTitle[lang]}:</strong> {LEVEL_WORDS.rule[lang]}</Text>
)

const PortalButton = ({ lang, url }: { lang: Lang; url: string | null }) =>
  url ? (
    <Section style={buttonWrap}>
      <Button style={button} href={url}>{LEVEL_WORDS.view[lang]}</Button>
    </Section>
  ) : null

// ─────────────────────────────────────────────────────────── 1. warning

export interface LevelWarningProps {
  customerName: string
  currentLevel: string
  nextLowerLevel: string
  stepDownAt: Date
  daysLeft: number
  points: number
  portalUrl: string | null
}

export const levelWarningSubject = () =>
  'あと30日でレベルが1段階下がります / Your level steps down in 30 days'

const WARNING_COPY = {
  ja: {
    heading: 'あと30日でレベルが1段階下がります',
    intro: (p: LevelWarningProps) =>
      `${p.customerName} 様、現在のレベルは ${p.currentLevel} です。${formatLevelDate(p.stepDownAt, 'ja')} までにお買い上げがない場合、レベルは ${p.nextLowerLevel} に1段階下がります。`,
    keep: 'それまでに一度でもお買い上げいただくと、現在のレベルはそのまま維持されます。',
    points: (p: LevelWarningProps) => `保有ポイント ${fmtPts(p.points)} も同じ日に失効します。`,
  },
  en: {
    heading: 'Your level steps down in 30 days',
    intro: (p: LevelWarningProps) =>
      `${p.customerName}, your current level is ${p.currentLevel}. If you have not made a purchase by ${formatLevelDate(p.stepDownAt, 'en')}, it steps down one level to ${p.nextLowerLevel}.`,
    keep: 'Any purchase before then keeps your current level exactly as it is.',
    points: (p: LevelWarningProps) => `Your ${fmtPts(p.points)} expire the same day.`,
  },
} as const

export const LevelWarningEmail = (p: LevelWarningProps) => (
  <Frame lang="ja" preview={levelWarningSubject()}>
    <Bilingual
      render={(lang, primary) => {
        const c = WARNING_COPY[lang]
        return (
          <>
            <Heading style={primary ? h1 : h2}>{c.heading}</Heading>
            <Text style={text}>{c.intro(p)}</Text>
            <Section style={block}>
              <Row k={LEVEL_WORDS.currentLevel[lang]} v={p.currentLevel} />
              <Row k={LEVEL_WORDS.stepDownDate[lang]} v={formatLevelDate(p.stepDownAt, lang)} />
              <Row k={LEVEL_WORDS.points[lang]} v={fmtPts(p.points)} />
            </Section>
            <Text style={notice}>{c.keep}</Text>
            {p.points > 0 && <Text style={muted}>{c.points(p)}</Text>}
            <PortalButton lang={lang} url={p.portalUrl} />
            <RuleNote lang={lang} />
          </>
        )
      }}
    />
  </Frame>
)

// ─────────────────────────────────────────────────────────── 2. step-down

export interface LevelStepdownProps {
  customerName: string
  oldLevel: string
  newLevel: string
  earnedLevel: string
  /** requalify_spend of the earned level minus spend since the baseline, floored at 0. */
  regainJpy: number
  portalUrl: string | null
}

export const levelStepdownSubject = () =>
  'レベルが変更されました / Your Cha Jewels level has changed'

const STEPDOWN_COPY = {
  ja: {
    heading: 'レベルが1段階下がりました',
    intro: (p: LevelStepdownProps) =>
      `${p.customerName} 様、180日間お買い上げがなかったため、レベルが ${p.oldLevel} から ${p.newLevel} に1段階下がりました。`,
    regain: (p: LevelStepdownProps) =>
      `これまでに獲得されたレベルは ${p.earnedLevel} です。あと ${fmtJpy(p.regainJpy)} のお買い上げで ${p.earnedLevel} に戻ります。`,
  },
  en: {
    heading: 'Your level has stepped down',
    intro: (p: LevelStepdownProps) =>
      `${p.customerName}, 180 days passed without a purchase, so your level has stepped down from ${p.oldLevel} to ${p.newLevel}.`,
    regain: (p: LevelStepdownProps) =>
      `The level you earned is ${p.earnedLevel}. Spend ${fmtJpy(p.regainJpy)} more and ${p.earnedLevel} comes back.`,
  },
} as const

export const LevelStepdownEmail = (p: LevelStepdownProps) => (
  <Frame lang="ja" preview={levelStepdownSubject()}>
    <Bilingual
      render={(lang, primary) => {
        const c = STEPDOWN_COPY[lang]
        return (
          <>
            <Heading style={primary ? h1 : h2}>{c.heading}</Heading>
            <Text style={text}>{c.intro(p)}</Text>
            <Section style={block}>
              <Row k={LEVEL_WORDS.newLevel[lang]} v={p.newLevel} />
              <Row k={LEVEL_WORDS.earnedLevel[lang]} v={p.earnedLevel} />
              <Row k={LEVEL_WORDS.regain[lang]} v={fmtJpy(p.regainJpy)} />
            </Section>
            <Text style={notice}>{c.regain(p)}</Text>
            <PortalButton lang={lang} url={p.portalUrl} />
            <RuleNote lang={lang} />
          </>
        )
      }}
    />
  </Frame>
)

// ─────────────────────────────────────────────────────────── 3. restored

export interface LevelRestoredProps {
  customerName: string
  oldLevel: string
  newLevel: string
  multiplier: number
  points: number
  portalUrl: string | null
}

export const levelRestoredSubject = () =>
  'レベルが元に戻りました / Your Cha Jewels level is back'

const RESTORED_COPY = {
  ja: {
    heading: 'レベルが元に戻りました',
    intro: (p: LevelRestoredProps) =>
      `${p.customerName} 様、ご購入ありがとうございます。レベルが ${p.oldLevel} から ${p.newLevel} に戻りました。`,
    perks: (p: LevelRestoredProps) => `ポイント倍率 ${p.multiplier}倍と ${p.newLevel} の特典が本日から再び適用されます。`,
  },
  en: {
    heading: 'Your level is back',
    intro: (p: LevelRestoredProps) =>
      `${p.customerName}, thank you for your purchase. Your level is back from ${p.oldLevel} to ${p.newLevel}.`,
    perks: (p: LevelRestoredProps) => `Your ${p.multiplier}x points rate and ${p.newLevel} perks apply again from today.`,
  },
} as const

export const LevelRestoredEmail = (p: LevelRestoredProps) => (
  <Frame lang="ja" preview={levelRestoredSubject()}>
    <Bilingual
      render={(lang, primary) => {
        const c = RESTORED_COPY[lang]
        return (
          <>
            <Heading style={primary ? h1 : h2}>{c.heading}</Heading>
            <Text style={text}>{c.intro(p)}</Text>
            <Section style={block}>
              <Row k={LEVEL_WORDS.currentLevel[lang]} v={p.newLevel} />
              <Row k={LEVEL_WORDS.multiplier[lang]} v={`${p.multiplier}x`} />
              <Row k={LEVEL_WORDS.points[lang]} v={fmtPts(p.points)} />
            </Section>
            <Text style={notice}>{c.perks(p)}</Text>
            <PortalButton lang={lang} url={p.portalUrl} />
          </>
        )
      }}
    />
  </Frame>
)
