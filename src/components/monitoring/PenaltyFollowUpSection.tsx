import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ShieldAlert, Flame, Skull, MessageCircle,
  CheckCircle, Bell, Copy, Check, Loader2, ExternalLink, Link2, Filter,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { formatCurrency } from '@/lib/calculations';
import { daysOverdueFromToday } from '@/lib/business-rules';
import { toast } from 'sonner';
import type { Currency } from '@/lib/types';

// ── Penalty Stage Definitions ──
export type PenaltyStage = 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7' | 'P8';

const PORTAL_BASE = 'https://chajewelslayaway.web.app';

interface StageConfig {
  key: PenaltyStage;
  label: string;
  shortLabel: string;
  minDays: number;
  maxDays: number;
  colorClass: string;
  borderClass: string;
  badgeClass: string;
  iconBg: string;
  tone: string;
}

const PENALTY_STAGES: StageConfig[] = [
  { key: 'P1', label: 'P1 – 7D After Due',     shortLabel: '7D',     minDays: 7,   maxDays: 13,       colorClass: 'text-amber-600 dark:text-amber-400',  borderClass: 'border-amber-300/40',  badgeClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-300/40',  iconBg: 'bg-amber-100 dark:bg-amber-900/30',  tone: 'Friendly reminder' },
  { key: 'P2', label: 'P2 – 14D After Due',    shortLabel: '14D',    minDays: 14,  maxDays: 29,       colorClass: 'text-amber-700 dark:text-amber-300',  borderClass: 'border-amber-400/40',  badgeClass: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border-amber-400/40',  iconBg: 'bg-amber-100 dark:bg-amber-900/40',  tone: 'Follow-up reminder' },
  { key: 'P3', label: 'P3 – 1M After Due',     shortLabel: '1M',     minDays: 30,  maxDays: 43,       colorClass: 'text-orange-600 dark:text-orange-400', borderClass: 'border-orange-300/40', badgeClass: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400 border-orange-300/40', iconBg: 'bg-orange-100 dark:bg-orange-900/30', tone: 'Strong reminder' },
  { key: 'P4', label: 'P4 – 1M14D After Due',  shortLabel: '1M14D',  minDays: 44,  maxDays: 59,       colorClass: 'text-orange-700 dark:text-orange-300', borderClass: 'border-orange-400/40', badgeClass: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300 border-orange-400/40', iconBg: 'bg-orange-100 dark:bg-orange-900/40', tone: 'Escalation notice' },
  { key: 'P5', label: 'P5 – 2M After Due',     shortLabel: '2M',     minDays: 60,  maxDays: 73,       colorClass: 'text-red-600 dark:text-red-400',       borderClass: 'border-red-300/40',    badgeClass: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-300/40',               iconBg: 'bg-red-100 dark:bg-red-900/30',       tone: 'Urgent reminder' },
  { key: 'P6', label: 'P6 – 2M14D After Due',  shortLabel: '2M14D',  minDays: 74,  maxDays: 89,       colorClass: 'text-red-700 dark:text-red-300',       borderClass: 'border-red-400/40',    badgeClass: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300 border-red-400/40',               iconBg: 'bg-red-100 dark:bg-red-900/40',       tone: 'Final warning' },
  { key: 'P7', label: 'P7 – 3M After Due',     shortLabel: '3M',     minDays: 90,  maxDays: 103,      colorClass: 'text-rose-700 dark:text-rose-300',     borderClass: 'border-rose-500/40',   badgeClass: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300 border-rose-500/40',           iconBg: 'bg-rose-100 dark:bg-rose-900/40',     tone: 'Critical escalation' },
  { key: 'P8', label: 'P8 – 3M14D+ After Due', shortLabel: '3M14D+', minDays: 104, maxDays: Infinity, colorClass: 'text-rose-800 dark:text-rose-200',     borderClass: 'border-rose-600/50',   badgeClass: 'bg-rose-200 text-rose-900 dark:bg-rose-900/60 dark:text-rose-200 border-rose-600/50',           iconBg: 'bg-rose-200 dark:bg-rose-900/60',     tone: 'Pre-forfeit warning' },
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

// ── Branded message templates ──
export function generatePenaltyReminderMessage(
  stage: PenaltyStage,
  customer: string,
  invoice: string,
  dueDate: string,
  installmentAmount: number,
  penaltyAmount: number,
  remainingBalance: number,
  currency: Currency,
  portalToken?: string | null,
): string {
  const dueStr = new Date(dueDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const amtStr = formatCurrency(installmentAmount, currency);
  const penaltyStr = formatCurrency(penaltyAmount, currency);
  const balanceStr = formatCurrency(remainingBalance, currency);
  const portalLink = portalToken
    ? `\n\nYou may view and pay here:\n${PORTAL_BASE}/portal?token=${portalToken}`
    : '';

  const templates: Record<PenaltyStage, string> = {
    P1: `✨ Cha Jewels Payment Reminder\n\nHi Ma'am/Sir ${customer}! 👋\n\nThis is a gentle reminder that your payment for:\n\nINV #${invoice}\nAmount Due: ${amtStr}\nDue Date: ${dueStr}\n\nis now 7 days overdue.\n\nA small penalty has already been applied (${penaltyStr}). We encourage you to settle soon to avoid additional charges.\nRemaining balance: ${balanceStr}${portalLink}\n\nThank you for your continued trust 💛\n— Cha Jewels 💎`,

    P2: `✨ Cha Jewels Follow-Up Reminder\n\nHi Ma'am/Sir ${customer},\n\nYour payment for INV #${invoice} is now 14 days overdue (due ${dueStr}) and penalties are increasing.\n\nAmount Due: ${amtStr}\nOutstanding penalties: ${penaltyStr}\nRemaining balance: ${balanceStr}\n\nWe kindly request your prompt attention to this matter.${portalLink}\n\nThank you! 💛\n— Cha Jewels 💎`,

    P3: `Cha Jewels – Strong Reminder\n\nHi Ma'am/Sir ${customer},\n\nYour layaway payment for INV #${invoice} is now 1 month overdue (due ${dueStr}). Immediate action is advised.\n\nAmount Due: ${amtStr}\nOutstanding penalties: ${penaltyStr}\nRemaining balance: ${balanceStr}\n\nPlease contact us to discuss your payment plan.${portalLink}\n\n— Cha Jewels 💎`,

    P4: `Cha Jewels – Escalation Notice\n\nHi Ma'am/Sir ${customer},\n\nIMPORTANT: Your payment for INV #${invoice} has been overdue for over 6 weeks (due ${dueStr}).\n\nAmount Due: ${amtStr}\nOutstanding penalties: ${penaltyStr}\nRemaining balance: ${balanceStr}\n\nPlease settle immediately to avoid account risk.${portalLink}\n\n— Cha Jewels 💎`,

    P5: `⚠️ Cha Jewels – URGENT Reminder\n\nDear Ma'am/Sir ${customer},\n\nYour layaway payment for INV #${invoice} is now 2 months overdue (due ${dueStr}).\n\nAmount Due: ${amtStr}\nOutstanding penalties: ${penaltyStr}\nRemaining balance: ${balanceStr}\n\nYour account is significantly overdue with penalties. Immediate payment is required.${portalLink}\n\n— Cha Jewels 💎`,

    P6: `⚠️ Cha Jewels – FINAL WARNING\n\nDear Ma'am/Sir ${customer},\n\nThis is your FINAL WARNING regarding INV #${invoice} (due ${dueStr}).\n\nAmount Due: ${amtStr}\nOutstanding penalties: ${penaltyStr}\nRemaining balance: ${balanceStr}\n\nFurther action will be taken if not settled immediately.${portalLink}\n\n— Cha Jewels 💎`,

    P7: `🚨 Cha Jewels – CRITICAL Escalation\n\nDear Ma'am/Sir ${customer},\n\nYour layaway account for INV #${invoice} is 3 months overdue (due ${dueStr}) and at HIGH RISK of forfeiture.\n\nAmount Due: ${amtStr}\nOutstanding penalties: ${penaltyStr}\nRemaining balance: ${balanceStr}\n\nPlease contact us IMMEDIATELY to resolve your account.${portalLink}\n\n— Cha Jewels 💎`,

    P8: `🚨 Cha Jewels – FINAL NOTICE (Pre-Forfeit)\n\nDear Ma'am/Sir ${customer},\n\nYour layaway account for INV #${invoice} has been overdue since ${dueStr} and is SUBJECT FOR FORFEITURE if not settled immediately.\n\nAmount Due: ${amtStr}\nOutstanding penalties: ${penaltyStr}\nRemaining balance: ${balanceStr}\n\nThis is your final notice before permanent account forfeiture.${portalLink}\n\n— Cha Jewels 💎`,
  };

  return templates[stage];
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
  messengerLink?: string | null;
}

interface StageBucket {
  config: StageConfig;
  count: number;
  totalPenalties: number;
  totalBalance: number;
  notified: number;
  pending: number;
}

type PenaltyNotifFilter = 'all' | 'not_notified' | 'notified';

// ── Component ──
export default function PenaltyFollowUpSection() {
  const { user, profile } = useAuth();
  const queryClient = useQueryClient();
  const [activeStage, setActiveStage] = useState<PenaltyStage | null>(null);
  const [notifFilter, setNotifFilter] = useState<PenaltyNotifFilter>('all');
  const [messengerDialog, setMessengerDialog] = useState<{ alert: PenaltyAlertItem; message: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedPortal, setCopiedPortal] = useState(false);
  const [bulkConfirm, setBulkConfirm] = useState<PenaltyStage | null>(null);
  const [bulkSending, setBulkSending] = useState(false);

  // Fetch overdue schedule items with penalties
  const { data: penaltyAlerts, isLoading } = useQuery({
    queryKey: ['penalty-followup-alerts'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('layaway_schedule')
        .select('*, layaway_accounts!inner(id, invoice_number, currency, status, customer_id, remaining_balance, customers(full_name, messenger_link))')
        .in('layaway_accounts.status', ['active', 'overdue', 'extension_active', 'final_settlement'])
        .in('status', ['pending', 'overdue', 'partially_paid'])
        .gt('penalty_amount', 0)
        .lt('due_date', new Date().toISOString().split('T')[0])
        .order('due_date', { ascending: true })
        .limit(800);

      if (error) throw error;

      const byAccount = new Map<string, any[]>();
      for (const item of data || []) {
        const acc = (item as any).layaway_accounts;
        if (!acc) continue;
        const list = byAccount.get(acc.id) || [];
        list.push(item);
        byAccount.set(acc.id, list);
      }

      const results: PenaltyAlertItem[] = [];
      for (const [, items] of byAccount.entries()) {
        const sorted = items.sort((a: any, b: any) => a.due_date.localeCompare(b.due_date));
        const item = sorted[0];
        const acc = item.layaway_accounts;
        const overdue = daysOverdueFromToday(item.due_date);
        const stage = classifyPenaltyStage(overdue);
        if (!stage) continue;

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
          messengerLink: acc.customers?.messenger_link || null,
        });
      }
      return results;
    },
  });

  // Fetch portal tokens
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

  // Fetch penalty-stage CSR notifications
  const { data: penaltyNotifications } = useQuery({
    queryKey: ['csr-notifications-penalty'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('csr_notifications')
        .select('schedule_id, reminder_stage, notified_by_name, notified_at')
        .like('reminder_stage', 'P%');
      if (error) throw error;
      return data;
    },
  });

  // Notification lookup: scheduleId_stage → notif info
  const penaltyNotifMap = useMemo(() => {
    const map = new Map<string, { notified_by_name: string; notified_at: string }>();
    for (const n of penaltyNotifications || []) {
      map.set(`${n.schedule_id}_${n.reminder_stage}`, {
        notified_by_name: n.notified_by_name,
        notified_at: n.notified_at,
      });
    }
    return map;
  }, [penaltyNotifications]);

  // Enrich alerts
  const enrichedAlerts = useMemo(() => {
    if (!penaltyAlerts) return [];
    return penaltyAlerts.map(a => ({
      ...a,
      portalToken: portalTokens?.get(a.customerId) || null,
    }));
  }, [penaltyAlerts, portalTokens]);

  // Build stage buckets with notif counts
  const stageBuckets = useMemo(() => {
    const buckets: StageBucket[] = PENALTY_STAGES.map(config => ({
      config, count: 0, totalPenalties: 0, totalBalance: 0, notified: 0, pending: 0,
    }));

    for (const alert of enrichedAlerts) {
      const idx = PENALTY_STAGES.findIndex(s => s.key === alert.stage);
      if (idx >= 0) {
        buckets[idx].count++;
        buckets[idx].totalPenalties += alert.penaltyAmount;
        buckets[idx].totalBalance += alert.remainingBalance;
        const isNotified = penaltyNotifMap.has(`${alert.scheduleId}_${alert.stage}`);
        if (isNotified) buckets[idx].notified++;
        else buckets[idx].pending++;
      }
    }
    return buckets;
  }, [enrichedAlerts, penaltyNotifMap]);

  const totalAccounts = enrichedAlerts.length;

  // Apply stage + notif filters
  const filteredAlerts = useMemo(() => {
    let list = enrichedAlerts;
    if (activeStage) list = list.filter(a => a.stage === activeStage);
    if (notifFilter !== 'all') {
      list = list.filter(a => {
        const isNotified = penaltyNotifMap.has(`${a.scheduleId}_${a.stage}`);
        return notifFilter === 'notified' ? isNotified : !isNotified;
      });
    }
    return list;
  }, [enrichedAlerts, activeStage, notifFilter, penaltyNotifMap]);

  const sortedAlerts = useMemo(() => {
    return [...filteredAlerts].sort((a, b) => b.daysOverdue - a.daysOverdue);
  }, [filteredAlerts]);

  // ── Notify single account ──
  const handleNotifySingle = async (alert: PenaltyAlertItem) => {
    if (!user) return;
    const staffName = profile?.full_name || user.email || 'Unknown';

    try {
      const { error } = await supabase.from('csr_notifications').insert({
        account_id: alert.accountId,
        schedule_id: alert.scheduleId,
        customer_id: alert.customerId,
        invoice_number: alert.invoice,
        due_date: alert.dueDate,
        reminder_stage: alert.stage,
        notified_by_user_id: user.id,
        notified_by_name: staffName,
      });

      if (error) {
        if (error.code === '23505') {
          toast.info('Already marked as notified for this stage.');
        } else throw error;
      } else {
        await supabase.from('audit_logs').insert({
          entity_type: 'csr_notification',
          entity_id: alert.accountId,
          action: 'CSR_PENALTY_REMINDER_SENT',
          performed_by_user_id: user.id,
          new_value_json: {
            invoice_number: alert.invoice,
            due_date: alert.dueDate,
            reminder_stage: alert.stage,
            notified_by: staffName,
            penalty_amount: alert.penaltyAmount,
          },
        });
        toast.success(`Marked as notified (${alert.stage})`);
      }
      queryClient.invalidateQueries({ queryKey: ['csr-notifications-penalty'] });
    } catch (err: any) {
      toast.error(err.message || 'Failed to record notification');
    }
  };

  // ── Bulk notify all unnotified in a stage ──
  const handleBulkNotify = async (stage: PenaltyStage) => {
    if (!user) return;
    setBulkSending(true);
    const staffName = profile?.full_name || user.email || 'Unknown';
    const targets = enrichedAlerts.filter(a =>
      a.stage === stage && !penaltyNotifMap.has(`${a.scheduleId}_${a.stage}`)
    );

    let success = 0;
    for (const alert of targets) {
      try {
        const { error } = await supabase.from('csr_notifications').insert({
          account_id: alert.accountId,
          schedule_id: alert.scheduleId,
          customer_id: alert.customerId,
          invoice_number: alert.invoice,
          due_date: alert.dueDate,
          reminder_stage: alert.stage,
          notified_by_user_id: user.id,
          notified_by_name: staffName,
        });
        if (!error) {
          await supabase.from('audit_logs').insert({
            entity_type: 'csr_notification',
            entity_id: alert.accountId,
            action: 'CSR_PENALTY_REMINDER_SENT',
            performed_by_user_id: user.id,
            new_value_json: {
              invoice_number: alert.invoice,
              due_date: alert.dueDate,
              reminder_stage: alert.stage,
              notified_by: staffName,
              bulk: true,
            },
          });
          success++;
        }
      } catch { /* skip individual failures */ }
    }

    queryClient.invalidateQueries({ queryKey: ['csr-notifications-penalty'] });
    toast.success(`Marked ${success} of ${targets.length} accounts as notified for ${stage}`);
    setBulkSending(false);
    setBulkConfirm(null);
  };

  // ── Message dialog helpers ──
  const openReminderDialog = (alert: PenaltyAlertItem) => {
    const msg = generatePenaltyReminderMessage(
      alert.stage, alert.customer, alert.invoice, alert.dueDate,
      alert.installmentAmount, alert.penaltyAmount, alert.remainingBalance,
      alert.currency, alert.portalToken,
    );
    setMessengerDialog({ alert, message: msg });
    setCopied(false);
    setCopiedPortal(false);
  };

  const handleCopyMessage = async () => {
    if (!messengerDialog) return;
    try {
      await navigator.clipboard.writeText(messengerDialog.message);
      setCopied(true);
      toast.success('Message copied!');
      setTimeout(() => setCopied(false), 3000);
    } catch { toast.error('Failed to copy'); }
  };

  const handleCopyAndOpenMessenger = async () => {
    if (!messengerDialog) return;
    try {
      await navigator.clipboard.writeText(messengerDialog.message);
      setCopied(true);
      toast.success('Message copied! Opening Messenger...');
      if (messengerDialog.alert.messengerLink) {
        window.open(messengerDialog.alert.messengerLink, '_blank');
      }
    } catch { toast.error('Failed to copy'); }
  };

  const handleCopyPortalLink = async () => {
    if (!messengerDialog?.alert.portalToken) return;
    try {
      await navigator.clipboard.writeText(`${PORTAL_BASE}/portal?token=${messengerDialog.alert.portalToken}`);
      setCopiedPortal(true);
      toast.success('Portal link copied!');
      setTimeout(() => setCopiedPortal(false), 2000);
    } catch { toast.error('Failed to copy'); }
  };

  const handleMarkNotifiedFromDialog = async () => {
    if (!messengerDialog) return;
    await handleNotifySingle(messengerDialog.alert);
    setMessengerDialog(null);
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
          {[...Array(8)].map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
        </div>
      </div>
    );
  }

  if (totalAccounts === 0) return null;

  // Count for bulk confirm
  const bulkStageCount = bulkConfirm
    ? enrichedAlerts.filter(a => a.stage === bulkConfirm && !penaltyNotifMap.has(`${a.scheduleId}_${a.stage}`)).length
    : 0;

  return (
    <div className="space-y-4">
      {/* Section Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-destructive" />
          <h2 className="text-lg font-bold text-foreground font-display">Penalty Follow-Up Stages</h2>
          <Badge variant="outline" className="text-xs">{totalAccounts} account{totalAccounts !== 1 ? 's' : ''}</Badge>
        </div>
        <div className="flex items-center gap-2">
          {activeStage && (
            <Button variant="ghost" size="sm" className="text-xs" onClick={() => { setActiveStage(null); setNotifFilter('all'); }}>
              Clear Filter
            </Button>
          )}
        </div>
      </div>

      {/* Stage Cards Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
        {stageBuckets.map(bucket => {
          const Icon = getStageIcon(bucket.config.key);
          const isActive = activeStage === bucket.config.key;
          return (
            <div key={bucket.config.key} className="flex flex-col gap-1">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => { setActiveStage(isActive ? null : bucket.config.key); setNotifFilter('all'); }}
                      className={`rounded-xl border bg-card p-3 text-center transition-all hover:bg-muted/30 ${
                        isActive
                          ? 'ring-2 ring-primary border-primary'
                          : bucket.count > 0 ? bucket.config.borderClass : 'border-border opacity-50'
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
                      {bucket.count > 0 && (
                        <div className="mt-1.5 flex items-center justify-center gap-1">
                          <span className="text-[9px] font-medium text-success">{bucket.notified} ✓</span>
                          <span className="text-[9px] text-muted-foreground">·</span>
                          <span className="text-[9px] font-medium text-warning">{bucket.pending} ⏳</span>
                        </div>
                      )}
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
              {/* Bulk Notify button under each card */}
              {bucket.pending > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-[10px] h-6 px-2 text-muted-foreground hover:text-primary"
                  onClick={() => setBulkConfirm(bucket.config.key)}
                >
                  <Bell className="h-3 w-3 mr-1" />
                  Notify All
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {/* Notif Filter Tabs */}
      <div className="flex gap-1 rounded-lg border border-border p-1 bg-card w-fit">
        {([
          { key: 'all' as PenaltyNotifFilter, label: 'All' },
          { key: 'not_notified' as PenaltyNotifFilter, label: 'Not Notified' },
          { key: 'notified' as PenaltyNotifFilter, label: 'Notified' },
        ]).map(tab => (
          <button
            key={tab.key}
            onClick={() => setNotifFilter(tab.key)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1 ${
              notifFilter === tab.key
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.key === 'not_notified' && <Filter className="h-3 w-3" />}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Filtered List Table */}
      {sortedAlerts.length > 0 ? (
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
                    <th className="text-left px-3 py-2.5 text-xs font-medium text-muted-foreground">Status</th>
                    <th className="text-left px-3 py-2.5 text-xs font-medium text-muted-foreground">Stage</th>
                    <th className="text-left px-3 py-2.5 text-xs font-medium text-muted-foreground">Customer</th>
                    <th className="text-left px-3 py-2.5 text-xs font-medium text-muted-foreground">Invoice</th>
                    <th className="text-left px-3 py-2.5 text-xs font-medium text-muted-foreground">Due Date</th>
                    <th className="text-right px-3 py-2.5 text-xs font-medium text-muted-foreground">Days</th>
                    <th className="text-right px-3 py-2.5 text-xs font-medium text-muted-foreground">Installment</th>
                    <th className="text-right px-3 py-2.5 text-xs font-medium text-muted-foreground">Penalty</th>
                    <th className="text-right px-3 py-2.5 text-xs font-medium text-muted-foreground">Balance</th>
                    <th className="text-center px-3 py-2.5 text-xs font-medium text-muted-foreground">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedAlerts.map((alert) => {
                    const cfg = getStageConfig(alert.stage);
                    const notifKey = `${alert.scheduleId}_${alert.stage}`;
                    const existingNotif = penaltyNotifMap.get(notifKey);
                    const isNotified = !!existingNotif;

                    return (
                      <tr key={`${alert.accountId}-${alert.scheduleId}`} className="border-b border-border/50 last:border-0 hover:bg-muted/20 transition-colors">
                        {/* Notif status icon */}
                        <td className="px-3 py-2.5 text-center">
                          {isNotified ? (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <CheckCircle className="h-4 w-4 text-success inline-block" />
                                </TooltipTrigger>
                                <TooltipContent side="right" className="text-xs">
                                  <p>Notified by {existingNotif!.notified_by_name}</p>
                                  <p className="text-muted-foreground">
                                    {new Date(existingNotif!.notified_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                                    {' at '}
                                    {new Date(existingNotif!.notified_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                                  </p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          ) : (
                            <span className="inline-block h-2.5 w-2.5 rounded-full bg-warning" />
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <Badge variant="outline" className={`text-[10px] ${cfg.badgeClass}`}>{cfg.label}</Badge>
                        </td>
                        <td className="px-3 py-2.5">
                          <Link to={`/accounts/${alert.accountId}`} className="font-medium text-card-foreground hover:text-primary transition-colors">
                            {alert.customer}
                          </Link>
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground">#{alert.invoice}</td>
                        <td className="px-3 py-2.5 text-muted-foreground">
                          {new Date(alert.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <span className={`font-semibold ${cfg.colorClass}`}>{alert.daysOverdue}d</span>
                        </td>
                        <td className="px-3 py-2.5 text-right text-card-foreground">
                          {formatCurrency(alert.installmentAmount, alert.currency)}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <span className="font-semibold text-destructive">{formatCurrency(alert.penaltyAmount, alert.currency)}</span>
                        </td>
                        <td className="px-3 py-2.5 text-right text-card-foreground">
                          {formatCurrency(alert.remainingBalance, alert.currency)}
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <div className="flex items-center justify-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-info"
                              title="Send Reminder"
                              onClick={() => openReminderDialog(alert)}
                            >
                              <MessageCircle className="h-3.5 w-3.5" />
                            </Button>
                            {!isNotified && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 px-2 text-[10px] gap-1 border-primary/30 text-primary hover:bg-primary/10"
                                onClick={() => handleNotifySingle(alert)}
                              >
                                <Bell className="h-3 w-3" />
                                Notify
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card p-6 text-center">
          <p className="text-sm text-muted-foreground">No accounts matching current filters.</p>
        </div>
      )}

      {/* Messenger/Reminder Dialog */}
      <Dialog open={!!messengerDialog} onOpenChange={(open) => !open && setMessengerDialog(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageCircle className="h-5 w-5 text-info" />
              {messengerDialog?.alert.stage} Penalty Reminder — {messengerDialog?.alert.customer}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {messengerDialog && (
              <Badge variant="outline" className={`text-xs ${getStageConfig(messengerDialog.alert.stage).badgeClass}`}>
                {getStageConfig(messengerDialog.alert.stage).label} · {getStageConfig(messengerDialog.alert.stage).tone}
              </Badge>
            )}
            <div className="rounded-lg border border-border bg-muted/30 p-4 max-h-[300px] overflow-y-auto">
              <pre className="text-sm text-card-foreground whitespace-pre-wrap font-sans leading-relaxed">
                {messengerDialog?.message}
              </pre>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" className="gap-2 text-xs" onClick={handleCopyMessage}>
                {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? 'Copied!' : 'Copy Message'}
              </Button>
              {messengerDialog?.alert.messengerLink && (
                <Button className="gap-2 text-xs" onClick={handleCopyAndOpenMessenger}>
                  <MessageCircle className="h-3.5 w-3.5" />
                  Copy & Open Messenger
                </Button>
              )}
              {messengerDialog?.alert.portalToken && (
                <>
                  <Button variant="outline" className="gap-2 text-xs" onClick={handleCopyPortalLink}>
                    {copiedPortal ? <Check className="h-3.5 w-3.5 text-success" /> : <Link2 className="h-3.5 w-3.5" />}
                    {copiedPortal ? 'Copied!' : 'Copy Portal Link'}
                  </Button>
                  <Button variant="outline" className="gap-2 text-xs" asChild>
                    <a href={`${PORTAL_BASE}/portal?token=${messengerDialog.alert.portalToken}`} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="h-3.5 w-3.5" />
                      Open Portal
                    </a>
                  </Button>
                </>
              )}
            </div>
            {messengerDialog && !penaltyNotifMap.has(`${messengerDialog.alert.scheduleId}_${messengerDialog.alert.stage}`) && (
              <Button
                className="w-full gap-2"
                onClick={handleMarkNotifiedFromDialog}
              >
                <CheckCircle className="h-4 w-4" />
                Mark as Notified ({messengerDialog.alert.stage})
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Bulk Notify Confirmation */}
      <AlertDialog open={!!bulkConfirm} onOpenChange={(open) => !open && setBulkConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Bulk Notify — {bulkConfirm}</AlertDialogTitle>
            <AlertDialogDescription>
              Send reminders to <strong>{bulkStageCount}</strong> unnotified customer{bulkStageCount !== 1 ? 's' : ''} under{' '}
              <strong>{bulkConfirm && getStageConfig(bulkConfirm).label}</strong>?
              <br /><br />
              This will mark all as notified and log each action for audit.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkSending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={bulkSending || bulkStageCount === 0}
              onClick={() => bulkConfirm && handleBulkNotify(bulkConfirm)}
            >
              {bulkSending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              {bulkSending ? 'Sending...' : `Notify ${bulkStageCount} Customer${bulkStageCount !== 1 ? 's' : ''}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
