/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Text } from 'npm:@react-email/components@0.0.22'
import { formatMoney } from '../storefront-email.ts'
import { Panel, Row, block, blockGutter, label, text } from './order-shared.tsx'

/**
 * Pieces shared by the three web-layaway emails. Separate from order-shared
 * because a plan has things an order does not — a deposit, a term, a dated
 * schedule — and because a plan can be settled in pesos, so nothing here may
 * assume the yen symbol.
 *
 * ENGLISH ONLY (owner rule: no layaway email is ever sent in Japanese —
 * subject or body). There is no `lang` anywhere in the layaway emails;
 * development/layaway-english.test.ts fails on any Japanese character.
 */

export interface LayawayScheduleRow {
  installment_number: number
  due_date: string
  amount: number
  paid?: boolean
}

export const LAYAWAY_WORDS = {
  reference: 'Reference',
  total: 'Total',
  deposit: 'Deposit (30%)',
  term: 'Term',
  months: 'months',
  schedule: 'Payment schedule',
  paid: 'Paid',
  viewPlan: 'View your plan',
  remaining: 'Remaining balance',
  received: 'Amount received',
  nextDue: 'Next payment',
} as const

/** A yyyy-mm-dd instalment date, in English. */
export function formatDueDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(d)
}

export const PlanSummary = ({
  reference, totalAmount, deposit, termMonths, currency,
}: {
  reference: string; totalAmount: number; deposit: number; termMonths: number
  currency: 'JPY' | 'PHP'
}) => (
  <Panel gutter={blockGutter} box={block}>
    <Text style={label}>{LAYAWAY_WORDS.reference}</Text>
    <Text style={{ ...text, margin: '0 0 8px', fontWeight: 'bold' }}>{reference}</Text>
    {/* Row is a table, not flex — Gmail drops display:flex. See order-shared. */}
    <Row k={LAYAWAY_WORDS.total} v={formatMoney(totalAmount, currency)} />
    <Row k={LAYAWAY_WORDS.deposit} v={formatMoney(deposit, currency)} />
    <Row k={LAYAWAY_WORDS.term} v={`${termMonths} ${LAYAWAY_WORDS.months}`} />
  </Panel>
)

export const ScheduleTable = ({
  rows, currency,
}: { rows: LayawayScheduleRow[]; currency: 'JPY' | 'PHP' }) => (
  <Panel gutter={blockGutter} box={block}>
    <Text style={label}>{LAYAWAY_WORDS.schedule}</Text>
    {rows.map((r) => (
      <Row
        key={r.installment_number}
        k={`${r.installment_number} · ${formatDueDate(r.due_date)}`}
        v={`${formatMoney(r.amount, currency)}${r.paid ? ` · ${LAYAWAY_WORDS.paid}` : ''}`}
      />
    ))}
  </Panel>
)
