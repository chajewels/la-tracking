import { mockAccounts, mockPayments, mockCustomers } from './mock-data';
import { Currency, RiskLevel, CLVTier, CompletionProbability } from './types';
import { formatCurrency } from './calculations';
import { toJpy } from './currency-converter';

// ──────────────────────────────────────────────────────
// 1. LATE PAYMENT RISK PREDICTION
// ──────────────────────────────────────────────────────

export interface RiskAssessment {
  accountId: string;
  riskLevel: RiskLevel;
  score: number; // 0–100, higher = riskier
  factors: string[];
  recommendation: string;
}

/**
 * Analyze a layaway account and produce a risk score based on:
 * - historical payment delays
 * - reminders sent count
 * - average days paid after due
 * - penalty frequency
 * - remaining balance size
 * - installment progress
 * - payment consistency
 */
export function assessAccountRisk(accountId: string): RiskAssessment {
  const account = mockAccounts.find(a => a.id === accountId);
  if (!account || account.status !== 'active') {
    return { accountId, riskLevel: 'low', score: 0, factors: [], recommendation: 'Monitor normally' };
  }

  const payments = mockPayments.filter(p => p.account_id === accountId);
  let score = 0;
  const factors: string[] = [];

  // Payment progress ratio
  const progressRatio = account.total_paid / account.total_amount;
  if (progressRatio === 0) {
    score += 35;
    factors.push('No payments made yet');
  } else if (progressRatio < 0.25) {
    score += 20;
    factors.push('Less than 25% paid');
  } else if (progressRatio >= 0.5) {
    score -= 10;
  }

  // Payment count vs expected
  const expectedPayments = Math.max(1, Math.floor(
    (Date.now() - new Date(account.order_date).getTime()) / (30 * 24 * 60 * 60 * 1000)
  ));
  const paymentRatio = payments.length / expectedPayments;
  if (paymentRatio < 0.5) {
    score += 25;
    factors.push('Missed multiple expected payments');
  } else if (paymentRatio < 1) {
    score += 10;
    factors.push('Behind on payment schedule');
  }

  // Remaining balance relative to total
  const balanceRatio = account.remaining_balance / account.total_amount;
  if (balanceRatio > 0.8) {
    score += 15;
    factors.push('High remaining balance');
  }

  // Payment consistency (variance in payment amounts)
  if (payments.length >= 2) {
    const amounts = payments.map(p => p.amount);
    const avg = amounts.reduce((s, a) => s + a, 0) / amounts.length;
    const variance = amounts.reduce((s, a) => s + Math.pow(a - avg, 2), 0) / amounts.length;
    const cv = Math.sqrt(variance) / avg;
    if (cv > 0.5) {
      score += 10;
      factors.push('Inconsistent payment amounts');
    }
  }

  // Penalty history (simulated)
  if (accountId === 'a4') {
    score += 20;
    factors.push('Penalties previously applied');
  }

  // Clamp score
  score = Math.max(0, Math.min(100, score));

  let riskLevel: RiskLevel;
  let recommendation: string;
  if (score >= 50) {
    riskLevel = 'high';
    recommendation = 'Send reminder now + schedule follow-up message';
  } else if (score >= 25) {
    riskLevel = 'medium';
    recommendation = 'Send reminder 2 days before due date';
  } else {
    riskLevel = 'low';
    recommendation = 'Monitor normally';
  }

  if (factors.length === 0) factors.push('On track with payments');

  return { accountId, riskLevel, score, factors, recommendation };
}

export function getAllRiskAssessments(): RiskAssessment[] {
  return mockAccounts
    .filter(a => a.status === 'active')
    .map(a => assessAccountRisk(a.id));
}

// ──────────────────────────────────────────────────────
// 2. CUSTOMER LIFETIME VALUE (CLV)
// ──────────────────────────────────────────────────────

export interface CLVAssessment {
  customerId: string;
  tier: CLVTier;
  score: number; // 0–100
  totalPurchaseValue: number;
  completedContracts: number;
  totalCollected: number;
  reliabilityScore: number;
}

export function assessCustomerCLV(customerId: string): CLVAssessment {
  const accounts = mockAccounts.filter(a => a.customer_id === customerId);
  const payments = mockPayments.filter(p => accounts.some(a => a.id === p.account_id));

  const totalPurchaseValue = accounts.reduce((s, a) => s + a.total_amount, 0);
  const completedContracts = accounts.filter(a => a.status === 'completed').length;
  const totalCollected = payments.reduce((s, p) => s + p.amount, 0);

  // Reliability: ratio of paid vs total across active accounts
  const activeAccounts = accounts.filter(a => a.status === 'active');
  const reliabilityScore = activeAccounts.length > 0
    ? (activeAccounts.reduce((s, a) => s + a.total_paid / a.total_amount, 0) / activeAccounts.length) * 100
    : completedContracts > 0 ? 100 : 0;

  let score = 0;
  // Purchase volume (max 30)
  score += Math.min(30, totalPurchaseValue / 5000);
  // Completed contracts (max 25)
  score += Math.min(25, completedContracts * 12.5);
  // Reliability (max 25)
  score += reliabilityScore * 0.25;
  // Retention (number of accounts, max 20)
  score += Math.min(20, accounts.length * 10);

  score = Math.min(100, Math.round(score));

  let tier: CLVTier;
  if (score >= 75) tier = 'vip';
  else if (score >= 50) tier = 'gold';
  else if (score >= 25) tier = 'silver';
  else tier = 'bronze';

  return {
    customerId,
    tier,
    score,
    totalPurchaseValue,
    completedContracts,
    totalCollected,
    reliabilityScore: Math.round(reliabilityScore),
  };
}

export function getAllCLVAssessments(): CLVAssessment[] {
  return mockCustomers.map(c => assessCustomerCLV(c.id));
}

// ──────────────────────────────────────────────────────
// 3. LAYAWAY COMPLETION PREDICTION
// ──────────────────────────────────────────────────────

export interface CompletionPrediction {
  accountId: string;
  probability: CompletionProbability;
  score: number; // 0–100
  progressPercent: number;
}

export function predictCompletion(accountId: string): CompletionPrediction {
  const account = mockAccounts.find(a => a.id === accountId);
  if (!account) return { accountId, probability: 'low', score: 0, progressPercent: 0 };

  const progressPercent = Math.round((account.total_paid / account.total_amount) * 100);
  const risk = assessAccountRisk(accountId);

  // Completion score inversely related to risk
  let score = 100 - risk.score;
  // Boost for progress
  score = Math.round(score * 0.6 + progressPercent * 0.4);
  score = Math.max(0, Math.min(100, score));

  let probability: CompletionProbability;
  if (score >= 65) probability = 'high';
  else if (score >= 35) probability = 'medium';
  else probability = 'low';

  return { accountId, probability, score, progressPercent };
}

export function getAllCompletionPredictions(): CompletionPrediction[] {
  return mockAccounts
    .filter(a => a.status === 'active')
    .map(a => predictCompletion(a.id));
}

// ──────────────────────────────────────────────────────
// 4. CASHFLOW FORECASTING
// ──────────────────────────────────────────────────────

export interface ForecastMonth {
  month: string;
  expected: number;
  adjusted: number; // After default probability
  currency: Currency;
}

export function generateCashflowForecast(currency?: Currency, months: number = 6): ForecastMonth[] {
  const activeAccounts = mockAccounts.filter(
    a => a.status === 'active' && (!currency || a.currency === currency)
  );

  const now = new Date();
  const forecast: ForecastMonth[] = [];

  for (let i = 0; i < months; i++) {
    const forecastDate = new Date(now.getFullYear(), now.getMonth() + i + 1, 1);
    const monthLabel = forecastDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

    let expected = 0;
    let adjusted = 0;

    activeAccounts.forEach(account => {
      const remainingMonths = account.payment_plan - Math.floor(
        (Date.now() - new Date(account.order_date).getTime()) / (30 * 24 * 60 * 60 * 1000)
      );
      if (remainingMonths > i) {
        const monthlyPayment = account.remaining_balance / Math.max(1, remainingMonths);
        const completion = predictCompletion(account.id);
        const completionFactor = completion.score / 100;
        expected += monthlyPayment;
        adjusted += monthlyPayment * completionFactor;
      }
    });

    const cur = currency || 'PHP';
    forecast.push({
      month: monthLabel,
      expected: Math.round(expected),
      adjusted: Math.round(adjusted),
      currency: cur,
    });
  }

  return forecast;
}

export function getExpectedNextMonthCollection(currency?: Currency): { amount: number; adjusted: number; currency: Currency } {
  const forecast = generateCashflowForecast(currency, 1);
  if (forecast.length === 0) return { amount: 0, adjusted: 0, currency: currency || 'PHP' };
  return { amount: forecast[0].expected, adjusted: forecast[0].adjusted, currency: forecast[0].currency };
}

// ──────────────────────────────────────────────────────
// 5. CURRENCY-FILTERED DASHBOARD STATS
// ──────────────────────────────────────────────────────

export function getPredictedRevenue(days: number, currency?: Currency): number {
  const activeAccounts = mockAccounts.filter(
    a => a.status === 'active' && (!currency || a.currency === currency)
  );
  let total = 0;
  activeAccounts.forEach(account => {
    const remainingMonths = Math.max(1, account.payment_plan - Math.floor(
      (Date.now() - new Date(account.order_date).getTime()) / (30 * 24 * 60 * 60 * 1000)
    ));
    const monthlyPayment = account.remaining_balance / remainingMonths;
    const monthsInPeriod = days / 30;
    const completion = predictCompletion(account.id);
    total += monthlyPayment * Math.min(monthsInPeriod, remainingMonths) * (completion.score / 100);
  });
  return Math.round(total);
}

// ──────────────────────────────────────────────────────
// 6. STYLE HELPERS
// ──────────────────────────────────────────────────────

export const riskStyles = {
  low: { bg: 'bg-success/10', text: 'text-success', border: 'border-success/20', emoji: '🟢', label: 'Low Risk' },
  medium: { bg: 'bg-warning/10', text: 'text-warning', border: 'border-warning/20', emoji: '🟠', label: 'Medium Risk' },
  high: { bg: 'bg-destructive/10', text: 'text-destructive', border: 'border-destructive/20', emoji: '🔴', label: 'High Risk' },
};

export const clvStyles = {
  bronze: { bg: 'bg-muted', text: 'text-muted-foreground', border: 'border-border', label: 'Bronze' },
  silver: { bg: 'bg-secondary', text: 'text-secondary-foreground', border: 'border-border', label: 'Silver' },
  gold: { bg: 'bg-warning/10', text: 'text-warning', border: 'border-warning/20', label: 'Gold' },
  vip: { bg: 'bg-primary/10', text: 'text-primary', border: 'border-primary/20', label: 'VIP' },
};

export const completionStyles = {
  high: { bg: 'bg-success/10', text: 'text-success', border: 'border-success/20', label: 'High Completion' },
  medium: { bg: 'bg-warning/10', text: 'text-warning', border: 'border-warning/20', label: 'Medium Completion' },
  low: { bg: 'bg-destructive/10', text: 'text-destructive', border: 'border-destructive/20', label: 'Low Completion' },
};
