import { useState } from 'react';
import { Scale, CheckCircle, XCircle, Clock, Eye } from 'lucide-react';
import { Link } from 'react-router-dom';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
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
  // joined
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
  };
  requester_profile: { full_name: string } | null;
}

const statusConfig = {
  pending: { icon: Clock, label: 'Pending', className: 'bg-warning/10 text-warning border-warning/20' },
  approved: { icon: CheckCircle, label: 'Approved', className: 'bg-success/10 text-success border-success/20' },
  rejected: { icon: XCircle, label: 'Rejected', className: 'bg-destructive/10 text-destructive border-destructive/20' },
} as const;

type FilterStatus = 'pending' | 'all';

export default function Waivers() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<FilterStatus>('pending');
  const [actionDialog, setActionDialog] = useState<{ waiver: WaiverRow; action: 'approve' | 'reject' } | null>(null);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const { data: waivers, isLoading } = useQuery({
    queryKey: ['waivers-page', filter],
    queryFn: async () => {
      let query = supabase
        .from('penalty_waiver_requests')
        .select('*, layaway_accounts(id, invoice_number, currency, customer_id, customers(full_name)), penalty_fees(id, penalty_stage, penalty_cycle, penalty_amount)')
        .order('created_at', { ascending: false });

      if (filter === 'pending') {
        query = query.eq('status', 'pending');
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as unknown as WaiverRow[];
    },
  });

  const handleAction = async () => {
    if (!actionDialog || !user) return;
    const { waiver, action } = actionDialog;
    setSubmitting(true);

    try {
      if (action === 'approve') {
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

        // 2. Waive the penalty fee
        const { error: penErr } = await supabase
          .from('penalty_fees')
          .update({
            status: 'waived' as any,
            waived_at: new Date().toISOString(),
          })
          .eq('id', waiver.penalty_fee_id);
        if (penErr) throw penErr;

        // 3. Recalculate schedule item penalty_amount and total_due
        const { data: remainingPens } = await supabase
          .from('penalty_fees')
          .select('penalty_amount, status')
          .eq('schedule_id', waiver.schedule_id)
          .in('status', ['unpaid']);
        
        const totalUnpaidPenalty = (remainingPens || []).reduce((s, p) => s + Number(p.penalty_amount), 0);

        const { data: schedItem } = await supabase
          .from('layaway_schedule')
          .select('base_installment_amount')
          .eq('id', waiver.schedule_id)
          .single();

        if (schedItem) {
          await supabase.from('layaway_schedule').update({
            penalty_amount: totalUnpaidPenalty,
            total_due_amount: Number(schedItem.base_installment_amount) + totalUnpaidPenalty,
          }).eq('id', waiver.schedule_id);
        }

        // 4. Recalculate account remaining_balance
        const { data: allSched } = await supabase
          .from('layaway_schedule')
          .select('total_due_amount, paid_amount, status')
          .eq('account_id', waiver.account_id);

        if (allSched) {
          const newRemaining = allSched.reduce((sum, s) => {
            if (s.status === 'paid' || s.status === 'cancelled') return sum;
            return sum + Math.max(0, Number(s.total_due_amount) - Number(s.paid_amount));
          }, 0);
          await supabase.from('layaway_accounts')
            .update({ remaining_balance: newRemaining })
            .eq('id', waiver.account_id);
        }

        // 5. Audit log
        await supabase.from('audit_logs').insert({
          entity_type: 'penalty_waiver',
          entity_id: waiver.id,
          action: 'waiver_approved',
          performed_by_user_id: user.id,
          new_value_json: {
            penalty_fee_id: waiver.penalty_fee_id,
            penalty_amount: waiver.penalty_amount,
            notes: notes.trim() || null,
          },
        });

        toast.success('Waiver approved — penalty removed and balances recalculated');
      } else {
        // Reject
        const { error: waiverErr } = await supabase
          .from('penalty_waiver_requests')
          .update({
            status: 'rejected' as any,
            rejected_at: new Date().toISOString(),
            approved_by_user_id: user.id,
          })
          .eq('id', waiver.id);
        if (waiverErr) throw waiverErr;

        await supabase.from('audit_logs').insert({
          entity_type: 'penalty_waiver',
          entity_id: waiver.id,
          action: 'waiver_rejected',
          performed_by_user_id: user.id,
          new_value_json: { notes: notes.trim() || null },
        });

        toast.success('Waiver rejected — no financial changes applied');
      }

      // Invalidate all relevant queries
      for (const key of MUTATION_INVALIDATION_KEYS) {
        qc.invalidateQueries({ queryKey: [key] });
      }
      qc.invalidateQueries({ queryKey: ['waivers-page'] });
      qc.invalidateQueries({ queryKey: ['waivers'] });

      setActionDialog(null);
      setNotes('');
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
            <p className="text-sm text-muted-foreground mt-1">Review and action pending penalty waiver requests</p>
          </div>
          <div className="flex gap-2">
            <Button
              variant={filter === 'pending' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFilter('pending')}
            >
              <Clock className="h-3.5 w-3.5 mr-1.5" /> Pending
            </Button>
            <Button
              variant={filter === 'all' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFilter('all')}
            >
              All Requests
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
          </div>
        ) : !waivers || waivers.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-12 text-center">
            <Scale className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm font-medium text-card-foreground">
              {filter === 'pending' ? 'No pending waiver requests' : 'No waiver requests found'}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {filter === 'pending' ? 'All requests have been actioned.' : 'No waivers have been submitted yet.'}
            </p>
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="text-left px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wider">Invoice</th>
                    <th className="text-left px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wider">Customer</th>
                    <th className="text-left px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wider">Penalty</th>
                    <th className="text-left px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wider">Amount</th>
                    <th className="text-left px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wider">Reason</th>
                    <th className="text-left px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wider">Requested</th>
                    <th className="text-left px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wider">Status</th>
                    <th className="text-right px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {waivers.map(w => {
                    const acc = w.layaway_accounts;
                    const currency = (acc?.currency || 'PHP') as Currency;
                    const config = statusConfig[w.status as keyof typeof statusConfig] || statusConfig.pending;
                    const StatusIcon = config.icon;
                    const penFee = w.penalty_fees;

                    return (
                      <tr key={w.id} className="hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-3">
                          <span className="font-mono font-semibold text-card-foreground">#{acc?.invoice_number}</span>
                        </td>
                        <td className="px-4 py-3 text-card-foreground">
                          {acc?.customers?.full_name || '—'}
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-xs text-muted-foreground">
                            {penFee ? `${penFee.penalty_stage} · Cycle ${penFee.penalty_cycle}` : 'Penalty'}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-semibold text-destructive tabular-nums">
                          {formatCurrency(Number(w.penalty_amount), currency)}
                        </td>
                        <td className="px-4 py-3 max-w-[200px]">
                          <p className="text-xs text-card-foreground truncate" title={w.reason}>{w.reason}</p>
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                          {new Date(w.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="outline" className={`text-[10px] ${config.className}`}>
                            <StatusIcon className="h-3 w-3 mr-1" />
                            {config.label}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Link to={`/accounts/${w.account_id}`}>
                              <Button variant="ghost" size="icon" className="h-7 w-7" title="View Account">
                                <Eye className="h-3.5 w-3.5" />
                              </Button>
                            </Link>
                            {w.status === 'pending' && (
                              <>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 text-xs border-success/30 text-success hover:bg-success/10"
                                  onClick={() => { setActionDialog({ waiver: w, action: 'approve' }); setNotes(''); }}
                                >
                                  Approve
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 text-xs border-destructive/30 text-destructive hover:bg-destructive/10"
                                  onClick={() => { setActionDialog({ waiver: w, action: 'reject' }); setNotes(''); }}
                                >
                                  Reject
                                </Button>
                              </>
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
        )}
      </div>

      {/* Approve / Reject Dialog */}
      <Dialog open={!!actionDialog} onOpenChange={(open) => { if (!open) setActionDialog(null); }}>
        <DialogContent className="bg-card border-border">
          <DialogHeader>
            <DialogTitle className="font-display text-card-foreground">
              {actionDialog?.action === 'approve' ? 'Approve Waiver' : 'Reject Waiver'}
            </DialogTitle>
            <DialogDescription>
              {actionDialog?.action === 'approve'
                ? 'This will waive the penalty and recalculate the account balance.'
                : 'This will reject the request. No financial changes will be made.'}
            </DialogDescription>
          </DialogHeader>
          {actionDialog && (
            <div className="space-y-3">
              <div className="rounded-lg bg-muted/50 p-3 space-y-1 text-xs">
                <p><span className="text-muted-foreground">Invoice:</span> <span className="font-semibold text-card-foreground">#{actionDialog.waiver.layaway_accounts?.invoice_number}</span></p>
                <p><span className="text-muted-foreground">Penalty:</span> <span className="font-semibold text-destructive">{formatCurrency(Number(actionDialog.waiver.penalty_amount), (actionDialog.waiver.layaway_accounts?.currency || 'PHP') as Currency)}</span></p>
                <p><span className="text-muted-foreground">Reason:</span> <span className="text-card-foreground">{actionDialog.waiver.reason}</span></p>
              </div>
              <div className="space-y-2">
                <Label className="text-card-foreground text-xs">Notes (optional)</Label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={actionDialog.action === 'approve' ? 'Approval notes...' : 'Rejection reason...'}
                  className="bg-background border-border resize-none text-sm"
                  rows={2}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setActionDialog(null)}>Cancel</Button>
            <Button
              onClick={handleAction}
              disabled={submitting}
              className={actionDialog?.action === 'approve'
                ? 'bg-success text-success-foreground hover:bg-success/90'
                : 'bg-destructive text-destructive-foreground hover:bg-destructive/90'}
            >
              {submitting ? 'Processing…' : actionDialog?.action === 'approve' ? 'Confirm Approve' : 'Confirm Reject'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
