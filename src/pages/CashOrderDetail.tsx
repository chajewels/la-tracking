import { useState, useMemo, useCallback, useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowLeft, Banknote, RefreshCcw, Upload, XCircle,
  AlertTriangle, User as UserIcon, MessageCircle, Plus,
  CalendarClock, Send, Eye, CheckCircle, MessageSquare, FileText,
  Image as ImageIcon, Clock, Pencil, RotateCcw, Settings, Copy, Check, Sparkles, Trash2,
} from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import StatusBadge from '@/components/customers/StatusBadge';
import RecordCashPaymentDialog from '@/components/customers/RecordCashPaymentDialog';
import InvoiceGeneratorSheet from '@/components/invoices/InvoiceGeneratorSheet';
import ApplyStoreCreditCard from '@/components/orders/ApplyStoreCreditCard';
import { Currency } from '@/lib/types';
import { formatCurrency } from '@/lib/calculations';
import { getConversionRate } from '@/lib/currency-converter';
import { CashOrderTimeline } from '@/components/accounts/PaymentTimeline';
import ProgressRing from '@/components/shared/ProgressRing';
import TypedConfirmField from '@/components/forms/TypedConfirmField';
import AccountStatement from '@/components/statements/AccountStatement';
import { supabase } from '@/integrations/supabase/client';
import ShipmentTrackingCard from '@/components/shipping/ShipmentTrackingCard';
import { getProofSignedUrl } from '@/lib/proof-url';
import { useAutoRefresh } from '@/hooks/use-auto-refresh';
import { useDeleteCashOrder } from '@/hooks/use-supabase-data';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import { useCustomerLoyaltyTier } from '@/hooks/useCustomerLoyaltyTier';
import LoyaltyTierBadge from '@/components/loyalty/LoyaltyTierBadge';
import ServiceJobsSection from '@/components/services/ServiceJobsSection';
import { getPortalLinkForCustomer } from '@/lib/portal-link';

// Shape of cancel-cash-order's preview response (preview:true writes nothing).
interface CancelPreview {
  invoice_number?: string;
  status?: string;
  currency?: string;
  money_received?: number;
  loyalty_redemption_excluded?: number;
  store_credit_to_issue?: number;
  earned_points_will_be_revoked?: boolean;
}

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
  expires_at: string | null;
  expired_at: string | null;
  notes: string | null;
  agreement_version: string | null;
  agreement_acceptance_datetime: string | null;
  completed_at: string | null;
  cancellation_reason?: string | null;
  cancelled_at?: string | null;
  cancelled_by_user_id?: string | null;
  created_at: string;
  is_trade?: boolean;
  discount_amount: number | null;
  discount_type: string | null;
  discount_value: number | null;
  shipping_fee: number | null;
  // Shipment tracking (select('*') already fetches these; declaring them so
  // ShipmentTrackingCard receives typed props instead of casts).
  shipping_method_id: string | null;
  tracking_number: string | null;
  shipped_at: string | null;
  tracking_set_by: string | null;
  tracking_updated_at: string | null;
  customers: {
    id: string;
    full_name: string;
    address_line1: string | null;
    city: string | null;
    postal_code: string | null;
    country: string | null;
    mobile_number: string | null;
    messenger_link: string | null;
  } | null;
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
  reference_number: string | null;
  proof_url: string | null;
  notes: string | null;
  reviewer_notes: string | null;
  customer_edited_at: string | null;
  submission_type: string | null;
  status: string;
  created_at: string;
}

interface CashOrderNoteRow {
  id: string;
  note_text: string;
  created_by_name: string | null;
  created_at: string;
}

interface CashOrderItemRow {
  id: string;
  title: string;
  sku: string | null;
  quantity: number;
  unit_price_jpy: number;
  line_total_jpy: number;
  image_url: string | null;
}

function useCashOrderDetail(id: string | undefined) {
  return useQuery({
    queryKey: ['cash-order', id],
    enabled: !!id,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('cash_orders')
        .select('*, customers(id, full_name, address_line1, city, postal_code, country, mobile_number, messenger_link)')
        .eq('id', id!)
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
      const { data, error } = await supabase
        .from('cash_payments')
        .select('*')
        .eq('cash_order_id', orderId!)
        .order('created_at', { ascending: true });
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
      const { data, error } = await supabase
        .from('payment_submissions')
        .select('id, cash_order_id, submitted_amount, payment_method, payment_date, sender_name, reference_number, proof_url, notes, reviewer_notes, customer_edited_at, submission_type, status, created_at')
        .eq('cash_order_id', orderId!)
        .in('status', ['submitted', 'under_review', 'needs_clarification'])
        .order('created_at', { ascending: false });
      if (error) throw error;
      return ((data || []) as unknown as SubmissionRow[]);
    },
  });
}

function useCashSubmissionProofs(orderId: string | undefined) {
  return useQuery({
    queryKey: ['cash-submission-proofs', orderId],
    enabled: !!orderId,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('payment_submissions')
        .select('proof_url, payment_date, sender_name')
        .eq('cash_order_id', orderId!)
        .eq('status', 'confirmed')
        .not('proof_url', 'is', null)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []) as Array<{ proof_url: string; payment_date: string; sender_name: string | null }>;
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
        .from('account_notes')
        .select('id, note_text, created_by_name, created_at')
        .eq('cash_order_id', orderId!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return ((data || []) as unknown as CashOrderNoteRow[]);
    },
  });
}

function useCashOrderItems(orderId: string | undefined) {
  return useQuery({
    queryKey: ['cash-order-items', orderId],
    enabled: !!orderId,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('cash_order_items')
        .select('id, title, sku, quantity, unit_price_jpy, line_total_jpy, image_url')
        .eq('cash_order_id', orderId!)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return ((data || []) as unknown as CashOrderItemRow[]);
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

// Mirrors PaymentSubmissions.tsx so the inline pending panel matches the
// shared review surface visually.
const submissionStatusConfig: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  submitted: { label: 'Submitted', color: 'bg-blue-500/10 text-blue-500 border-blue-500/20', icon: <Send className="h-3 w-3" /> },
  under_review: { label: 'Under Review', color: 'bg-warning/10 text-warning border-warning/20', icon: <Eye className="h-3 w-3" /> },
  confirmed: { label: 'Confirmed', color: 'bg-success/10 text-success border-success/20', icon: <CheckCircle className="h-3 w-3" /> },
  rejected: { label: 'Rejected', color: 'bg-destructive/10 text-destructive border-destructive/20', icon: <XCircle className="h-3 w-3" /> },
  needs_clarification: { label: 'Needs Clarification', color: 'bg-warning/10 text-warning border-warning/20', icon: <MessageSquare className="h-3 w-3" /> },
};

/** Render a proof-of-payment image via a short-lived signed URL.
 *  The payment-proofs bucket is PRIVATE — mints a signed URL on demand. */
function ProofImage({ url, className }: { url: string; className?: string }) {
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
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <ImageIcon className="h-3.5 w-3.5" /> Proof unavailable
      </span>
    );
  }
  if (!src) {
    return <span className="text-xs text-muted-foreground">Loading proof…</span>;
  }
  return (
    <img src={src} alt="Proof of payment" className={className}
      onError={() => setImgError(true)} />
  );
}

export default function CashOrderDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { roles, loading: authLoading } = useAuth();
  const { can } = usePermissions();
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
  const [statementOpen, setStatementOpen] = useState(false);
  const { data: submissions } = useCashSubmissions(id);
  const { data: orderItems } = useCashOrderItems(id);
  const { data: submissionProofs } = useCashSubmissionProofs(id);
  const proofByDate = useMemo(() => {
    const map = new Map<string, { url: string; sender: string }>();
    (submissionProofs || []).forEach((s) => {
      if (s.proof_url && s.payment_date && !map.has(s.payment_date)) {
        map.set(s.payment_date, {
          url: s.proof_url,
          sender: s.sender_name || 'Unknown',
        });
      }
    });
    return map;
  }, [submissionProofs]);
  const { data: notes } = useCashOrderNotes(id);
  const { data: cancelledByProfile } = useProfileName(
    order?.status === 'cancelled' ? order?.cancelled_by_user_id : undefined,
  );
  const { data: loyaltyTier } = useCustomerLoyaltyTier(order?.customer_id);

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
  // Cancellation is a money-moving action (auto-issues store credit + revokes
  // earned loyalty points) — preview the consequences before confirming.
  const [cancelPreview, setCancelPreview] = useState<CancelPreview | null>(null);
  const [cancelPreviewLoading, setCancelPreviewLoading] = useState(false);
  const [cancelPreviewError, setCancelPreviewError] = useState<string | null>(null);

  // Edit expiry dialog
  const [editExpiryOpen, setEditExpiryOpen] = useState(false);
  const [editExpiryValue, setEditExpiryValue] = useState('');
  const [editExpirySaving, setEditExpirySaving] = useState(false);
  const openEditExpiry = useCallback(() => {
    if (!order) return;
    // Pre-fill with current expires_at as YYYY-MM-DD if set
    const initial = order.expires_at
      ? Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(order.expires_at))
      : '';
    setEditExpiryValue(initial);
    setEditExpiryOpen(true);
  }, [order]);
  const confirmEditExpiry = useCallback(async () => {
    if (!order || !editExpiryValue) {
      toast.error('Please pick a new expiration date');
      return;
    }
    setEditExpirySaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const oldExpiresAt = order.expires_at;
      const oldStatus = order.status;
      const newIso = new Date(editExpiryValue + 'T00:00:00Z').toISOString();

      // Bug #217: revive an expired order when the new expiry is in the future.
      // Same UPDATE call clears expired_at and flips status back to 'pending';
      // auto-expire-cash-orders cron will re-expire it correctly if the new date
      // passes (race-guard on status='pending' already handles that).
      const isReviving =
        oldStatus === 'expired' && new Date(newIso).getTime() > Date.now();

      const updatePayload: Record<string, unknown> = { expires_at: newIso };
      if (isReviving) {
        updatePayload.status = 'pending';
        updatePayload.expired_at = null;
      }

      const { error } = await supabase
        .from('cash_orders')
        .update(updatePayload as any)
        .eq('id', order.id);
      if (error) throw error;
      // Best-effort audit log
      try {
        await supabase.from('audit_logs').insert({
          entity_type: 'cash_order',
          entity_id: order.id,
          action: isReviving ? 'cash_order_revived' : 'expires_at_updated',
          performed_by_user_id: user?.id ?? null,
          old_value_json: { expires_at: oldExpiresAt, status: oldStatus },
          new_value_json: isReviving
            ? { expires_at: newIso, invoice_number: order.invoice_number, revived_from_status: 'expired' }
            : { expires_at: newIso, invoice_number: order.invoice_number },
        });
      } catch { /* non-blocking */ }
      if (isReviving) {
        const newLabel = new Intl.DateTimeFormat('en-US', {
          timeZone: 'Asia/Manila',
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }).format(new Date(newIso));
        toast.success(`Order revived — new expiration ${newLabel}`);
      } else {
        toast.success('Expiration date updated');
      }
      setEditExpiryOpen(false);
      qc.invalidateQueries({ queryKey: ['cash-order', id] });
      qc.invalidateQueries({ queryKey: ['cash-orders'] });
    } catch (err: unknown) {
      toast.error((err as Error).message || 'Failed to update expiration');
    } finally {
      setEditExpirySaving(false);
    }
  }, [order, editExpiryValue, qc, id]);

  // Manage Invoice dialog — admin-only total_amount correction (encode fixes).
  // Mirrors the layaway EditAccountDialog Manage Invoice flow. Loyalty
  // (loyalty_jpy_amount) is NEVER touched; total_paid is NEVER modified.
  const [manageOpen, setManageOpen] = useState(false);
  const [manageTotal, setManageTotal] = useState('');
  const [manageSaving, setManageSaving] = useState(false);
  // Business order date (cash_orders.order_date). NOT created_at — the DB
  // insert timestamp is an immutable audit fact and is never edited here.
  const [manageOrderDate, setManageOrderDate] = useState('');
  // Discount & shipping (descriptive; order currency). Model 1 — these do NOT
  // auto-change total_amount; the admin explicitly clicks "Apply to total".
  const [manageDiscountMode, setManageDiscountMode] = useState<'amount' | 'percent'>(order?.discount_type === 'percent' ? 'percent' : 'amount');
  const [manageDiscountInput, setManageDiscountInput] = useState('');
  const [manageShippingInput, setManageShippingInput] = useState('');

  // Items subtotal (line items are stored in JPY) → order currency.
  const manageItemsSubtotalJpy = (orderItems ?? []).reduce((s, li) => s + (Number(li.line_total_jpy) || Number(li.unit_price_jpy) * Number(li.quantity)), 0);
  const manageItemsSubtotalAcct = order?.currency === 'PHP' ? Math.round(manageItemsSubtotalJpy * getConversionRate()) : manageItemsSubtotalJpy;
  const manageDiscountAmount = manageDiscountMode === 'percent'
    ? Math.round(manageItemsSubtotalAcct * (parseFloat(manageDiscountInput) || 0) / 100)
    : Math.round(parseFloat(manageDiscountInput) || 0);
  const manageShippingFee = Math.round(parseFloat(manageShippingInput) || 0);
  const manageReconciledTotal = Math.max(0, manageItemsSubtotalAcct - manageDiscountAmount + manageShippingFee);
  const manageShowReconciliation = (orderItems ?? []).length > 0 || manageDiscountInput !== '' || manageShippingInput !== '';

  const openManageInvoice = useCallback(() => {
    if (!order) return;
    setManageTotal(String(Number(order.total_amount)));
    setManageOrderDate(String(order.order_date).slice(0, 10));
    setManageDiscountMode(order.discount_type === 'percent' ? 'percent' : 'amount');
    setManageDiscountInput(order.discount_type ? String(order.discount_value ?? '') : '');
    setManageShippingInput(order.shipping_fee ? String(order.shipping_fee) : '');
    setManageOpen(true);
  }, [order]);

  const confirmManageInvoice = useCallback(async () => {
    if (!order) return;
    setManageSaving(true);
    try {
      const newTotal = Math.round(parseFloat(manageTotal) * 100) / 100;
      if (isNaN(newTotal)) {
        toast.error('Enter a valid amount');
        setManageSaving(false);
        return;
      }
      // Skip the write entirely if nothing changed — total OR discount/shipping.
      const nextDiscountType = manageDiscountInput === '' ? null : manageDiscountMode;
      const nextDiscountValue = manageDiscountInput === '' ? null : (parseFloat(manageDiscountInput) || 0);
      const nextOrderDate = manageOrderDate.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(nextOrderDate) || isNaN(new Date(nextOrderDate).getTime())) {
        toast.error('Enter a valid order date');
        setManageSaving(false);
        return;
      }
      const dateChanged = nextOrderDate !== String(order.order_date).slice(0, 10);
      const totalChanged = newTotal !== Number(order.total_amount);
      const discountChanged =
        manageDiscountAmount !== Number(order.discount_amount || 0) ||
        nextDiscountType !== (order.discount_type ?? null) ||
        nextDiscountValue !== (order.discount_value ?? null);
      const shippingChanged = manageShippingFee !== Number(order.shipping_fee || 0);
      if (!totalChanged && !discountChanged && !shippingChanged && !dateChanged) {
        setManageOpen(false);
        setManageSaving(false);
        return;
      }

      const remaining_balance = Math.max(
        0,
        Math.round((newTotal - Number(order.total_paid)) * 100) / 100,
      );

      // Defensive admin gate: RLS allows staff UPDATE at row level, so this
      // frontend strip is the real gate. Non-admins never write total_amount.
      // Discount & shipping are descriptive and persisted alongside.
      const updatePayload: Record<string, unknown> = {
        total_amount: newTotal,
        remaining_balance,
        discount_amount: manageDiscountAmount,
        discount_type: nextDiscountType,
        discount_value: nextDiscountValue,
        shipping_fee: manageShippingFee,
        order_date: nextOrderDate,
      };
      if (!isAdmin) {
        delete (updatePayload as any).total_amount;
        delete (updatePayload as any).remaining_balance;
        delete (updatePayload as any).order_date;
      }
      if (Object.keys(updatePayload).length === 0) {
        toast.error('Only admins can edit the cash order total');
        setManageSaving(false);
        return;
      }

      const { error } = await supabase
        .from('cash_orders')
        .update(updatePayload as any)
        .eq('id', order.id);
      if (error) throw error;

      // Best-effort audit log
      try {
        await supabase.from('audit_logs').insert({
          entity_type: 'cash_order',
          entity_id: order.id,
          action: 'cash_order_total_edited',
          old_value_json: {
            total_amount: Number(order.total_amount),
            remaining_balance: Number(order.remaining_balance),
            order_date: String(order.order_date).slice(0, 10),
          },
          new_value_json: { total_amount: newTotal, remaining_balance, order_date: nextOrderDate },
          performed_by_user_id: (await supabase.auth.getUser()).data.user?.id ?? null,
        });
      } catch { /* non-blocking */ }

      toast.success('Cash order total updated');
      setManageOpen(false);
      qc.invalidateQueries({ queryKey: ['cash-order', id] });
      qc.invalidateQueries({ queryKey: ['cash-orders'] });
      qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
      qc.invalidateQueries({ queryKey: ['daily-cash-orders'] });
      qc.invalidateQueries({ queryKey: ['daily-cash-orders-last-month'] });
    } catch (err: unknown) {
      toast.error((err as Error).message || 'Failed to update total');
    } finally {
      setManageSaving(false);
    }
  }, [order, manageTotal, manageOrderDate, manageDiscountAmount, manageDiscountMode, manageDiscountInput, manageShippingFee, isAdmin, qc, id]);

  const confirmCancel = useCallback(async () => {
    if (!order || !cancelReason.trim()) {
      toast.error('Please enter a cancellation reason');
      return;
    }
    setCancelling(true);
    try {
      const { data, error } = await supabase.functions.invoke('cancel-cash-order', {
        body: { cash_order_id: order.id, reason: cancelReason.trim() },
      });
      if (error) {
        let msg = error.message || 'Failed to cancel';
        try {
          if ('context' in error && (error as any).context?.body) {
            const b = await new Response((error as any).context.body).json();
            if (b?.error) msg = b.error;
          }
        } catch { /* ignore */ }
        throw new Error(msg);
      }
      if ((data as any)?.error) throw new Error((data as any).error);
      const storeCredit = (data as any)?.store_credit ?? null;
      if (storeCredit) {
        const moneyReceived = Number((data as any)?.money_received ?? 0);
        toast.success(
          `Cash order #${order.invoice_number} cancelled — ${formatCurrency(moneyReceived, order.currency as Currency)} store credit issued`,
        );
      } else {
        toast.success(`Cash order #${order.invoice_number} cancelled`);
      }
      setCancelOpen(false);
      setCancelReason('');
      qc.invalidateQueries({ queryKey: ['cash-order', id] });
      qc.invalidateQueries({ queryKey: ['cash-orders'] });
      qc.invalidateQueries({ queryKey: ['cash-payments', id] });
      qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
      qc.invalidateQueries({ queryKey: ['store-credit-lots', order.customer_id] });
      qc.invalidateQueries({ queryKey: ['store-credit-txns', order.customer_id] });
    } catch (err: unknown) {
      toast.error((err as Error).message || 'Failed to cancel');
    } finally {
      setCancelling(false);
    }
  }, [order, cancelReason, qc, id]);

  // Load the cancellation preview (money-moving consequences) whenever the
  // cancel dialog opens — preview:true writes nothing on the server.
  useEffect(() => {
    if (!cancelOpen || !order) return;
    let cancelled = false;
    setCancelPreview(null);
    setCancelPreviewError(null);
    setCancelPreviewLoading(true);
    (async () => {
      try {
        const { data, error } = await supabase.functions.invoke('cancel-cash-order', {
          body: { cash_order_id: order.id, reason: '', preview: true },
        });
        if (error) {
          let msg = error.message || 'Failed to load cancellation preview';
          try {
            if ('context' in error && (error as any).context?.body) {
              const b = await new Response((error as any).context.body).json();
              if (b?.error) msg = b.error;
            }
          } catch { /* ignore */ }
          throw new Error(msg);
        }
        if ((data as any)?.error) throw new Error((data as any).error);
        if (!cancelled) setCancelPreview(data as CancelPreview);
      } catch (err: unknown) {
        if (!cancelled) setCancelPreviewError((err as Error).message || 'Failed to load cancellation preview');
      } finally {
        if (!cancelled) setCancelPreviewLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [cancelOpen, order]);

  // Typed-confirmation gates (Phase 5) — arm existing buttons only.
  const [cancelArmed, setCancelArmed] = useState(false);
  const [voidArmed, setVoidArmed] = useState(false);
  // Items image zoom
  const [zoomImage, setZoomImage] = useState<string | null>(null);
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

  const [restoringId, setRestoringId] = useState<string | null>(null);

  const handleRestoreCashPayment = useCallback(async (cashPaymentId: string) => {
    setRestoringId(cashPaymentId);
    try {
      const { error } = await supabase.functions.invoke('restore-cash-payment', {
        body: { cash_payment_id: cashPaymentId },
      });
      if (error) {
        let msg = error.message || 'Failed to restore payment';
        try {
          if ('context' in error && (error as any).context?.body) {
            const body = await new Response((error as any).context.body).json();
            if (body?.error) msg = body.error;
          }
        } catch { /* ignore */ }
        throw new Error(msg);
      }
      toast.success('Payment restored');
      qc.invalidateQueries({ queryKey: ['cash-order', id] });
      qc.invalidateQueries({ queryKey: ['cash-payments', id] });
    } catch (err: unknown) {
      toast.error((err as Error).message || 'Failed to restore payment');
    } finally {
      setRestoringId(null);
    }
  }, [qc, id]);

  const nonVoidedPayments = useMemo(
    () => (payments || []).filter(p => !p.voided_at),
    [payments],
  );

  // ── Customer message (mirrors AccountDetail.tsx:189-216, 858-870) ──
  // Hooks must stay ABOVE the orderLoading / !order early returns below.
  const cashCustomerId = order?.customer_id;
  const { data: portalToken } = useQuery({
    queryKey: ['portal-token', cashCustomerId],
    enabled: !!cashCustomerId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data } = await supabase
        .from('customer_portal_tokens')
        .select('token')
        .eq('customer_id', cashCustomerId!)
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      return data?.token || null;
    },
  });
  const { data: authUserId } = useQuery({
    queryKey: ['customer_auth_user_id', cashCustomerId],
    enabled: !!cashCustomerId,
    queryFn: async () => {
      const { data } = await supabase
        .from('customers')
        .select('auth_user_id')
        .eq('id', cashCustomerId!)
        .maybeSingle();
      return ((data as any)?.auth_user_id as string | null) ?? null;
    },
  });
  const [copied, setCopied] = useState(false);
  const [awardingLoyalty, setAwardingLoyalty] = useState(false);
  const deleteCashOrder = useDeleteCashOrder();
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const message = useMemo(() => {
    if (!order) return '';
    const cur = order.currency as Currency;
    const hasAuthMeans = !!authUserId || !!portalToken;
    const portalUrl = hasAuthMeans
      ? getPortalLinkForCustomer(
          { auth_user_id: authUserId ?? null, portal_token: portalToken ?? null },
          'portal',
        )
      : null;

    const _pinDigits = (order.customers?.mobile_number ?? '').replace(/\D/g, '');
    const customerPin = _pinDigits.length >= 4 ? _pinDigits.slice(-4) : null;
    const pinLine = (!!portalToken && !authUserId && customerPin)
      ? `🔐 Your portal PIN is the last 4 digits of your mobile number on file: ${customerPin}\n`
      : '';

    // Line items are stored in JPY and rendered as JPY in the Items card
    // above — keep the message consistent with that.
    const appendItemLines = (msg: string) => {
      const lines = orderItems ?? [];
      if (lines.length === 0) return msg;
      msg += `\nItems:\n`;
      lines.forEach((li) => {
        const qty = Number(li.quantity ?? 1);
        msg += `  • ${li.title}${qty > 1 ? ` x${qty}` : ''} — ${formatCurrency(Number(li.line_total_jpy ?? 0), 'JPY')}\n`;
      });
      return msg;
    };

    let msg = '';

    if (order.status === 'cancelled' || order.status === 'expired') {
      msg += order.status === 'cancelled'
        ? `⛔ NOTICE: This order has been CANCELLED.\n\n`
        : `⛔ NOTICE: This order has EXPIRED.\n\n`;
      msg += `Inv # ${order.invoice_number}\n`;
      msg += `Status: ${order.status === 'cancelled' ? 'CANCELLED' : 'EXPIRED'}\n`;
      msg += `\nFor any questions, please contact Cha Jewels directly.`;
      return msg;
    }

    if (order.status === 'completed') {
      msg += `Thank you for your payment. ${formatCurrency(Number(order.total_paid), cur)} has been received.\n\n`;
      msg += `Inv # ${order.invoice_number}\n`;
      msg += `Status: FULLY PAID\n`;
      msg = appendItemLines(msg);
      if (portalUrl) msg += `\nView your order details here:\n🔗 ${portalUrl}\n`;
      if (pinLine) msg += pinLine;
      msg += `\nThank you for your continued trust in Cha Jewels! 🧡`;
      return msg;
    }

    msg += `Inv # ${order.invoice_number}\n\n`;
    msg += `Total Amount: ${formatCurrency(Number(order.total_amount), cur)}\n`;
    msg += `Amount Paid: ${formatCurrency(Number(order.total_paid), cur)}\n`;
    msg += `Remaining Balance: ${formatCurrency(Number(order.remaining_balance), cur)}\n`;
    msg = appendItemLines(msg);
    if (portalUrl) msg += `\nView your order and payment details here:\n🔗 ${portalUrl}\n`;
    if (pinLine) msg += pinLine;
    if (order.expires_at) {
      const exp = new Date(order.expires_at).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      });
      msg += `\nPlease complete payment by: ${exp}\n`;
    }
    msg += `\nThank you for your continued trust in Cha Jewels! 🧡`;
    return msg;
  }, [order, orderItems, portalToken, authUserId]);

  const handleCopyMessage = () => {
    navigator.clipboard.writeText(message);
    setCopied(true);
    toast.success('Message copied to clipboard');
    setTimeout(() => setCopied(false), 2000);
  };

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
  const canCancel = isAdmin && (order.status === 'pending' || order.status === 'completed');
  const canVoid = isAdmin || isFinance;
  const canRestore = can('restore_payment');
  const canAwardLoyalty = can('loyalty_adjust_points');

  const handleAwardLoyalty = async () => {
    if (!order) return;
    setAwardingLoyalty(true);
    try {
      const { data, error } = await supabase.functions.invoke('award-loyalty-points', {
        body: { cash_order_id: order.id },
      });
      if (error) throw error;
      const res = data as Record<string, unknown> | null;
      if (res?.skipped) {
        toast.info(`No points awarded — ${String(res.reason ?? 'skipped')}`);
      } else if (res?.awarded) {
        const pts = Number(res.points_earned ?? 0);
        const bonus = Number(res.bonus_points ?? 0);
        toast.success(
          `Awarded ${pts.toLocaleString()} points${bonus > 0 ? ` (+${bonus.toLocaleString()} bonus)` : ''}` +
          (res.tier_upgraded ? ` — tier upgraded to ${String(res.new_tier)}` : '')
        );
        qc.invalidateQueries({ queryKey: ['cash-order', id] });
      } else {
        toast.error('Unexpected response from award-loyalty-points');
      }
    } catch (err) {
      toast.error((err as Error).message || 'Failed to award loyalty points');
    } finally {
      setAwardingLoyalty(false);
    }
  };

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
                  {order.shipped_at && (
                    <Badge
                      variant="outline"
                      className="bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-900/30 dark:text-emerald-200 dark:border-emerald-800 text-xs"
                    >
                      Shipped
                    </Badge>
                  )}
                  {order.is_trade && (
                    <Badge
                      variant="outline"
                      className="bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-900/30 dark:text-amber-200 dark:border-amber-800 text-xs"
                    >
                      🔄 Trade
                    </Badge>
                  )}
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
                  {loyaltyTier?.current_tier_name && (
                    <LoyaltyTierBadge tierName={loyaltyTier.current_tier_name} />
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
          {(() => {
            const hasLoyalty = order.loyalty_jpy_amount && Number(order.loyalty_jpy_amount) > 0;
            const showExpiry = !!order.expires_at || order.status === 'expired';
            const tileCount = 3 + (hasLoyalty ? 1 : 0) + (showExpiry ? 1 : 0);
            const gridClass =
              tileCount === 5 ? 'grid-cols-2 sm:grid-cols-5'
              : tileCount === 4 ? 'grid-cols-2 sm:grid-cols-4'
              : 'grid-cols-3';
            // Expiry color logic
            const expiresAtDate = order.expires_at ? new Date(order.expires_at) : null;
            const expiredAtDate = order.expired_at ? new Date(order.expired_at) : null;
            const daysRemaining = expiresAtDate
              ? Math.floor((expiresAtDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
              : null;
            const expiryColor = order.status === 'expired'
              ? 'text-destructive'
              : daysRemaining === null
                ? 'text-card-foreground'
                : daysRemaining < 0
                  ? 'text-destructive'
                  : daysRemaining <= 1
                    ? 'text-amber-500'
                    : 'text-success';
            return (
              <div className={`grid gap-4 ${gridClass}`}>
                <div className="text-center">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Total</p>
                  <p className="mt-1 text-lg sm:text-xl font-bold text-card-foreground tabular-nums">
                    {formatCurrency(Number(order.total_amount), currency)}
                  </p>
                </div>
                <div className="text-center border-l border-border">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Paid</p>
                  <p className="mt-1 text-lg sm:text-xl font-bold text-success tabular-nums">
                    {formatCurrency(Number(order.total_paid), currency)}
                  </p>
                </div>
                <div className="text-center border-l border-border">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Remaining</p>
                  <p className="mt-1 text-lg sm:text-xl font-bold text-primary tabular-nums">
                    {formatCurrency(Number(order.remaining_balance), currency)}
                  </p>
                </div>
                {hasLoyalty && (
                  <div className="text-center border-l border-border">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Loyalty Amount</p>
                    <p className="mt-1 text-lg sm:text-xl font-bold text-card-foreground tabular-nums">
                      ¥{Number(order.loyalty_jpy_amount).toLocaleString()}
                    </p>
                  </div>
                )}
                {showExpiry && (
                  <div className="text-center border-l border-border">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      {order.status === 'expired' ? 'Expired' : 'Expires'}
                    </p>
                    {order.status === 'expired' && expiredAtDate ? (
                      <>
                        <p className={`mt-1 text-sm font-bold ${expiryColor}`}>
                          {expiredAtDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </p>
                        <p className="text-[10px] text-destructive uppercase tracking-wide">forfeited</p>
                      </>
                    ) : expiresAtDate ? (
                      <>
                        <p className={`mt-1 text-sm font-bold ${expiryColor}`}>
                          {expiresAtDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </p>
                        <p className={`text-[10px] uppercase tracking-wide ${expiryColor}`}>
                          {daysRemaining === null
                            ? ''
                            : daysRemaining < 0
                              ? `${Math.abs(daysRemaining)}d overdue`
                              : daysRemaining === 0
                                ? 'today'
                                : daysRemaining === 1
                                  ? '1 day left'
                                  : `${daysRemaining} days left`}
                        </p>
                      </>
                    ) : (
                      <p className="mt-1 text-sm text-muted-foreground">—</p>
                    )}
                  </div>
                )}
              </div>
            );
          })()}
        </div>

        {/* Order Timeline + Progress (Phase 4) — stored columns and
            cash_payments rows only; % uses the CashOrdersList convention */}
        <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2 pb-3 hairline-b mb-4">
            <h3 className="text-sm font-semibold text-card-foreground">Order Timeline</h3>
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setStatementOpen(true)}>
              Statement
            </Button>
          </div>
          <div className="flex flex-col sm:flex-row gap-6">
            <div className="flex justify-center sm:block shrink-0">
              <ProgressRing
                percent={Number(order.total_amount) > 0 ? Math.round((Number(order.total_paid) / Number(order.total_amount)) * 100) : 0}
                label="paid"
              />
            </div>
            <div className="flex-1 min-w-0">
              <CashOrderTimeline
                currency={currency as Currency}
                orderDate={order.order_date}
                payments={(payments || []).map(p => ({
                  id: p.id,
                  amount: Number(p.amount_paid),
                  createdAt: p.created_at,
                  method: p.payment_method,
                  reference: p.reference_number,
                  voided: !!p.voided_at,
                }))}
                status={order.status}
                terminalAt={order.completed_at ?? order.cancelled_at ?? order.expired_at}
              />
            </div>
          </div>
        </div>

        <AccountStatement
          open={statementOpen}
          onClose={() => setStatementOpen(false)}
          kind="cash"
          currency={currency as Currency}
          customerName={order.customers?.full_name || 'Unknown'}
          invoiceNumber={order.invoice_number}
          status={order.status}
          orderDate={order.order_date}
          itemDescription={order.item_description}
          payments={(payments || []).map(p => ({
            id: p.id,
            amount: Number(p.amount_paid),
            createdAt: p.created_at,
            method: p.payment_method,
            reference: p.reference_number,
            voided: !!p.voided_at,
          }))}
          totals={{
            total: Number(order.total_amount),
            paid: Number(order.total_paid),
            remaining: Number(order.remaining_balance),
          }}
        />

        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          {canRecordPayment && (
            <Button
              className="gold-gradient text-primary-foreground font-medium shadow"
              onClick={() => setRecordOpen(true)}
            >
              <Upload className="h-4 w-4 mr-1.5" />
              Submit Payment
            </Button>
          )}
          <InvoiceGeneratorSheet
            cashOrderId={order.id}
            parentInvoiceNumber={order.invoice_number}
            defaultTerms="3 DAYS"
            prefillAddress={{
              name: order.customers?.full_name || '',
              address_line1: order.customers?.address_line1 ?? null,
              city: order.customers?.city ?? null,
              postal_code: order.customers?.postal_code ?? null,
              country: order.customers?.country ?? null,
              phone: order.customers?.mobile_number ?? null,
            }}
          />
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
          {isAdmin && (
            <Button
              variant="outline"
              className="border-destructive/30 text-destructive hover:bg-destructive/10"
              onClick={() => setDeleteConfirmOpen(true)}
            >
              <Trash2 className="h-4 w-4 mr-1.5" />
              Delete Order
            </Button>
          )}
          {(isAdmin || isStaff) && (
            <Button
              variant="outline"
              onClick={openEditExpiry}
            >
              <Pencil className="h-4 w-4 mr-1.5" />
              Edit Expiry
            </Button>
          )}
          {can('edit_invoice') && (
            <Button
              variant="outline"
              onClick={openManageInvoice}
            >
              <Settings className="h-4 w-4 mr-1.5" />
              Manage Invoice
            </Button>
          )}
        </div>

        {/* Apply existing store credit to this new, unpaid order */}
        <ApplyStoreCreditCard
          orderType="cash"
          orderId={order.id}
          customerId={order.customer_id}
          currency={currency}
          totalPaid={Number(order.total_paid)}
          status={order.status}
          onApplied={() => {
            qc.invalidateQueries({ queryKey: ['cash-order', id] });
            qc.invalidateQueries({ queryKey: ['cash-orders'] });
            qc.invalidateQueries({ queryKey: ['cash-payments', id] });
            qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
            qc.invalidateQueries({ queryKey: ['store-credit-lots', order.customer_id] });
            qc.invalidateQueries({ queryKey: ['store-credit-txns', order.customer_id] });
          }}
        />

        {/* Items — cash_order_items line items (Path A picker / Path B webhook);
            falls back to the legacy item_description text when no rows exist */}
        {(orderItems && orderItems.length > 0) ? (
          <div className="rounded-xl border border-border bg-card p-5">
            <h3 className="text-sm font-semibold text-card-foreground mb-3">Items</h3>
            <div className="space-y-2">
              {orderItems.map(li => (
                <div key={li.id} className="flex items-center gap-3">
                  {li.image_url ? (
                    <img
                      src={li.image_url}
                      alt=""
                      onClick={() => setZoomImage(li.image_url)}
                      className="h-12 w-12 shrink-0 cursor-pointer rounded border border-border object-cover"
                    />
                  ) : (
                    <div className="h-12 w-12 shrink-0 rounded border border-border bg-muted" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-card-foreground">{li.title}</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
                      {li.sku && <span className="mr-2">SKU {li.sku}</span>}
                      {li.quantity} × {formatCurrency(li.unit_price_jpy, 'JPY')}
                    </div>
                  </div>
                  <span className="shrink-0 text-right text-sm font-medium text-card-foreground tabular-nums">
                    {formatCurrency(li.line_total_jpy, 'JPY')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : order.item_description ? (
          <div className="rounded-xl border border-border bg-card p-5">
            <h3 className="text-sm font-semibold text-card-foreground mb-3">Items</h3>
            <p className="text-sm text-card-foreground">{order.item_description}</p>
          </div>
        ) : null}

        {/* Financial Breakdown — recorded discount / shipping (order currency).
            Lists the recorded values + the authoritative total; no reconciliation
            equation is asserted. */}
        {(Number(order.discount_amount || 0) > 0 || Number(order.shipping_fee || 0) > 0) && (
          <div className="rounded-xl border border-border bg-card p-5">
            <h3 className="text-sm font-semibold text-card-foreground mb-3">Financial Breakdown</h3>
            <div className="space-y-2 text-sm">
              {Number(order.discount_amount || 0) > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">
                    Discount{order.discount_type === 'percent' ? ` (${order.discount_value}%)` : ''}
                  </span>
                  <span className="tabular-nums text-destructive">−{formatCurrency(Number(order.discount_amount), currency)}</span>
                </div>
              )}
              {Number(order.shipping_fee || 0) > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Shipping fee</span>
                  <span className="tabular-nums text-card-foreground">+{formatCurrency(Number(order.shipping_fee), currency)}</span>
                </div>
              )}
              <div className="flex items-center justify-between border-t border-border pt-2 font-semibold">
                <span className="text-card-foreground">Total</span>
                <span className="tabular-nums text-card-foreground">{formatCurrency(Number(order.total_amount), currency)}</span>
              </div>
            </div>
          </div>
        )}

        {/* Loyalty Amount */}
        {order.loyalty_jpy_amount && Number(order.loyalty_jpy_amount) > 0 && (
          <div className="rounded-xl border border-primary/30 bg-card p-5">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Loyalty Amount</span>
              <span className="font-semibold">
                ¥{Number(order.loyalty_jpy_amount).toLocaleString()}
              </span>
            </div>
          </div>
        )}

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
                        {!voided && proofByDate.has(p.date_paid) && (
                          <div className="mt-1">
                            <a
                              href={proofByDate.get(p.date_paid)!.url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-[11px] text-primary hover:underline"
                            >
                              📎 View Proof · {proofByDate.get(p.date_paid)!.sender}
                            </a>
                          </div>
                        )}
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
                            {canRestore && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={restoringId === p.id}
                                onClick={() => handleRestoreCashPayment(p.id)}
                                className="text-muted-foreground hover:text-primary mt-1 h-7 text-[11px]"
                              >
                                <RotateCcw className="h-3.5 w-3.5 mr-1" />
                                {restoringId === p.id ? 'Restoring…' : 'Restore'}
                              </Button>
                            )}
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

        {/* Payment submissions (admin/finance/staff) — hidden once the order is closed */}
        {(isAdmin || isFinance || isStaff) && order.status === 'pending' && (
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
              <div className="space-y-3">
                {submissions!.map(sub => {
                  const cfg = submissionStatusConfig[sub.status] || submissionStatusConfig.submitted;
                  const isPending = ['submitted', 'under_review'].includes(sub.status);
                  const hasProof = !!(sub.proof_url && sub.proof_url.trim().length > 0);
                  return (
                    <Card key={sub.id} className={`shadow-sm ${isPending ? 'ring-1 ring-primary/10' : ''}`}>
                      <CardContent className="p-4 sm:p-5">
                        <div className="flex flex-col sm:flex-row sm:items-start gap-4">
                          {/* Left: Details */}
                          <div className="flex-1 min-w-0 space-y-2.5">
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <div className="flex items-center gap-2">
                                  <p className="text-base font-bold font-display text-card-foreground tabular-nums">
                                    {formatCurrency(Number(sub.submitted_amount), currency)}
                                  </p>
                                  <Badge variant="outline" className="text-[9px] bg-amber-500/10 text-amber-500 border-amber-500/30">
                                    💵 CASH ORDER
                                  </Badge>
                                  {hasProof ? (
                                    <span title="Proof attached" className="inline-flex items-center text-sm leading-none text-emerald-500">📎</span>
                                  ) : (
                                    <Badge variant="outline" className="text-[9px] bg-destructive/10 text-destructive border-destructive/30" title="No proof of payment attached">
                                      No proof
                                    </Badge>
                                  )}
                                </div>
                                <p className="text-xs text-muted-foreground mt-0.5">
                                  via {sub.payment_method || '—'} · {new Date(sub.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
                                </p>
                              </div>
                              <Badge variant="outline" className={`text-[10px] gap-1 shrink-0 ${cfg.color}`}>
                                {cfg.icon} {cfg.label}
                              </Badge>
                            </div>

                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                              <div>
                                <p className="text-muted-foreground">Payment Date</p>
                                <p className="text-card-foreground font-medium">
                                  {sub.payment_date
                                    ? new Date(sub.payment_date + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                                    : '—'}
                                </p>
                              </div>
                              <div>
                                <p className="text-muted-foreground">Reference</p>
                                <p className="text-card-foreground font-mono text-[11px]">{sub.reference_number || '—'}</p>
                              </div>
                              <div>
                                <p className="text-muted-foreground">Sender</p>
                                <p className="text-card-foreground font-medium truncate">{sub.sender_name || '—'}</p>
                              </div>
                            </div>

                            {sub.notes && (
                              <p className="text-xs text-muted-foreground">Notes: <span className="text-card-foreground">{sub.notes}</span></p>
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
                                <p className="text-xs text-card-foreground">{sub.reviewer_notes}</p>
                              </div>
                            )}

                            {hasProof ? (
                              <div className="mt-1 space-y-1.5">
                                <p className="text-[10px] text-muted-foreground font-medium">Proof of Payment</p>
                                {sub.proof_url!.match(/\.pdf$/i) ? (
                                  <div className="flex items-center gap-2 rounded border border-primary/20 bg-primary/5 p-2">
                                    <FileText className="h-4 w-4 text-primary shrink-0" />
                                    <span className="text-xs text-card-foreground truncate flex-1" title={sub.proof_url!.split('/').pop()}>
                                      {decodeURIComponent(sub.proof_url!.split('/').pop() || 'proof.pdf').split('?')[0]}
                                    </span>
                                    <a href={sub.proof_url!} target="_blank" rel="noopener noreferrer"
                                      className="text-[10px] text-primary underline whitespace-nowrap">
                                      View Proof
                                    </a>
                                  </div>
                                ) : (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => window.open(sub.proof_url!, '_blank', 'noopener,noreferrer')}
                                      className="block w-full text-left">
                                      <ProofImage url={sub.proof_url!}
                                        className="w-full max-h-48 object-cover rounded border border-[hsl(var(--border))] hover:opacity-90 transition-opacity cursor-zoom-in" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => window.open(sub.proof_url!, '_blank', 'noopener,noreferrer')}
                                      className="text-[10px] text-primary underline inline-flex items-center gap-1">
                                      <ImageIcon className="h-3 w-3" /> View Proof
                                    </button>
                                  </>
                                )}
                              </div>
                            ) : (
                              <p className="text-[10px] text-destructive italic font-medium">No proof attached</p>
                            )}
                          </div>

                          {/* Right: Action */}
                          <div className="flex flex-row sm:flex-col gap-1.5 shrink-0">
                            {isPending && (
                              <Badge variant="outline" className="bg-warning/10 text-warning border-warning/20 text-[10px]">
                                <Clock className="h-3 w-3 mr-1" /> Pending Confirmation
                              </Badge>
                            )}
                            <Link to="/payments-hub">
                              <Button variant="outline" size="sm" className="h-7 text-[11px] w-full">
                                Review →
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
        )}

        {/* Services (service_jobs scoped to this invoice) */}
        <ServiceJobsSection invoiceNumber={order?.invoice_number} />

        {/* Customer Message — mirrors AccountDetail.tsx */}
        <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
          <h3 className="text-sm font-semibold text-card-foreground mb-4 flex items-center gap-2">
            <MessageCircle className="h-4 w-4 text-info" /> Customer Message
          </h3>
          {canAwardLoyalty && (
            <div className="mb-4">
              <Button
                onClick={handleAwardLoyalty}
                disabled={awardingLoyalty}
                variant="outline"
                size="sm"
                className="border-primary/30 text-primary hover:bg-primary/10"
              >
                <Sparkles className="h-3.5 w-3.5 mr-1" />
                {awardingLoyalty ? 'Awarding…' : 'Award loyalty points'}
              </Button>
            </div>
          )}
          <div className="rounded-lg bg-muted/50 p-3 sm:p-4 border border-border" style={{ maxWidth: '100%', overflow: 'hidden' }}>
            <pre className="text-[10px] sm:text-xs text-card-foreground font-body leading-relaxed" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', overflowWrap: 'anywhere', maxWidth: '100%' }}>
              {message}
            </pre>
          </div>
          <div className="flex gap-2 mt-4 flex-wrap">
            <Button onClick={handleCopyMessage} variant="outline" size="sm" className="border-primary/30 text-primary hover:bg-primary/10">
              {copied ? <Check className="h-3.5 w-3.5 mr-1" /> : <Copy className="h-3.5 w-3.5 mr-1" />}
              {copied ? 'Copied!' : 'Copy Message'}
            </Button>
            {order.customers?.messenger_link && (
              <a href={order.customers.messenger_link} target="_blank" rel="noopener noreferrer">
                <Button variant="outline" size="sm" className="border-info/30 text-info hover:bg-info/10">
                  <MessageCircle className="h-3.5 w-3.5 mr-1" /> Messenger
                </Button>
              </a>
            )}
          </div>
        </div>

        {/* Shipment Tracking */}
        <ShipmentTrackingCard
          kind="cash_order"
          recordId={order.id}
          trackingNumber={order.tracking_number ?? null}
          shippingMethodId={order.shipping_method_id ?? null}
          shippedAt={order.shipped_at ?? null}
          trackingUpdatedAt={order.tracking_updated_at ?? null}
          canEdit={isAdmin || isStaff}
          onSaved={() => qc.invalidateQueries({ queryKey: ['cash-order', id] })}
        />

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

          {/* Money-moving consequences (from the server preview) */}
          {cancelPreviewLoading ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-background p-3 text-sm text-muted-foreground">
              <RefreshCcw className="h-4 w-4 animate-spin" /> Calculating consequences…
            </div>
          ) : cancelPreviewError ? (
            <p className="text-sm text-destructive">{cancelPreviewError}</p>
          ) : cancelPreview ? (
            <div className="rounded-lg border border-border bg-background p-3 space-y-1.5 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Money received</span>
                <span className="tabular-nums text-card-foreground">
                  {formatCurrency(Number(cancelPreview.money_received ?? 0), currency)}
                </span>
              </div>
              {Number(cancelPreview.loyalty_redemption_excluded ?? 0) > 0 && (
                <p className="text-muted-foreground">
                  Loyalty redemption excluded:{' '}
                  {formatCurrency(Number(cancelPreview.loyalty_redemption_excluded), currency)}{' '}
                  (redeemed points are not returned)
                </p>
              )}
              {Number(cancelPreview.store_credit_to_issue ?? 0) > 0 ? (
                <div className="flex justify-between border-t border-border pt-1.5 font-semibold text-primary">
                  <span>Store credit to be issued</span>
                  <span className="tabular-nums">
                    {formatCurrency(Number(cancelPreview.store_credit_to_issue), currency)} (valid 1 year)
                  </span>
                </div>
              ) : (
                <p className="border-t border-border pt-1.5 text-muted-foreground">
                  No payments received — no store credit will be issued.
                </p>
              )}
              {cancelPreview.earned_points_will_be_revoked === true && (
                <p className="text-amber-600">Loyalty points earned on this order will be revoked.</p>
              )}
            </div>
          ) : null}

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
          <TypedConfirmField word="CANCEL" onArmedChange={setCancelArmed} />
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setCancelOpen(false)} disabled={cancelling}>
              Back
            </Button>
            <Button
              variant="destructive"
              onClick={confirmCancel}
              disabled={
                cancelling || !cancelReason.trim() || !cancelArmed ||
                cancelPreviewLoading || !!cancelPreviewError || !cancelPreview
              }
            >
              {cancelling ? 'Cancelling…' : 'Confirm Cancel'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Expiry */}
      <Dialog open={editExpiryOpen} onOpenChange={setEditExpiryOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarClock className="h-5 w-5 text-primary" />
              Edit Expiration Date
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Cash order #{order.invoice_number}. Updating this date changes when
            the order will be auto-expired.
          </p>
          <div className="space-y-2">
            <Label htmlFor="edit-expiry">New expiration date *</Label>
            <Input
              id="edit-expiry"
              type="date"
              value={editExpiryValue}
              onChange={e => setEditExpiryValue(e.target.value)}
              className="bg-background border-border"
            />
            <p className="text-[11px] text-muted-foreground">
              Order will be auto-expired the morning after this date.
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setEditExpiryOpen(false)} disabled={editExpirySaving}>
              Back
            </Button>
            <Button
              onClick={confirmEditExpiry}
              disabled={editExpirySaving || !editExpiryValue}
              className="gold-gradient text-primary-foreground font-medium"
            >
              {editExpirySaving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manage Invoice — admin-only total correction */}
      <Dialog open={manageOpen} onOpenChange={setManageOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5 text-primary" />
              Manage Invoice
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Correct the total for cash order #{order.invoice_number}. This does
            not change the amount paid or loyalty.
          </p>
          <div className="space-y-2">
            <Label htmlFor="manage-order-date">Order Date</Label>
            <Input
              id="manage-order-date"
              type="date"
              value={manageOrderDate}
              onChange={e => setManageOrderDate(e.target.value)}
              readOnly={!isAdmin}
              disabled={!isAdmin}
              className={`h-9 text-sm ${isAdmin ? 'bg-background border-border' : 'bg-muted cursor-not-allowed'}`}
              title={isAdmin ? undefined : 'Only admins can edit the order date.'}
            />
            <p className="text-[11px] text-muted-foreground pb-1">
              Business date of the order. Changing it moves this order between months in sales reporting.
            </p>
            <Label htmlFor="manage-total">Total Amount ({currency})</Label>
            <Input
              id="manage-total"
              type="number"
              step="0.01"
              value={manageTotal}
              onChange={e => setManageTotal(e.target.value)}
              readOnly={!isAdmin}
              disabled={!isAdmin}
              className={`h-9 text-sm tabular-nums ${isAdmin ? 'bg-background border-border' : 'bg-muted cursor-not-allowed'}`}
              title={isAdmin ? undefined : 'Only admins can edit the cash order total.'}
            />
            {!isAdmin && (
              <p className="text-[11px] text-muted-foreground">
                Read-only — admin only.
              </p>
            )}
            <div className="flex justify-between text-[11px] text-muted-foreground pt-1">
              <span>Paid</span>
              <span className="tabular-nums">{formatCurrency(Number(order.total_paid), currency)}</span>
            </div>
          </div>

          {/* Discount & Shipping (descriptive — Model 1: does not auto-change
              the total; admin explicitly clicks "Apply to total") */}
          <div className="space-y-3 border-t border-border pt-3">
            <h5 className="text-xs font-semibold text-card-foreground">Discount &amp; Shipping</h5>
            {isAdmin ? (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground">Discount</Label>
                    <div className="flex rounded-md border border-border overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setManageDiscountMode('amount')}
                        className={`px-2 py-0.5 text-[11px] ${manageDiscountMode === 'amount' ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground'}`}
                      >
                        {currency === 'PHP' ? '₱' : '¥'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setManageDiscountMode('percent')}
                        className={`px-2 py-0.5 text-[11px] ${manageDiscountMode === 'percent' ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground'}`}
                      >
                        %
                      </button>
                    </div>
                  </div>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                      {manageDiscountMode === 'percent' ? '%' : (currency === 'PHP' ? '₱' : '¥')}
                    </span>
                    <Input
                      type="number"
                      min={0}
                      value={manageDiscountInput}
                      onChange={e => setManageDiscountInput(e.target.value)}
                      placeholder="0"
                      className="h-9 text-sm bg-background border-border pl-6 tabular-nums"
                    />
                  </div>
                  {manageDiscountMode === 'percent' && (
                    <p className="text-[10px] text-muted-foreground">of items subtotal</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Shipping fee</Label>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                      {currency === 'PHP' ? '₱' : '¥'}
                    </span>
                    <Input
                      type="number"
                      min={0}
                      value={manageShippingInput}
                      onChange={e => setManageShippingInput(e.target.value)}
                      placeholder="0"
                      className="h-9 text-sm bg-background border-border pl-6 tabular-nums"
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground space-y-1">
                <div>
                  Discount:{' '}
                  {order.discount_type
                    ? (order.discount_type === 'percent'
                        ? `${order.discount_value}% (${formatCurrency(Number(order.discount_amount || 0), currency)})`
                        : formatCurrency(Number(order.discount_amount || 0), currency))
                    : '—'}
                </div>
                <div>Shipping: {order.shipping_fee ? formatCurrency(Number(order.shipping_fee), currency) : '—'}</div>
              </div>
            )}

            {/* Reconciliation readout — order currency */}
            {manageShowReconciliation && (
              <div className="rounded-lg border border-border bg-background p-3 text-xs space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Items subtotal</span>
                  <span className="tabular-nums text-card-foreground">{formatCurrency(manageItemsSubtotalAcct, currency)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">− Discount</span>
                  <span className="tabular-nums text-card-foreground">{formatCurrency(manageDiscountAmount, currency)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">+ Shipping</span>
                  <span className="tabular-nums text-card-foreground">{formatCurrency(manageShippingFee, currency)}</span>
                </div>
                <div className="flex justify-between border-t border-border pt-1 font-medium">
                  <span className="text-card-foreground">= Reconciled</span>
                  <span className="tabular-nums text-card-foreground">{formatCurrency(manageReconciledTotal, currency)}</span>
                </div>
                <div className="flex items-center justify-between pt-1">
                  <span className="text-muted-foreground">Current total: {formatCurrency(Number(order.total_amount), currency)}</span>
                  {isAdmin && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs border-primary/30 text-primary hover:bg-primary/10"
                      onClick={() => setManageTotal(String(manageReconciledTotal))}
                    >
                      Apply to total
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setManageOpen(false)} disabled={manageSaving}>
              Back
            </Button>
            <Button
              onClick={confirmManageInvoice}
              disabled={manageSaving || !isAdmin}
              className="gold-gradient text-primary-foreground font-medium"
            >
              {manageSaving ? 'Saving…' : 'Save'}
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
          <TypedConfirmField word="VOID" onArmedChange={setVoidArmed} />
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setVoidOpen(false)} disabled={voiding}>
              Back
            </Button>
            <Button
              variant="destructive"
              onClick={confirmVoid}
              disabled={voiding || !voidReason.trim() || !voidArmed}
            >
              {voiding ? 'Voiding…' : 'Confirm Void'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Item image zoom */}
      <Dialog open={!!zoomImage} onOpenChange={(open) => { if (!open) setZoomImage(null); }}>
        <DialogContent className="max-w-2xl p-2 bg-card border-border">
          {zoomImage && <img src={zoomImage} alt="" className="w-full h-auto rounded-lg object-contain max-h-[80vh]" />}
        </DialogContent>
      </Dialog>

      {/* Delete Cash Order Confirmation */}
      {deleteConfirmOpen && (
        <>
          <div
            className="fixed inset-0 bg-black/60"
            style={{ zIndex: 9998, pointerEvents: 'auto' }}
          />
          <div
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-card border border-border rounded-xl p-6 shadow-xl"
            style={{ zIndex: 9999, pointerEvents: 'auto' }}
          >
            <h2 className="text-lg font-semibold text-card-foreground mb-1">Delete Cash Order?</h2>
            <p className="text-sm text-muted-foreground mb-4">
              This will permanently delete INV #{order.invoice_number} and all associated payments, items, invoices, and payment proofs. Loyalty points from this order will be revoked. This action cannot be undone.
            </p>
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2">
              <Button variant="outline" className="border-border mt-2 sm:mt-0" onClick={() => setDeleteConfirmOpen(false)}>
                Cancel
              </Button>
              <Button
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                disabled={deleteCashOrder.isPending}
                onClick={async () => {
                  try {
                    await deleteCashOrder.mutateAsync(order.id);
                    toast.success(`Cash order INV #${order.invoice_number} deleted`);
                    navigate('/sales?tab=cash');
                  } catch (err: any) {
                    toast.error(err.message || 'Failed to delete cash order');
                  }
                }}
              >
                {deleteCashOrder.isPending ? 'Deleting…' : 'Delete Order'}
              </Button>
            </div>
          </div>
        </>
      )}
    </AppLayout>
  );
}
