import { useState } from 'react';
import { Scale, CheckCircle, XCircle, Clock, Eye, ChevronDown, ChevronUp } from 'lucide-react';
import { Link } from 'react-router-dom';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MUTATION_INVALIDATION_KEYS } from '@/lib/business-rules';

interface WaiverRow {
  id: string;
  account_id: string;
  schedule_id: string;
  penalty_fee_id: string;
  penalty_amount: number;
  reason: string;
  status: string;
  created_at: string;
  requested_by_user_id: string;
  approved_by_user_id: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  layaway_accounts: {
    id: string;
    invoice_number: string;
    currency: string;
    customer_id: string;
    customers: { full_name: string };
  };
  penalty_fees: {
    id: string;
    penalty_stage: string;
    penalty_cycle: number;
    penalty_amount: number;
    penalty_date: string;
    status: string;
  };
}

const statusConfig = {
  pending: { icon: Clock, label: 'Pending', className: 'bg-warning/10 text-warning border-warning/20' },
  approved: { icon: CheckCircle, label: 'Approved', className: 'bg-success/10 text-success border-success/20' },
  rejected: { icon: XCircle, label: 'Rejected', className: 'bg-destructive/10 text-destructive border-destructive/20' },
} as const;

type FilterStatus = 'pending' | 'all';

// Group waivers by account for batch view
interface WaiverGroup {
  accountId: string;
  invoiceNumber: string;
  customerName: string;
  currency: Currency;
  waivers: WaiverRow[];
  totalAmount: number;
}

function groupWaivers(waivers: WaiverRow[]): WaiverGroup[] {
  const map = new Map<string, WaiverGroup>();
  for (const w of waivers) {
    const acc = w.layaway_accounts;
    const key = w.account_id;
    if (!map.has(key)) {
      map.set(key, {
        accountId: key,
        invoiceNumber: acc?.invoice_number || '—',
        customerName: acc?.customers?.full_name || '—',
        currency: (acc?.currency || 'PHP') as Currency,
        waivers: [],
        totalAmount: 0,
      });
    }
    const group = map.get(key)!;
    group.waivers.push(w);
    group.totalAmount += Number(w.penalty_amount);
  }
  return [...map.values()].sort((a, b) => b.totalAmount - a.totalAmount);
}

export default function Waivers() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<FilterStatus>('pending');
  const [actionDialog, setActionDialog] = useState<{ group: WaiverGroup; action: 'approve' | 'reject' } | null>(null);
  const [selectedWaiverIds, setSelectedWaiverIds] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const { data: waivers, isLoading } = useQuery({
    queryKey: ['waivers-page', filter],
    queryFn: async () => {
      let query = supabase
        .from('penalty_waiver_requests')
        .select('*, layaway_accounts(id, invoice_number, currency, customer_id, customers(full_name)), penalty_fees(id, penalty_stage, penalty_cycle, penalty_amount, penalty_date, status)')
        .order('created_at', { ascending: false });

      if (filter === 'pending') {
        query = query.eq('status', 'pending');
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as unknown as WaiverRow[];
    },
  });

  const groups = groupWaivers(waivers || []);

  const toggleGroup = (accountId: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      next.has(accountId) ? next.delete(accountId) : next.add(accountId);
      return next;
    });
  };

  const openActionDialog = (group: WaiverGroup, action: 'approve' | 'reject') => {
    const pendingWaivers = group.waivers.filter(w => w.status === 'pending');
    // Only select waivers whose penalty is still unpaid (not already waived)
    const eligible = pendingWaivers.filter(w => w.penalty_fees?.status === 'unpaid');
    setSelectedWaiverIds(new Set(eligible.map(w => w.id)));
    setActionDialog({ group, action });
    setNotes('');
  };

  const toggleWaiverSelection = (id: string) => {
    setSelectedWaiverIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (!actionDialog) return;
    const eligible = actionDialog.group.waivers.filter(w => w.status === 'pending' && w.penalty_fees?.status === 'unpaid');
    setSelectedWaiverIds(new Set(eligible.map(w => w.id)));
  };

  const deselectAll = () => setSelectedWaiverIds(new Set());

  const selectedTotal = actionDialog
    ? actionDialog.group.waivers
        .filter(w => selectedWaiverIds.has(w.id))
        .reduce((s, w) => s + Number(w.penalty_amount), 0)
    : 0;

  const handleAction = async () => {
    if (!actionDialog || !user || selectedWaiverIds.size === 0) return;
    const { group, action } = actionDialog;
    setSubmitting(true);

    try {
      const selectedWaivers = group.waivers.filter(w => selectedWaiverIds.has(w.id));

      if (action === 'approve') {
        for (const waiver of selectedWaivers) {
          // 1. Update waiver status
          const { error: waiverErr } = await supabase
            .from('penalty_waiver_requests')
            .update({
              status: 'approved' as any,
              approved_by_user_id: user.id,
              approved_at: new Date().toISOString(),
            })
            .eq('id', waiver.id);
          if (waiverErr) throw waiverErr;

          // 2. Waive the penalty fee (only if still unpaid)
          if (waiver.penalty_fees?.status === 'unpaid') {
            const { error: penErr } = await supabase
              .from('penalty_fees')
              .update({
                status: 'waived' as any,
                waived_at: new Date().toISOString(),
              })
              .eq('id', waiver.penalty_fee_id)
              .eq('status', 'unpaid'); // safety: only waive if still unpaid
            if (penErr) throw penErr;
          }
        }

        // 3. Recalculate affected schedule items
        const affectedScheduleIds = [...new Set(selectedWaivers.map(w => w.schedule_id))];
        for (const schedId of affectedScheduleIds) {
          // Include paid + unpaid (all non-waived) so penalty_amount stays consistent
          // with activePenaltyTotal (which counts paid + unpaid, excludes waived)
          const { data: remainingPens } = await supabase
            .from('penalty_fees')
            .select('penalty_amount')
            .eq('schedule_id', schedId)
            .not('status', 'eq', 'waived');

          const totalActivePenalty = (remainingPens || []).reduce((s, p) => s + Number(p.penalty_amount), 0);

          const { data: schedItem } = await supabase
            .from('layaway_schedule')
            .select('base_installment_amount')
            .eq('id', schedId)
            .single();

          if (schedItem) {
            await supabase.from('layaway_schedule').update({
              penalty_amount: totalActivePenalty,
              total_due_amount: Number(schedItem.base_installment_amount) + totalActivePenalty,
            }).eq('id', schedId);
          }
        }

        // 4. Recalculate account remaining_balance:
        //    remaining = principal + activePenalties (non-waived) + services - totalPaid
        const [{ data: accountData }, { data: activePens }, { data: accountSvcs }] = await Promise.all([
          supabase.from('layaway_accounts').select('total_amount, total_paid').eq('id', group.accountId).single(),
          supabase.from('penalty_fees').select('penalty_amount').eq('account_id', group.accountId).not('status', 'eq', 'waived'),
          supabase.from('account_services').select('amount').eq('account_id', group.accountId),
        ]);

        if (accountData) {
          const activePenaltySum = (activePens || []).reduce((s: number, p: any) => s + Number(p.penalty_amount), 0);
          const servicesSum = (accountSvcs || []).reduce((s: number, sv: any) => s + Number(sv.amount), 0);
          const newRemaining = Math.max(0, Number(accountData.total_amount) + activePenaltySum + servicesSum - Number(accountData.total_paid));
          await supabase.from('layaway_accounts')
            .update({ remaining_balance: newRemaining })
            .eq('id', group.accountId);
        }

        // 5. Audit log with full penalty breakdown
        await supabase.from('audit_logs').insert({
          entity_type: 'penalty_waiver',
          entity_id: group.accountId,
          action: 'batch_waiver_approved',
          performed_by_user_id: user.id,
          new_value_json: {
            waiver_ids: selectedWaivers.map(w => w.id),
            penalty_fee_ids: selectedWaivers.map(w => w.penalty_fee_id),
            penalties_waived: selectedWaivers.map(w => ({
              penalty_fee_id: w.penalty_fee_id,
              stage: w.penalty_fees?.penalty_stage,
              cycle: w.penalty_fees?.penalty_cycle,
              amount: w.penalty_amount,
            })),
            total_waived: selectedTotal,
            notes: notes.trim() || null,
          },
        });

        toast.success(`${selectedWaivers.length} penalty waiver(s) approved — balances recalculated`);
      } else {
        // Reject selected waivers
        for (const waiver of selectedWaivers) {
          const { error: waiverErr } = await supabase
            .from('penalty_waiver_requests')
            .update({
              status: 'rejected' as any,
              rejected_at: new Date().toISOString(),
              approved_by_user_id: user.id,
            })
            .eq('id', waiver.id);
          if (waiverErr) throw waiverErr;
        }

        await supabase.from('audit_logs').insert({
          entity_type: 'penalty_waiver',
          entity_id: group.accountId,
          action: 'batch_waiver_rejected',
          performed_by_user_id: user.id,
          new_value_json: {
            waiver_ids: selectedWaivers.map(w => w.id),
            count: selectedWaivers.length,
            notes: notes.trim() || null,
          },
        });

        toast.success(`${selectedWaivers.length} waiver(s) rejected — no financial changes`);
      }

      for (const key of MUTATION_INVALIDATION_KEYS) {
        qc.invalidateQueries({ queryKey: [key] });
      }
      qc.invalidateQueries({ queryKey: ['waivers-page'] });

      setActionDialog(null);
      setNotes('');
      setSelectedWaiverIds(new Set());
    } catch (err: any) {
      toast.error(err.message || 'Action failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-primary uppercase tracking-widest mb-1">Operations</p>
            <h1 className="text-2xl font-bold text-foreground font-display">Waiver Requests</h1>
            <p className="text-sm text-muted-foreground mt-1">Review and action pending penalty waiver requests with selective penalty control</p>
          </div>
          <div className="flex gap-2">
            <Button variant={filter === 'pending' ? 'default' : 'outline'} size="sm" onClick={() => setFilter('pending')}>
              <Clock className="h-3.5 w-3.5 mr-1.5" /> Pending
            </Button>
            <Button variant={filter === 'all' ? 'default' : 'outline'} size="sm" onClick={() => setFilter('all')}>
              All Requests
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-3">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
        ) : groups.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-12 text-center">
            <Scale className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm font-medium text-card-foreground">
              {filter === 'pending' ? 'No pending waiver requests' : 'No waiver requests found'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {groups.map(group => {
              const isExpanded = expandedGroups.has(group.accountId);
              const pendingCount = group.waivers.filter(w => w.status === 'pending').length;
              return (
                <div key={group.accountId} className="rounded-xl border border-border bg-card overflow-hidden">
                  {/* Group Header */}
                  <div
                    className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-muted/20 transition-colors"
                    onClick={() => toggleGroup(group.accountId)}
                  >
                    <div className="flex items-center gap-3">
                      {isExpanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-semibold text-card-foreground">#{group.invoiceNumber}</span>
                          <span className="text-sm text-card-foreground">{group.customerName}</span>
                          <Badge variant="outline" className="text-[10px]">{group.waivers.length} penalt{group.waivers.length === 1 ? 'y' : 'ies'}</Badge>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-bold text-destructive tabular-nums">
                        {formatCurrency(group.totalAmount, group.currency)}
                      </span>
                      {pendingCount > 0 && (
                        <div className="flex gap-1">
                          <Button variant="outline" size="sm" className="h-7 text-xs border-success/30 text-success hover:bg-success/10"
                            onClick={e => { e.stopPropagation(); openActionDialog(group, 'approve'); }}>
                            Approve
                          </Button>
                          <Button variant="outline" size="sm" className="h-7 text-xs border-destructive/30 text-destructive hover:bg-destructive/10"
                            onClick={e => { e.stopPropagation(); openActionDialog(group, 'reject'); }}>
                            Reject
                          </Button>
                          <Link to={`/accounts/${group.accountId}`} onClick={e => e.stopPropagation()}>
                            <Button variant="ghost" size="icon" className="h-7 w-7" title="View Account">
                              <Eye className="h-3.5 w-3.5" />
                            </Button>
                          </Link>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Expanded Penalty Breakdown */}
                  {isExpanded && (
                    <div className="border-t border-border">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-muted/30">
                            <th className="text-left px-4 py-2 text-xs font-semibold text-muted-foreground uppercase">Stage</th>
                            <th className="text-left px-4 py-2 text-xs font-semibold text-muted-foreground uppercase">Cycle</th>
                            <th className="text-left px-4 py-2 text-xs font-semibold text-muted-foreground uppercase">Date Applied</th>
                            <th className="text-left px-4 py-2 text-xs font-semibold text-muted-foreground uppercase">Amount</th>
                            <th className="text-left px-4 py-2 text-xs font-semibold text-muted-foreground uppercase">Penalty Status</th>
                            <th className="text-left px-4 py-2 text-xs font-semibold text-muted-foreground uppercase">Waiver Status</th>
                            <th className="text-left px-4 py-2 text-xs font-semibold text-muted-foreground uppercase">Reason</th>
                            <th className="text-left px-4 py-2 text-xs font-semibold text-muted-foreground uppercase">Requested</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {group.waivers.map(w => {
                            const pen = w.penalty_fees;
                            const config = statusConfig[w.status as keyof typeof statusConfig] || statusConfig.pending;
                            const StatusIcon = config.icon;
                            return (
                              <tr key={w.id} className="hover:bg-muted/10">
                                <td className="px-4 py-2 text-card-foreground">{pen?.penalty_stage || '—'}</td>
                                <td className="px-4 py-2 text-card-foreground">{pen?.penalty_cycle || '—'}</td>
                                <td className="px-4 py-2 text-muted-foreground text-xs">{pen?.penalty_date ? new Date(pen.penalty_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</td>
                                <td className="px-4 py-2 font-semibold text-destructive tabular-nums">{formatCurrency(Number(w.penalty_amount), group.currency)}</td>
                                <td className="px-4 py-2">
                                  <Badge variant="outline" className={`text-[10px] ${pen?.status === 'waived' ? 'bg-muted text-muted-foreground' : pen?.status === 'paid' ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive'}`}>
                                    {pen?.status || 'unknown'}
                                  </Badge>
                                </td>
                                <td className="px-4 py-2">
                                  <Badge variant="outline" className={`text-[10px] ${config.className}`}>
                                    <StatusIcon className="h-3 w-3 mr-1" />{config.label}
                                  </Badge>
                                </td>
                                <td className="px-4 py-2 max-w-[180px]">
                                  <p className="text-xs text-card-foreground truncate" title={w.reason}>{w.reason}</p>
                                </td>
                                <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap">
                                  {new Date(w.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Selective Approve/Reject Dialog */}
      <Dialog open={!!actionDialog} onOpenChange={open => { if (!open) { setActionDialog(null); setSelectedWaiverIds(new Set()); } }}>
        <DialogContent className="bg-card border-border max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-display text-card-foreground">
              {actionDialog?.action === 'approve' ? 'Approve Selected Penalties' : 'Reject Selected Waivers'}
            </DialogTitle>
            <DialogDescription>
              {actionDialog?.action === 'approve'
                ? 'Select which penalties to waive. Only selected penalties will be removed.'
                : 'Select which waiver requests to reject.'}
            </DialogDescription>
          </DialogHeader>
          {actionDialog && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  INV #{actionDialog.group.invoiceNumber} · {actionDialog.group.customerName}
                </p>
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={selectAll}>Select All</Button>
                  <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={deselectAll}>Deselect All</Button>
                </div>
              </div>

              {/* Penalty selection checkboxes */}
              <div className="rounded-lg border border-border divide-y divide-border max-h-60 overflow-y-auto">
                {actionDialog.group.waivers
                  .filter(w => w.status === 'pending')
                  .map(w => {
                    const pen = w.penalty_fees;
                    const isSelected = selectedWaiverIds.has(w.id);
                    const isAlreadyWaived = pen?.status === 'waived';
                    return (
                      <label
                        key={w.id}
                        className={`flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors ${isSelected ? 'bg-primary/5' : 'hover:bg-muted/30'} ${isAlreadyWaived ? 'opacity-50 cursor-not-allowed' : ''}`}
                      >
                        <Checkbox
                          checked={isSelected}
                          disabled={isAlreadyWaived}
                          onCheckedChange={() => toggleWaiverSelection(w.id)}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-card-foreground">{pen?.penalty_stage} · Cycle {pen?.penalty_cycle}</span>
                            {isAlreadyWaived && <Badge variant="outline" className="text-[10px] bg-muted text-muted-foreground">Already Waived</Badge>}
                          </div>
                          <span className="text-[10px] text-muted-foreground">
                            Applied {pen?.penalty_date ? new Date(pen.penalty_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
                          </span>
                        </div>
                        <span className="text-xs font-bold text-destructive tabular-nums">
                          {formatCurrency(Number(w.penalty_amount), actionDialog.group.currency)}
                        </span>
                      </label>
                    );
                  })}
              </div>

              {/* Summary */}
              <div className="rounded-lg bg-muted/50 p-3 flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {selectedWaiverIds.size} of {actionDialog.group.waivers.filter(w => w.status === 'pending').length} selected
                </span>
                <span className="text-sm font-bold text-card-foreground">
                  {actionDialog.action === 'approve' ? 'Waive' : 'Reject'}: {formatCurrency(selectedTotal, actionDialog.group.currency)}
                </span>
              </div>

              <div className="space-y-2">
                <Label className="text-card-foreground text-xs">Notes (optional)</Label>
                <Textarea
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder={actionDialog.action === 'approve' ? 'Approval notes...' : 'Rejection reason...'}
                  className="bg-background border-border resize-none text-sm"
                  rows={2}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setActionDialog(null); setSelectedWaiverIds(new Set()); }}>Cancel</Button>
            <Button
              onClick={handleAction}
              disabled={submitting || selectedWaiverIds.size === 0}
              className={actionDialog?.action === 'approve'
                ? 'bg-success text-success-foreground hover:bg-success/90'
                : 'bg-destructive text-destructive-foreground hover:bg-destructive/90'}
            >
              {submitting ? 'Processing…' : `${actionDialog?.action === 'approve' ? 'Approve' : 'Reject'} ${selectedWaiverIds.size} Selected`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
