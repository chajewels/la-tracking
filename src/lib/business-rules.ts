/**
 * Centralized Business Rules for Cha Jewels Layaway System
 * ─────────────────────────────────────────────────────────
 * SINGLE SOURCE OF TRUTH for all status checks, date logic,
 * schedule calculations, and financial computations.
 *
 * Every page/component MUST import from here instead of
 * implementing local calculations.
 */

import type { Tables } from '@/integrations/supabase/types';
import { Currency } from './types';

// ── Type aliases ──
export type DbSchedule = Tables<'layaway_schedule'>;
export type DbAccount = Tables<'layaway_accounts'>;
export type DbPayment = Tables<'payments'>;
export type DbPenalty = Tables<'penalty_fees'>;

// ── Penalty Cap Constants ──
export const PENALTY_CAP = {
  PHP: { months1to5: 1000, month6: Infinity },
  JPY: { months1to5: 2000, month6: Infinity },
} as const;

/** Get the max penalty allowed for a given installment number and currency. */
export function getPenaltyCap(currency: 'PHP' | 'JPY', installmentNumber: number): number {
  if (installmentNumber >= 6) return Infinity;
  return currency === 'PHP' ? PENALTY_CAP.PHP.months1to5 : PENALTY_CAP.JPY.months1to5;
}

/** Check if a penalty amount exceeds the cap for a given installment. */
export function isPenaltyOverCap(currency: 'PHP' | 'JPY', installmentNumber: number, totalPenalty: number): boolean {
  const cap = getPenaltyCap(currency, installmentNumber);
  return totalPenalty > cap;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 1. DATE UTILITIES (timezone-safe, string-based)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Get today as YYYY-MM-DD string (local timezone). */
export function todayStr(): string {
  return new Date().toISOString().split('T')[0];
}

/** Days between two YYYY-MM-DD strings. Positive = overdue. */
export function daysBetween(from: string, to: string): number {
  return Math.floor(
    (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000
  );
}

/** Days overdue from today. Positive = past due. Negative = days until due. */
export function daysOverdueFromToday(dueDate: string): number {
  return daysBetween(dueDate, todayStr());
}

/** N days from today as YYYY-MM-DD. */
export function daysFromNow(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

/** Check if date falls in the current month. */
export function isCurrentMonth(dateStr: string): boolean {
  const now = new Date();
  const d = new Date(dateStr);
  return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
}

/** Check if date falls in the current year. */
export function isCurrentYear(dateStr: string): boolean {
  return new Date(dateStr).getFullYear() === new Date().getFullYear();
}

/** Start of current week (Sunday) as YYYY-MM-DD. */
export function startOfWeek(): string {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay());
  d.setHours(0, 0, 0, 0);
  return d.toISOString().split('T')[0];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 2. SCHEDULE ITEM STATUS RULES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * An installment is "effectively paid" when:
 * - DB status is 'paid', OR
 * - paid_amount > 0 AND paid_amount >= total_due_amount
 *   (handles short-payment rollover where base was adjusted)
 */
export function isEffectivelyPaid(item: {
  status: string;
  paid_amount: number | string;
  total_due_amount: number | string;
}): boolean {
  if (item.status === 'paid') return true;
  const paid = Number(item.paid_amount);
  const due = Number(item.total_due_amount);
  return paid > 0 && paid >= due;
}

/** Remaining amount due on a schedule item (never negative). */
export function remainingDue(item: {
  total_due_amount: number | string;
  paid_amount: number | string;
}): number {
  return Math.max(0, Number(item.total_due_amount) - Number(item.paid_amount));
}

/** Overpayment credit on a paid item. */
export function overpaymentCredit(item: {
  total_due_amount: number | string;
  paid_amount: number | string;
  status: string;
}): number {
  if (!isEffectivelyPaid(item)) return 0;
  return Math.max(0, Number(item.paid_amount) - Number(item.total_due_amount));
}

/** Display amount for a schedule item (actual paid for paid items, total_due for unpaid). */
export function scheduleDisplayAmount(item: {
  status: string;
  paid_amount: number | string;
  total_due_amount: number | string;
}): number {
  if (isEffectivelyPaid(item)) {
    return Math.max(Number(item.paid_amount), Number(item.total_due_amount));
  }
  return Number(item.total_due_amount);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 3. ACCOUNT-LEVEL STATUS RULES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Active statuses that count toward receivables and operations. */
export const ACTIVE_STATUSES = ['active', 'overdue'] as const;

/** Statuses excluded from receivables and account counts. */
export const EXCLUDED_STATUSES = ['forfeited', 'cancelled'] as const;

/** Check if account is operationally active. */
export function isAccountActive(status: string): boolean {
  return ACTIVE_STATUSES.includes(status as any);
}

/** Check if account should be excluded from counts/receivables. */
export function isAccountExcluded(status: string): boolean {
  return EXCLUDED_STATUSES.includes(status as any);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 4. FINANCIAL CALCULATIONS (account-level)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Compute remaining balance from schedule items.
 * This is THE canonical way to compute remaining balance —
 * derived from unpaid schedule items, not from account.remaining_balance
 * (which may lag behind after payments).
 */
export function computeRemainingBalance(
  schedule: Array<{
    status: string;
    paid_amount: number | string;
    total_due_amount: number | string;
  }>
): number {
  return schedule.reduce((sum, item) => {
    if (isEffectivelyPaid(item) || item.status === 'cancelled') return sum;
    return sum + remainingDue(item);
  }, 0);
}

/** Filter schedule to only unpaid items (not effectively paid and not cancelled). */
export function getUnpaidScheduleItems<T extends { status: string; paid_amount: number | string; total_due_amount: number | string }>(
  schedule: T[]
): T[] {
  return schedule.filter(s => !isEffectivelyPaid(s) && s.status !== 'cancelled');
}

/** Filter active (non-voided) payments. */
export function getActivePayments<T extends { voided_at: string | null }>(
  payments: T[]
): T[] {
  return payments.filter(p => !p.voided_at);
}

/** Account progress as a percentage (0–100). */
export function accountProgress(totalPaid: number, totalAmount: number): number {
  if (totalAmount <= 0) return 0;
  return Math.min(100, Math.round((totalPaid / totalAmount) * 100));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 5. RISK ASSESSMENT (live, from real schedule data)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import type { RiskLevel, CompletionProbability, CLVTier } from './types';

export interface RiskAssessment {
  riskLevel: RiskLevel;
  score: number;
  recommendation: string;
  maxOverdueDays: number;
}

/**
 * Assess late-payment risk based on schedule overdue duration.
 * Rules:
 * - <7d → low (monitor)
 * - 7–30d → low (send reminder)
 * - 31–60d → medium (urgent follow-up)
 * - 61+d → high (escalate)
 */
export function assessRisk(
  schedules: Array<{ due_date: string; status: string }>,
): RiskAssessment {
  const today = todayStr();
  const overdueItems = schedules.filter(
    s => s.due_date < today && ['pending', 'partially_paid'].includes(s.status)
  );

  if (overdueItems.length === 0) {
    return { riskLevel: 'low', score: 0, recommendation: 'On track — no overdue', maxOverdueDays: 0 };
  }

  const oldestDueDate = overdueItems.reduce(
    (oldest, s) => (s.due_date < oldest ? s.due_date : oldest),
    overdueItems[0].due_date
  );
  const maxOverdueDays = daysBetween(oldestDueDate, today);

  let riskLevel: RiskLevel = 'low';
  let recommendation = 'Monitor normally';
  let score = 0;

  if (maxOverdueDays < 7) {
    riskLevel = 'low';
    score = Math.round((maxOverdueDays / 7) * 15);
    recommendation = 'Recently overdue — monitor';
  } else if (maxOverdueDays <= 30) {
    riskLevel = 'low';
    score = 15 + Math.round(((maxOverdueDays - 7) / 23) * 18);
    recommendation = 'Send payment reminder';
  } else if (maxOverdueDays <= 60) {
    riskLevel = 'medium';
    score = 34 + Math.round(((maxOverdueDays - 30) / 30) * 32);
    recommendation = 'Urgent follow-up needed';
  } else {
    riskLevel = 'high';
    score = 67 + Math.min(33, Math.round(((maxOverdueDays - 60) / 30) * 33));
    recommendation = 'Escalate — restructure or collect';
  }

  return { riskLevel, score: Math.max(0, Math.min(100, score)), recommendation, maxOverdueDays };
}

export interface CompletionPrediction {
  probability: CompletionProbability;
  score: number;
  progressPercent: number;
}

/** Predict layaway completion likelihood. */
export function predictCompletion(
  totalPaid: number,
  totalAmount: number,
  riskScore: number,
): CompletionPrediction {
  const progressPercent = accountProgress(totalPaid, totalAmount);
  let score = Math.round((100 - riskScore) * 0.6 + progressPercent * 0.4);
  score = Math.max(0, Math.min(100, score));
  let probability: CompletionProbability = 'low';
  if (score >= 65) probability = 'high';
  else if (score >= 35) probability = 'medium';
  return { probability, score, progressPercent };
}

export interface CLVAssessment {
  tier: CLVTier;
  score: number;
  totalPurchaseValue: number;
  completedContracts: number;
  reliabilityScore: number;
}

/** Assess Customer Lifetime Value from account and payment data. */
export function assessCLV(
  customerAccounts: Array<{ status: string; total_amount: number | string; total_paid: number | string }>,
): CLVAssessment {
  const totalPurchaseValue = customerAccounts.reduce((s, a) => s + Number(a.total_amount), 0);
  const completedContracts = customerAccounts.filter(a => a.status === 'completed').length;
  const activeAccounts = customerAccounts.filter(a => isAccountActive(a.status));
  const reliabilityScore = activeAccounts.length > 0
    ? (activeAccounts.reduce((s, a) => s + Number(a.total_paid) / Number(a.total_amount), 0) / activeAccounts.length) * 100
    : completedContracts > 0 ? 100 : 0;

  let score = 0;
  score += Math.min(30, totalPurchaseValue / 5000);
  score += Math.min(25, completedContracts * 12.5);
  score += reliabilityScore * 0.25;
  score += Math.min(20, customerAccounts.length * 10);
  score = Math.min(100, Math.round(score));

  let tier: CLVTier = 'bronze';
  if (score >= 75) tier = 'vip';
  else if (score >= 50) tier = 'gold';
  else if (score >= 25) tier = 'silver';

  return { tier, score, totalPurchaseValue, completedContracts, reliabilityScore: Math.round(reliabilityScore) };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 6. COLLECTION STATS (from payment arrays)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface CollectionStats {
  todayTotal: number;
  yesterdayTotal: number;
  weekTotal: number;
  monthTotal: number;
  yearTotal: number;
}

/**
 * Compute collection stats from a list of non-voided payments.
 * @param payments - array with date_paid and amount (already converted if needed)
 */
export function computeCollectionStats(
  payments: Array<{ date_paid: string; amount: number }>
): CollectionStats {
  const today = todayStr();
  const yesterday = daysFromNow(-1);
  const weekStart = startOfWeek();

  let todayTotal = 0, yesterdayTotal = 0, weekTotal = 0, monthTotal = 0, yearTotal = 0;

  for (const p of payments) {
    const amt = p.amount;
    if (p.date_paid === today) todayTotal += amt;
    if (p.date_paid === yesterday) yesterdayTotal += amt;
    if (p.date_paid >= weekStart) weekTotal += amt;
    if (isCurrentMonth(p.date_paid)) monthTotal += amt;
    if (isCurrentYear(p.date_paid)) yearTotal += amt;
  }

  return { todayTotal, yesterdayTotal, weekTotal, monthTotal, yearTotal };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 7. ALERT CATEGORIZATION (for monitoring & reminders)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type AlertType = 'overdue' | 'due_today' | 'upcoming';
export type AccountBucket = 'overdue' | 'due_today' | 'due_3_days' | 'due_7_days' | 'future' | 'fully_paid';

export function categorizeByDueDate(dueDate: string): AlertType {
  const today = todayStr();
  if (dueDate < today) return 'overdue';
  if (dueDate === today) return 'due_today';
  return 'upcoming';
}

/**
 * Get the NEXT unpaid schedule item for an account (earliest due_date with remaining balance).
 * This is THE canonical way to determine an account's current payment state.
 */
export function getNextUnpaidDueDate(
  scheduleItems: Array<{ due_date: string; status: string; paid_amount: number | string; total_due_amount: number | string }>
): string | null {
  const unpaid = scheduleItems
    .filter(s => !isEffectivelyPaid(s) && s.status !== 'cancelled')
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
  return unpaid.length > 0 ? unpaid[0].due_date : null;
}

/**
 * Get the "next monthly payment" statement date.
 * Rule: If auto-penalty has been applied to the next unpaid installment,
 * the statement date shifts to due_date + 14 days.
 */
export function getNextPaymentStatementDate(
  scheduleItems: Array<{ due_date: string; status: string; paid_amount: number | string; total_due_amount: number | string; penalty_amount: number | string }>
): { date: string; isAdjusted: boolean } | null {
  const unpaid = scheduleItems
    .filter(s => !isEffectivelyPaid(s) && s.status !== 'cancelled')
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
  if (unpaid.length === 0) return null;

  const next = unpaid[0];
  const hasPenalty = Number(next.penalty_amount) > 0;
  const today = todayStr();
  const isOverdue = next.due_date < today;

  if (hasPenalty && isOverdue) {
    // Shift to due_date + 14 days
    const d = new Date(next.due_date);
    d.setDate(d.getDate() + 14);
    return { date: d.toISOString().split('T')[0], isAdjusted: true };
  }

  return { date: next.due_date, isAdjusted: false };
}

/**
 * Classify an account into a single bucket based on its NEXT unpaid due date.
 * Each account goes into exactly ONE bucket (most urgent wins).
 */
export function classifyAccountBucket(nextDueDate: string | null): AccountBucket {
  if (!nextDueDate) return 'fully_paid';
  const today = todayStr();
  if (nextDueDate < today) return 'overdue';
  if (nextDueDate === today) return 'due_today';
  const in3 = daysFromNow(3);
  if (nextDueDate <= in3) return 'due_3_days';
  const in7 = daysFromNow(7);
  if (nextDueDate <= in7) return 'due_7_days';
  return 'future';
}

/**
 * Check if an account is computationally overdue based on its schedule items.
 * An account is overdue if it has ANY unpaid installment with due_date < today.
 */
export function isComputedOverdue(
  scheduleItems: Array<{ due_date: string; status: string; paid_amount: number | string; total_due_amount: number | string }>
): boolean {
  const today = todayStr();
  return scheduleItems.some(
    s => !isEffectivelyPaid(s) && s.status !== 'cancelled' && s.due_date < today
  );
}

export function categorizeScheduleItems<T extends { due_date: string; total_due_amount: number | string; paid_amount: number | string }>(
  items: T[]
): { overdue: T[]; dueToday: T[]; upcoming: T[] } {
  const overdue: T[] = [];
  const dueToday: T[] = [];
  const upcoming: T[] = [];

  for (const item of items) {
    if (remainingDue(item) <= 0) continue;
    const type = categorizeByDueDate(item.due_date);
    if (type === 'overdue') overdue.push(item);
    else if (type === 'due_today') dueToday.push(item);
    else upcoming.push(item);
  }

  return { overdue, dueToday, upcoming };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 8. STYLE CONSTANTS (shared across all components)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const riskStyles = {
  low: { bg: 'bg-success/10', text: 'text-success', border: 'border-success/20', emoji: '🟢', label: 'Low Risk' },
  medium: { bg: 'bg-warning/10', text: 'text-warning', border: 'border-warning/20', emoji: '🟠', label: 'Medium Risk' },
  high: { bg: 'bg-destructive/10', text: 'text-destructive', border: 'border-destructive/20', emoji: '🔴', label: 'High Risk' },
} as const;

export const clvStyles = {
  bronze: { bg: 'bg-muted', text: 'text-muted-foreground', border: 'border-border', label: 'Bronze' },
  silver: { bg: 'bg-secondary', text: 'text-secondary-foreground', border: 'border-border', label: 'Silver' },
  gold: { bg: 'bg-warning/10', text: 'text-warning', border: 'border-warning/20', label: 'Gold' },
  vip: { bg: 'bg-primary/10', text: 'text-primary', border: 'border-primary/20', label: 'VIP' },
} as const;

export const completionStyles = {
  high: { bg: 'bg-success/10', text: 'text-success', border: 'border-success/20', label: 'High Completion' },
  medium: { bg: 'bg-warning/10', text: 'text-warning', border: 'border-warning/20', label: 'Medium Completion' },
  low: { bg: 'bg-destructive/10', text: 'text-destructive', border: 'border-destructive/20', label: 'Low Completion' },
} as const;

export const alertTypeConfig = {
  overdue: { label: 'Overdue', badgeClass: 'bg-destructive/10 text-destructive border-destructive/20', borderClass: 'border-destructive/20', iconBg: 'bg-destructive/10', iconColor: 'text-destructive' },
  due_today: { label: 'Due Today', badgeClass: 'bg-warning/10 text-warning border-warning/20', borderClass: 'border-warning/20', iconBg: 'bg-warning/10', iconColor: 'text-warning' },
  upcoming: { label: 'Upcoming', badgeClass: 'bg-info/10 text-info border-info/20', borderClass: 'border-border', iconBg: 'bg-info/10', iconColor: 'text-info' },
} as const;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 9. ORDINALS & MESSAGE HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'] as const;

export function ordinal(index: number): string {
  return ORDINALS[index] || `${index + 1}th`;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 10. CACHE INVALIDATION KEYS (one source of truth)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Standard set of query keys to invalidate after any payment/account mutation. */
export const MUTATION_INVALIDATION_KEYS = [
  'accounts',
  'payments',
  'schedule',
  'dashboard-summary',
  'payments-with-accounts',
  'customer-detail',
  'customers',
  'aging-buckets',
  'collections-upcoming-schedule',
  'operations-action-items',
  'monitoring-schedules',
  'reminder-actionable',
  'weekly-collections',
  'all-schedules-analytics',
  'waivers',
  'waivers-page',
] as const;

/** Service labels for account services display. */
export const SERVICE_LABELS: Record<string, string> = {
  resize: 'Resize',
  certificate: 'Certificate',
  polish: 'Polish',
  change_color: 'Change Color',
  engraving: 'Engraving',
  repair: 'Repair',
  other: 'Other',
};
