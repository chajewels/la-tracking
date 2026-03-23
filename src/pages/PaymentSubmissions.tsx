import { useState } from 'react';
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
  AlertTriangle, Check, CheckCircle, Clock, CreditCard, Eye, ExternalLink,
  Filter, Image as ImageIcon, Loader2, MessageSquare, Search, Send, XCircle, FileText,
} from 'lucide-react';
import { toast } from 'sonner';
import { formatCurrency } from '@/lib/calculations';
import { Link } from 'react-router-dom';
import { usePermissions } from '@/contexts/PermissionsContext';

type SubmissionStatus = 'submitted' | 'under_review' | 'confirmed' | 'rejected' | 'needs_clarification';

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
  created_at: string;
  updated_at: string;
  customers: { full_name: string; customer_code: string } | null;
  layaway_accounts: { invoice_number: string; currency: string; remaining_balance: number; total_amount: number } | null;
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

  const reviewMutation = useMutation({
    mutationFn: async ({ submissionId, action, notes }: { submissionId: string; action: string; notes: string }) => {
      const { data, error } = await supabase.functions.invoke('review-payment-submission', {
        body: { submission_id: submissionId, action, reviewer_notes: notes },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['payment-submissions'] });
      toast.success(`Submission ${vars.action === 'confirmed' ? 'confirmed and payment recorded' : vars.action.replace('_', ' ')}`);
      setActionDialog(null);
      setReviewerNotes('');
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

              return (
                <Card key={sub.id} className={`shadow-sm ${isPending ? 'ring-1 ring-primary/10' : ''}`}>
                  <CardContent className="p-4 sm:p-5">
                    <div className="flex flex-col sm:flex-row sm:items-start gap-4">
                      {/* Left: Details */}
                      <div className="flex-1 min-w-0 space-y-2.5">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="text-base font-bold font-display text-foreground tabular-nums">
                              {formatCurrency(sub.submitted_amount, currency)}
                            </p>
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
                            <p className="text-foreground font-medium">#{sub.layaway_accounts?.invoice_number || '—'}</p>
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

                        {sub.sender_name && (
                          <p className="text-xs text-muted-foreground">Sender: <span className="text-foreground">{sub.sender_name}</span></p>
                        )}
                        {sub.notes && (
                          <p className="text-xs text-muted-foreground">Notes: <span className="text-foreground">{sub.notes}</span></p>
                        )}
                        {sub.reviewer_notes && (
                          <div className="p-2.5 rounded-lg bg-muted/30 border border-[hsl(var(--border))]">
                            <p className="text-[10px] text-muted-foreground mb-0.5 font-medium">Staff Note:</p>
                            <p className="text-xs text-foreground">{sub.reviewer_notes}</p>
                          </div>
                        )}
                      </div>

                      {/* Right: Actions */}
                      <div className="flex flex-row sm:flex-col gap-1.5 shrink-0">
                        {sub.proof_url && (
                          <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={() => setProofDialog(sub.proof_url!)}>
                            <ImageIcon className="h-3.5 w-3.5" /> Proof
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
      <Dialog open={!!actionDialog} onOpenChange={(open) => !open && setActionDialog(null)}>
        <DialogContent>
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

      {/* Proof Preview Dialog */}
      <Dialog open={!!proofDialog} onOpenChange={(open) => !open && setProofDialog(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-display">Proof of Payment</DialogTitle>
          </DialogHeader>
          {proofDialog && (
            <div className="mt-2">
              {proofDialog.match(/\.pdf$/i) ? (
                <a href={proofDialog} target="_blank" rel="noopener noreferrer" className="text-primary underline text-sm flex items-center gap-2">
                  <FileText className="h-4 w-4" /> Open PDF
                </a>
              ) : (
                <img src={proofDialog} alt="Proof of payment" className="w-full rounded-lg border border-[hsl(var(--border))]" />
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
