import { useState } from 'react';
import { Shield, Clock, CheckCircle, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { formatCurrency } from '@/lib/calculations';
import { Currency, PenaltyWaiver, WaiverStatus } from '@/lib/types';
import { toast } from 'sonner';

interface PenaltyWaiverPanelProps {
  accountId: string;
  invoiceNumber: string;
  currency: Currency;
  penalties: { monthNumber: number; amount: number }[];
}

const statusConfig: Record<WaiverStatus, { icon: typeof Clock; label: string; className: string }> = {
  pending: { icon: Clock, label: 'Pending', className: 'bg-warning/10 text-warning border-warning/20' },
  approved: { icon: CheckCircle, label: 'Approved', className: 'bg-success/10 text-success border-success/20' },
  rejected: { icon: XCircle, label: 'Rejected', className: 'bg-destructive/10 text-destructive border-destructive/20' },
};

export default function PenaltyWaiverPanel({ accountId, invoiceNumber, currency, penalties }: PenaltyWaiverPanelProps) {
  const [waivers, setWaivers] = useState<PenaltyWaiver[]>([]);
  const [requestOpen, setRequestOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [auditLog, setAuditLog] = useState<{ action: string; by: string; at: string; details: string }[]>([]);

  const totalPenalty = penalties.reduce((s, p) => s + p.amount, 0);

  const handleRequestWaiver = () => {
    if (!reason.trim()) {
      toast.error('Please provide a reason for the waiver request');
      return;
    }

    const waiver: PenaltyWaiver = {
      id: `w-${Date.now()}`,
      penalty_id: `pen-${accountId}`,
      requested_by: 'CSR Alice',
      reason: reason.trim(),
      status: 'pending',
      created_at: new Date().toISOString(),
    };

    setWaivers(prev => [...prev, waiver]);
    setAuditLog(prev => [...prev, {
      action: 'Waiver Requested',
      by: 'CSR Alice',
      at: new Date().toISOString(),
      details: `Requested penalty waiver for INV #${invoiceNumber}. Reason: ${reason.trim()}`,
    }]);

    toast.success('Penalty waiver request submitted');
    setReason('');
    setRequestOpen(false);
  };

  const handleReview = (waiverId: string, decision: 'approved' | 'rejected') => {
    setWaivers(prev => prev.map(w =>
      w.id === waiverId
        ? { ...w, status: decision, reviewed_by: 'Admin', reviewed_at: new Date().toISOString() }
        : w
    ));

    setAuditLog(prev => [...prev, {
      action: decision === 'approved' ? 'Waiver Approved' : 'Waiver Rejected',
      by: 'Admin',
      at: new Date().toISOString(),
      details: `Penalty waiver for INV #${invoiceNumber} ${decision}. Total penalty: ${formatCurrency(totalPenalty, currency)}`,
    }]);

    toast.success(`Waiver ${decision}`);
  };

  if (penalties.length === 0) return null;

  return (
    <div className="rounded-xl border border-destructive/20 bg-card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-card-foreground flex items-center gap-2">
          <Shield className="h-4 w-4 text-destructive" /> Penalties & Waivers
        </h3>
        <Dialog open={requestOpen} onOpenChange={setRequestOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm" className="border-destructive/30 text-destructive hover:bg-destructive/10">
              Request Waiver
            </Button>
          </DialogTrigger>
          <DialogContent className="bg-card border-border">
            <DialogHeader>
              <DialogTitle className="font-display text-card-foreground">Request Penalty Waiver</DialogTitle>
              <DialogDescription>
                Total penalties: {formatCurrency(totalPenalty, currency)} on INV #{invoiceNumber}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
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
              {/* Penalty breakdown */}
              <div className="rounded-lg bg-muted/50 p-3 space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground uppercase">Penalty Breakdown</p>
                {penalties.map(p => (
                  <div key={p.monthNumber} className="flex justify-between text-xs text-card-foreground">
                    <span>Month {p.monthNumber}</span>
                    <span className="font-medium text-destructive">{formatCurrency(p.amount, currency)}</span>
                  </div>
                ))}
                <div className="border-t border-border pt-1.5 flex justify-between text-xs font-bold text-card-foreground">
                  <span>Total</span>
                  <span>{formatCurrency(totalPenalty, currency)}</span>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRequestOpen(false)}>Cancel</Button>
              <Button onClick={handleRequestWaiver} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                Submit Request
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Penalty Items */}
      <div className="space-y-2">
        {penalties.map(p => (
          <div key={p.monthNumber} className="flex items-center justify-between p-2 rounded-lg bg-destructive/5 border border-destructive/10">
            <span className="text-xs text-card-foreground">Month {p.monthNumber} Penalty</span>
            <span className="text-xs font-semibold text-destructive tabular-nums">{formatCurrency(p.amount, currency)}</span>
          </div>
        ))}
      </div>

      {/* Waiver Requests */}
      {waivers.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase">Waiver Requests</p>
          {waivers.map(w => {
            const config = statusConfig[w.status];
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
                <p className="text-[10px] text-muted-foreground">Requested by {w.requested_by}</p>
                {w.status === 'pending' && (
                  <div className="flex gap-2 pt-1">
                    <Button size="sm" variant="outline" className="h-7 text-xs border-success/30 text-success hover:bg-success/10"
                      onClick={() => handleReview(w.id, 'approved')}>
                      <CheckCircle className="h-3 w-3 mr-1" /> Approve
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 text-xs border-destructive/30 text-destructive hover:bg-destructive/10"
                      onClick={() => handleReview(w.id, 'rejected')}>
                      <XCircle className="h-3 w-3 mr-1" /> Reject
                    </Button>
                  </div>
                )}
                {w.reviewed_by && (
                  <p className="text-[10px] text-muted-foreground">
                    {w.status === 'approved' ? '✅' : '❌'} Reviewed by {w.reviewed_by} on {new Date(w.reviewed_at!).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Audit Log */}
      {auditLog.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase">Audit Log</p>
          <div className="rounded-lg bg-muted/30 p-3 space-y-2 max-h-40 overflow-y-auto">
            {auditLog.map((entry, i) => (
              <div key={i} className="text-[10px] text-muted-foreground border-b border-border last:border-0 pb-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-card-foreground">{entry.action}</span>
                  <span>{new Date(entry.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <p>{entry.details}</p>
                <p className="text-muted-foreground/70">By: {entry.by}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
