import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ShieldAlert, Flame, Skull } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatCurrency } from '@/lib/calculations';
import { daysOverdueFromToday } from '@/lib/business-rules';
import type { Currency } from '@/lib/types';

// ── Penalty Stage Definitions ──
export type PenaltyStage = 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7' | 'P8';

interface StageConfig {
  key: PenaltyStage;
  label: string;
  shortLabel: string;
  minDays: number;
  maxDays: number; // Infinity for P8
  colorClass: string;
  borderClass: string;
  badgeClass: string;
  iconBg: string;
  tone: string;
}

const PENALTY_STAGES: StageConfig[] = [
  { key: 'P1', label: 'P1 – 7D After Due',    shortLabel: '7D',    minDays: 7,   maxDays: 13,       colorClass: 'text-amber-600 dark:text-amber-400',   borderClass: 'border-amber-300/40',   badgeClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-300/40',   iconBg: 'bg-amber-100 dark:bg-amber-900/30',   tone: 'Friendly reminder' },
  { key: 'P2', label: 'P2 – 14D After Due',   shortLabel: '14D',   minDays: 14,  maxDays: 29,       colorClass: 'text-amber-700 dark:text-amber-300',   borderClass: 'border-amber-400/40',   badgeClass: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border-amber-400/40',   iconBg: 'bg-amber-100 dark:bg-amber-900/40',   tone: 'Follow-up reminder' },
  { key: 'P3', label: 'P3 – 1M After Due',    shortLabel: '1M',    minDays: 30,  maxDays: 43,       colorClass: 'text-orange-600 dark:text-orange-400',  borderClass: 'border-orange-300/40',  badgeClass: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400 border-orange-300/40', iconBg: 'bg-orange-100 dark:bg-orange-900/30', tone: 'Strong reminder' },
  { key: 'P4', label: 'P4 – 1M14D After Due', shortLabel: '1M14D', minDays: 44,  maxDays: 59,       colorClass: 'text-orange-700 dark:text-orange-300',  borderClass: 'border-orange-400/40',  badgeClass: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300 border-orange-400/40', iconBg: 'bg-orange-100 dark:bg-orange-900/40', tone: 'Escalation notice' },
  { key: 'P5', label: 'P5 – 2M After Due',    shortLabel: '2M',    minDays: 60,  maxDays: 73,       colorClass: 'text-red-600 dark:text-red-400',        borderClass: 'border-red-300/40',     badgeClass: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-300/40',               iconBg: 'bg-red-100 dark:bg-red-900/30',       tone: 'Urgent reminder' },
  { key: 'P6', label: 'P6 – 2M14D After Due', shortLabel: '2M14D', minDays: 74,  maxDays: 89,       colorClass: 'text-red-700 dark:text-red-300',        borderClass: 'border-red-400/40',     badgeClass: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300 border-red-400/40',               iconBg: 'bg-red-100 dark:bg-red-900/40',       tone: 'Final warning' },
  { key: 'P7', label: 'P7 – 3M After Due',    shortLabel: '3M',    minDays: 90,  maxDays: 103,      colorClass: 'text-rose-700 dark:text-rose-300',      borderClass: 'border-rose-500/40',    badgeClass: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300 border-rose-500/40',           iconBg: 'bg-rose-100 dark:bg-rose-900/40',     tone: 'Critical escalation' },
  { key: 'P8', label: 'P8 – 3M14D+ After Due', shortLabel: '3M14D+', minDays: 104, maxDays: Infinity, colorClass: 'text-rose-800 dark:text-rose-200',      borderClass: 'border-rose-600/50',    badgeClass: 'bg-rose-200 text-rose-900 dark:bg-rose-900/60 dark:text-rose-200 border-rose-600/50',           iconBg: 'bg-rose-200 dark:bg-rose-900/60',     tone: 'Pre-forfeit warning' },
];

function getStageIcon(key: PenaltyStage) {
  if (key <= 'P2') return AlertTriangle;
  if (key <= 'P4') return ShieldAlert;
  if (key <= 'P6') return Flame;
  return Skull;
}

export function classifyPenaltyStage(daysOverdue: number): PenaltyStage | null {
  for (const s of PENALTY_STAGES) {
    if (daysOverdue >= s.minDays && daysOverdue <= s.maxDays) return s.key;
  }
  return null;
}

export function getStageConfig(stage: PenaltyStage): StageConfig {
  return PENALTY_STAGES.find(s => s.key === stage)!;
}

// ── Penalty reminder message templates ──
export function generatePenaltyReminderMessage(
  stage: PenaltyStage,
  customer: string,
  invoice: string,
  dueDate: string,
  penaltyAmount: number,
  remainingBalance: number,
  currency: Currency,
  portalToken?: string | null,
): string {
  const dueStr = new Date(dueDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const penaltyStr = formatCurrency(penaltyAmount, currency);
  const balanceStr = formatCurrency(remainingBalance, currency);
  const portalLink = portalToken
    ? `\n\n📱 View your account anytime:\nhttps://chajewelslayaway.web.app/portal?token=${portalToken}`
    : '';

  const cfg = getStageConfig(stage);

  const toneMap: Record<PenaltyStage, string> = {
    P1: `Hi ${customer}! 👋\n\nThis is a friendly reminder from Cha Jewels that your layaway payment for INV #${invoice} was due on ${dueStr} and remains unpaid.\n\nOutstanding penalties: ${penaltyStr}\nRemaining balance: ${balanceStr}\n\nPlease settle at your earliest convenience to avoid further penalties.${portalLink}\n\nThank you! 💎`,
    P2: `Hi ${customer}! 👋\n\nThis is a follow-up reminder from Cha Jewels regarding your overdue layaway payment for INV #${invoice} (due ${dueStr}).\n\nOutstanding penalties: ${penaltyStr}\nRemaining balance: ${balanceStr}\n\nWe kindly request your prompt attention to this matter.${portalLink}\n\nThank you! 💎`,
    P3: `Hi ${customer},\n\nYour layaway payment for INV #${invoice} is now 1 month overdue (due ${dueStr}).\n\nOutstanding penalties: ${penaltyStr}\nRemaining balance: ${balanceStr}\n\nPlease contact us to discuss your payment plan.${portalLink}\n\n— Cha Jewels 💎`,
    P4: `Hi ${customer},\n\nIMPORTANT: Your layaway payment for INV #${invoice} has been overdue for over 6 weeks (due ${dueStr}).\n\nOutstanding penalties: ${penaltyStr}\nRemaining balance: ${balanceStr}\n\nPlease settle immediately to avoid further escalation.${portalLink}\n\n— Cha Jewels 💎`,
    P5: `Dear ${customer},\n\n⚠️ URGENT: Your layaway payment for INV #${invoice} is now 2 months overdue (due ${dueStr}).\n\nOutstanding penalties: ${penaltyStr}\nRemaining balance: ${balanceStr}\n\nImmediate payment is required. Please contact us today.${portalLink}\n\n— Cha Jewels 💎`,
    P6: `Dear ${customer},\n\n⚠️ FINAL WARNING: Your layaway payment for INV #${invoice} has been overdue for over 2.5 months (due ${dueStr}).\n\nOutstanding penalties: ${penaltyStr}\nRemaining balance: ${balanceStr}\n\nThis is your final reminder before account escalation.${portalLink}\n\n— Cha Jewels 💎`,
    P7: `Dear ${customer},\n\n🚨 CRITICAL: Your layaway account for INV #${invoice} is 3 months overdue (due ${dueStr}) and at risk of forfeiture.\n\nOutstanding penalties: ${penaltyStr}\nRemaining balance: ${balanceStr}\n\nPlease contact us IMMEDIATELY to resolve your account.${portalLink}\n\n— Cha Jewels 💎`,
    P8: `Dear ${customer},\n\n🚨 PRE-FORFEIT NOTICE: Your layaway account for INV #${invoice} has been overdue since ${dueStr} and is past the forfeiture threshold.\n\nOutstanding penalties: ${penaltyStr}\nRemaining balance: ${balanceStr}\n\nImmediate action is required to prevent permanent account forfeiture.${portalLink}\n\n— Cha Jewels 💎`,
  };

  return toneMap[stage];
}

// ── Interfaces ──
export interface PenaltyAlertItem {
  stage: PenaltyStage;
  customer: string;
  invoice: string;
  dueDate: string;
  daysOverdue: number;
  installmentAmount: number;
  penaltyAmount: number;
  remainingBalance: number;
  currency: Currency;
  accountId: string;
  scheduleId: string;
  customerId: string;
  portalToken?: string | null;
}

interface StageBucket {
  config: StageConfig;
  count: number;
  totalPenalties: number;
  totalBalance: number;
}

// ── Component ──
export default function PenaltyFollowUpSection() {
  const [activeStage, setActiveStage] = useState<PenaltyStage | null>(null);

  // Fetch overdue schedule items with penalties
  const { data: penaltyAlerts, isLoading } = useQuery({
    queryKey: ['penalty-followup-alerts'],
    queryFn: async () => {
      // Get overdue schedule items with penalty > 0
      const { data, error } = await supabase
        .from('layaway_schedule')
        .select('*, layaway_accounts!inner(id, invoice_number, currency, status, customer_id, remaining_balance, customers(full_name))')
        .in('layaway_accounts.status', ['active', 'overdue', 'extension_active', 'final_settlement'])
        .in('status', ['pending', 'overdue', 'partially_paid'])
        .gt('penalty_amount', 0)
        .lt('due_date', new Date().toISOString().split('T')[0])
        .order('due_date', { ascending: true })
        .limit(800);

      if (error) throw error;

      // Group by account → pick earliest unpaid penalized installment
      const byAccount = new Map<string, any[]>();
      for (const item of data || []) {
        const acc = (item as any).layaway_accounts;
        if (!acc) continue;
        const list = byAccount.get(acc.id) || [];
        list.push(item);
        byAccount.set(acc.id, list);
      }

      const results: PenaltyAlertItem[] = [];
      for (const [accountId, items] of byAccount.entries()) {
        // Pick the earliest overdue penalized installment
        const sorted = items.sort((a: any, b: any) => a.due_date.localeCompare(b.due_date));
        const item = sorted[0];
        const acc = item.layaway_accounts;
        const overdue = daysOverdueFromToday(item.due_date);
        const stage = classifyPenaltyStage(overdue);
        if (!stage) continue; // <7 days, not yet in penalty follow-up

        // Sum all outstanding penalties for this account
        const totalPenalty = sorted.reduce((s: number, i: any) => s + Number(i.penalty_amount), 0);

        results.push({
          stage,
          customer: acc.customers?.full_name || 'Unknown',
          invoice: acc.invoice_number,
          dueDate: item.due_date,
          daysOverdue: overdue,
          installmentAmount: Number(item.base_installment_amount),
          penaltyAmount: totalPenalty,
          remainingBalance: Number(acc.remaining_balance || 0),
          currency: acc.currency as Currency,
          accountId: acc.id,
          scheduleId: item.id,
          customerId: acc.customer_id,
        });
      }

      return results;
    },
  });

  // Fetch portal tokens for links
  const { data: portalTokens } = useQuery({
    queryKey: ['portal-tokens-active'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('customer_portal_tokens')
        .select('customer_id, token, expires_at')
        .eq('is_active', true)
        .order('created_at', { ascending: false });
      if (error) throw error;
      const map = new Map<string, string>();
      for (const t of data || []) {
        if (map.has(t.customer_id)) continue;
        if (t.expires_at && new Date(t.expires_at) < new Date()) continue;
        map.set(t.customer_id, t.token);
      }
      return map;
    },
  });

  // Enrich alerts with portal tokens
  const enrichedAlerts = useMemo(() => {
    if (!penaltyAlerts) return [];
    return penaltyAlerts.map(a => ({
      ...a,
      portalToken: portalTokens?.get(a.customerId) || null,
    }));
  }, [penaltyAlerts, portalTokens]);

  // Build stage buckets
  const stageBuckets = useMemo(() => {
    const buckets: StageBucket[] = PENALTY_STAGES.map(config => ({
      config,
      count: 0,
      totalPenalties: 0,
      totalBalance: 0,
    }));

    for (const alert of enrichedAlerts) {
      const idx = PENALTY_STAGES.findIndex(s => s.key === alert.stage);
      if (idx >= 0) {
        buckets[idx].count++;
        buckets[idx].totalPenalties += alert.penaltyAmount;
        buckets[idx].totalBalance += alert.remainingBalance;
      }
    }

    return buckets;
  }, [enrichedAlerts]);

  const totalAccounts = enrichedAlerts.length;

  // Filter list by active stage
  const filteredAlerts = useMemo(() => {
    if (!activeStage) return enrichedAlerts;
    return enrichedAlerts.filter(a => a.stage === activeStage);
  }, [enrichedAlerts, activeStage]);

  // Sort by days overdue desc
  const sortedAlerts = useMemo(() => {
    return [...filteredAlerts].sort((a, b) => b.daysOverdue - a.daysOverdue);
  }, [filteredAlerts]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
          {[...Array(8)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
        </div>
      </div>
    );
  }

  if (totalAccounts === 0) return null;

  return (
    <div className="space-y-4">
      {/* Section Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-destructive" />
          <h2 className="text-lg font-bold text-foreground font-display">Penalty Follow-Up Stages</h2>
          <Badge variant="outline" className="text-xs">{totalAccounts} account{totalAccounts !== 1 ? 's' : ''}</Badge>
        </div>
        {activeStage && (
          <Button variant="ghost" size="sm" className="text-xs" onClick={() => setActiveStage(null)}>
            Clear Filter
          </Button>
        )}
      </div>

      {/* Stage Cards Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
        {stageBuckets.map(bucket => {
          const Icon = getStageIcon(bucket.config.key);
          const isActive = activeStage === bucket.config.key;
          return (
            <TooltipProvider key={bucket.config.key}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setActiveStage(isActive ? null : bucket.config.key)}
                    className={`rounded-xl border bg-card p-3 text-center transition-all hover:bg-muted/30 ${
                      isActive
                        ? 'ring-2 ring-primary border-primary'
                        : bucket.count > 0
                          ? bucket.config.borderClass
                          : 'border-border opacity-50'
                    }`}
                  >
                    <div className="flex items-center justify-center mb-1">
                      <div className={`flex h-7 w-7 items-center justify-center rounded-lg ${bucket.config.iconBg}`}>
                        <Icon className={`h-3.5 w-3.5 ${bucket.config.colorClass}`} />
                      </div>
                    </div>
                    <p className={`text-2xl font-bold font-display ${bucket.count > 0 ? bucket.config.colorClass : 'text-muted-foreground'}`}>
                      {bucket.count}
                    </p>
                    <p className="text-[10px] text-muted-foreground font-medium mt-0.5 leading-tight">
                      {bucket.config.key}
                    </p>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs max-w-[200px]">
                  <p className="font-semibold">{bucket.config.label}</p>
                  <p className="text-muted-foreground">{bucket.config.minDays}–{bucket.config.maxDays === Infinity ? '∞' : bucket.config.maxDays} days overdue</p>
                  {bucket.count > 0 && (
                    <>
                      <p className="mt-1">Penalties: ₱{bucket.totalPenalties.toLocaleString()}</p>
                      <p>Tone: {bucket.config.tone}</p>
                    </>
                  )}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          );
        })}
      </div>

      {/* Filtered List */}
      {sortedAlerts.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {activeStage
              ? `${sortedAlerts.length} account${sortedAlerts.length !== 1 ? 's' : ''} in ${getStageConfig(activeStage).label}`
              : `${sortedAlerts.length} account${sortedAlerts.length !== 1 ? 's' : ''} with penalty follow-up`}
          </p>
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Stage</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Customer</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Invoice</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Due Date</th>
                    <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Days</th>
                    <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Installment</th>
                    <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Penalty</th>
                    <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedAlerts.map((alert) => {
                    const cfg = getStageConfig(alert.stage);
                    return (
                      <tr key={`${alert.accountId}-${alert.scheduleId}`} className="border-b border-border/50 last:border-0 hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-2.5">
                          <Badge variant="outline" className={`text-[10px] ${cfg.badgeClass}`}>
                            {cfg.label}
                          </Badge>
                        </td>
                        <td className="px-4 py-2.5">
                          <Link to={`/accounts/${alert.accountId}`} className="font-medium text-card-foreground hover:text-primary transition-colors">
                            {alert.customer}
                          </Link>
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">#{alert.invoice}</td>
                        <td className="px-4 py-2.5 text-muted-foreground">
                          {new Date(alert.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <span className={`font-semibold ${cfg.colorClass}`}>{alert.daysOverdue}d</span>
                        </td>
                        <td className="px-4 py-2.5 text-right text-card-foreground">
                          {formatCurrency(alert.installmentAmount, alert.currency)}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <span className="font-semibold text-destructive">{formatCurrency(alert.penaltyAmount, alert.currency)}</span>
                        </td>
                        <td className="px-4 py-2.5 text-right text-card-foreground">
                          {formatCurrency(alert.remainingBalance, alert.currency)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
