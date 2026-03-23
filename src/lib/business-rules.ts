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
  PHP: { perInstallment: 1000 },
  JPY: { perInstallment: 2000 },
} as const;

/**
 * Get the max penalty allowed for a given installment.
 * The FINAL installment of any plan (3-month, 6-month, etc.) is UNCAPPED
 * because it can legitimately accumulate multiple months of penalties.
 * All non-final installments are capped at PHP 1,000 / JPY 2,000.
 */
export function getPenaltyCap(currency: 'PHP' | 'JPY', installmentNumber: number, planMonths: number = 6): number {
  if (installmentNumber >= planMonths) return Infinity;
  return currency === 'PHP' ? PENALTY_CAP.PHP.perInstallment : PENALTY_CAP.JPY.perInstallment;
}

/** Check if a penalty amount exceeds the cap for a given installment. */
export function isPenaltyOverCap(currency: 'PHP' | 'JPY', installmentNumber: number, totalPenalty: number, planMonths: number = 6): boolean {
  const cap = getPenaltyCap(currency, installmentNumber, planMonths);
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

/**
 * An installment is "partially paid" when:
 * - NOT effectively paid, AND
 * - paid_amount > 0
 */
export function isPartiallyPaid(item: {
  status: string;
  paid_amount: number | string;
  total_due_amount: number | string;
}): boolean {
  if (isEffectivelyPaid(item)) return false;
  return Number(item.paid_amount) > 0;
}

/** Remaining amount due on a schedule item (never negative). */
export function remainingDue(item: {
  total_due_amount: number | string;
  paid_amount: number | string;
}): number {
  return Math.max(0, Number(item.total_due_amount) - Number(item.paid_amount));
}

/**
 * Remaining principal due on a schedule item (base_installment_amount - paid_amount, never negative).
 * This considers only the principal portion, excluding penalties.
 */
export function remainingPrincipalDue(item: {
  base_installment_amount: number | string;
  paid_amount: number | string;
}): number {
  return Math.max(0, Number(item.base_installment_amount) - Number(item.paid_amount));
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
export const ACTIVE_STATUSES = ['active', 'overdue', 'final_settlement', 'extension_active'] as const;

/** Statuses excluded from receivables and account counts. */
export const EXCLUDED_STATUSES = ['forfeited', 'cancelled', 'final_forfeited'] as const;

/** Check if account is operationally active. */
export function isAccountActive(status: string): boolean {
  return ACTIVE_STATUSES.includes(status as any);
}

/** Check if account should be excluded from counts/receivables. */
export function isAccountExcluded(status: string): boolean {
  return EXCLUDED_STATUSES.includes(status as any);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ⛔ PERMANENT FORFEITURE LIFECYCLE — LOCKED RULE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// This block defines the immutable forfeiture status flow.
// DO NOT MODIFY without explicit business owner approval.
//
// STATUS FLOW:
//   OVERDUE → FORFEITED → EXTENSION_ACTIVE → FINAL_FORFEITED
//
// RULES:
//   1. Forfeiture reference = FIRST UNPAID DUE DATE (never last paid).
//   2. FORFEITED triggers at exactly 3 calendar months (day-level precision).
//   3. ONE-TIME reactivation allowed → status becomes EXTENSION_ACTIVE
//      with a 1-month final extension. Penalty cycle continues (no reset).
//   4. If unpaid after the 1-month extension → FINAL_FORFEITED.
//   5. FINAL_FORFEITED is PERMANENT:
//      - No reactivation, no extension, no negotiation, no override.
//   6. No account may become FINAL_FORFEITED before extension period ends.
//   7. No account may be reactivated more than once (is_reactivated flag).
//
// UI RULES:
//   - OVERDUE: warning banner only, no negotiation button.
//   - FORFEITED: show one-time "Reactivate" button (if not already used).
//   - EXTENSION_ACTIVE: no second negotiation button.
//   - FINAL_FORFEITED: no buttons, no negotiation, no reactivation.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Check if account is in final settlement state. */
export function isFinalSettlement(status: string): boolean {
  return status === 'final_settlement';
}

/** Check if account is in extension period after reactivation. */
export function isExtensionActive(status: string): boolean {
  return status === 'extension_active';
}

/** Check if account is permanently forfeited (no further action). */
export function isFinalForfeited(status: string): boolean {
  return status === 'final_forfeited';
}

/** Guard: Can this account be reactivated? Only forfeited + never reactivated. */
export function canReactivate(status: string, isReactivated: boolean): boolean {
  return status === 'forfeited' && !isReactivated;
}

/** Guard: Can this account accept payments? */
export function canAcceptPayment(status: string): boolean {
  return !['forfeited', 'cancelled', 'final_forfeited'].includes(status);
}

/** Guard: Can services be added to this account? */
export function canAddService(status: string): boolean {
  return !['forfeited', 'cancelled', 'final_forfeited'].includes(status);
}

/** Guard: Can penalties be added to this account? */
export function canAddPenalty(status: string): boolean {
  return ['active', 'overdue', 'extension_active'].includes(status);
}

/** Guard: Is any negotiation/extension allowed? */
export function canNegotiate(status: string, isReactivated: boolean): boolean {
  if (status === 'final_forfeited') return false;
  if (status === 'extension_active') return false;
  if (status === 'forfeited' && isReactivated) return false;
  return status === 'forfeited';
}

/**
 * Calculate forfeiture notification info for an overdue account.
 * Returns null if not applicable, or an object with warning details.
 * Based on: 3 full months after FIRST UNPAID DUE DATE = FORFEITED.
 */
export function getForfeitureWarning(
  status: string,
  scheduleItems: DbSchedule[],
): { monthsOverdue: number; firstUnpaidDueDate: string; forfeitDate: string; daysUntilForfeit: number } | null {
  if (status !== 'overdue') return null;

  const sorted = [...scheduleItems]
    .filter(s => s.status !== 'cancelled')
    .sort((a, b) => a.installment_number - b.installment_number);

  const unpaidItems = sorted.filter(s => !isEffectivelyPaid(s));
  if (unpaidItems.length === 0) return null;

  const firstUnpaidDueDate = unpaidItems[0].due_date;

  // Calculate forfeit date = first unpaid due date + 3 months
  const refDate = new Date(firstUnpaidDueDate + 'T00:00:00Z');
  const forfeitDate = new Date(refDate);
  forfeitDate.setUTCMonth(forfeitDate.getUTCMonth() + 3);
  const forfeitDateStr = forfeitDate.toISOString().split('T')[0];

  const today = new Date();
  const todayUTC = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const daysUntilForfeit = Math.ceil((forfeitDate.getTime() - todayUTC.getTime()) / 86_400_000);

  // Calculate months overdue with day-level precision
  const rawMonths = (todayUTC.getUTCFullYear() - refDate.getUTCFullYear()) * 12 +
    (todayUTC.getUTCMonth() - refDate.getUTCMonth());
  const monthsOverdue = todayUTC.getUTCDate() < refDate.getUTCDate()
    ? Math.max(0, rawMonths - 1)
    : rawMonths;

  if (monthsOverdue < 1) return null;

  return {
    monthsOverdue,
    firstUnpaidDueDate,
    forfeitDate: forfeitDateStr,
    daysUntilForfeit,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 4. FINANCIAL CALCULATIONS (account-level)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Compute remaining balance using SINGLE SOURCE OF TRUTH formula:
 *   Remaining = Total Amount - Total Paid
 * When account-level totals are available, use them directly.
 * Falls back to schedule-derived calculation only if account data unavailable.
 * 
 * IMPORTANT: Do NOT derive remaining from schedule rows — this causes
 * rounding/gap discrepancies when paid_amount doesn't exactly match base amounts.
 */
export function computeRemainingBalance(
  schedule: Array<{
    status: string;
    paid_amount: number | string;
    total_due_amount: number | string;
  }>,
  accountTotalAmount?: number,
  accountTotalPaid?: number
): number {
  // Preferred: use account-level totals (single source of truth)
  if (accountTotalAmount !== undefined && accountTotalPaid !== undefined) {
    return Math.max(0, accountTotalAmount - accountTotalPaid);
  }
  // Fallback only: schedule-derived (legacy, avoid when possible)
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

/**
 * Message-only payment coverage across schedule rows using confirmed non-voided payments.
 * Downpayment is consumed first, then the remaining confirmed amount is applied to
 * schedule rows in order so paid markers cannot exceed the confirmed payment total.
 */
export function getMessageSchedulePaymentCoverage<T extends { total_due_amount: number | string }>(
  schedule: T[],
  totalPaid: number,
  downpaymentAmount: number,
): number[] {
  let remainingConfirmedForSchedule = Math.max(0, totalPaid - Math.min(downpaymentAmount, totalPaid));

  return schedule.map((item) => {
    const totalDue = Math.max(0, Number(item.total_due_amount));
    const coveredAmount = Math.min(totalDue, remainingConfirmedForSchedule);
    remainingConfirmedForSchedule = Math.max(0, remainingConfirmedForSchedule - coveredAmount);
    return coveredAmount;
  });
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
export type AccountBucket = 'overdue' | 'grace_period' | 'due_today' | 'due_3_days' | 'due_7_days' | 'future' | 'fully_paid';

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
 * Get the "next payment" statement date.
 *
 * For unpaid installments that are NOT yet overdue, returns the due_date.
 * For overdue installments, computes the next penalty checkpoint using
 * the alternating pattern (due+7, due+14, monthly, monthly+14, …)
 * and returns the first checkpoint >= today.
 */
export function getNextPaymentStatementDate(
  scheduleItems: Array<{ due_date: string; status: string; paid_amount: number | string; total_due_amount: number | string; penalty_amount: number | string }>
): { date: string; isAdjusted: boolean } | null {
  const unpaid = scheduleItems
    .filter(s => !isEffectivelyPaid(s) && s.status !== 'cancelled')
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
  if (unpaid.length === 0) return null;

  const today = todayStr();

  // If there's an upcoming (not yet overdue) installment, return its due_date
  const upcoming = unpaid.find(s => s.due_date >= today);
  if (upcoming) {
    return { date: upcoming.due_date, isAdjusted: false };
  }

  // All unpaid are overdue — compute the next penalty checkpoint for the earliest one
  const overdueItem = unpaid[0];
  const dueDate = new Date(overdueItem.due_date + 'T00:00:00Z');
  const todayDate = new Date(today + 'T00:00:00Z');
  const dueDayOfMonth = dueDate.getUTCDate();

  // Build penalty checkpoint dates in the alternating pattern
  const checkpoints: Date[] = [];

  // Phase 1: due + 7
  const p1 = new Date(dueDate);
  p1.setUTCDate(p1.getUTCDate() + 7);
  checkpoints.push(p1);

  // Phase 2: due + 14
  const p2 = new Date(dueDate);
  p2.setUTCDate(p2.getUTCDate() + 14);
  checkpoints.push(p2);

  // Phase 3+: monthly checkpoint + 14 days alternating
  for (let m = 1; m <= 12; m++) {
    const year = dueDate.getUTCFullYear();
    const month = dueDate.getUTCMonth() + m;
    const maxDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const monthly = new Date(Date.UTC(year, month, Math.min(dueDayOfMonth, maxDay)));
    checkpoints.push(monthly);

    const plus14 = new Date(monthly);
    plus14.setUTCDate(plus14.getUTCDate() + 14);
    checkpoints.push(plus14);
  }

  // Find the next checkpoint that is > today (the next one the customer should pay by)
  const nextCheckpoint = checkpoints.find(cp => cp > todayDate);
  if (nextCheckpoint) {
    return { date: nextCheckpoint.toISOString().split('T')[0], isAdjusted: true };
  }

  // Fallback: return the due date itself
  return { date: overdueItem.due_date, isAdjusted: false };
}

/**
 * Classify an account into a single bucket based on its NEXT unpaid due date.
 * Each account goes into exactly ONE bucket (most urgent wins).
 */
export function classifyAccountBucket(nextDueDate: string | null): AccountBucket {
  if (!nextDueDate) return 'fully_paid';
  const today = todayStr();
  if (nextDueDate < today) {
    // Check if within 1-6 days grace period
    const daysOver = daysBetween(nextDueDate, today);
    if (daysOver >= 1 && daysOver <= 6) return 'grace_period';
    return 'overdue';
  }
  if (nextDueDate === today) return 'due_today';
  const exactly3 = daysFromNow(3);
  if (nextDueDate === exactly3) return 'due_3_days';
  const exactly7 = daysFromNow(7);
  if (nextDueDate === exactly7) return 'due_7_days';
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
  grace_period: { label: 'Grace Period', badgeClass: 'bg-amber-500/10 text-amber-600 border-amber-500/20', borderClass: 'border-amber-500/20', iconBg: 'bg-amber-500/10', iconColor: 'text-amber-600' },
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
  'overdue-schedule',
  'penalty-followup-alerts',
  'csr-notifications-penalty',
  'pending-submissions-count',
  'pending-submissions',
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 11. ACCOUNT SUMMARY — SINGLE SOURCE OF TRUTH
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Compute all account summary values from raw data.
 * This is THE canonical function for summary cards, customer messages,
 * statements, and portal views. Every consumer must use this to avoid
 * calculation mismatches.
 *
 * SAFETY: This function does NOT touch penalty records, payment history,
 * or audit logs. It is read-only and forward-looking.
 */
export interface AccountSummaryValues {
  /** Original contract principal (never includes penalties) */
  principalTotal: number;
  /** Sum of all confirmed payments */
  totalPaid: number;
  /** Principal remaining: principalTotal - totalPaid (never negative) */
  remainingPrincipal: number;
  /** Sum of unpaid penalties from penalty_fees table */
  outstandingPenalties: number;
  /** Sum of additional services */
  totalServices: number;
  /** What the customer owes right now: remainingPrincipal + outstandingPenalties + totalServices */
  currentTotalPayable: number;
  /** Payment progress as percentage (0–100), based on principal only */
  progressPercent: number;
  /** Schedule line items with derived paid state (for message/statement sync) */
  scheduleStates: ScheduleLineState[];
  /** Next unpaid due date or null if fully paid */
  nextDueDate: string | null;
  /** Number of remaining unpaid installments */
  unpaidCount: number;
  /** Whether any installment is past due */
  isOverdue: boolean;
}

/** Per-installment derived state used by messages, schedule cards, and statements. */
export interface ScheduleLineState {
  installmentNumber: number;
  dueDate: string;
  baseAmount: number;
  penaltyAmount: number;
  totalDue: number;
  paidAmount: number;
  /** true when paid_amount >= base_installment_amount (or status=paid) */
  isPaid: boolean;
  /** true when 0 < paid_amount < base_installment_amount and not fully paid */
  isPartial: boolean;
  /** Principal remaining on this specific installment */
  principalRemaining: number;
  status: string;
}

export function computeAccountSummary(params: {
  principalTotal: number;
  totalPaid: number;
  unpaidPenaltySum: number;
  totalServicesAmount: number;
  scheduleItems?: Array<{
    installment_number: number;
    due_date: string;
    base_installment_amount: number | string;
    penalty_amount: number | string;
    total_due_amount: number | string;
    paid_amount: number | string;
    status: string;
  }>;
}): AccountSummaryValues {
  const { principalTotal, totalPaid, unpaidPenaltySum, totalServicesAmount, scheduleItems } = params;
  const remainingPrincipal = Math.max(0, principalTotal - totalPaid);
  const currentTotalPayable = remainingPrincipal + unpaidPenaltySum + totalServicesAmount;
  const progressPercent = accountProgress(totalPaid, principalTotal);

  // Derive schedule states from actual DB paid_amount (single source of truth)
  const scheduleStates: ScheduleLineState[] = (scheduleItems || [])
    .filter(s => s.status !== 'cancelled')
    .map(item => {
      const baseAmount = Number(item.base_installment_amount);
      const penaltyAmount = Number(item.penalty_amount);
      const totalDue = Number(item.total_due_amount);
      const paidAmount = Number(item.paid_amount);
      const isPaid = isEffectivelyPaid(item as any);
      const isPartialFlag = !isPaid && paidAmount > 0;
      const principalRemaining = Math.max(0, baseAmount - paidAmount);
      return {
        installmentNumber: item.installment_number,
        dueDate: item.due_date,
        baseAmount,
        penaltyAmount,
        totalDue,
        paidAmount,
        isPaid,
        isPartial: isPartialFlag,
        principalRemaining,
        status: item.status,
      };
    });

  const unpaidStates = scheduleStates.filter(s => !s.isPaid);
  const today = todayStr();
  const nextDueDate = unpaidStates.length > 0
    ? unpaidStates.sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0].dueDate
    : null;
  const isOverdueFlag = unpaidStates.some(s => s.dueDate < today);

  return {
    principalTotal,
    totalPaid,
    remainingPrincipal,
    outstandingPenalties: unpaidPenaltySum,
    totalServices: totalServicesAmount,
    currentTotalPayable,
    progressPercent,
    scheduleStates,
    nextDueDate,
    unpaidCount: unpaidStates.length,
    isOverdue: isOverdueFlag,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 12. CONSISTENCY VALIDATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface ConsistencyCheck {
  isValid: boolean;
  errors: string[];
}

/**
 * Validate that account data is internally consistent.
 * Uses confirmed payments as the single source of truth.
 * 
 * Call this after any mutation to detect desync early.
 */
export function validateAccountConsistency(params: {
  principalTotal: number;
  confirmedPaymentsTotal: number;
  storedTotalPaid: number;
  storedRemainingBalance: number;
  schedulePaidSum: number;
}): ConsistencyCheck {
  const { principalTotal, confirmedPaymentsTotal, storedTotalPaid, storedRemainingBalance, schedulePaidSum } = params;
  const errors: string[] = [];

  // Rule 1: stored total_paid must match SUM(confirmed payments)
  if (Math.abs(storedTotalPaid - confirmedPaymentsTotal) > 0.01) {
    errors.push(`Total Paid mismatch: stored=${storedTotalPaid}, payments sum=${confirmedPaymentsTotal}`);
  }

  // Rule 2: remaining_balance must equal principal - total_paid
  const expectedRemaining = Math.max(0, principalTotal - confirmedPaymentsTotal);
  if (Math.abs(storedRemainingBalance - expectedRemaining) > 0.01) {
    errors.push(`Remaining Balance mismatch: stored=${storedRemainingBalance}, expected=${expectedRemaining}`);
  }

  // Rule 3: schedule paid_amount sum should not exceed total_paid
  if (schedulePaidSum > confirmedPaymentsTotal + 0.01) {
    errors.push(`Schedule paid sum (${schedulePaidSum}) exceeds confirmed payments (${confirmedPaymentsTotal})`);
  }

  return { isValid: errors.length === 0, errors };
}
