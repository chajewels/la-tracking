import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import AppLayout from '@/components/layout/AppLayout';
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
  AlertTriangle, Check, CheckCircle, Clock, CreditCard, Eye, ExternalLink,
  Filter, Image as ImageIcon, Loader2, MessageSquare, Search, Send, XCircle, FileText,
} from 'lucide-react';
import { toast } from 'sonner';
import { formatCurrency } from '@/lib/calculations';
import { Link } from 'react-router-dom';
import { usePermissions } from '@/contexts/PermissionsContext';
import {
  computeWaterfall, getRowStatus, isRowPaid, getRowRemaining,
  type ScheduleViewRow, type WaterfallResult,
} from '@/lib/business-rules';

type SubmissionStatus = 'submitted' | 'under_review' | 'confirmed' | 'rejected' | 'needs_clarification' | 'cancelled';

interface SubmissionRow {
  id: string;
  customer_id: string;
  account_id: string;
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
}

interface SubmissionAllocation {
  id: string;
  submission_id: string;
  account_id: string;
  invoice_number: string;
  allocated_amount: number;
}

/** Extract the bucket-relative path from any proof_url variant:
 *  - https://.../storage/v1/object/public/payment-proofs/{path}
 *  - https://.../storage/v1/object/sign/payment-proofs/{path}?token=...
 *  - bare path like "{account_id}/file.jpg" */
function getProofPath(url: string): string {
  const m = url.match(/\/storage\/v1\/object\/(?:public|sign)\/payment-proofs\/(.+?)(?:\?|$)/);
  if (m) return decodeURIComponent(m[1]);
  // Already a bare path
  if (!url.startsWith('http')) return url;
  return url;
}

/** Renders a proof-of-payment image using a fresh Supabase signed URL (1 hr TTL).
 *  Falls back to the original URL if signing fails, and shows a link-only
 *  fallback if the image still won't load. */
function ProofImage({ url, className }: { url: string; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setImgError(false);
    setSrc(null);
    const path = getProofPath(url);
    supabase.storage.from('payment-proofs').createSignedUrl(path, 3600).then(({ data }) => {
      if (cancelled) return;
      setSrc(data?.signedUrl ?? url);
    });
    return () => { cancelled = true; };
  }, [url]);

  if (!src) {
    return <div className="w-full h-20 rounded bg-muted/30 animate-pulse" />;
  }
  if (imgError) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-xs text-primary underline">
        <ImageIcon className="h-3.5 w-3.5" /> View proof (open in new tab)
      </a>
    );
  }
  return (
    <img src={src} alt="Proof of payment" className={className}
      onError={() => setImgError(true)} />
  );
}

const statusConfig: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  submitted: { label: 'Submitted', color: 'bg-blue-500/10 text-blue-500 border-blue-500/20', icon: <Send className="h-3 w-3" /> },
  under_review: { label: 'Under Review', color: 'bg-warning/10 text-warning border-warning/20', icon: <Eye className="h-3 w-3" /> },
  confirmed: { label: 'Confirmed', color: 'bg-success/10 text-success border-success/20', icon: <CheckCircle className="h-3 w-3" /> },
  rejected: { label: 'Rejected', color: 'bg-destructive/10 text-destructive border-destructive/20', icon: <XCircle className="h-3 w-3" /> },
  needs_clarification: { label: 'Needs Clarification', color: 'bg-warning/10 text-warning border-warning/20', icon: <MessageSquare className="h-3 w-3" /> },
};

export default function PaymentSubmissions() {
  const { session } = useAuth();
  const { can } = usePermissions();
  const canConfirm = can('confirm_payment');
  const canReview = can('review_submission');
  const canReject = can('reject_submission');
  const canModerate = canConfirm || canReview || canReject;
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>('pending');
  const [search, setSearch] = useState('');
  const [actionDialog, setActionDialog] = useState<{ sub: SubmissionRow; action: string } | null>(null);
  const [reviewerNotes, setReviewerNotes] = useState('');
  const [proofDialog, setProofDialog] = useState<string | null>(null);
  const [expandedAllocs, setExpandedAllocs] = useState<string | null>(null);

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

  // Fetch schedule and compute waterfall when confirm dialog opens
  useEffect(() => {
    if (!actionDialog || actionDialog.action !== 'confirmed') {
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
        .eq('account_id', actionDialog.sub.account_id)
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
    for (const alloc of confirmWaterfall.allocations) {
      const row = confirmScheduleRows.find(r => r.id === alloc.scheduleId);
      if (!row) continue;
      const rowTotal = Number(row.base_installment_amount) + Number(row.penalty_amount || 0) + Number(row.carried_amount || 0);
      const newAllocated = (Number(row.allocated) || 0) + alloc.amount;
      if (newAllocated < rowTotal - 0.01 && newAllocated > 0) {
        return { scheduleId: row.id, row, shortfall: Math.round((rowTotal - newAllocated) * 100) / 100 };
      }
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
      let query = (supabase as any)
        .from('payment_submissions')
        .select('*, customers(full_name, customer_code), layaway_accounts(invoice_number, currency, remaining_balance, total_amount)')
        .order('created_at', { ascending: false });

      if (statusFilter === 'pending') {
        query = query.in('status', ['submitted', 'under_review']);
      } else if (statusFilter !== 'all') {
        query = query.eq('status', statusFilter);
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
      const { data, error } = await (supabase as any)
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
        body: { submission_id: submissionId, action, reviewer_notes: notes },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: async (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['payment-submissions'] });
      queryClient.invalidateQueries({ queryKey: ['pending-submission-count'] });

      if (vars.action === 'confirmed') {
        // Check if underpayment occurred — show decision modal
        if (getConfirmPartialRow && actionDialog) {
          const cur = (actionDialog.sub.layaway_accounts?.currency || 'PHP') as 'PHP' | 'JPY';
          setUnderpaymentModal({
            scheduleId: getConfirmPartialRow.scheduleId,
            accountId: actionDialog.sub.account_id,
            row: getConfirmPartialRow.row,
            shortfall: getConfirmPartialRow.shortfall,
            currency: cur,
          });
          setActionDialog(null);
          setReviewerNotes('');
          setConfirmResults(null);
        } else {
          toast.success('Payment approved and recorded');
          setActionDialog(null);
          setReviewerNotes('');
          setConfirmResults(null);
        }
      } else {
        toast.success(`Submission ${vars.action.replace('_', ' ')}`);
        setActionDialog(null);
        setReviewerNotes('');
      }
    },
    onError: (err: any) => {
      toast.error(err.message || 'Failed to process submission');
    },
  });

  const filtered = (submissions || []).filter((s) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      s.customers?.full_name?.toLowerCase().includes(q) ||
      s.layaway_accounts?.invoice_number?.toLowerCase().includes(q) ||
      s.reference_number?.toLowerCase().includes(q) ||
      s.payment_method.toLowerCase().includes(q)
    );
  });

  const pendingCount = (submissions || []).filter(s => ['submitted', 'under_review'].includes(s.status)).length;

  return (
    <AppLayout>
      <div className="p-4 sm:p-6 space-y-6 max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold font-display text-foreground tracking-tight">
              Payment Submissions
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Review and process customer payment submissions from the portal.
            </p>
          </div>
          {pendingCount > 0 && (
            <Badge variant="outline" className="bg-warning/10 text-warning border-warning/20 text-sm px-3 py-1 self-start">
              {pendingCount} pending review
            </Badge>
          )}
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search customer, invoice, or reference…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full sm:w-[180px]">
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
        </div>

        {/* Submissions List */}
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : filtered.length === 0 ? (
          <Card>
            <CardContent className="py-16 text-center">
              <Send className="h-12 w-12 text-muted-foreground/20 mx-auto mb-4" />
              <h3 className="text-lg font-semibold font-display text-foreground mb-1">No Submissions</h3>
              <p className="text-sm text-muted-foreground">
                {statusFilter === 'pending' ? 'No pending submissions to review.' : 'No submissions match your filters.'}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {filtered.map((sub) => {
              const cfg = statusConfig[sub.status] || statusConfig.submitted;
              const currency = (sub.layaway_accounts?.currency || 'PHP') as 'PHP' | 'JPY';
              const isPending = ['submitted', 'under_review'].includes(sub.status);
              const isSplit = sub.submission_type === 'split';
              const allocs = getAllocsForSubmission(sub.id);

              return (
                <Card key={sub.id} className={`shadow-sm ${isPending ? 'ring-1 ring-primary/10' : ''}`}>
                  <CardContent className="p-4 sm:p-5">
                    <div className="flex flex-col sm:flex-row sm:items-start gap-4">
                      {/* Left: Details */}
                      <div className="flex-1 min-w-0 space-y-2.5">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="text-base font-bold font-display text-foreground tabular-nums">
                                {formatCurrency(sub.submitted_amount, currency)}
                              </p>
                              {isSplit && (
                                <Badge variant="outline" className="text-[9px] bg-primary/10 text-primary border-primary/20">
                                  Split
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              via {sub.payment_method} · {new Date(sub.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
                            </p>
                          </div>
                          <Badge variant="outline" className={`text-[10px] gap-1 shrink-0 ${cfg.color}`}>
                            {cfg.icon} {cfg.label}
                          </Badge>
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                          <div>
                            <p className="text-muted-foreground">Customer</p>
                            <p className="text-foreground font-medium truncate">{sub.customers?.full_name || '—'}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground">Invoice</p>
                            <p className="text-foreground font-medium">
                              {isSplit && allocs.length > 1
                                ? `${allocs.length} invoices`
                                : `#${sub.layaway_accounts?.invoice_number || '—'}`}
                            </p>
                          </div>
                          <div>
                            <p className="text-muted-foreground">Payment Date</p>
                            <p className="text-foreground font-medium">{new Date(sub.payment_date + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground">Reference</p>
                            <p className="text-foreground font-mono text-[11px]">{sub.reference_number || '—'}</p>
                          </div>
                        </div>

                        {/* Split Allocation Breakdown */}
                        {isSplit && allocs.length > 0 && (
                          <div className="space-y-1">
                            <button
                              onClick={() => setExpandedAllocs(expandedAllocs === sub.id ? null : sub.id)}
                              className="text-[10px] text-primary font-medium hover:underline flex items-center gap-1"
                            >
                              {expandedAllocs === sub.id ? '▼' : '▶'} View allocation breakdown ({allocs.length} invoices)
                            </button>
                            {expandedAllocs === sub.id && (
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
                        )}

                        {sub.sender_name && (
                          <p className="text-xs text-muted-foreground">Sender: <span className="text-foreground">{sub.sender_name}</span></p>
                        )}
                        {sub.notes && (
                          <p className="text-xs text-muted-foreground">Notes: <span className="text-foreground">{sub.notes}</span></p>
                        )}
                        {sub.customer_edited_at && isPending && (
                          <div className="flex items-center gap-1.5 p-2 rounded-md bg-warning/10 border border-warning/30">
                            <AlertTriangle className="h-3.5 w-3.5 text-warning shrink-0" />
                            <p className="text-xs text-warning font-medium">
                              ⚠️ Customer edited this submission on {new Date(sub.customer_edited_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })} — re-check the proof.
                            </p>
                          </div>
                        )}

                        {sub.reviewer_notes && (
                          <div className="p-2.5 rounded-lg bg-muted/30 border border-[hsl(var(--border))]">
                            <p className="text-[10px] text-muted-foreground mb-0.5 font-medium">Staff Note:</p>
                            <p className="text-xs text-foreground">{sub.reviewer_notes}</p>
                          </div>
                        )}

                        {/* Inline proof preview */}
                        {sub.proof_url && (
                          <div className="mt-1 space-y-1.5">
                            <p className="text-[10px] text-muted-foreground font-medium">Proof of Payment</p>
                            {sub.proof_url.match(/\.pdf$/i) ? (
                              <a href={sub.proof_url} target="_blank" rel="noopener noreferrer"
                                className="inline-flex items-center gap-1.5 text-xs text-primary underline p-2 rounded border border-primary/20 bg-primary/5">
                                <FileText className="h-3.5 w-3.5" /> Open PDF
                              </a>
                            ) : (
                              <>
                                <button onClick={() => setProofDialog(sub.proof_url!)} className="block w-full text-left">
                                  <ProofImage url={sub.proof_url}
                                    className="w-full max-h-48 object-cover rounded border border-[hsl(var(--border))] hover:opacity-90 transition-opacity cursor-zoom-in" />
                                </button>
                                <div className="flex gap-2">
                                  <button onClick={() => setProofDialog(sub.proof_url!)}
                                    className="text-[10px] text-primary underline flex items-center gap-1">
                                    <ImageIcon className="h-3 w-3" /> View full size
                                  </button>
                                  <a href={sub.proof_url} download target="_blank" rel="noopener noreferrer"
                                    className="text-[10px] text-muted-foreground underline flex items-center gap-1">
                                    Download
                                  </a>
                                </div>
                              </>
                            )}
                          </div>
                        )}
                        {!sub.proof_url && (
                          <p className="text-[10px] text-muted-foreground italic">No proof attached</p>
                        )}
                      </div>

                      {/* Right: Actions */}
                      <div className="flex flex-row sm:flex-col gap-1.5 shrink-0">
                        {sub.proof_url && !sub.proof_url.match(/\.pdf$/i) && (
                          <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={() => setProofDialog(sub.proof_url!)}>
                            <ImageIcon className="h-3.5 w-3.5" /> Expand
                          </Button>
                        )}
                        {isPending && canModerate && (
                          <>
                            {canConfirm && (
                              <Button size="sm" variant="default" className="gap-1.5 text-xs" onClick={() => setActionDialog({ sub, action: 'confirmed' })}>
                                <Check className="h-3.5 w-3.5" /> Confirm
                              </Button>
                            )}
                            {canReject && (
                              <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={() => setActionDialog({ sub, action: 'rejected' })}>
                                <XCircle className="h-3.5 w-3.5" /> Reject
                              </Button>
                            )}
                            {canReview && (
                              <Button size="sm" variant="ghost" className="gap-1.5 text-xs" onClick={() => setActionDialog({ sub, action: 'needs_clarification' })}>
                                <MessageSquare className="h-3.5 w-3.5" /> Clarify
                              </Button>
                            )}
                          </>
                        )}
                        {isPending && !canModerate && (
                          <Badge variant="outline" className="bg-warning/10 text-warning border-warning/20 text-[10px]">
                            <Clock className="h-3 w-3 mr-1" /> Pending Confirmation
                          </Badge>
                        )}
                        <Link to={`/accounts/${sub.account_id}`}>
                          <Button size="sm" variant="ghost" className="gap-1.5 text-xs w-full">
                            <ExternalLink className="h-3.5 w-3.5" /> Account
                          </Button>
                        </Link>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Action Dialog */}
      <Dialog open={!!actionDialog} onOpenChange={(open) => { if (!open) { setActionDialog(null); setReviewerNotes(''); setConfirmResults(null); } }}>
        <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-display">
              {actionDialog?.action === 'confirmed' ? '✅ Confirm Payment' :
               actionDialog?.action === 'rejected' ? '❌ Reject Submission' :
               '💬 Request Clarification'}
            </DialogTitle>
            <DialogDescription>
              {actionDialog?.action === 'confirmed'
                ? `This will create a confirmed payment of ${actionDialog?.sub ? formatCurrency(actionDialog.sub.submitted_amount, (actionDialog.sub.layaway_accounts?.currency || 'PHP') as 'PHP' | 'JPY') : ''} and update the account balance.`
                : actionDialog?.action === 'rejected'
                ? 'This submission will be marked as rejected. The customer will see your reason.'
                : 'Send a message to the customer requesting more information.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
              {/* Waterfall breakdown for confirm action */}
              {actionDialog?.action === 'confirmed' && (() => {
                const cur = (actionDialog.sub.layaway_accounts?.currency || 'PHP') as 'PHP' | 'JPY';
                if (confirmLoadingSchedule) {
                  return (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading allocation preview…
                    </div>
                  );
                }
                if (confirmWaterfall?.valid && confirmWaterfall.allocations.length > 0) {
                  return (
                    <div className="rounded-md border border-border bg-muted/30 p-2.5">
                      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Allocation breakdown</p>
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
                              <span className="text-green-600 dark:text-green-400 font-medium">PAID ✅</span>
                            ) : (
                              <span className="text-yellow-600 dark:text-yellow-400 font-medium">PARTIAL 🟡</span>
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
                      {getConfirmPartialRow && (
                        <p className="text-[10px] text-warning mt-1.5">
                          ⚠️ Underpayment of {formatCurrency(getConfirmPartialRow.shortfall, cur)} — you'll choose how to handle it after confirming.
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
                  {actionDialog?.action === 'confirmed' ? 'Note (optional)' : 'Reason / Message *'}
                </label>
                <Textarea
                  value={reviewerNotes}
                  onChange={(e) => setReviewerNotes(e.target.value)}
                  placeholder={
                    actionDialog?.action === 'confirmed' ? 'Optional note...' :
                    actionDialog?.action === 'rejected' ? 'Reason for rejection...' :
                    'What information do you need?'
                  }
                  rows={3}
                  className="mt-1.5"
                />
              </div>
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={() => { setActionDialog(null); setReviewerNotes(''); }}>Cancel</Button>
              <Button
                variant={actionDialog?.action === 'rejected' ? 'destructive' : 'default'}
                disabled={reviewMutation.isPending || (actionDialog?.action !== 'confirmed' && !reviewerNotes.trim())}
                onClick={() => {
                  if (actionDialog) {
                    reviewMutation.mutate({
                      submissionId: actionDialog.sub.id,
                      action: actionDialog.action,
                      notes: reviewerNotes,
                    });
                  }
                }}
              >
                {reviewMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                {actionDialog?.action === 'confirmed' ? 'Confirm & Record Payment' :
                 actionDialog?.action === 'rejected' ? 'Reject Submission' :
                 'Send Clarification Request'}
              </Button>
            </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Underpayment Decision Modal — must layer above the Action Dialog */}
      <AlertDialog open={!!underpaymentModal}>
        <AlertDialogContent className="max-w-md" style={{ zIndex: 60 }}>
          <style>{`[data-state="open"][role="alertdialog"] ~ [data-state="open"]:not([role]) { z-index: 60 !important; }`}</style>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-display flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-warning" />
              Underpayment Detected
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                {underpaymentModal && (
                  <>
                    <div className="rounded-md border border-border bg-muted/30 p-3 space-y-1.5">
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Month</span>
                        <span className="font-medium text-foreground">
                          Month {underpaymentModal.row.installment_number} — {new Date(underpaymentModal.row.due_date + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Base amount due</span>
                        <span className="font-medium text-foreground tabular-nums">
                          {formatCurrency(
                            Number(underpaymentModal.row.base_installment_amount) + Number(underpaymentModal.row.penalty_amount || 0) + Number(underpaymentModal.row.carried_amount || 0),
                            underpaymentModal.currency
                          )}
                        </span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Amount paid</span>
                        <span className="font-medium text-foreground tabular-nums">
                          {formatCurrency(
                            Number(underpaymentModal.row.base_installment_amount) + Number(underpaymentModal.row.penalty_amount || 0) + Number(underpaymentModal.row.carried_amount || 0) - underpaymentModal.shortfall,
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
                  </>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2 mt-2">
            <Button
              variant="outline"
              className="w-full justify-start text-left h-auto py-3 px-4"
              disabled={!!underpaymentLoading}
              onClick={async () => {
                // Keep as Partial — do nothing, just close
                setUnderpaymentModal(null);
                setUnderpaymentLoading(null);
                toast.success('Payment recorded. Month stays partially paid.');
                queryClient.invalidateQueries({ queryKey: ['payment-submissions'] });
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
                  This month stays open. Customer must settle the remaining {underpaymentModal ? formatCurrency(underpaymentModal.shortfall, underpaymentModal.currency) : ''} before moving to the next month.
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
                  Close this month and add {underpaymentModal ? formatCurrency(underpaymentModal.shortfall, underpaymentModal.currency) : ''} to next month's balance.
                </p>
              </div>
            </Button>
          </div>
        </AlertDialogContent>
      </AlertDialog>

      {/* Proof Preview Dialog */}
      <Dialog open={!!proofDialog} onOpenChange={(open) => !open && setProofDialog(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-display">Proof of Payment</DialogTitle>
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
    </AppLayout>
  );
}
