import { useState, useEffect, useMemo, useCallback, useRef, memo, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Database } from '@/integrations/supabase/types';
import { getProofSignedUrl } from '@/lib/proof-url';
import { useAuth } from '@/contexts/AuthContext';
import AppLayout from '@/components/layout/AppLayout';

const EmbeddedWrapper = ({ children }: { children: ReactNode }) => <>{children}</>;
import RefreshControl from '@/components/common/RefreshControl';
import { useAutoRefresh } from '@/hooks/use-auto-refresh';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription,
} from '@/components/ui/alert-dialog';
import {
  AlertTriangle, Check, ChevronRight, CreditCard, ExternalLink,
  Filter, Image as ImageIcon, Loader2, MessageSquare, Pencil, RotateCcw, X, XCircle, FileText,
} from 'lucide-react';
import { toast } from 'sonner';
import { formatCurrency } from '@/lib/calculations';
import { methodLabel, normalizeMethod } from '@/lib/payment-method-registry';
import { Link } from 'react-router-dom';
import { usePermissions } from '@/contexts/PermissionsContext';
import SubmissionsSearchBar from '@/components/search/SubmissionsSearchBar';
import {
  computeWaterfall, getRowStatus, isRowPaid, getRowRemaining,
  type ScheduleViewRow, type WaterfallResult,
} from '@/lib/business-rules';
import StatusPill from '@/components/shared/StatusPill';
import { SUBMISSION_STATUS_TONE } from '@/components/shared/status-tone';
import IllustratedState, { LedgerIllustration } from '@/components/shared/LedgerIllustration';
import DecoDialogHeader, { decoTitleClass } from '@/components/shared/DecoDialogHeader';
import DataTable, { type DataTableColumn } from '@/components/data-table/DataTable';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

type SubmissionStatus = 'submitted' | 'under_review' | 'confirmed' | 'rejected' | 'needs_clarification' | 'cancelled';

interface SubmissionRow {
  id: string;
  customer_id: string;
  account_id: string | null;
  cash_order_id: string | null;
  submitted_amount: number;
  payment_date: string;
  payment_method: string;
  reference_number: string | null;
  sender_name: string | null;
  notes: string | null;
  proof_url: string | null;
  status: SubmissionStatus;
  reviewer_user_id: string | null;
  reviewer_notes: string | null;
  confirmed_payment_id: string | null;
  portal_token: string | null;
  submission_type: string | null;
  created_at: string;
  updated_at: string;
  customer_edited_at: string | null;
  customers: { full_name: string; customer_code: string } | null;
  layaway_accounts: { invoice_number: string; currency: string; remaining_balance: number; total_amount: number } | null;
  cash_orders: { invoice_number: string; currency: string; customer_id: string; customers: { full_name: string; customer_code: string } | null } | null;
}

interface SubmissionAllocation {
  id: string;
  submission_id: string;
  account_id: string;
  invoice_number: string;
  allocated_amount: number;
}

/** Renders a proof-of-payment image via a short-lived signed URL.
 *  The payment-proofs bucket is PRIVATE — all reads must go through
 *  Storage's signed-URL API (RLS-gated by the SELECT policy). */
function ProofImage({ url, className, compact = false }: { url: string; className?: string; compact?: boolean }) {
  const [imgError, setImgError] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setImgError(false);
    setSrc(null);
    getProofSignedUrl(url).then((u) => {
      if (!active) return;
      if (u) setSrc(u);
      else setImgError(true);
    });
    return () => { active = false; };
  }, [url]);

  if (imgError) {
    if (compact) {
      return (
        <span title="Proof unavailable" className="flex h-full w-full items-center justify-center text-muted-foreground">
          <ImageIcon className="h-4 w-4" />
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <ImageIcon className="h-3.5 w-3.5" /> Proof unavailable
      </span>
    );
  }
  if (!src) {
    if (compact) return <span aria-label="Loading proof…" className="block h-full w-full animate-pulse bg-muted/60" />;
    return <span className="text-xs text-muted-foreground">Loading proof…</span>;
  }
  return (
    <img src={src} alt="Proof of payment" className={className}
      onError={() => setImgError(true)} />
  );
}

// Labels are unchanged; colour now comes from the shared StatusPill tones
// (SUBMISSION_STATUS_TONE). Unknown statuses fall back to Submitted, as before.
const statusConfig: Record<string, { label: string }> = {
  submitted: { label: 'Submitted' },
  under_review: { label: 'Under Review' },
  confirmed: { label: 'Confirmed' },
  rejected: { label: 'Rejected' },
  needs_clarification: { label: 'Needs Clarification' },
};
const statusTone = (status: string) => SUBMISSION_STATUS_TONE[statusConfig[status] ? status : 'submitted'] ?? 'info';

/** A proof is present when proof_url is a non-blank string (unchanged rule). */
const hasProof = (url: string | null): url is string => !!url && url.trim().length > 0;
const isPdf = (url: string) => /\.pdf$/i.test(url);
const proofFileName = (url: string) => decodeURIComponent(url.split('/').pop() || 'proof.pdf').split('?')[0];

/** Surface shared by the three hand-rolled review modals (they layer above
 *  each other at z 9998/9999, so they are not Radix dialogs). */
const MODAL_PANEL = 'ui-dialog-panel fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[calc(100%-2rem)] max-w-md border border-gold-500/20 rounded-xl p-6 bg-background text-foreground';

// ─────────────────────────────────────────────────────────────────────────────
// ActionDialogModal
// Extracted so `reviewerNotes` state lives LOCAL to this modal instead of in
// PaymentSubmissions. Typing no longer re-renders the 1,300-line list parent;
// only this small component re-renders on each keystroke. The modal mounts on
// open (actionDialog truthy) and unmounts on close, so state resets naturally.
// ─────────────────────────────────────────────────────────────────────────────
interface ActionDialogModalProps {
  actionDialog: { sub: SubmissionRow; action: string };
  confirmLoadingSchedule: boolean;
  confirmWaterfall: WaterfallResult | null;
  confirmScheduleRows: ScheduleViewRow[];
  confirmPartialRow: { scheduleId: string; row: ScheduleViewRow; shortfall: number } | null;
  isPending: boolean;
  setProofDialog: (url: string | null, trigger?: HTMLElement | null) => void;
  onCancel: () => void;
  onSubmit: (notes: string) => void;
}

const ActionDialogModal = memo(function ActionDialogModal({
  actionDialog,
  confirmLoadingSchedule,
  confirmWaterfall,
  confirmScheduleRows,
  confirmPartialRow,
  isPending,
  setProofDialog,
  onCancel,
  onSubmit,
}: ActionDialogModalProps) {
  const [reviewerNotes, setReviewerNotes] = useState('');
  const isCashSub = !!actionDialog.sub.cash_order_id;
  const cur = (
    (isCashSub ? actionDialog.sub.cash_orders?.currency : actionDialog.sub.layaway_accounts?.currency) || 'PHP'
  ) as 'PHP' | 'JPY';

  return (
    <>
      <div
        className="fixed inset-0 bg-black/60"
        style={{ zIndex: 9998, pointerEvents: 'auto' }}
        onClick={onCancel}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="submission-action-title"
        className={cn(MODAL_PANEL, 'max-h-[85vh] overflow-y-auto')}
        style={{ zIndex: 9999, pointerEvents: 'auto' }}
      >
        <DecoDialogHeader
          className="mb-4"
          icon={actionDialog.action === 'confirmed' ? <Check /> :
                actionDialog.action === 'rejected' ? <XCircle /> :
                actionDialog.action === 'restore' ? <RotateCcw /> :
                <MessageSquare />}
          title={
          <h2 id="submission-action-title" className={decoTitleClass}>
            {actionDialog.action === 'confirmed' ? 'Confirm Payment' :
             actionDialog.action === 'rejected' ? 'Reject Submission' :
             actionDialog.action === 'restore' ? 'Restore Submission' :
             'Request Clarification'}
          </h2>}
          description={
          <p className="text-sm text-muted-foreground">
            {actionDialog.action === 'confirmed'
              ? `This will create a confirmed payment of ${formatCurrency(actionDialog.sub.submitted_amount, cur)} and update the account balance.`
              : actionDialog.action === 'rejected'
              ? 'This submission will be marked as rejected. The customer will see your reason.'
              : actionDialog.action === 'restore'
              ? 'This will return the submission to the queue for re-review. The original rejection reason is preserved as history.'
              : 'Send a message to the customer requesting more information.'}
          </p>}
        />

        <div className="space-y-3">
          {/* Proof preview — always shown regardless of status */}
          {(actionDialog.sub.proof_url && actionDialog.sub.proof_url.trim().length > 0) ? (
            <div className="rounded-lg border border-gold-500/15 bg-surface-1/60 p-2.5 space-y-1.5">
              <p className="label-caps text-[10px] text-ink-muted">Proof of Payment</p>
              {actionDialog.sub.proof_url.match(/\.pdf$/i) ? (
                <div className="flex items-center gap-2 rounded border border-primary/20 bg-primary/5 p-2">
                  <FileText className="h-4 w-4 text-primary shrink-0" />
                  <span className="text-xs text-foreground truncate flex-1" title={actionDialog.sub.proof_url.split('/').pop()}>
                    {decodeURIComponent(actionDialog.sub.proof_url.split('/').pop() || 'proof.pdf').split('?')[0]}
                  </span>
                  <a
                    href={actionDialog.sub.proof_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] text-primary underline whitespace-nowrap">
                    View Proof
                  </a>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    aria-label="Proof of payment — view full size"
                    onClick={(e) => setProofDialog(actionDialog.sub.proof_url!, e.currentTarget)}
                    className="block w-full text-left">
                    <ProofImage
                      url={actionDialog.sub.proof_url}
                      className="w-full max-h-40 object-cover rounded border border-[hsl(var(--border))] hover:opacity-90 transition-opacity cursor-zoom-in" />
                  </button>
                  <button
                    type="button"
                    onClick={() => window.open(actionDialog.sub.proof_url!, '_blank', 'noopener,noreferrer')}
                    className="text-[10px] text-primary underline inline-flex items-center gap-1">
                    <ImageIcon className="h-3 w-3" /> View Proof
                  </button>
                </>
              )}
            </div>
          ) : (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2">
              <p className="text-xs text-destructive italic font-medium">No proof attached</p>
            </div>
          )}

          {/* Waterfall breakdown for confirm action */}
          {actionDialog.action === 'confirmed' && (() => {
            if (confirmLoadingSchedule) {
              return (
                <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading allocation preview…
                </div>
              );
            }
            if (confirmWaterfall?.valid && confirmWaterfall.allocations.length > 0) {
              return (
                <div className="rounded-lg border border-gold-500/15 bg-surface-1/60 p-2.5">
                  <p className="label-caps text-[10px] text-ink-muted mb-1.5">Allocation breakdown</p>
                  {confirmWaterfall.allocations.map((alloc) => {
                    const row = confirmScheduleRows.find(r => r.id === alloc.scheduleId);
                    if (!row) return null;
                    const rowTotal = Number(row.base_installment_amount) + Number(row.penalty_amount || 0) + Number(row.carried_amount || 0);
                    const newAllocated = (Number(row.allocated) || 0) + alloc.amount;
                    const isPaidAfter = newAllocated >= rowTotal - 0.01;
                    const dateLabel = new Date(row.due_date + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                    return (
                      <div key={alloc.scheduleId} className="flex items-center gap-2 text-[11px] py-0.5 flex-wrap">
                        <span className="text-muted-foreground">Month {row.installment_number}</span>
                        <span className="text-muted-foreground">{dateLabel}</span>
                        <span className="font-medium text-foreground tabular-nums">{formatCurrency(alloc.amount, cur)}</span>
                        <span className="text-muted-foreground">→</span>
                        {isPaidAfter ? (
                          <StatusPill label="Paid" tone="success" />
                        ) : (
                          <StatusPill label="Partial" tone="warning" />
                        )}
                      </div>
                    );
                  })}
                  {(() => {
                    const lastAlloc = confirmWaterfall.allocations[confirmWaterfall.allocations.length - 1];
                    const lastRow = confirmScheduleRows.find(r => r.id === lastAlloc?.scheduleId);
                    if (!lastRow) return null;
                    const rowTotal = Number(lastRow.base_installment_amount) + Number(lastRow.penalty_amount || 0) + Number(lastRow.carried_amount || 0);
                    const newAllocated = (Number(lastRow.allocated) || 0) + lastAlloc.amount;
                    const remainAfter = Math.max(0, rowTotal - newAllocated);
                    if (remainAfter > 0.01) {
                      return (
                        <p className="text-[10px] text-muted-foreground mt-1">
                          Remaining after: {formatCurrency(remainAfter, cur)}
                        </p>
                      );
                    }
                    return null;
                  })()}
                  {confirmPartialRow && (
                    <p className="text-[10px] text-warning mt-1.5">
                      ⚠️ Underpayment of {formatCurrency(confirmPartialRow.shortfall, cur)} — you'll choose how to handle it after confirming.
                    </p>
                  )}
                </div>
              );
            }
            if (confirmWaterfall && !confirmWaterfall.valid) {
              return (
                <div className="p-2 rounded-md bg-destructive/10 border border-destructive/20 text-xs text-destructive">
                  ⚠️ {confirmWaterfall.error}
                </div>
              );
            }
            return null;
          })()}

          <div>
            <label className="text-xs font-medium text-foreground">
              {actionDialog.action === 'confirmed' || actionDialog.action === 'restore' ? 'Note (optional)' : 'Reason / Message *'}
            </label>
            <Textarea
              value={reviewerNotes}
              onChange={(e) => setReviewerNotes(e.target.value)}
              placeholder={
                actionDialog.action === 'confirmed' ? 'Optional note...' :
                actionDialog.action === 'rejected' ? 'Reason for rejection...' :
                actionDialog.action === 'restore' ? 'Optional restore reason...' :
                'What information do you need?'
              }
              rows={3}
              className="mt-1.5"
            />
          </div>
        </div>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end mt-5 pt-4 hairline-t">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button
            variant={actionDialog.action === 'rejected' ? 'destructive' : 'default'}
            disabled={isPending || (actionDialog.action !== 'confirmed' && actionDialog.action !== 'restore' && !reviewerNotes.trim()) || (actionDialog.action === 'confirmed' && (!actionDialog.sub.proof_url || actionDialog.sub.proof_url.trim().length === 0))}
            onClick={() => onSubmit(reviewerNotes)}
          >
            {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            {actionDialog.action === 'confirmed' ? 'Confirm & Record Payment' :
             actionDialog.action === 'rejected' ? 'Reject Submission' :
             actionDialog.action === 'restore' ? 'Restore Submission' :
             'Send Clarification Request'}
          </Button>
        </div>
      </div>
    </>
  );
});

const InlineAmountEdit = memo(function InlineAmountEdit({
  submissionId,
  amount,
  currency,
  canEdit,
  userId,
  compact = false,
}: {
  submissionId: string;
  amount: number;
  currency: string;
  canEdit: boolean;
  userId: string | null;
  /** Table cell size (right-aligned, body-size figures). Display only. */
  compact?: boolean;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setValue(String(amount));
    setEditing(true);
  };

  const cancel = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setEditing(false);
  };

  const save = async (e?: React.MouseEvent) => {
    e?.stopPropagation();
    const newVal = Number(value);
    if (!Number.isFinite(newVal) || newVal <= 0) {
      toast.error('Enter a valid amount greater than 0');
      return;
    }
    if (newVal === Number(amount)) { setEditing(false); return; }
    setPending(true);

    queryClient.setQueriesData<SubmissionRow[]>(
      { queryKey: ['payment-submissions'] },
      (old) => old?.map((row) =>
        row.id === submissionId ? { ...row, submitted_amount: newVal } : row
      ),
    );

    const { error } = await supabase
      .from('payment_submissions')
      .update({ submitted_amount: newVal })
      .eq('id', submissionId);

    setPending(false);

    if (error) {
      queryClient.invalidateQueries({ queryKey: ['payment-submissions'] });
      toast.error('Failed to update amount', { description: error.message });
      return;
    }

    try {
      await (supabase.from('audit_logs') as any).insert([{
        entity_type: 'payment_submission',
        entity_id: submissionId,
        action: 'edit_submitted_amount',
        old_value_json: { submitted_amount: Number(amount) },
        new_value_json: { submitted_amount: newVal },
        performed_by_user_id: userId || null,
      }]);
    } catch { /* audit failure is non-fatal */ }

    setEditing(false);
    toast.success('Submitted amount updated');
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <Input
          type="number"
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); }}
          className={cn('h-7 w-32 tabular-nums px-2', compact ? 'text-sm font-semibold' : 'text-lg font-bold')}
          autoFocus
          disabled={pending}
        />
        <Button variant="ghost" size="icon" className="h-6 w-6 text-success" onClick={save} disabled={pending}>
          <Check className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" onClick={cancel} disabled={pending}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <div className={cn('flex items-center gap-1.5', compact && 'justify-end')}>
      <p className={cn('text-foreground tabular-nums whitespace-nowrap', compact ? 'text-sm font-semibold' : 'text-lg font-bold font-display')}>
        {formatCurrency(amount, currency as 'PHP' | 'JPY')}
      </p>
      {canEdit && (
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 text-muted-foreground hover:text-foreground"
          title="Edit submitted amount"
          onClick={startEdit}
        >
          <Pencil className="h-3 w-3" />
        </Button>
      )}
    </div>
  );
});

const InlinePaymentMethodSelect = memo(function InlinePaymentMethodSelect({
  submissionId,
  currentMethod,
  availableMethods,
}: {
  submissionId: string;
  currentMethod: string;
  availableMethods: string[];
}) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);

  const currentCanon = currentMethod ? normalizeMethod(currentMethod) : currentMethod;
  const options = useMemo(() => {
    const set = new Set(availableMethods.map(normalizeMethod));
    if (currentMethod) set.add(normalizeMethod(currentMethod));
    return Array.from(set);
  }, [availableMethods, currentMethod]);

  const handleChange = async (newValue: string) => {
    if (newValue === currentCanon) return;
    setPending(true);

    queryClient.setQueriesData<SubmissionRow[]>(
      { queryKey: ['payment-submissions'] },
      (old) => old?.map((row) =>
        row.id === submissionId ? { ...row, payment_method: newValue } : row
      ),
    );

    const { error } = await supabase
      .from('payment_submissions')
      .update({ payment_method: newValue })
      .eq('id', submissionId);

    setPending(false);

    if (error) {
      queryClient.invalidateQueries({ queryKey: ['payment-submissions'] });
      toast.error('Failed to update payment method', { description: error.message });
      return;
    }
    toast.success('Payment method updated');
  };

  return (
    <Select value={currentCanon} onValueChange={handleChange} disabled={pending}>
      <SelectTrigger
        onClick={(e) => e.stopPropagation()}
        className="h-6 px-2 py-0 text-sm font-medium inline-flex w-auto min-w-0 gap-1 shrink-0 bg-card/40 border-border/50 hover:bg-card/70 text-foreground"
      >
        <SelectValue placeholder={methodLabel(currentMethod)} />
      </SelectTrigger>
      <SelectContent>
        {options.map((m) => (
          <SelectItem key={m} value={m} className="text-sm">
            {methodLabel(m)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Presentation pieces shared by the phone card and the desktop row detail.
// Lifted verbatim from the former card body (Hub visual refresh, Phase 2B) so
// both layouts render the SAME markup and call the SAME handlers — there is
// no second implementation of proof viewing, split breakdown or notes.
// ─────────────────────────────────────────────────────────────────────────────

/** Proof of payment: PDF link, or image preview + View / full size / Download. */
function ProofPanel({ url, onExpand, imageClassName = 'w-full max-h-72 object-cover' }: {
  url: string | null;
  onExpand: (url: string, trigger?: HTMLElement | null) => void;
  imageClassName?: string;
}) {
  if (!hasProof(url)) {
    return <p className="text-[10px] text-destructive italic font-medium">No proof attached</p>;
  }
  return (
    <div className="space-y-1.5">
      <p className="label-caps text-[10px] text-ink-muted">Proof of Payment</p>
      {isPdf(url) ? (
        <div className="flex items-center gap-2 rounded border border-primary/20 bg-primary/5 p-2">
          <FileText className="h-4 w-4 text-primary shrink-0" />
          <span className="text-xs text-foreground truncate flex-1" title={url.split('/').pop()}>
            {proofFileName(url)}
          </span>
          <a href={url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-primary underline whitespace-nowrap">
            View Proof
          </a>
        </div>
      ) : (
        <>
          <button onClick={(e) => onExpand(url, e.currentTarget)} className="block w-full text-left">
            <ProofImage url={url}
              className={cn(imageClassName, 'rounded border border-[hsl(var(--border))] hover:opacity-90 transition-opacity cursor-zoom-in')} />
          </button>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => window.open(url, '_blank', 'noopener,noreferrer')} className="text-[10px] text-primary underline flex items-center gap-1">
              <ImageIcon className="h-3 w-3" /> View Proof
            </button>
            <button onClick={(e) => onExpand(url, e.currentTarget)} className="text-[10px] text-muted-foreground underline flex items-center gap-1">
              View full size
            </button>
            <a href={url} download target="_blank" rel="noopener noreferrer" className="text-[10px] text-muted-foreground underline flex items-center gap-1">
              Download
            </a>
          </div>
        </>
      )}
    </div>
  );
}

/** Split submission: the per-invoice breakdown behind its toggle. */
function SplitBreakdown({ sub, allocs, currency, open, onToggle }: {
  sub: SubmissionRow;
  allocs: SubmissionAllocation[];
  currency: 'PHP' | 'JPY';
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="space-y-1">
      <button
        onClick={onToggle}
        className="text-[10px] text-primary font-medium hover:underline flex items-center gap-1"
      >
        {open ? '▼' : '▶'} View allocation breakdown ({allocs.length} invoices)
      </button>
      {open && (
        <div className="p-2.5 rounded-lg bg-primary/5 border border-primary/10 space-y-1">
          {allocs.map((alloc) => (
            <div key={alloc.id} className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">#{alloc.invoice_number}</span>
              <span className="font-medium text-foreground tabular-nums">
                {formatCurrency(alloc.allocated_amount, currency)}
              </span>
            </div>
          ))}
          <div className="flex items-center justify-between text-xs pt-1 border-t border-primary/10">
            <span className="font-semibold text-foreground">Total</span>
            <span className="font-bold text-primary tabular-nums">
              {formatCurrency(sub.submitted_amount, currency)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

const fmtStamp = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
/** Row-size submitted time; the full stamp is the tooltip. */
const fmtShortStamp = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtPaymentDate = (d: string) =>
  new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** Sender, customer notes, the customer-edit warning and the staff note. */
function SubmissionNotes({ sub, isPending }: { sub: SubmissionRow; isPending: boolean }) {
  return (
    <>
      {sub.sender_name && (
        <p className="text-sm text-muted-foreground">Sender: <span className="text-foreground">{sub.sender_name}</span></p>
      )}
      {sub.notes && (
        <p className="text-sm text-muted-foreground">Notes: <span className="text-foreground">{sub.notes}</span></p>
      )}
      {sub.customer_edited_at && isPending && (
        <div className="flex items-center gap-1.5 p-2 rounded-md bg-warning/10 border border-warning/30">
          <AlertTriangle className="h-3.5 w-3.5 text-warning shrink-0" />
          <p className="text-xs text-warning font-medium">
            Customer edited this submission on {fmtStamp(sub.customer_edited_at)} — re-check the proof.
          </p>
        </div>
      )}
      {sub.reviewer_notes && (
        <div className="p-2.5 rounded-lg bg-muted/30 border border-[hsl(var(--border))]">
          <p className="text-[10px] text-muted-foreground mb-0.5 font-medium">Staff Note:</p>
          <p className="text-xs text-foreground">{sub.reviewer_notes}</p>
        </div>
      )}
    </>
  );
}

interface PaymentSubmissionsProps {
  embedded?: boolean;
  searchValue?: string;
}

const PaymentSubmissions = memo(function PaymentSubmissions({ embedded = false, searchValue }: PaymentSubmissionsProps = {}) {
  const { session } = useAuth();
  const { can } = usePermissions();
  const canConfirm = can('confirm_payment');
  const canReview = can('review_submission');
  const canReject = can('reject_submission');
  const canModerate = canConfirm || canReview || canReject;
  const queryClient = useQueryClient();
  const { data: paymentMethodOptions = [] } = useQuery<string[]>({
    queryKey: ['payment-methods-active'],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('payment_methods')
        .select('method_name')
        .eq('is_active', true);
      if (error) throw error;
      return (data ?? []).map((r: { method_name: string }) => r.method_name);
    },
  });
  const { lastRefreshedAt, refreshing, refresh } = useAutoRefresh([
    ['payment-submissions'],
    ['submission-allocations'],
    ['pending-submission-count'],
  ]);
  const [statusFilter, setStatusFilter] = useState<string>('pending');
  const [typeFilter, setTypeFilter] = useState<'all' | 'layaway' | 'cash'>('all');
  const searchRef = useRef('');
  const [filterTick, setFilterTick] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const handleSearch = useCallback((v: string) => {
    searchRef.current = v;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setFilterTick(t => t + 1), 300);
  }, []);

  // External search from a parent toolbar (PaymentsHub workspace toolbar).
  // When undefined, this child manages its own search via SubmissionsSearchBar.
  useEffect(() => {
    if (searchValue !== undefined) {
      searchRef.current = searchValue;
      clearTimeout(debounceRef.current);
      setFilterTick(t => t + 1);
    }
  }, [searchValue]);

  const [actionDialog, setActionDialog] = useState<{ sub: SubmissionRow; action: string } | null>(null);
  const [proofDialog, setProofDialogState] = useState<string | null>(null);
  // Whatever opened the preview gets focus back when it closes — including
  // the image inside the Confirm dialog. Passed explicitly because Safari
  // does not focus a button on click, so activeElement can't be trusted.
  const proofReturnFocus = useRef<HTMLElement | null>(null);
  const setProofDialog = useCallback((url: string | null, trigger?: HTMLElement | null) => {
    if (url) proofReturnFocus.current = trigger ?? (document.activeElement as HTMLElement | null);
    setProofDialogState(url);
  }, []);
  const [expandedAllocs, setExpandedAllocs] = useState<string | null>(null);

  // Staff attach/replace-proof dialog (proof-only; supports layaway + cash subs)
  const [attachProofSub, setAttachProofSub] = useState<SubmissionRow | null>(null);
  const [attachFile, setAttachFile] = useState<File | null>(null);
  const [attachUploading, setAttachUploading] = useState(false);

  const handleAttachProofSave = async () => {
    if (!attachProofSub || !attachFile) return;
    setAttachUploading(true);
    try {
      const sub = attachProofSub;
      const folder = sub.account_id ?? sub.cash_order_id;
      const invoice = (sub.layaway_accounts?.invoice_number || sub.cash_orders?.invoice_number || '').replace(/[^a-zA-Z0-9]/g, '');
      const customerName = (sub.customers?.full_name || sub.cash_orders?.customers?.full_name || 'Customer').replace(/[^a-zA-Z0-9]/g, '');
      const ext = (attachFile.name.split('.').pop() || 'jpg').toLowerCase();
      const fileName = `${customerName}_${invoice}_${sub.payment_date}_${Date.now().toString(36)}.${ext}`;
      const storagePath = `${folder}/${fileName}`;

      const { error: uploadErr } = await supabase.storage
        .from('payment-proofs')
        .upload(storagePath, attachFile, { cacheControl: '3600', upsert: false });
      if (uploadErr) throw uploadErr;

      const { data: urlData } = supabase.storage.from('payment-proofs').getPublicUrl(storagePath);

      const { error: updErr } = await supabase
        .from('payment_submissions')
        .update({ proof_url: urlData.publicUrl })
        .eq('id', sub.id);
      if (updErr) throw updErr;

      queryClient.invalidateQueries({ queryKey: ['payment-submissions'] });
      toast.success('Proof attached.');
      setAttachProofSub(null);
      setAttachFile(null);
    } catch (err: unknown) {
      toast.error((err as Error)?.message || 'Failed to attach proof');
    } finally {
      setAttachUploading(false);
    }
  };

  // Waterfall state for confirm dialog
  const [confirmScheduleRows, setConfirmScheduleRows] = useState<ScheduleViewRow[]>([]);
  const [confirmWaterfall, setConfirmWaterfall] = useState<WaterfallResult | null>(null);
  const [confirmLoadingSchedule, setConfirmLoadingSchedule] = useState(false);
  const [confirmResults, setConfirmResults] = useState<Array<{ ok: boolean; msg: string }> | null>(null);

  // Underpayment decision modal state
  const [underpaymentModal, setUnderpaymentModal] = useState<{
    scheduleId: string;
    accountId: string;
    row: ScheduleViewRow;
    shortfall: number;
    currency: 'PHP' | 'JPY';
  } | null>(null);
  const [underpaymentLoading, setUnderpaymentLoading] = useState<'partial' | 'carry' | null>(null);
  const [overpaymentModal, setOverpaymentModal] = useState<{
    row: ScheduleViewRow | null;
    sourceRowId: string | null;
    dueAmount: number;
    paidAmount: number;
    surplus: number;
    currency: 'PHP' | 'JPY';
    accountId: string;
    paymentId: string | null;
  } | null>(null);

  // Fetch schedule and compute waterfall when confirm dialog opens
  useEffect(() => {
    if (!actionDialog || actionDialog.action !== 'confirmed' || actionDialog.sub.submission_type === 'downpayment') {
      setConfirmScheduleRows([]);
      setConfirmWaterfall(null);
      setConfirmResults(null);
      return;
    }
    // Skip waterfall preview for split submissions — the total amount is split
    // across multiple accounts and cannot be validated against a single account's schedule
    if (actionDialog.sub.submission_type === 'split') {
      setConfirmWaterfall(null);
      setConfirmResults(null);
      return;
    }
    // Skip waterfall preview for cash-order submissions — no schedule, no installments
    if (actionDialog.sub.cash_order_id) {
      setConfirmScheduleRows([]);
      setConfirmWaterfall(null);
      setConfirmResults(null);
      return;
    }
    let cancelled = false;
    setConfirmLoadingSchedule(true);
    (async () => {
      const { data } = await supabase
        .from('schedule_with_actuals')
        .select('*')
        .eq('account_id', actionDialog.sub.account_id!)
        .order('due_date', { ascending: true });
      if (cancelled) return;
      const rows: ScheduleViewRow[] = (data || []).map((r: any) => ({
        id: r.id,
        account_id: r.account_id,
        installment_number: r.installment_number,
        due_date: r.due_date,
        base_installment_amount: r.base_installment_amount,
        penalty_amount: r.penalty_amount,
        carried_amount: r.carried_amount,
        currency: r.currency,
        db_status: r.db_status,
        allocated: r.allocated,
        actual_remaining: r.actual_remaining,
        computed_status: r.computed_status,
      }));
      setConfirmScheduleRows(rows);
      const wf = computeWaterfall(Number(actionDialog.sub.submitted_amount), rows);
      setConfirmWaterfall(wf);
      setConfirmLoadingSchedule(false);
    })();
    return () => { cancelled = true; };
  }, [actionDialog]);

  // Helpers for waterfall partial detection
  const getConfirmPartialRow = useMemo(() => {
    if (!confirmWaterfall?.valid || confirmScheduleRows.length === 0) return null;
    // Underpayment = this submission covers less than the row's CANONICAL remaining.
    // row.actual_remaining (= ceiling − allocated) is freshly fetched above, so a
    // partial already paid or waterfalled surplus on this row is NOT re-charged.
    const firstAlloc = confirmWaterfall.allocations[0];
    if (!firstAlloc) return null;
    const row = confirmScheduleRows.find(r => r.id === firstAlloc.scheduleId);
    if (!row) return null;
    const firstRowRemaining = Number(row.actual_remaining);
    const submittedAmount = confirmWaterfall.allocations.reduce((sum, a) => sum + a.amount, 0);
    if (submittedAmount < firstRowRemaining - 0.01 && submittedAmount > 0) {
      return { scheduleId: row.id, row, shortfall: Math.round((firstRowRemaining - submittedAmount) * 100) / 100 };
    }
    return null;
  }, [confirmWaterfall, confirmScheduleRows]);

  const getConfirmNextRow = useMemo(() => {
    if (!getConfirmPartialRow) return null;
    const sorted = [...confirmScheduleRows]
      .filter(r => r.id !== getConfirmPartialRow.scheduleId && !isRowPaid(r) && getRowStatus(r) !== 'cancelled')
      .sort((a, b) => a.due_date.localeCompare(b.due_date));
    return sorted[0] || null;
  }, [getConfirmPartialRow, confirmScheduleRows]);

  const { data: submissions, isLoading } = useQuery({
    queryKey: ['payment-submissions', statusFilter],
    queryFn: async () => {
      let query = supabase
        .from('payment_submissions')
        .select('*, customers(full_name, customer_code), layaway_accounts(invoice_number, currency, remaining_balance, total_amount), cash_orders(invoice_number, currency, customer_id, customers(full_name, customer_code))')
        .order('created_at', { ascending: false });

      if (statusFilter === 'pending') {
        query = query.in('status', ['submitted', 'under_review']);
      } else if (statusFilter !== 'all') {
        query = query.eq('status', statusFilter as Database['public']['Enums']['submission_status']);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as SubmissionRow[];
    },
    enabled: !!session,
  });

  // Fetch allocations for all submissions
  const submissionIds = (submissions || []).map(s => s.id);
  const { data: allAllocations } = useQuery({
    queryKey: ['submission-allocations', submissionIds],
    queryFn: async () => {
      if (submissionIds.length === 0) return [];
      const { data, error } = await supabase
        .from('payment_submission_allocations')
        .select('*')
        .in('submission_id', submissionIds);
      if (error) throw error;
      return data as SubmissionAllocation[];
    },
    enabled: !!session && submissionIds.length > 0,
  });

  const getAllocsForSubmission = (subId: string) =>
    (allAllocations || []).filter(a => a.submission_id === subId);

  const reviewMutation = useMutation({
    mutationFn: async ({ submissionId, action, notes }: { submissionId: string; action: string; notes: string }) => {
      const { data, error } = await supabase.functions.invoke('review-payment-submission', {
        body: { submission_id: submissionId, action, reviewer_notes: notes, submission_type: actionDialog?.sub.submission_type ?? 'single' },
      });
      // Prefer the server's actual error message over the generic invoke wrapper.
      // Path 1: supabase-js parsed the body into `data` (happens for some response shapes).
      if (data?.error) throw new Error(data.error);
      if (error) {
        // Path 2: For non-2xx responses, supabase-js v2 wraps the Response in error.context.
        // Extract the server's specific message and attach the HTTP status so onError can
        // detect permission errors (403) reliably.
        const ctx = (error as any)?.context;
        if (ctx && typeof ctx.json === 'function') {
          let body: any = null;
          try {
            body = typeof ctx.clone === 'function' ? await ctx.clone().json() : await ctx.json();
          } catch {
            // body parsing failed — fall through to throw the wrapper error below
          }
          if (body?.error) {
            const serverError = new Error(body.error);
            (serverError as any).status = ctx.status;
            throw serverError;
          }
        }
        throw error;
      }
      return data;
    },
    onSuccess: async (data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['payment-submissions'] });
      queryClient.invalidateQueries({ queryKey: ['pending-submission-count'] });
      const approvedAccountId = actionDialog?.sub.account_id;

      if (vars.action === 'confirmed') {
        for (const award of ((data as any)?.loyalty_awards ?? [])) {
          if (award.awarded) {
            toast.success(
              `Loyalty points awarded: +${award.points_earned}${award.bonus_points ? ` (+${award.bonus_points} bonus)` : ''} pts · balance ${award.remaining_points}` +
              (award.tier_upgraded ? ` · Tier upgraded: ${award.old_tier} → ${award.new_tier}` : '')
            );
          } else if (award.error) {
            toast.warning(`Loyalty award failed — check wiring: ${award.error}`);
          }
        }
        // Skip underpayment/overpayment decision flow for cash-order submissions —
        // cash orders have no schedule, no carry-over, no per-row partial concept.
        if (actionDialog?.sub.cash_order_id) {
          setActionDialog(null);
          setConfirmResults(null);
          return;
        }
        // Check if underpayment occurred — show decision modal
        if (getConfirmPartialRow && actionDialog && actionDialog.sub.account_id) {
          const cur = (actionDialog.sub.layaway_accounts?.currency || 'PHP') as 'PHP' | 'JPY';
          setUnderpaymentModal({
            scheduleId: getConfirmPartialRow.scheduleId,
            accountId: actionDialog.sub.account_id,
            row: getConfirmPartialRow.row,
            shortfall: getConfirmPartialRow.shortfall,
            currency: cur,
          });
          setActionDialog(null);
          setConfirmResults(null);
        } else if (actionDialog) {
          // No underpayment on first month. Check if surplus from fully-paid months
          // flowed into a later month (overpayment case).
          const partialAlloc = confirmWaterfall?.allocations.find(a => {
            const row = confirmScheduleRows.find(r => r.id === a.scheduleId);
            return row && a.amount < Number(getRowRemaining(row)) - 0.01;
          });
          const firstAllocId = confirmWaterfall?.allocations[0]?.scheduleId;
          if (partialAlloc && partialAlloc.scheduleId !== firstAllocId && confirmWaterfall) {
            // OVERPAYMENT — earlier months fully paid, surplus partially covers next month
            const partialIndex = confirmWaterfall.allocations.findIndex(a => a.scheduleId === partialAlloc.scheduleId);
            const dueAmount = confirmWaterfall.allocations
              .slice(0, partialIndex)
              .reduce((s, a) => s + a.amount, 0);
            const partialRow = confirmScheduleRows.find(r => r.id === partialAlloc.scheduleId) ?? null;
            const cur = (actionDialog.sub.layaway_accounts?.currency || 'PHP') as 'PHP' | 'JPY';
            setOverpaymentModal({
              row: partialRow,
              sourceRowId: confirmWaterfall.allocations[0]?.scheduleId ?? null,
              dueAmount,
              paidAmount: Number(actionDialog.sub.submitted_amount),
              surplus: partialAlloc.amount,
              currency: cur,
              accountId: actionDialog.sub.account_id!,
              paymentId: (data as any)?.confirmed_payment_ids?.[0] ?? null,
            });
            setActionDialog(null);
            setConfirmResults(null);
          } else {
            toast.success('Payment approved and recorded');
            if (approvedAccountId) {
              queryClient.invalidateQueries({ queryKey: ['account', approvedAccountId] });
              queryClient.invalidateQueries({ queryKey: ['schedule', approvedAccountId] });
              queryClient.invalidateQueries({ queryKey: ['payments', approvedAccountId] });
              queryClient.invalidateQueries({ queryKey: ['penalties', approvedAccountId] });
            }
            setActionDialog(null);
            setConfirmResults(null);
          }
        }
      } else {
        toast.success(`Submission ${vars.action.replace('_', ' ')}`);
        setActionDialog(null);
      }
    },
    onError: (err: any) => {
      const message = err?.message || 'Failed to process submission';
      // Read status from either the enrichedError thrown in mutationFn (err.status)
      // OR from the original FunctionsHttpError's Response context (err.context.status).
      const status: number | undefined = err?.status ?? err?.context?.status;
      const isPermissionError =
        status === 403 ||
        message.toLowerCase().includes('access denied') ||
        message.toLowerCase().includes('permission') ||
        message.toLowerCase().includes('forbidden');

      if (isPermissionError) {
        toast.error(
          "You don't have permission to confirm payments. Please ask an admin or finance team member to confirm this submission."
        );
        // Close the modal so the user isn't stuck on a dead-end screen
        setActionDialog(null);
        setConfirmResults(null);
      } else {
        toast.error(message);
      }
    },
  });

  const filtered = useMemo(() => (submissions || []).filter((s) => {
    // Type filter: layaway = has account_id (no cash_order_id), cash = has cash_order_id
    if (typeFilter === 'layaway' && s.cash_order_id) return false;
    if (typeFilter === 'cash' && !s.cash_order_id) return false;

    if (!searchRef.current) return true;
    const q = searchRef.current.toLowerCase();
    return (
      s.customers?.full_name?.toLowerCase().includes(q) ||
      s.cash_orders?.customers?.full_name?.toLowerCase().includes(q) ||
      s.layaway_accounts?.invoice_number?.toLowerCase().includes(q) ||
      s.cash_orders?.invoice_number?.toLowerCase().includes(q) ||
      s.reference_number?.toLowerCase().includes(q) ||
      s.payment_method.toLowerCase().includes(q)
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [submissions, filterTick, typeFilter]);

  const pendingCount = (submissions || []).filter(s => ['submitted', 'under_review'].includes(s.status)).length;

  // Hub visual refresh: desktop = ledger table (several rows can be open at
  // once), phones = the cards. Same rows, same handlers, same permission gates.
  const isMobile = useIsMobile();
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const toggleRow = useCallback((sub: SubmissionRow) => {
    setOpenRows(prev => {
      const next = new Set(prev);
      if (next.has(sub.id)) next.delete(sub.id); else next.add(sub.id);
      return next;
    });
  }, []);

  /** Per-row facts, computed exactly as the card always computed them. */
  const describe = (sub: SubmissionRow) => {
    const isCash = !!sub.cash_order_id;
    const currency = (
      (isCash ? sub.cash_orders?.currency : sub.layaway_accounts?.currency) || 'PHP'
    ) as 'PHP' | 'JPY';
    const invoiceNumber = isCash
      ? sub.cash_orders?.invoice_number
      : sub.layaway_accounts?.invoice_number;
    const customerName = isCash
      ? (sub.cash_orders?.customers?.full_name || sub.customers?.full_name)
      : sub.customers?.full_name;
    const isPending = ['submitted', 'under_review'].includes(sub.status);
    const isSplit = sub.submission_type === 'split';
    const allocs = getAllocsForSubmission(sub.id);
    const dupMatch = isPending ? (submissions || [])
      .filter(o =>
        o.id !== sub.id &&
        ['submitted', 'under_review'].includes(o.status) &&
        Math.abs(Number(o.submitted_amount) - Number(sub.submitted_amount)) < 1 &&
        ((sub.account_id && o.account_id === sub.account_id) ||
         (sub.cash_order_id && o.cash_order_id === sub.cash_order_id)),
      )
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]
      : null;
    const dupMinutesAgo = dupMatch
      ? Math.max(1, Math.round((Date.now() - new Date(dupMatch.created_at).getTime()) / 60000))
      : 0;
    const dupTitle = dupMatch
      ? `Matches submission by ${dupMatch.sender_name ?? 'unknown'}, submitted ${dupMinutesAgo} minute${dupMinutesAgo === 1 ? '' : 's'} ago`
      : '';
    const invoiceLabel = isSplit && allocs.length > 1 ? `${allocs.length} invoices` : `#${invoiceNumber || '—'}`;
    const detailHref = isCash ? `/cash-orders/${sub.cash_order_id}` : `/accounts/${sub.account_id}`;
    return { isCash, currency, invoiceNumber, customerName, isPending, isSplit, allocs, dupMatch, dupTitle, invoiceLabel, detailHref };
  };

  /** Confirm / Reject / Clarify / Attach / Restore — the card's exact gates. */
  const renderActions = (sub: SubmissionRow, isPending: boolean, layout: 'row' | 'card') => {
    const row = layout === 'row';
    const btn = row ? 'h-7 gap-1 px-2.5 text-xs' : 'gap-1.5 text-xs';
    return (
      <>
        {isPending && canModerate && (
          <>
            {canConfirm && (
              <Button size="sm" variant="default" className={btn}
                disabled={!hasProof(sub.proof_url)}
                title={!hasProof(sub.proof_url) ? 'Proof of payment required to confirm' : undefined}
                onClick={() => setActionDialog({ sub, action: 'confirmed' })}>
                <Check className="h-3.5 w-3.5" /> Confirm
              </Button>
            )}
            {canReject && (
              <Button size="sm" variant="outline" className={btn} onClick={() => setActionDialog({ sub, action: 'rejected' })}>
                <XCircle className="h-3.5 w-3.5" /> Reject
              </Button>
            )}
            {canReview && (row ? (
              <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-gold-300"
                aria-label="Clarify" title="Request clarification"
                onClick={() => setActionDialog({ sub, action: 'needs_clarification' })}>
                <MessageSquare className="h-3.5 w-3.5" />
              </Button>
            ) : (
              <Button size="sm" variant="ghost" className={btn} onClick={() => setActionDialog({ sub, action: 'needs_clarification' })}>
                <MessageSquare className="h-3.5 w-3.5" /> Clarify
              </Button>
            ))}
            {row ? (
              <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-gold-300"
                aria-label="Attach / Replace proof" title="Attach / Replace proof"
                onClick={() => { setAttachProofSub(sub); setAttachFile(null); }}>
                <ImageIcon className="h-3.5 w-3.5" />
              </Button>
            ) : (
              <Button size="sm" variant="outline" className={btn} onClick={() => { setAttachProofSub(sub); setAttachFile(null); }}>
                <ImageIcon className="h-3.5 w-3.5" /> Attach / Replace proof
              </Button>
            )}
          </>
        )}
        {isPending && !canModerate && (
          <StatusPill label="Pending Confirmation" tone="warning" />
        )}
        {sub.status === 'rejected' && canReject && (
          <Button size="sm" variant="outline" className={btn} onClick={() => setActionDialog({ sub, action: 'restore' })}>
            <RotateCcw className="h-3.5 w-3.5" /> Restore
          </Button>
        )}
      </>
    );
  };

  // Desktop ledger columns. Sized so the table fits a 1280px screen beside the
  // expanded sidebar; long names and references truncate with a tooltip.
  const tight = 'px-2';
  const columns: DataTableColumn<SubmissionRow>[] = [
    {
      key: 'customer',
      header: 'Customer',
      headClassName: tight,
      cellClassName: cn(tight, 'max-w-[150px]'),
      cell: (sub) => {
        const d = describe(sub);
        return (
          <span className="block min-w-0">
            <span className="flex items-center gap-1.5 min-w-0">
              <span className="truncate text-sm font-medium text-card-foreground" title={d.customerName || undefined}>{d.customerName || '—'}</span>
              {(sub.notes || sub.reviewer_notes) && (
                <MessageSquare className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Has notes" />
              )}
            </span>
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground whitespace-nowrap">
              <span className="font-deco text-[13px] font-semibold text-champagne [font-variant-numeric:lining-nums_tabular-nums]">{d.invoiceLabel}</span>
              {d.isCash && <span className="rounded border border-gold-500/30 bg-gold-500/10 px-1 text-[9px] font-semibold uppercase tracking-wide text-gold-300">Cash</span>}
            </span>
          </span>
        );
      },
    },
    {
      key: 'payment',
      header: 'Payment',
      headClassName: tight,
      cellClassName: cn(tight, 'max-w-[160px]'),
      cell: (sub) => (
        <span className="flex flex-col items-start gap-0.5 min-w-0">
          <InlinePaymentMethodSelect
            submissionId={sub.id}
            currentMethod={sub.payment_method}
            availableMethods={paymentMethodOptions}
          />
          <span className="block max-w-full truncate font-mono text-[11px] text-muted-foreground" title={sub.reference_number || undefined}>
            {sub.reference_number || '—'}
          </span>
        </span>
      ),
    },
    {
      key: 'proof',
      header: 'Proof',
      headClassName: tight,
      cellClassName: tight,
      cell: (sub) => {
        const url = sub.proof_url;
        if (!hasProof(url)) return <StatusPill label="No proof" tone="danger" />;
        if (isPdf(url)) {
          return (
            <a href={url} target="_blank" rel="noopener noreferrer" aria-label="View Proof (PDF)" title={proofFileName(url)}
              className="flex h-10 w-10 items-center justify-center rounded border border-gold-500/25 bg-gold-500/5 text-gold-300 hover:border-gold-500/60">
              <FileText className="h-4 w-4" />
            </a>
          );
        }
        return (
          <button type="button" onClick={(e) => setProofDialog(url, e.currentTarget)} aria-label="Proof of payment — view full size" title="View full size"
            className="block h-10 w-10 overflow-hidden rounded border border-gold-500/25 hover:border-gold-500/60 cursor-zoom-in">
            <ProofImage url={url} compact className="h-full w-full object-cover" />
          </button>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      headClassName: tight,
      cellClassName: tight,
      cell: (sub) => {
        const d = describe(sub);
        return (
          <span className="flex flex-col items-start gap-1">
            <span className="flex flex-wrap items-center gap-1">
              <StatusPill label={(statusConfig[sub.status] || statusConfig.submitted).label} tone={statusTone(sub.status)} />
              {d.isSplit && <StatusPill label="Split" tone="gold" />}
            </span>
            {d.dupMatch && <span title={d.dupTitle}><StatusPill label="Possible duplicate" tone="warning" /></span>}
            {sub.customer_edited_at && d.isPending && (
              <span title={`Customer edited this submission on ${fmtStamp(sub.customer_edited_at)} — re-check the proof.`}>
                <StatusPill label="Edited" tone="warning" />
              </span>
            )}
            <span className="text-[11px] text-muted-foreground whitespace-nowrap" title={`Submitted ${fmtStamp(sub.created_at)}`}>{fmtShortStamp(sub.created_at)}</span>
          </span>
        );
      },
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      headClassName: tight,
      cellClassName: tight,
      cell: (sub) => {
        const d = describe(sub);
        return (
          <span className="flex flex-col items-end gap-0.5">
            <InlineAmountEdit
              compact
              submissionId={sub.id}
              amount={Number(sub.submitted_amount)}
              currency={d.currency}
              userId={session?.user?.id ?? null}
              canEdit={canConfirm && !d.isSplit && ['submitted', 'under_review', 'needs_clarification'].includes(sub.status)}
            />
            <span className="text-[11px] text-muted-foreground whitespace-nowrap" title={`Payment date ${fmtPaymentDate(sub.payment_date)}`}>
              Paid {new Date(sub.payment_date + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </span>
          </span>
        );
      },
    },
    {
      key: 'actions',
      header: '',
      hideable: false,
      align: 'right',
      headClassName: tight,
      cellClassName: cn(tight, 'w-px'),
      cell: (sub) => {
        const d = describe(sub);
        return (
          <span className="inline-flex items-center justify-end gap-1">
            {renderActions(sub, d.isPending, 'row')}
            <Link to={d.detailHref} aria-label={d.isCash ? 'Open cash order' : 'Open account'} title={d.isCash ? 'Cash Order' : 'Account'}>
              <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-primary" tabIndex={-1}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </Link>
          </span>
        );
      },
    },
  ];

  /** Row detail (desktop): everything the card showed that the row summarises. */
  const renderDetail = (sub: SubmissionRow) => {
    const d = describe(sub);
    return (
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
        <div className="space-y-2.5 min-w-0">
          <dl className="grid grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-2 text-sm">
            <div className="min-w-0">
              <dt className="label-caps text-[10px] text-ink-muted">Customer</dt>
              <dd className="text-foreground font-medium break-words">{d.customerName || '—'}</dd>
            </div>
            <div>
              <dt className="label-caps text-[10px] text-ink-muted">Invoice</dt>
              <dd className="text-foreground font-medium">{d.invoiceLabel}</dd>
            </div>
            <div>
              <dt className="label-caps text-[10px] text-ink-muted">Payment Date</dt>
              <dd className="text-foreground">{fmtPaymentDate(sub.payment_date)}</dd>
            </div>
            <div className="min-w-0">
              <dt className="label-caps text-[10px] text-ink-muted">Reference</dt>
              <dd className="text-foreground font-mono text-xs break-all">{sub.reference_number || '—'}</dd>
            </div>
          </dl>
          {d.isSplit && d.allocs.length > 0 && (
            <SplitBreakdown sub={sub} allocs={d.allocs} currency={d.currency}
              open={expandedAllocs === sub.id}
              onToggle={() => setExpandedAllocs(expandedAllocs === sub.id ? null : sub.id)} />
          )}
          <SubmissionNotes sub={sub} isPending={d.isPending} />
        </div>
        <div className="min-w-0">
          {hasProof(sub.proof_url) ? (
            <div className="space-y-1.5">
              <p className="label-caps text-[10px] text-ink-muted">Proof of Payment</p>
              <div className="flex items-center gap-2 rounded border border-gold-500/20 bg-gold-500/5 p-2">
                <FileText className="h-4 w-4 text-gold-300 shrink-0" />
                <span className="text-xs text-foreground truncate flex-1" title={sub.proof_url.split('/').pop()}>{proofFileName(sub.proof_url)}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {isPdf(sub.proof_url) ? (
                  <a href={sub.proof_url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-primary underline whitespace-nowrap">View Proof</a>
                ) : (
                  <>
                    <button type="button" onClick={() => window.open(sub.proof_url!, '_blank', 'noopener,noreferrer')} className="text-[10px] text-primary underline flex items-center gap-1">
                      <ImageIcon className="h-3 w-3" /> View Proof
                    </button>
                    <button onClick={(e) => setProofDialog(sub.proof_url!, e.currentTarget)} className="text-[10px] text-muted-foreground underline flex items-center gap-1">
                      View full size
                    </button>
                    <a href={sub.proof_url} download target="_blank" rel="noopener noreferrer" className="text-[10px] text-muted-foreground underline flex items-center gap-1">
                      Download
                    </a>
                  </>
                )}
              </div>
            </div>
          ) : (
            <p className="text-[10px] text-destructive italic font-medium">No proof attached</p>
          )}
        </div>
      </div>
    );
  };

  const Wrapper = embedded ? EmbeddedWrapper : AppLayout;
  const selectTrigger = 'h-9 w-full sm:w-auto sm:min-w-[170px] rounded-lg border-border bg-card text-xs font-medium [&>span]:flex-1 [&>span]:text-left';

  return (
    <Wrapper>
      <div className={embedded ? 'space-y-5' : 'p-4 sm:p-6 space-y-6 max-w-6xl mx-auto'}>
        {/* Header — on the Sales page the band above already names the screen,
            so the embedded view opens straight onto its toolbar. */}
        {!embedded && (
          <div>
            <h1 className="font-deco text-3xl font-semibold tracking-tight text-champagne">Payment Submissions</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Review and process customer payment submissions from the portal.
            </p>
          </div>
        )}

        {/* Filters + queue state — the same toolbar row as Cash / Layaway. */}
        <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2">
          {!embedded && <SubmissionsSearchBar onSearch={handleSearch} />}
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className={selectTrigger} aria-label="Status filter">
              <Filter className="h-3.5 w-3.5 mr-1.5 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pending">Pending Review</SelectItem>
              <SelectItem value="all">All Submissions</SelectItem>
              <SelectItem value="confirmed">Confirmed</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="needs_clarification">Needs Clarification</SelectItem>
            </SelectContent>
          </Select>
          <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as 'all' | 'layaway' | 'cash')}>
            <SelectTrigger className={selectTrigger} aria-label="Type filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="layaway">Layaway</SelectItem>
              <SelectItem value="cash">Cash Orders</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex flex-wrap items-center gap-3 sm:ml-auto">
            {pendingCount > 0 && (
              <StatusPill label={`${pendingCount} pending review`} tone="warning" size="md" />
            )}
            <RefreshControl lastRefreshedAt={lastRefreshedAt} refreshing={refreshing} onRefresh={refresh} />
          </div>
        </div>

        {/* Submissions List */}
        {isLoading ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3 text-sm text-muted-foreground" role="status">
              <LedgerIllustration kind="scroll" className="h-8 w-10" />
              Opening the ledger…
            </div>
            <div className="space-y-2">
              {[...Array(4)].map((_, i) => <div key={i} className="h-14 rounded-lg skeleton-shimmer bg-muted/40" />)}
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <IllustratedState
            kind="scroll"
            className="rounded-xl border border-gold-500/15 bg-card py-12"
            text={statusFilter === 'pending' ? 'No pending submissions to review.' : 'No submissions match your filters.'}
          />
        ) : !isMobile ? (
          <DataTable
            variant="ledger"
            showToolbar={false}
            columns={columns}
            rows={filtered}
            rowKey={(sub) => sub.id}
            renderExpanded={renderDetail}
            expandedKeys={openRows}
            onToggleExpanded={toggleRow}
            rowProps={(sub) => ({
              'aria-label': `${describe(sub).customerName || 'Submission'}, ${describe(sub).invoiceLabel}`,
              className: cn('align-top', ['submitted', 'under_review'].includes(sub.status) && 'bg-gold-500/[0.015]'),
            })}
            maxHeightClassName="max-h-[72vh]"
          />
        ) : (
          <div className="space-y-3">
            {filtered.map((sub) => {
              const d = describe(sub);
              return (
                <Card key={sub.id} className={cn('shadow-sm border-gold-500/15', d.isPending && 'ring-1 ring-primary/10')}>
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <InlineAmountEdit
                            submissionId={sub.id}
                            amount={Number(sub.submitted_amount)}
                            currency={d.currency}
                            userId={session?.user?.id ?? null}
                            canEdit={canConfirm && !d.isSplit && ['submitted', 'under_review', 'needs_clarification'].includes(sub.status)}
                          />
                          {d.isSplit && <StatusPill label="Split" tone="gold" />}
                          {d.isCash && <StatusPill label="Cash order" tone="gold" />}
                          {hasProof(sub.proof_url)
                            ? <span title="Proof attached" className="inline-flex items-center text-sm leading-none text-success">📎</span>
                            : <span title="No proof of payment attached"><StatusPill label="No proof" tone="danger" /></span>}
                        </div>
                        <div className="text-sm text-muted-foreground mt-1 flex items-center gap-1.5 flex-wrap">
                          <span>via</span>
                          <InlinePaymentMethodSelect
                            submissionId={sub.id}
                            currentMethod={sub.payment_method}
                            availableMethods={paymentMethodOptions}
                          />
                          <span>·</span>
                          <span>{fmtStamp(sub.created_at)}</span>
                        </div>
                      </div>
                      <StatusPill label={(statusConfig[sub.status] || statusConfig.submitted).label} tone={statusTone(sub.status)} />
                    </div>
                    {d.dupMatch && (
                      <span title={d.dupTitle} className="inline-block"><StatusPill label="Possible duplicate" tone="warning" /></span>
                    )}

                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div className="min-w-0">
                        <p className="label-caps text-[10px] text-ink-muted">Customer</p>
                        <p className="text-foreground font-semibold truncate" title={d.customerName || undefined}>{d.customerName || '—'}</p>
                      </div>
                      <div>
                        <p className="label-caps text-[10px] text-ink-muted">Invoice</p>
                        <p className="font-deco text-base font-semibold text-champagne">{d.invoiceLabel}</p>
                      </div>
                      <div>
                        <p className="label-caps text-[10px] text-ink-muted">Payment Date</p>
                        <p className="text-foreground font-medium">{fmtPaymentDate(sub.payment_date)}</p>
                      </div>
                      <div className="min-w-0">
                        <p className="label-caps text-[10px] text-ink-muted">Reference</p>
                        <p className="text-foreground font-mono text-xs break-all">{sub.reference_number || '—'}</p>
                      </div>
                    </div>

                    {d.isSplit && d.allocs.length > 0 && (
                      <SplitBreakdown sub={sub} allocs={d.allocs} currency={d.currency}
                        open={expandedAllocs === sub.id}
                        onToggle={() => setExpandedAllocs(expandedAllocs === sub.id ? null : sub.id)} />
                    )}
                    <SubmissionNotes sub={sub} isPending={d.isPending} />

                    <ProofPanel url={sub.proof_url} onExpand={setProofDialog} imageClassName="w-full max-h-56 object-cover" />

                    <div className="flex flex-wrap gap-1.5 pt-3 hairline-t">
                      {hasProof(sub.proof_url) && !isPdf(sub.proof_url) && (
                        <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={(e) => setProofDialog(sub.proof_url!, e.currentTarget)}>
                          <ImageIcon className="h-3.5 w-3.5" /> Expand
                        </Button>
                      )}
                      {renderActions(sub, d.isPending, 'card')}
                      <Link to={d.detailHref}>
                        <Button size="sm" variant="ghost" className="gap-1.5 text-xs">
                          <ExternalLink className="h-3.5 w-3.5" /> {d.isCash ? 'Cash Order' : 'Account'}
                        </Button>
                      </Link>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Action Dialog — reviewerNotes state lives INSIDE this component, not here,
          so typing no longer re-renders the whole PaymentSubmissions tree. */}
      {actionDialog && (
        <ActionDialogModal
          actionDialog={actionDialog}
          confirmLoadingSchedule={confirmLoadingSchedule}
          confirmWaterfall={confirmWaterfall}
          confirmScheduleRows={confirmScheduleRows}
          confirmPartialRow={getConfirmPartialRow}
          isPending={reviewMutation.isPending}
          setProofDialog={setProofDialog}
          onCancel={() => { setActionDialog(null); setConfirmResults(null); }}
          onSubmit={(notes) => {
            reviewMutation.mutate({
              submissionId: actionDialog.sub.id,
              action: actionDialog.action,
              notes,
            });
          }}
        />
      )}

      {/* Staff Attach / Replace proof dialog (proof-only) */}
      <Dialog open={!!attachProofSub} onOpenChange={(open) => { if (!open) { setAttachProofSub(null); setAttachFile(null); } }}>
        <DialogContent>
          <DialogHeader className="space-y-0">
            <DecoDialogHeader
              icon={<ImageIcon />}
              title={<DialogTitle className={decoTitleClass}>Attach / Replace proof of payment</DialogTitle>}
              description={
                <DialogDescription>
                  Upload an image or PDF. This attaches proof to the submission so it can be confirmed.
                </DialogDescription>}
            />
          </DialogHeader>
          <div className="py-2">
            <Input
              type="file"
              accept="image/*,application/pdf"
              onChange={(e) => setAttachFile(e.target.files?.[0] ?? null)}
            />
            {attachFile && (
              <p className="mt-2 text-xs text-muted-foreground truncate" title={attachFile.name}>{attachFile.name}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setAttachProofSub(null); setAttachFile(null); }}>Cancel</Button>
            <Button disabled={!attachFile || attachUploading} onClick={handleAttachProofSave}>
              {attachUploading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Save proof
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Underpayment Decision Modal — must layer above the Action Dialog */}
      {!!underpaymentModal && (
        <>
          <div
            className="fixed inset-0 bg-black/60"
            style={{ zIndex: 9998, pointerEvents: 'auto' }}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="underpayment-title"
            className={MODAL_PANEL}
            style={{ zIndex: 9999, pointerEvents: 'auto' }}
          >
            <DecoDialogHeader
              className="mb-4"
              icon={<AlertTriangle className="text-warning" />}
              title={<h2 id="underpayment-title" className={decoTitleClass}>Underpayment Detected</h2>}
            />
            <div className="space-y-3 mb-4">
              <div className="rounded-lg border border-gold-500/15 bg-surface-1/60 p-3 space-y-1.5">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Month</span>
                  <span className="font-medium text-foreground">
                    Month {underpaymentModal.row.installment_number} — {new Date(underpaymentModal.row.due_date + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Amount due this month</span>
                  <span className="font-medium text-foreground tabular-nums">
                    {formatCurrency(
                      Number(underpaymentModal.row.actual_remaining),
                      underpaymentModal.currency
                    )}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Amount paid</span>
                  <span className="font-medium text-foreground tabular-nums">
                    {formatCurrency(
                      Number(underpaymentModal.row.actual_remaining) - underpaymentModal.shortfall,
                      underpaymentModal.currency
                    )}
                  </span>
                </div>
                <div className="flex justify-between text-sm pt-1.5 border-t border-border">
                  <span className="text-warning font-medium">Shortfall</span>
                  <span className="font-bold text-warning tabular-nums">
                    {formatCurrency(underpaymentModal.shortfall, underpaymentModal.currency)}
                  </span>
                </div>
              </div>
            </div>
            <div className="space-y-2">
              <Button
                variant="outline"
                className="w-full justify-start text-left h-auto py-3 px-4"
                disabled={!!underpaymentLoading}
                onClick={async () => {
                  // Keep as Partial — do nothing, just close
                  const keepAccountId = underpaymentModal?.accountId;
                  setUnderpaymentModal(null);
                  setUnderpaymentLoading(null);
                  toast.success('Payment recorded. Month stays partially paid.');
                  queryClient.invalidateQueries({ queryKey: ['payment-submissions'] });
                  if (keepAccountId) {
                    queryClient.invalidateQueries({ queryKey: ['account', keepAccountId] });
                    queryClient.invalidateQueries({ queryKey: ['schedule', keepAccountId] });
                    queryClient.invalidateQueries({ queryKey: ['payments', keepAccountId] });
                    queryClient.invalidateQueries({ queryKey: ['penalties', keepAccountId] });
                  }
                }}
              >
                {underpaymentLoading === 'partial' ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2 shrink-0" />
                ) : (
                  <CreditCard className="h-4 w-4 mr-2 shrink-0 text-muted-foreground" />
                )}
                <div>
                  <p className="font-medium text-foreground text-sm">Keep as Partial</p>
                  <p className="text-xs text-muted-foreground font-normal mt-0.5">
                    This month stays open. Customer must settle the remaining {formatCurrency(underpaymentModal.shortfall, underpaymentModal.currency)} before moving to the next month.
                  </p>
                </div>
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start text-left h-auto py-3 px-4 border-primary/30 hover:bg-primary/5"
                disabled={!!underpaymentLoading}
                onClick={async () => {
                  if (!underpaymentModal) return;
                  setUnderpaymentLoading('carry');
                  try {
                    const { data, error } = await supabase.functions.invoke('carry-over', {
                      body: {
                        schedule_row_id: underpaymentModal.scheduleId,
                        account_id: underpaymentModal.accountId,
                      },
                    });
                    if (error) throw error;
                    if (data?.error) throw new Error(data.error);
                    toast.success('Carry-over applied successfully');
                    queryClient.invalidateQueries({ queryKey: ['payment-submissions'] });
                    const carryAccountId = underpaymentModal.accountId;
                    if (carryAccountId) {
                      queryClient.invalidateQueries({ queryKey: ['account', carryAccountId] });
                      queryClient.invalidateQueries({ queryKey: ['schedule', carryAccountId] });
                      queryClient.invalidateQueries({ queryKey: ['payments', carryAccountId] });
                      queryClient.invalidateQueries({ queryKey: ['penalties', carryAccountId] });
                    }
                    setUnderpaymentModal(null);
                  } catch (err: any) {
                    toast.error(`Carry-over failed: ${err.message || 'Unknown error'}`);
                  } finally {
                    setUnderpaymentLoading(null);
                  }
                }}
              >
                {underpaymentLoading === 'carry' ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2 shrink-0" />
                ) : (
                  <Check className="h-4 w-4 mr-2 shrink-0 text-primary" />
                )}
                <div>
                  <p className="font-medium text-foreground text-sm">Accept & Carry Over</p>
                  <p className="text-xs text-muted-foreground font-normal mt-0.5">
                    Close this month and add {formatCurrency(underpaymentModal.shortfall, underpaymentModal.currency)} to next month's balance.
                  </p>
                </div>
              </Button>
            </div>
          </div>
        </>
      )}

      {/* Overpayment Decision Modal */}
      {overpaymentModal && (
        <>
          <div
            className="fixed inset-0 bg-black/60"
            style={{ zIndex: 9998, pointerEvents: 'auto' }}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="overpayment-title"
            className={MODAL_PANEL}
            style={{ zIndex: 9999, pointerEvents: 'auto' }}
          >
            <DecoDialogHeader
              className="mb-4"
              icon={<CreditCard />}
              title={<h2 id="overpayment-title" className={decoTitleClass}>Overpayment Detected</h2>}
            />
            <div className="space-y-3 mb-4">
              {overpaymentModal.row && (
                <p className="text-sm text-muted-foreground">
                  Month {overpaymentModal.row.installment_number} — {new Date(overpaymentModal.row.due_date + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </p>
              )}
              <div className="rounded-lg border border-gold-500/15 bg-surface-1/60 p-3 space-y-1.5">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Total due</span>
                  <span className="font-medium text-foreground tabular-nums">
                    {formatCurrency(overpaymentModal.dueAmount, overpaymentModal.currency)}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Amount paid</span>
                  <span className="font-medium text-foreground tabular-nums">
                    {formatCurrency(overpaymentModal.paidAmount, overpaymentModal.currency)}
                  </span>
                </div>
                <div className="flex justify-between text-sm pt-1.5 border-t border-border">
                  <span className="text-info font-medium">Surplus</span>
                  <span className="font-bold text-info tabular-nums">
                    {formatCurrency(overpaymentModal.surplus, overpaymentModal.currency)}
                  </span>
                </div>
              </div>
            </div>
            <div className="space-y-2">
              <Button
                variant="outline"
                className="w-full justify-start text-left h-auto py-3 px-4 border-primary/30 hover:bg-primary/5 bg-background"
                onClick={() => {
                  const overAccountId = overpaymentModal?.accountId;
                  setOverpaymentModal(null);
                  toast.success('Payment recorded. Surplus applied to next month.');
                  queryClient.invalidateQueries({ queryKey: ['payment-submissions'] });
                  if (overAccountId) {
                    queryClient.invalidateQueries({ queryKey: ['account', overAccountId] });
                    queryClient.invalidateQueries({ queryKey: ['schedule', overAccountId] });
                    queryClient.invalidateQueries({ queryKey: ['payments', overAccountId] });
                    queryClient.invalidateQueries({ queryKey: ['penalties', overAccountId] });
                  }
                }}
              >
                <Check className="h-4 w-4 mr-2 shrink-0 text-primary" />
                <div>
                  <p className="font-medium text-foreground text-sm">Carry Over</p>
                  <p className="text-xs text-muted-foreground font-normal mt-0.5">
                    Accept the waterfall allocation — surplus applied to the next month as a partial payment.
                  </p>
                </div>
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start text-left h-auto py-3 px-4 border-muted-foreground/30 hover:bg-muted/20 bg-background"
                onClick={() => {
                  const overAccountId = overpaymentModal?.accountId;
                  setOverpaymentModal(null);
                  toast.success('Payment recorded. Surplus applied to next months.');
                  queryClient.invalidateQueries({ queryKey: ['payment-submissions'] });
                  if (overAccountId) {
                    queryClient.invalidateQueries({ queryKey: ['account', overAccountId] });
                    queryClient.invalidateQueries({ queryKey: ['schedule', overAccountId] });
                    queryClient.invalidateQueries({ queryKey: ['payments', overAccountId] });
                    queryClient.invalidateQueries({ queryKey: ['penalties', overAccountId] });
                  }
                }}
              >
                <CreditCard className="h-4 w-4 mr-2 shrink-0 text-muted-foreground" />
                <div>
                  <p className="font-medium text-foreground text-sm">Keep</p>
                  <p className="text-xs text-muted-foreground font-normal mt-0.5">
                    Record the overpayment as-is. No additional changes.
                  </p>
                </div>
              </Button>
            </div>
          </div>
        </>
      )}

      {/* Proof Preview Dialog */}
      {/* Stacks ABOVE the hand-rolled review modals (z 9998 / 9999), so an
          image clicked inside Confirm opens in front of it. Outside clicks
          close on the overlay's own click — not on pointer-down — so the
          click never falls through to the Confirm backdrop and closes it. */}
      <Dialog open={!!proofDialog} onOpenChange={(open) => !open && setProofDialog(null)}>
        <DialogContent
          className="max-w-lg z-[10001]"
          overlayProps={{ className: 'z-[10000]', onClick: () => setProofDialog(null) }}
          onPointerDownOutside={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => {
            const el = proofReturnFocus.current;
            proofReturnFocus.current = null;
            if (el && el.isConnected) { e.preventDefault(); el.focus(); }
          }}
        >
          <DialogHeader className="space-y-0">
            <DecoDialogHeader icon={<FileText />} title={<DialogTitle className={decoTitleClass}>Proof of Payment</DialogTitle>} />
          </DialogHeader>
          {proofDialog && (
            <div className="mt-2 space-y-2">
              {proofDialog.match(/\.pdf$/i) ? (
                <a href={proofDialog} target="_blank" rel="noopener noreferrer" className="text-primary underline text-sm flex items-center gap-2">
                  <FileText className="h-4 w-4" /> Open PDF
                </a>
              ) : (
                <>
                  <ProofImage url={proofDialog} className="w-full rounded-lg border border-[hsl(var(--border))]" />
                  <div className="flex gap-3 pt-1">
                    <a href={proofDialog} download target="_blank" rel="noopener noreferrer"
                      className="text-xs text-muted-foreground underline flex items-center gap-1">
                      Download
                    </a>
                    <a href={proofDialog} target="_blank" rel="noopener noreferrer"
                      className="text-xs text-primary underline flex items-center gap-1">
                      <ImageIcon className="h-3 w-3" /> Open in new tab
                    </a>
                  </div>
                </>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Wrapper>
  );
});

export default PaymentSubmissions;
