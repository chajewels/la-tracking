import { useState, useMemo, useCallback, useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowLeft, Banknote, RefreshCcw, Receipt, XCircle, ChevronDown, ChevronUp,
  AlertTriangle, User as UserIcon, MessageCircle, Plus,
} from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import StatusBadge from '@/components/customers/StatusBadge';
import RecordCashPaymentDialog from '@/components/customers/RecordCashPaymentDialog';
import { Currency } from '@/lib/types';
import { formatCurrency } from '@/lib/calculations';
import { supabase } from '@/integrations/supabase/client';
import { useAutoRefresh } from '@/hooks/use-auto-refresh';
import { useAuth } from '@/contexts/AuthContext';

interface CashOrderRow {
  id: string;
  customer_id: string;
  invoice_number: string;
  currency: Currency;
  total_amount: number;
  total_paid: number;
  remaining_balance: number;
  loyalty_jpy_amount: number | null;
  status: string;
  item_description: string | null;
  order_date: string | null;
  notes: string | null;
  agreement_version: string | null;
  agreement_acceptance_datetime: string | null;
  completed_at: string | null;
  cancellation_reason?: string | null;
  cancelled_at?: string | null;
  cancelled_by_user_id?: string | null;
  created_at: string;
  customers: { id: string; full_name: string } | null;
}

interface CashPaymentRow {
  id: string;
  cash_order_id: string;
  amount_paid: number;
  currency: Currency;
  date_paid: string;
  payment_method: string | null;
  reference_number: string | null;
  remarks: string | null;
  submitted_by_type: string | null;
  submitted_by_name: string | null;
  entered_by_user_id: string | null;
  voided_at: string | null;
  voided_by_user_id: string | null;
  void_reason: string | null;
  created_at: string;
}

interface SubmissionRow {
  id: string;
  cash_order_id: string;
  submitted_amount: number;
  payment_method: string | null;
  payment_date: string | null;
  sender_name: string | null;
  status: string;
  created_at: string;
}

interface CashOrderNoteRow {
  id: string;
  note_text: string;
  created_by_name: string | null;
  created_at: string;
}

interface AuditLogRow {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  new_value_json: any;
  old_value_json: any;
  performed_by_user_id: string | null;
  created_at: string;
}

function useCashOrderDetail(id: string | undefined) {
  return useQuery({
    queryKey: ['cash-order', id],
    enabled: !!id,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('cash_orders')
        .select('*, customers(id, full_name)')
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      return (data as unknown as CashOrderRow) || null;
    },
  });
}

function useCashPayments(orderId: string | undefined) {
  return useQuery({
    queryKey: ['cash-payments', orderId],
    enabled: !!orderId,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('cash_payments')
        .select('*')
        .eq('cash_order_id', orderId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return ((data || []) as unknown as CashPaymentRow[]);
    },
  });
}

function useCashSubmissions(orderId: string | undefined) {
  return useQuery({
    queryKey: ['cash-submissions', orderId],
    enabled: !!orderId,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('payment_submissions')
        .select('id, cash_order_id, submitted_amount, payment_method, payment_date, sender_name, status, created_at')
        .eq('cash_order_id', orderId)
        .in('status', ['submitted', 'under_review', 'needs_clarification'])
        .order('created_at', { ascending: false });
      if (error) throw error;
      return ((data || []) as unknown as SubmissionRow[]);
    },
  });
}

function useCashOrderNotes(orderId: string | undefined) {
  return useQuery({
    queryKey: ['cash-order-notes', orderId],
    enabled: !!orderId,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('account_notes' as any)
        .select('id, note_text, created_by_name, created_at')
        .eq('cash_order_id' as any, orderId!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return ((data || []) as unknown as CashOrderNoteRow[]);
    },
  });
}

function useProfileName(userId: string | null | undefined) {
  return useQuery({
    queryKey: ['profile-name', userId],
    enabled: !!userId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data } = await supabase
        .from('profiles')
        .select('user_id, full_name')
        .eq('user_id', userId!)
        .maybeSingle();
      return (data as { user_id: string; full_name: string | null } | null) ?? null;
    },
  });
}

function useCashAuditLogs(orderId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['cash-audit-logs', orderId],
    enabled: !!orderId && enabled,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('audit_logs')
        .select('id, action, entity_type, entity_id, new_value_json, old_value_json, performed_by_user_id, created_at')
        .eq('entity_type', 'cash_order')
        .eq('entity_id', orderId!)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return ((data || []) as unknown as AuditLogRow[]);
    },
  });
}

export default function CashOrderDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { roles, loading: authLoading } = useAuth();
  const rolesArr = roles as any[];
  const isAdmin = rolesArr.includes('admin');
  const isFinance = rolesArr.includes('finance');
  const isStaff = rolesArr.includes('staff');
  const isCustomerOnly = !isAdmin && !isFinance && !isStaff;

  // Customer-only users go to their portal (no admin detail view access)
  useEffect(() => {
    if (!authLoading && isCustomerOnly) navigate('/', { replace: true });
  }, [authLoading, isCustomerOnly, navigate]);

  const { data: order, isLoading: orderLoading } = useCashOrderDetail(id);
  const { data: payments, isLoading: paymentsLoading } = useCashPayments(id);
  const { data: submissions } = useCashSubmissions(id);
  const { data: notes } = useCashOrderNotes(id);
  const { data: cancelledByProfile } = useProfileName(
    order?.status === 'cancelled' ? order?.cancelled_by_user_id : undefined,
  );
  const [auditOpen, setAuditOpen] = useState(false);
  const { data: auditLogs } = useCashAuditLogs(id, isAdmin && auditOpen);

  // Record payment dialog state
  const [recordOpen, setRecordOpen] = useState(false);

  // Note form state
  const [noteFormOpen, setNoteFormOpen] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);

  // 30-second auto-refresh + manual button
  const { refreshing, refresh } = useAutoRefresh(
    [
      ['cash-order', id],
      ['cash-payments', id],
      ['cash-submissions', id],
      ['cash-order-notes', id],
    ],
    30_000,
  );

  // Cancel dialog
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);

  const confirmCancel = useCallback(async () => {
    if (!order || !cancelReason.trim()) {
      toast.error('Please enter a cancellation reason');
      return;
    }
    setCancelling(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await (supabase as any)
        .from('cash_orders')
        .update({
          status: 'cancelled',
          cancellation_reason: cancelReason.trim(),
          cancelled_at: new Date().toISOString(),
          cancelled_by_user_id: user?.id ?? null,
        })
        .eq('id', order.id);
      if (error) throw error;
      toast.success(`Cash order #${order.invoice_number} cancelled`);
      setCancelOpen(false);
      setCancelReason('');
      qc.invalidateQueries({ queryKey: ['cash-order', id] });
      qc.invalidateQueries({ queryKey: ['cash-orders'] });
    } catch (err: unknown) {
      toast.error((err as Error).message || 'Failed to cancel');
    } finally {
      setCancelling(false);
    }
  }, [order, cancelReason, qc, id]);

  // Void dialog
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidPaymentId, setVoidPaymentId] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [voiding, setVoiding] = useState(false);

  const openVoid = (paymentId: string) => {
    setVoidPaymentId(paymentId);
    setVoidReason('');
    setVoidOpen(true);
  };

  const confirmVoid = useCallback(async () => {
    if (!voidPaymentId || !voidReason.trim()) {
      toast.error('Please enter a void reason');
      return;
    }
    setVoiding(true);
    try {
      const { error } = await supabase.functions.invoke('void-cash-payment', {
        body: { cash_payment_id: voidPaymentId, void_reason: voidReason.trim() },
      });
      if (error) {
        let msg = error.message || 'Failed to void payment';
        try {
          if ('context' in error && (error as any).context?.body) {
            const body = await new Response((error as any).context.body).json();
            if (body?.error) msg = body.error;
          }
        } catch { /* ignore */ }
        throw new Error(msg);
      }
      toast.success('Payment voided');
      setVoidOpen(false);
      setVoidPaymentId(null);
      setVoidReason('');
      qc.invalidateQueries({ queryKey: ['cash-order', id] });
      qc.invalidateQueries({ queryKey: ['cash-payments', id] });
    } catch (err: unknown) {
      toast.error((err as Error).message || 'Failed to void payment');
    } finally {
      setVoiding(false);
    }
  }, [voidPaymentId, voidReason, qc, id]);

  const nonVoidedPayments = useMemo(
    () => (payments || []).filter(p => !p.voided_at),
    [payments],
  );

  if (orderLoading) {
    return (
      <AppLayout>
        <div className="max-w-3xl animate-fade-in space-y-4">
          <Skeleton className="h-14 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
      </AppLayout>
    );
  }

  if (!order) {
    return (
      <AppLayout>
        <div className="max-w-3xl animate-fade-in">
          <div className="rounded-xl border border-border bg-card p-12 text-center">
            <Banknote className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-40" />
            <p className="text-sm text-muted-foreground">Cash order not found</p>
            <Link to="/customers?tab=cash" className="inline-block mt-4">
              <Button variant="outline" size="sm">Back to Cash Orders</Button>
            </Link>
          </div>
        </div>
      </AppLayout>
    );
  }

  const currency = order.currency as Currency;
  const canRecordPayment = (isAdmin || isFinance || isStaff) && order.status === 'pending';
  const canCancel = isAdmin && order.status === 'pending';
  const canVoid = isAdmin || isFinance;

  return (
    <AppLayout>
      <div className="animate-fade-in max-w-3xl space-y-6">
        {/* Header */}
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-start gap-4">
            <Link to="/customers?tab=cash">
              <Button variant="ghost" size="icon" className="text-muted-foreground">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl gold-gradient shrink-0">
                <Banknote className="h-5 w-5 text-primary-foreground" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h1 className="text-xl sm:text-2xl font-bold text-foreground font-display truncate">
                    Cash Order #{order.invoice_number}
                  </h1>
                  <StatusBadge status={order.status} />
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {order.customers && (
                    <Link
                      to={`/customers/${order.customers.id}`}
                      className="flex items-center gap-1 hover:text-primary transition-colors"
                    >
                      <UserIcon className="h-3 w-3" />
                      {order.customers.full_name}
                    </Link>
                  )}
                  {order.order_date && (
                    <span>Order date: {order.order_date}</span>
                  )}
                  <span className="font-semibold text-foreground/70">{currency}</span>
                </div>
                {order.status === 'cancelled' && order.cancelled_at && (
                  <p className="mt-2 text-xs text-destructive">
                    Cancelled on {new Date(order.cancelled_at).toLocaleString()}
                    {' '}by {cancelledByProfile?.full_name || 'Unknown user'}
                    {order.cancellation_reason ? ` — ${order.cancellation_reason}` : ''}
                  </p>
                )}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => refresh()}
              disabled={refreshing}
              className="shrink-0 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              title="Refresh"
            >
              <RefreshCcw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>

        {/* Amount card */}
        <div className="rounded-xl border border-primary/30 bg-card p-6 shadow-sm">
          <div className="grid grid-cols-3 gap-4">
            <div className="text-center">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Total</p>
              <p className="mt-1 text-lg sm:text-xl font-bold text-card-foreground tabular-nums">
                {formatCurrency(Number(order.total_amount), currency)}
              </p>
            </div>
            <div className="text-center border-x border-border">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Paid</p>
              <p className="mt-1 text-lg sm:text-xl font-bold text-success tabular-nums">
                {formatCurrency(Number(order.total_paid), currency)}
              </p>
            </div>
            <div className="text-center">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Remaining</p>
              <p className="mt-1 text-lg sm:text-xl font-bold text-primary tabular-nums">
                {formatCurrency(Number(order.remaining_balance), currency)}
              </p>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          {canRecordPayment && (
            <Button
              className="gold-gradient text-primary-foreground font-medium shadow"
              onClick={() => setRecordOpen(true)}
            >
              <Receipt className="h-4 w-4 mr-1.5" />
              Record Payment
            </Button>
          )}
          {canCancel && (
            <Button
              variant="outline"
              className="border-destructive/30 text-destructive hover:bg-destructive/10"
              onClick={() => setCancelOpen(true)}
            >
              <XCircle className="h-4 w-4 mr-1.5" />
              Cancel Order
            </Button>
          )}
        </div>

        {/* Item details */}
        <div className="rounded-xl border border-border bg-card p-5 space-y-3">
          <h3 className="text-sm font-semibold text-card-foreground">Item Details</h3>
          {order.item_description && (
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Item</p>
              <p className="text-sm text-card-foreground mt-0.5">{order.item_description}</p>
            </div>
          )}
          {order.notes && (
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Notes</p>
              <p className="text-sm text-card-foreground mt-0.5 whitespace-pre-wrap">{order.notes}</p>
            </div>
          )}
          {isAdmin && order.loyalty_jpy_amount != null && (
            <p className="text-[11px] text-muted-foreground pt-1 border-t border-border/50">
              Product Value (Loyalty pts): ¥{Number(order.loyalty_jpy_amount).toLocaleString()}
            </p>
          )}
        </div>

        {/* Payment history */}
        <div className="rounded-xl border border-border bg-card p-5">
          <h3 className="text-sm font-semibold text-card-foreground mb-3">Payment History</h3>
          {paymentsLoading ? (
            <Skeleton className="h-20 rounded-lg" />
          ) : (payments || []).length === 0 ? (
            <p className="text-sm text-muted-foreground italic">No payments yet</p>
          ) : (
            <div className="space-y-2">
              {payments!.map(p => {
                const voided = !!p.voided_at;
                return (
                  <div
                    key={p.id}
                    className={`rounded-lg border p-3 ${
                      voided ? 'border-destructive/20 bg-destructive/5' : 'border-border bg-background'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`text-sm font-bold tabular-nums ${voided ? 'line-through text-muted-foreground' : 'text-card-foreground'}`}>
                            {formatCurrency(Number(p.amount_paid), (p.currency || currency) as Currency)}
                          </span>
                          {voided && (
                            <Badge variant="outline" className="text-[10px] bg-destructive/10 text-destructive border-destructive/30">
                              VOIDED
                            </Badge>
                          )}
                          {p.payment_method && (
                            <Badge variant="outline" className="text-[10px]">
                              {p.payment_method}
                            </Badge>
                          )}
                          {p.submitted_by_type && (
                            <span className="text-[10px] text-muted-foreground">
                              · {p.submitted_by_type}
                            </span>
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                          <span>Paid {p.date_paid}</span>
                          {p.reference_number && <span>Ref: {p.reference_number}</span>}
                          {p.submitted_by_name && <span>By: {p.submitted_by_name}</span>}
                        </div>
                        {p.remarks && (
                          <p className="text-[11px] text-muted-foreground mt-1 italic">{p.remarks}</p>
                        )}
                        {voided && (
                          <div className="mt-2 rounded-md border border-destructive/20 bg-card p-2 space-y-0.5">
                            <p className="text-[11px]">
                              <span className="text-muted-foreground">Reason:</span>{' '}
                              <span className="text-destructive">{p.void_reason || '—'}</span>
                            </p>
                            <p className="text-[10px] text-muted-foreground">
                              Voided {p.voided_at ? new Date(p.voided_at).toLocaleString() : ''}
                            </p>
                          </div>
                        )}
                      </div>
                      {!voided && canVoid && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => openVoid(p.id)}
                          className="text-muted-foreground hover:text-destructive shrink-0 h-7 text-[11px]"
                        >
                          <XCircle className="h-3.5 w-3.5 mr-1" />
                          Void
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
              {nonVoidedPayments.length > 0 && (
                <p className="pt-1 text-[11px] text-muted-foreground">
                  {nonVoidedPayments.length} active · {(payments!.length - nonVoidedPayments.length)} voided
                </p>
              )}
            </div>
          )}
        </div>

        {/* Payment submissions (admin/finance/staff) */}
        {(isAdmin || isFinance || isStaff) && (
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-card-foreground">Pending Submissions</h3>
              <Link to="/payments-hub" className="text-[11px] text-primary hover:underline">
                Review in Submissions →
              </Link>
            </div>
            {(submissions || []).length === 0 ? (
              <p className="text-sm text-muted-foreground italic">No pending submissions</p>
            ) : (
              <div className="space-y-2">
                {submissions!.map(s => (
                  <div key={s.id} className="rounded-lg border border-border bg-background p-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-card-foreground tabular-nums">
                          {formatCurrency(Number(s.submitted_amount), currency)}
                        </span>
                        <Badge variant="outline" className="text-[10px] capitalize">
                          {s.status.replace('_', ' ')}
                        </Badge>
                        {s.payment_method && (
                          <Badge variant="outline" className="text-[10px]">{s.payment_method}</Badge>
                        )}
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        {s.payment_date} {s.sender_name ? `· ${s.sender_name}` : ''}
                      </div>
                    </div>
                    <Link to="/payments-hub">
                      <Button variant="outline" size="sm" className="h-7 text-[11px]">Review</Button>
                    </Link>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Account Notes */}
        {(isAdmin || isFinance || isStaff) && (
          <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-card-foreground flex items-center gap-2">
                <MessageCircle className="h-4 w-4 text-primary" /> Account Notes
              </h3>
              {!noteFormOpen && (isAdmin || isStaff) && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs border-primary/30 text-primary hover:bg-primary/10"
                  onClick={() => setNoteFormOpen(true)}
                >
                  <Plus className="h-3 w-3 mr-1" /> Add Note
                </Button>
              )}
            </div>

            {noteFormOpen && (isAdmin || isStaff) && (
              <div className="mb-4 rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-2">
                <textarea
                  className="w-full rounded-md border border-border bg-background p-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-primary"
                  rows={4}
                  maxLength={1000}
                  placeholder="Type a note..."
                  value={noteText}
                  onChange={e => setNoteText(e.target.value)}
                />
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground">{noteText.length}/1000</span>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => { setNoteFormOpen(false); setNoteText(''); }}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      className="h-7 text-xs gold-gradient text-primary-foreground"
                      disabled={noteSaving || !noteText.trim()}
                      onClick={async () => {
                        if (!order) return;
                        setNoteSaving(true);
                        try {
                          const { data: { user } } = await supabase.auth.getUser();
                          const userName = (user?.user_metadata as any)?.full_name || user?.email || 'Unknown';
                          const { error } = await supabase.from('account_notes' as any).insert({
                            account_id: null,
                            cash_order_id: order.id,
                            note_text: noteText.trim(),
                            created_by_user_id: user?.id,
                            created_by_name: userName,
                          } as any);
                          if (error) throw error;
                          toast.success('Note added');
                          setNoteText('');
                          setNoteFormOpen(false);
                          qc.invalidateQueries({ queryKey: ['cash-order-notes', id] });
                        } catch (err: unknown) {
                          toast.error((err as Error).message || 'Failed to add note');
                        } finally {
                          setNoteSaving(false);
                        }
                      }}
                    >
                      {noteSaving ? 'Saving…' : 'Save Note'}
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {(!notes || notes.length === 0) && !noteFormOpen && (
              <p className="text-xs text-muted-foreground text-center py-4">No notes yet</p>
            )}

            {notes && notes.length > 0 && (
              <div className="space-y-2">
                {notes.map(note => (
                  <div key={note.id} className="rounded-lg border border-border bg-muted/30 p-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-card-foreground">{note.created_by_name || 'Unknown'}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {new Date(note.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground whitespace-pre-wrap">{note.note_text}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Activity Log (admin only, collapsible) */}
        {isAdmin && (
          <div className="rounded-xl border border-border bg-card">
            <button
              type="button"
              onClick={() => setAuditOpen(v => !v)}
              className="w-full flex items-center justify-between p-5 text-sm font-semibold text-card-foreground hover:bg-muted/40 transition-colors rounded-xl"
            >
              <span>Activity Log</span>
              {auditOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
            {auditOpen && (
              <div className="px-5 pb-5 pt-0 border-t border-border/60 space-y-2">
                {(auditLogs || []).length === 0 ? (
                  <p className="text-sm text-muted-foreground italic pt-4">No activity recorded yet</p>
                ) : (
                  auditLogs!.map(log => (
                    <div key={log.id} className="rounded-lg border border-border/60 bg-background p-3">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <span className="text-xs font-medium text-card-foreground capitalize">
                          {log.action.replace(/_/g, ' ')}
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          {new Date(log.created_at).toLocaleString()}
                        </span>
                      </div>
                      {log.new_value_json && (
                        <pre className="mt-1 text-[10px] text-muted-foreground bg-muted/40 p-2 rounded overflow-x-auto">
                          {JSON.stringify(log.new_value_json, null, 2)}
                        </pre>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Record Cash Payment */}
      {canRecordPayment && (
        <RecordCashPaymentDialog
          isOpen={recordOpen}
          onClose={() => setRecordOpen(false)}
          cashOrder={{
            id: order.id,
            invoice_number: order.invoice_number,
            customer_id: order.customer_id,
            currency,
            total_amount: Number(order.total_amount),
            total_paid: Number(order.total_paid),
            remaining_balance: Number(order.remaining_balance),
            customer: order.customers ? { full_name: order.customers.full_name } : null,
          }}
          onSuccess={() => {
            qc.invalidateQueries({ queryKey: ['cash-order', id] });
            qc.invalidateQueries({ queryKey: ['cash-payments', id] });
            qc.invalidateQueries({ queryKey: ['cash-submissions', id] });
          }}
        />
      )}

      {/* Cancel confirmation */}
      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Cancel Cash Order
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This marks cash order #{order.invoice_number} as cancelled. This action cannot be undone from the UI.
          </p>
          <div className="space-y-2">
            <Label htmlFor="cancel-reason">Reason *</Label>
            <Input
              id="cancel-reason"
              value={cancelReason}
              onChange={e => setCancelReason(e.target.value)}
              placeholder="Why is this order being cancelled?"
              className="bg-background border-border"
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setCancelOpen(false)} disabled={cancelling}>
              Back
            </Button>
            <Button
              variant="destructive"
              onClick={confirmCancel}
              disabled={cancelling || !cancelReason.trim()}
            >
              {cancelling ? 'Cancelling…' : 'Confirm Cancel'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Void confirmation */}
      <Dialog open={voidOpen} onOpenChange={setVoidOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <XCircle className="h-5 w-5 text-destructive" />
              Void Cash Payment
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Voiding will reverse this payment against the cash order totals. If the order was already marked completed, it will revert to pending.
          </p>
          <div className="space-y-2">
            <Label htmlFor="void-reason">Reason *</Label>
            <Input
              id="void-reason"
              value={voidReason}
              onChange={e => setVoidReason(e.target.value)}
              placeholder="Why is this payment being voided?"
              className="bg-background border-border"
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setVoidOpen(false)} disabled={voiding}>
              Back
            </Button>
            <Button
              variant="destructive"
              onClick={confirmVoid}
              disabled={voiding || !voidReason.trim()}
            >
              {voiding ? 'Voiding…' : 'Confirm Void'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
