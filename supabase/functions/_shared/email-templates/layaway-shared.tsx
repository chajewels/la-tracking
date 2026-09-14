/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Section, Text } from 'npm:@react-email/components@0.0.22'
import { formatMoney, type Lang } from '../storefront-email.ts'
import { Row, block, label, text } from './order-shared.tsx'

/**
 * Pieces shared by the three web-layaway emails. Separate from order-shared
 * because a plan has things an order does not — a deposit, a term, a dated
 * schedule — and because a plan can be settled in pesos, so nothing here may
 * assume the yen symbol.
 */

export interface LayawayScheduleRow {
  installment_number: number
  due_date: string
  amount: number
  paid?: boolean
}

export const LAYAWAY_WORDS = {
  reference: { ja: 'ご予約番号', en: 'Reference' },
  total: { ja: 'お品物合計', en: 'Total' },
  deposit: { ja: 'お申込金（30%）', en: 'Deposit (30%)' },
  term: { ja: 'お支払い回数', en: 'Term' },
  months: { ja: 'か月', en: 'months' },
  schedule: { ja: 'お支払いスケジュール', en: 'Payment schedule' },
  installment: { ja: '回目', en: '' },
  paid: { ja: 'お支払い済み', en: 'Paid' },
  viewPlan: { ja: '分割予約を確認する', en: 'View your plan' },
  remaining: { ja: 'お支払い残額', en: 'Remaining balance' },
  received: { ja: 'ご入金額', en: 'Amount received' },
  nextDue: { ja: '次回お支払い', en: 'Next payment' },
} as const

/** A yyyy-mm-dd instalment date, read in the customer's language. */
export function formatDueDate(iso: string, lang: Lang): string {
  const d = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return lang === 'ja'
    ? new Intl.DateTimeFormat('ja-JP', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' }).format(d)
    : new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(d)
}

export const PlanSummary = ({
  reference, totalAmount, deposit, termMonths, currency, lang,
}: {
  reference: string; totalAmount: number; deposit: number; termMonths: number
  currency: 'JPY' | 'PHP'; lang: Lang
}) => (
  <Section style={block}>
    <Text style={label}>{LAYAWAY_WORDS.reference[lang]}</Text>
    <Text style={{ ...text, margin: '0 0 8px', fontWeight: 'bold' }}>{reference}</Text>
    {/* Row is a table, not flex — Gmail drops display:flex. See order-shared. */}
    <Row k={LAYAWAY_WORDS.total[lang]} v={formatMoney(totalAmount, currency)} />
    <Row k={LAYAWAY_WORDS.deposit[lang]} v={formatMoney(deposit, currency)} />
    <Row
      k={LAYAWAY_WORDS.term[lang]}
      v={`${termMonths}${lang === 'ja' ? LAYAWAY_WORDS.months.ja : ` ${LAYAWAY_WORDS.months.en}`}`}
    />
  </Section>
)

export const ScheduleTable = ({
  rows, currency, lang,
}: { rows: LayawayScheduleRow[]; currency: 'JPY' | 'PHP'; lang: Lang }) => (
  <Section style={block}>
    <Text style={label}>{LAYAWAY_WORDS.schedule[lang]}</Text>
    {rows.map((r) => (
      <Row
        key={r.installment_number}
        k={lang === 'ja'
          ? `${r.installment_number}${LAYAWAY_WORDS.installment.ja} · ${formatDueDate(r.due_date, lang)}`
          : `${r.installment_number} · ${formatDueDate(r.due_date, lang)}`}
        v={`${formatMoney(r.amount, currency)}${r.paid ? ` · ${LAYAWAY_WORDS.paid[lang]}` : ''}`}
      />
    ))}
  </Section>
)
