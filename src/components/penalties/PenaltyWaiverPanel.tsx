import { useState } from 'react';
import { Shield, Clock, CheckCircle, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { toast } from 'sonner';
import { useWaiverRequests } from '@/hooks/use-supabase-data';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useQueryClient } from '@tanstack/react-query';

interface PenaltyItem {
  id: string;
  scheduleId: string;
  amount: number;
  stage: string;
  installmentNumber?: number | null;
}

function monthLabel(n: number | null | undefined): string {
  if (n == null || n === 0) return 'Downpayment';
  return `Month ${n}`;
}

interface PenaltyWaiverPanelProps {
  accountId: string;
  invoiceNumber: string;
  currency: Currency;
  penalties: PenaltyItem[];
}

const statusConfig: Record<string, { icon: typeof Clock; label: string; className: string }> = {
  pending: { icon: Clock, label: 'Pending', className: 'bg-warning/10 text-warning border-warning/20' },
  approved: { icon: CheckCircle, label: 'Approved', className: 'bg-success/10 text-success border-success/20' },
  rejected: { icon: XCircle, label: 'Rejected', className: 'bg-destructive/10 text-destructive border-destructive/20' },
};

export default function PenaltyWaiverPanel({ accountId, invoiceNumber, currency, penalties }: PenaltyWaiverPanelProps) {
  const { data: waivers } = useWaiverRequests(accountId);
  const { user } = useAuth();
  const qc = useQueryClient();
  const [requestOpen, setRequestOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Filter out penalties that already have pending/approved waivers
  const existingWaiverPenaltyIds = new Set(
    (waivers || []).filter(w => w.status === 'pending' || w.status === 'approved').map(w => w.penalty_fee_id)
  );
  const eligiblePenalties = penalties.filter(p => !existingWaiverPenaltyIds.has(p.id));

  const selectedTotal = penalties.filter(p => selectedIds.has(p.id)).reduce((s, p) => s + p.amount, 0);
  const totalPenalty = penalties.reduce((s, p) => s + p.amount, 0);

  const toggleSelection = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const selectAllEligible = () => setSelectedIds(new Set(eligiblePenalties.map(p => p.id)));
  const deselectAll = () => setSelectedIds(new Set());

  const handleOpenDialog = () => {
    selectAllEligible();
    setRequestOpen(true);
  };

  const handleRequestWaiver = async () => {
    if (!reason.trim()) {
      toast.error('Please provide a reason for the waiver request');
      return;
    }
    if (!user || selectedIds.size === 0) {
      toast.error('Please select at least one penalty');
      return;
    }

    setSubmitting(true);
    const selected = penalties.filter(p => selectedIds.has(p.id));
    for (const p of selected) {
      const { error } = await supabase.from('penalty_waiver_requests').insert({
        account_id: accountId,
        schedule_id: p.scheduleId,
        penalty_fee_id: p.id,
        penalty_amount: p.amount,
        requested_by_user_id: user.id,
        reason: reason.trim(),
      });
      if (error) {
        toast.error(error.message);
        setSubmitting(false);
        return;
      }
    }
    qc.invalidateQueries({ queryKey: ['waivers', accountId] });
    qc.invalidateQueries({ queryKey: ['waivers-page'] });
    toast.success(`Waiver request submitted for ${selected.length} penalt${selected.length === 1 ? 'y' : 'ies'}`);
    setReason('');
    setSelectedIds(new Set());
    setRequestOpen(false);
    setSubmitting(false);
  };

  if (penalties.length === 0) return null;

  return (
    <div className="rounded-xl border border-destructive/20 bg-card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-card-foreground flex items-center gap-2">
          <Shield className="h-4 w-4 text-destructive" /> Penalties & Waivers
        </h3>
        {eligiblePenalties.length > 0 && (
          <Dialog open={requestOpen} onOpenChange={setRequestOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="border-destructive/30 text-destructive hover:bg-destructive/10" onClick={handleOpenDialog}>
                Request Waiver
              </Button>
            </DialogTrigger>
            <DialogContent className="bg-card border-border">
              <DialogHeader>
                <DialogTitle className="font-display text-card-foreground">Request Penalty Waiver</DialogTitle>
                <DialogDescription>
                  Select penalties to waive on INV #{invoiceNumber}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">{selectedIds.size} of {eligiblePenalties.length} selected</span>
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={selectAllEligible}>Select All</Button>
                    <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={deselectAll}>Deselect All</Button>
                  </div>
                </div>

                {/* Penalty checkboxes */}
                <div className="rounded-lg border border-border divide-y divide-border max-h-48 overflow-y-auto">
                  {penalties.map(p => {
                    const isEligible = eligiblePenalties.some(e => e.id === p.id);
                    const isSelected = selectedIds.has(p.id);
                    const hasWaiver = existingWaiverPenaltyIds.has(p.id);
                    return (
                      <label
                        key={p.id}
                        className={`flex items-center gap-3 px-3 py-2.5 transition-colors ${isEligible ? (isSelected ? 'bg-primary/5 cursor-pointer' : 'hover:bg-muted/30 cursor-pointer') : 'opacity-50 cursor-not-allowed'}`}
                      >
                        <Checkbox
                          checked={isSelected}
                          disabled={!isEligible}
                          onCheckedChange={() => toggleSelection(p.id)}
                        />
                        <div className="flex-1">
                          <span className="text-xs font-medium text-card-foreground">{p.stage} Penalty</span>
                          {hasWaiver && <Badge variant="outline" className="ml-2 text-[10px] bg-warning/10 text-warning">Waiver Pending</Badge>}
                          <span className="block text-[10px] text-muted-foreground">{monthLabel(p.installmentNumber)}</span>
                        </div>
                        <span className="text-xs font-semibold text-destructive tabular-nums">{formatCurrency(p.amount, currency)}</span>
                      </label>
                    );
                  })}
                </div>

                <div className="rounded-lg bg-muted/50 p-3 flex justify-between text-xs">
                  <span className="text-muted-foreground">Selected total</span>
                  <span className="font-bold text-card-foreground">{formatCurrency(selectedTotal, currency)}</span>
                </div>

                <div className="space-y-2">
                  <Label className="text-card-foreground">Reason for waiver *</Label>
                  <Textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Explain why the penalty should be waived..."
                    className="bg-background border-border resize-none"
                    rows={3}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setRequestOpen(false)}>Cancel</Button>
                <Button onClick={handleRequestWaiver} disabled={submitting || selectedIds.size === 0} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                  {submitting ? 'Submitting…' : `Submit for ${selectedIds.size} Penalt${selectedIds.size === 1 ? 'y' : 'ies'}`}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {/* Penalty Items */}
      <div className="space-y-2">
        {penalties.map(p => (
          <div key={p.id} className="flex items-center justify-between p-2 rounded-lg bg-destructive/5 border border-destructive/10">
            <div>
              <span className="text-xs text-card-foreground">{p.stage} Penalty</span>
              <span className="block text-[10px] text-muted-foreground">{monthLabel(p.installmentNumber)}</span>
            </div>
            <span className="text-xs font-semibold text-destructive tabular-nums">{formatCurrency(p.amount, currency)}</span>
          </div>
        ))}
      </div>

      {/* Waiver Requests */}
      {(waivers || []).length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase">Waiver Requests</p>
          {(waivers || []).map(w => {
            const config = statusConfig[w.status] || statusConfig.pending;
            const StatusIcon = config.icon;
            return (
              <div key={w.id} className="p-3 rounded-lg border border-border space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <StatusIcon className="h-3.5 w-3.5" />
                    <Badge variant="outline" className={`text-[10px] ${config.className}`}>{config.label}</Badge>
                  </div>
                  <span className="text-[10px] text-muted-foreground">
                    {new Date(w.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <p className="text-xs text-card-foreground">{w.reason}</p>
                <p className="text-[10px] text-muted-foreground">
                  Amount: {formatCurrency(Number(w.penalty_amount), currency)}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
