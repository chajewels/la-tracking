import { useState, useCallback, useEffect } from 'react';
import { useParams, useSearchParams, Link, useNavigate } from 'react-router-dom';
import { ROUTES } from '@/constants/routes';
import { ArrowLeft, Copy, Check, CheckCircle2, MessageCircle, Calendar, AlertTriangle, MapPin, Pencil, X, Ban, Wrench, Save, ChevronRight, Mail, Phone, Facebook, StickyNote } from 'lucide-react';
import CustomerPortalShareMenu from '@/components/customers/CustomerPortalShareMenu';
import { useCustomerCashOrders } from '@/hooks/useCustomerCashOrders';
import { orderCountsLabel, tallyCustomerOrders } from '@/lib/customer-account-stats';
import TestTag from '@/components/shared/TestTag';
import PageHeaderBand from '@/components/layout/PageHeaderBand';
import Monogram from '@/components/shared/Monogram';
import StatusPill from '@/components/shared/StatusPill';
import { ACCOUNT_STATUS_TONE } from '@/components/shared/status-tone';
import IllustratedState from '@/components/shared/LedgerIllustration';
import DataTable, { type DataTableColumn } from '@/components/data-table/DataTable';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import AppLayout from '@/components/layout/AppLayout';
import CountrySelect from '@/components/customers/CountrySelect';
import { LocationType, parseLocation, toLocationString } from '@/lib/countries';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import RecordPaymentDialog from '@/components/payments/RecordPaymentDialog';
import MultiInvoicePaymentDialog from '@/components/payments/MultiInvoicePaymentDialog';
import AICustomerInsightsDialog from '@/components/ai/AICustomerInsightsDialog';
import CustomerCashOrdersTab from '@/components/customers/CustomerCashOrdersTab';
import CustomerLoyaltyTab from '@/components/customers/CustomerLoyaltyTab';
import CustomerStoreCreditTab from '@/components/customers/CustomerStoreCreditTab';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { getPHTToday } from '@/lib/date-utils';
import { getPortalLinkForCustomer } from '@/lib/portal-link';
import { toast } from 'sonner';
import { useCustomerAccounts, useForfeitAccount } from '@/hooks/use-supabase-data';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { KeyRound, Plus, Gem } from 'lucide-react';
import { usePermissions } from '@/contexts/PermissionsContext';
import { useQueryClient } from '@tanstack/react-query';
import {
  isEffectivelyPaid, isPartiallyPaid, remainingDue, getUnpaidScheduleItems, getMessageSchedulePaymentCoverage,
  ordinal, SERVICE_LABELS, accountProgress, getNextPaymentStatementDate,
} from '@/lib/business-rules';

// Key-fact pill in the header card — the same treatment as AccountDetail's.
const factPill = 'inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-surface-2/60 px-2.5 text-xs text-muted-foreground';

export default function CustomerDetail() {
  const { customerId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const initialTab: 'layaway' | 'cash' | 'loyalty' | 'credit' =
    tabParam === 'cash' ? 'cash' : tabParam === 'loyalty' ? 'loyalty' : tabParam === 'credit' ? 'credit' : 'layaway';
  const [activeTab, setActiveTab] = useState<'layaway' | 'cash' | 'loyalty' | 'credit'>(initialTab);
  const handleTabChange = useCallback((v: string) => {
    const tab = (v === 'cash' ? 'cash' : v === 'loyalty' ? 'loyalty' : v === 'credit' ? 'credit' : 'layaway') as
      | 'layaway'
      | 'cash'
      | 'loyalty'
      | 'credit';
    setActiveTab(tab);
    if (tab === 'layaway') searchParams.delete('tab');
    else searchParams.set('tab', tab);
    setSearchParams(searchParams, { replace: true });
  }, [searchParams, setSearchParams]);
  const { data, isLoading } = useCustomerAccounts(customerId);
  // Same query (and cache entry) as the Cash Orders tab — feeds the header badge.
  const { data: customerCashOrders } = useCustomerCashOrders(customerId);
  const [copied, setCopied] = useState(false);
  const [editingLocation, setEditingLocation] = useState(false);
  const [locationType, setLocationType] = useState<LocationType>('japan');
  const [country, setCountry] = useState('');
  const queryClient = useQueryClient();
  const forfeitAccount = useForfeitAccount();

  // Portal link for split payment confirmation message
  const [portalLink, setPortalLink] = useState<string | null>(null);
  const [customerPin, setCustomerPin] = useState<string | null>(null);
  useEffect(() => {
    if (!customerId || !data?.customer) return;
    (async () => {
      const { data: tokenRow } = await supabase
        .from('customer_portal_tokens')
        .select('token, expires_at')
        .eq('customer_id', customerId)
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const authUserId = data.customer.auth_user_id ?? null;
      // An expired token is no token — see the note in AccountDetail's
      // portal-token query. Nulling it here keeps the PIN line consistent
      // with the link.
      const tokenExp = tokenRow?.expires_at ? Date.parse(tokenRow.expires_at) : NaN;
      const tokenValue = (tokenRow?.token && !(!Number.isNaN(tokenExp) && tokenExp < Date.now()))
        ? tokenRow.token
        : null;
      const _digits = (data.customer.mobile_number ?? '').replace(/\D/g, '');
      const _last4 = _digits.length >= 4 ? _digits.slice(-4) : null;
      setCustomerPin((!authUserId && tokenValue && _last4) ? _last4 : null);
      const hasAuthMeans = !!authUserId || !!tokenValue;
      if (hasAuthMeans) {
        setPortalLink(getPortalLinkForCustomer(
          { auth_user_id: authUserId, portal_token: tokenValue },
          'portal'
        ));
      }
    })();
  }, [customerId, data?.customer?.auth_user_id]);

  // --- Inline customer detail editing (hooks must be before early returns) ---
  const [editingCustomer, setEditingCustomer] = useState(false);
  const [editFields, setEditFields] = useState({
    full_name: '', facebook_name: '', messenger_link: '', mobile_number: '', email: '',
  });
  const [editSaving, setEditSaving] = useState(false);

  // --- Set Portal PIN dialog state ---
  const { roles } = useAuth();
  const { can } = usePermissions();
  const canManagePin = (roles as any[]).includes('admin') || (roles as any[]).includes('staff');
  const [pinDialogOpen, setPinDialogOpen] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [pinSaving, setPinSaving] = useState(false);
  const handleSetPin = async () => {
    if (!customerId || !/^\d{4}$/.test(pinInput)) {
      toast.error('PIN must be exactly 4 digits');
      return;
    }
    setPinSaving(true);
    try {
      const { data: res, error } = await supabase.functions.invoke('set-portal-pin', {
        body: { customer_id: customerId, pin: pinInput },
      });
      if (error || (res as any)?.error) throw new Error((res as any)?.error || error?.message || 'Failed to set PIN');
      toast.success('Portal PIN set successfully');
      setPinDialogOpen(false);
      setPinInput('');
    } catch (err: any) {
      toast.error(err.message || 'Failed to set PIN');
    } finally {
      setPinSaving(false);
    }
  };

  const customer = data?.customer;
  const isMobile = useIsMobile();
  const navigate = useNavigate();

  const startEditCustomer = useCallback(() => {
    if (!customer) return;
    setEditFields({
      full_name: customer.full_name || '',
      facebook_name: customer.facebook_name || '',
      messenger_link: customer.messenger_link || '',
      mobile_number: customer.mobile_number || '',
      email: customer.email || '',
    });
    setEditingCustomer(true);
  }, [customer]);

  const saveCustomerEdit = useCallback(async () => {
    if (!customer) return;
    if (!editFields.full_name.trim()) { toast.error('Name is required'); return; }
    setEditSaving(true);
    try {
      const { error } = await supabase.from('customers').update({
        full_name: editFields.full_name.trim(),
        facebook_name: editFields.facebook_name.trim() || null,
        messenger_link: editFields.messenger_link.trim() || null,
        mobile_number: editFields.mobile_number.trim() || null,
        email: editFields.email.trim() || null,
      }).eq('id', customer.id);
      if (error) throw error;
      toast.success('Customer details updated — message will reflect changes');
      queryClient.invalidateQueries({ queryKey: ['customer-detail', customerId] });
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      setEditingCustomer(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to update');
    } finally {
      setEditSaving(false);
    }
  }, [editFields, customer, customerId, queryClient]);

  if (isLoading) {
    return (
      <AppLayout>
        <div className="space-y-6 max-w-5xl">
          <Skeleton className="h-10 w-64" />
          <div className="grid grid-cols-3 gap-4">
            {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
          </div>
        </div>
      </AppLayout>
    );
  }

  if (!data || !customer) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-64">
          <p className="text-muted-foreground">Customer not found</p>
        </div>
      </AppLayout>
    );
  }

  const { accounts } = data;
  // Override stale OVERDUE status: only truly overdue if an unpaid month has a past due_date
  const cdToday = getPHTToday();
  const effectiveStatusOf = (account: (typeof accounts)[number]['account'], schedule: (typeof accounts)[number]['schedule']) => {
    const cdHasUnpaidPastDue = schedule.some(s => !isEffectivelyPaid(s) && s.due_date < cdToday);
    return account.status === 'overdue' && !cdHasUnpaidPastDue ? 'active' : account.status;
  };
  const badgeLabel: Record<string, string> = {
    active: 'Active', overdue: 'Overdue', completed: 'Completed',
    cancelled: 'Cancelled', forfeited: 'Forfeited',
    extension_active: 'Extension', final_forfeited: 'Perm. Forfeited',
    final_settlement: 'Settlement',
  };
  // Layaway accounts as the Sales ledger table (desktop) — same fields the
  // cards below show; each row opens the account as the invoice link does.
  type AcctRow = (typeof accounts)[number];
  const money = (n: number, c: Currency) => <span className="tabular-nums">{formatCurrency(n, c)}</span>;
  const accountColumns: DataTableColumn<AcctRow>[] = [
    {
      key: 'invoice', header: 'Invoice', cellClassName: 'whitespace-nowrap',
      cell: ({ account }) => (
        <Link to={`/accounts/${account.id}`} onClick={(e) => e.stopPropagation()} className="font-deco text-base font-semibold text-champagne [font-variant-numeric:lining-nums_tabular-nums] hover:text-gold-300 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          #{account.invoice_number}
        </Link>
      ),
    },
    {
      key: 'status', header: 'Status',
      cell: ({ account, schedule }) => {
        const st = effectiveStatusOf(account, schedule);
        return <StatusPill label={badgeLabel[st] || st} tone={ACCOUNT_STATUS_TONE[st] ?? 'muted'} pulse={st === 'overdue'} />;
      },
    },
    {
      key: 'progress', header: 'Paid',
      cell: ({ account }) => {
        const total = Number(account.total_amount);
        const pct = total > 0 ? (Number(account.total_paid) / total) * 100 : 0;
        return (
          <span className="flex items-center gap-2" title={`${Math.round(pct)}% paid · ${account.payment_plan_months}mo plan`}>
            <span className="h-1 w-12 overflow-hidden rounded-full bg-muted">
              <span className="block h-full rounded-full gold-gradient" style={{ width: `${Math.min(pct, 100)}%` }} />
            </span>
            <span className="text-[11px] tabular-nums text-muted-foreground">{Math.round(pct)}%</span>
          </span>
        );
      },
    },
    { key: 'currency', header: 'Currency', cell: ({ account }) => <span className="text-muted-foreground">{account.currency}</span> },
    { key: 'total', header: 'Total', align: 'right', cell: ({ account }) => money(Number(account.total_amount), account.currency as Currency) },
    { key: 'paid', header: 'Received', align: 'right', cell: ({ account }) => <span className="text-success">{money(Number(account.total_paid), account.currency as Currency)}</span> },
    {
      key: 'balance', header: 'Balance', align: 'right',
      cell: ({ account }) => <span className="font-semibold text-champagne">{money(Number(account.remaining_balance), account.currency as Currency)}</span>,
    },
    {
      key: 'open', header: '', hideable: false, align: 'right', cellClassName: 'w-12',
      cell: ({ account }) => (
        <Link to={`/accounts/${account.id}`} aria-label={`Open account ${account.invoice_number}`} onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-primary" tabIndex={-1}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </Link>
      ),
    },
  ];
  // Same entry point as the Cash Orders tab (Bug #284).
  const canCreateLayaway = can('create_account');
  const canEditCustomer = can('edit_customer');
  const newLayawayHref = `/accounts/new?customer_id=${encodeURIComponent(customerId ?? '')}`;

  // Filter accounts: only include active/open invoices for consolidated message
  const activeAccounts = accounts.filter(a =>
    !['completed', 'cancelled', 'forfeited', 'final_forfeited'].includes(a.account.status)
  );


  const sortPaymentsNewestFirst = (a: any, b: any) => {
    const createdDiff = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    if (createdDiff !== 0) return createdDiff;
    return new Date(b.date_paid).getTime() - new Date(a.date_paid).getTime();
  };

  // Build consolidated message across only active/open accounts
  const buildConsolidatedMessage = () => {
    // If no active accounts, return a clean completion message
    if (activeAccounts.length === 0) {
      let msg = `Dear ${customer.full_name},\n\n`;
      msg += `All your layaway accounts have been completed. 🎉\n\n`;
      msg += `Thank you for your continued trust in Cha Jewels. We appreciate your business! 🧡`;
      return msg;
    }

    // Use activeAccounts for payment lookup (only from open invoices)
    const allActivePayments = activeAccounts.flatMap((acct) =>
      (acct.payments || [])
        .filter((p: any) => !p.voided_at)
        .map((p: any) => ({
          ...p,
          invoice_number: acct.account.invoice_number,
          currency: acct.account.currency as Currency,
        }))
    );

    const latestPayment = [...allActivePayments].sort(sortPaymentsNewestFirst)[0];
    const latestPaymentIsSplitBatch =
      !!latestPayment?.reference_number &&
      typeof latestPayment?.remarks === 'string' &&
      latestPayment.remarks.startsWith('[Multi-invoice]');

    const latestPaymentEvent = latestPayment
      ? latestPaymentIsSplitBatch
        ? allActivePayments
            .filter((p: any) => p.reference_number === latestPayment.reference_number)
            .sort(sortPaymentsNewestFirst)
        : [latestPayment]
      : [];

    const recentByCurrency = latestPaymentEvent.reduce<Record<Currency, number>>(
      (totals, payment: any) => {
        totals[payment.currency] += Number(payment.amount_paid);
        return totals;
      },
      { PHP: 0, JPY: 0 }
    );

    const thankYouParts = (Object.entries(recentByCurrency) as [Currency, number][])
      .filter(([, amt]) => amt > 0)
      .map(([cur, amt]) => formatCurrency(amt, cur));

    let msg = ``;

    // Multi-invoice payment header
    if (latestPaymentEvent.length > 1 && thankYouParts.length > 0) {
      msg += `Thank you for your payment. ${thankYouParts.join(' and ')} has been received.\n\n`;
      latestPaymentEvent.forEach((payment: any) => {
        msg += `Inv # ${payment.invoice_number} - ${formatCurrency(Number(payment.amount_paid), payment.currency)}\n`;
      });
      msg += `\n`;
    }

    // Single-invoice single-payment: add "Thank you" greeting if not already added by multi-invoice header
    if (latestPaymentEvent.length <= 1 && thankYouParts.length > 0) {
      msg += `Thank you for your payment. ${thankYouParts.join(' and ')} has been received.\n\n`;
    }

    // Only iterate active accounts (excludes completed/cancelled)
    for (const acct of activeAccounts) {
      const currency = acct.account.currency as Currency;
      const scheduleItems = acct.schedule || [];

      const downpayment = Number((acct.account as any).downpayment_amount || 0);
      const schedBaseSum = scheduleItems.reduce((s, i) => s + Number(i.base_installment_amount), 0);
      const schedPenaltySum = scheduleItems.reduce((s, i) => s + Number(i.penalty_amount), 0);
      const originalPrincipal = downpayment + schedBaseSum;
      const acctServicesList = (acct as any).services || [];
      const totalSvcAmt = acctServicesList.reduce((s: number, svc: any) => s + Number(svc.amount), 0);
      const totalLayawayAmount = originalPrincipal + schedPenaltySum + totalSvcAmt;
      const totalPaid = Number(acct.account.total_paid);
      const remainingBalance = scheduleItems
        .filter(s => s.status !== 'paid' && s.status !== 'cancelled')
        .reduce((sum, s) => sum + Math.max(0, Number(s.total_due_amount) - Number(s.paid_amount)), 0);

      const activePayments = [...(acct.payments || [])]
        .filter((p: any) => !p.voided_at)
        .sort((a: any, b: any) => {
          const dateDiff = new Date(a.date_paid).getTime() - new Date(b.date_paid).getTime();
          if (dateDiff !== 0) return dateDiff;
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        });

      const paymentParts = activePayments.map((p: any, index: number) => {
        const amt = Number(p.amount_paid);
        const formatted = formatCurrency(amt, currency);
        // First payment is downpayment — label it
        const isDP = p.submission_type === 'downpayment' ||
                     (index === 0 && amt === downpayment);
        return isDP ? `${formatted} (DP)` : formatted;
      });
      const breakdownTotal = activePayments.reduce(
        (sum: number, p: any) => sum + Number(p.amount_paid), 0
      );
      const paymentBreakdownText = activePayments.length > 0
        ? `${paymentParts.join(' + ')} = ${formatCurrency(breakdownTotal, currency)}`
        : formatCurrency(breakdownTotal, currency);
      const messageScheduleCoverage = getMessageSchedulePaymentCoverage(scheduleItems, totalPaid, downpayment);

      // LA month label from last schedule item
      const lastSchedDate = scheduleItems.length > 0 ? new Date(scheduleItems[scheduleItems.length - 1].due_date) : null;
      const laMonthLabel = lastSchedDate ? `LA ${lastSchedDate.toLocaleDateString('en-US', { month: 'short' }).toUpperCase()}` : 'LA';

      // ══════════════════════════════════════════════════════════════════════
      // 🔒 OFFICIAL CHA JEWELS CUSTOMER MESSAGE TEMPLATE — LOCKED
      // ══════════════════════════════════════════════════════════════════════

      const unpaidSchedule = getUnpaidScheduleItems(scheduleItems);

      msg += `Inv # ${acct.account.invoice_number}\n`;
      // Total LA Amount with breakdown
      const totalLAParts: string[] = [];
      if (schedPenaltySum > 0) totalLAParts.push(`${formatCurrency(schedPenaltySum, currency).replace(/^[₱¥]\s*/, '')} (Penalty)`);
      if (totalSvcAmt > 0) totalLAParts.push(`${formatCurrency(totalSvcAmt, currency).replace(/^[₱¥]\s*/, '')} (Service)`);
      if (totalLAParts.length > 0) {
        msg += `Total LA Amount: ${formatCurrency(originalPrincipal, currency)} + ${totalLAParts.join(' + ')} = ${formatCurrency(totalLayawayAmount, currency)}\n`;
      } else {
        msg += `Total LA Amount: ${formatCurrency(totalLayawayAmount, currency)}\n`;
      }
      msg += `Amount Paid: ${paymentBreakdownText}\n`;
      msg += `================\n`;
      const unpaidCount = unpaidSchedule.length;
      msg += `${laMonthLabel} remaining balance - ${formatCurrency(remainingBalance, currency)} to pay in ${unpaidCount} month${unpaidCount !== 1 ? 's' : ''}\n`;

      msg += `\nMonthly Payment:\n`;
      scheduleItems.forEach((item, idx) => {
        const totalDue = Number(item.total_due_amount);
        const coveredAmount = Math.min(messageScheduleCoverage[idx] || 0, totalDue);
        const dbPaid = item.status === 'paid';
        const effPaid = dbPaid || (isEffectivelyPaid(item) && totalDue > 0 && coveredAmount >= totalDue);
        const dateStr = new Date(item.due_date).toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
        const penalty = Number(item.penalty_amount);
        const baseAmt = Number(item.base_installment_amount);

        if (effPaid) {
          if (penalty > 0) {
            msg += `✅ ${ordinal(idx)} month ${dateStr}: ${formatCurrency(baseAmt, currency)} + ${formatCurrency(penalty, currency)} (Penalty) = ${formatCurrency(totalDue, currency)} (PAID)\n`;
          } else {
            msg += `✅ ${ordinal(idx)} month ${dateStr}: ${formatCurrency(baseAmt, currency)} (PAID)\n`;
          }
        } else if (penalty > 0) {
          msg += `${ordinal(idx)} month ${dateStr}: ${formatCurrency(baseAmt, currency)} + ${formatCurrency(penalty, currency)} (Penalty) = ${formatCurrency(totalDue, currency)}\n`;
        } else {
          msg += `${ordinal(idx)} month ${dateStr}: ${formatCurrency(remainingDue(item), currency)}\n`;
        }
      });

      const nextStatement = getNextPaymentStatementDate(scheduleItems);
      if (nextStatement) {
        const nextDate = new Date(nextStatement.date).toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
        msg += `\nPlease note your next monthly payment is on ${nextDate}. Please expect another payment reminder from us.\n`;
      }
      msg += `\n`;
    }

    msg += `Thank you for your continued trust in Cha Jewels. We appreciate your business! 🧡`;
    return msg;
  };

  const message = buildConsolidatedMessage();

  const handleCopy = () => {
    navigator.clipboard.writeText(message);
    setCopied(true);
    toast.success('Message copied to clipboard');
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6 max-w-5xl">
        <PageHeaderBand
          className="pb-3"
          crumbs={[
            { label: 'Hub', to: ROUTES.DASHBOARD },
            { label: 'Customers', to: ROUTES.CUSTOMERS },
            { label: customer.full_name },
          ]}
        />

        {/* Header card (Hub visual refresh): monogram, name, key facts as
            pills — all values the page already has — and the actions. */}
        <div className="ledger-card relative overflow-hidden rounded-2xl border border-gold-500/20 bg-card/90 p-4 sm:p-6">
        <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3 sm:gap-5">
          <Link to={ROUTES.CUSTOMERS} className="hidden sm:block">
            <Button variant="ghost" size="icon" className="text-muted-foreground" aria-label="Back to customers">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <Monogram name={customer.full_name} />
          <div className="flex-1 min-w-0">
            <h1 className="font-deco text-[1.75rem] sm:text-[2.6rem] font-semibold leading-[1.05] tracking-tight text-champagne break-words">{customer.full_name}</h1>
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              {customer.is_test && <TestTag className="py-1 text-xs" />}
              {customer.customer_code && (
                <span className={cn(factPill, 'border-gold-500/25 bg-gold-500/[0.06] font-mono text-gold-300')}>{customer.customer_code}</span>
              )}
              {/* Same active/done rule as the directory row (layaways + cash orders). */}
              <span className={factPill} data-testid="customer-order-counts">
                {orderCountsLabel(tallyCustomerOrders(accounts.map(a => a.account), customerCashOrders ?? []))}
              </span>
              {customer.facebook_name && <span className={cn(factPill, 'max-w-full truncate')} title={`@${customer.facebook_name}`}>@{customer.facebook_name}</span>}
              {customer.messenger_link && (
                <span className={factPill}><MessageCircle className="h-3 w-3 text-info" aria-hidden /> Messenger</span>
              )}
            </div>
            {/* Location */}
            <div className="flex items-center gap-2 mt-2">
              <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
              {editingLocation ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <Select value={locationType} onValueChange={(v) => {
                    const lt = v as LocationType;
                    setLocationType(lt);
                    if (lt !== 'international') setCountry('');
                  }}>
                    <SelectTrigger className="h-7 text-xs w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="japan">Japan</SelectItem>
                      <SelectItem value="philippines">Philippines</SelectItem>
                      <SelectItem value="international">International</SelectItem>
                    </SelectContent>
                  </Select>
                  {locationType === 'international' && (
                    <div className="w-40">
                      <CountrySelect value={country} onValueChange={setCountry} triggerClassName="h-7 text-xs" />
                    </div>
                  )}
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-emerald-500" onClick={async () => {
                    const loc = toLocationString(locationType, country);
                    if (locationType === 'international' && !loc) { toast.error('Please select a country'); return; }
                    const { error } = await supabase.from('customers').update({ location: loc } as any).eq('id', customer.id);
                    if (error) { toast.error(error.message); return; }
                    toast.success('Location updated');
                    queryClient.invalidateQueries({ queryKey: ['customer-detail', customerId] });
                    queryClient.invalidateQueries({ queryKey: ['customers'] });
                    setEditingLocation(false);
                  }}><Check className="h-3.5 w-3.5" /></Button>
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={() => setEditingLocation(false)}><X className="h-3.5 w-3.5" /></Button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 group">
                  <span className="text-xs text-muted-foreground">{(customer as any).location || 'Not set'}</span>
                  <Button variant="ghost" size="icon" aria-label="Edit location" className="h-5 w-5 transition-opacity text-muted-foreground [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 focus-visible:opacity-100" onClick={() => {
                    const parsed = parseLocation((customer as any).location);
                    setLocationType(parsed.locationType);
                    setCountry(parsed.country);
                    setEditingLocation(true);
                  }}><Pencil className="h-3 w-3" /></Button>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="flex gap-2 flex-wrap border-t border-gold-500/15 pt-4 sm:justify-end">
            <Button variant="outline" size="sm" onClick={startEditCustomer} className="border-primary/30 text-primary hover:bg-primary/10">
              <Pencil className="h-3.5 w-3.5 mr-1.5" /> Edit Details
            </Button>
            <AICustomerInsightsDialog customerId={customer.id} customerName={customer.full_name} />
            <MultiInvoicePaymentDialog
              customerId={customer.id}
              customerName={customer.full_name}
              portalLink={portalLink}
              customerPin={customerPin}
              accounts={accounts.map(({ account, schedule }) => ({
                id: account.id,
                invoice_number: account.invoice_number,
                currency: account.currency,
                remaining_balance: Number(account.remaining_balance),
                total_amount: Number(account.total_amount),
                total_paid: Number(account.total_paid),
                status: account.status,
                notes: account.notes,
                schedule: schedule.map(s => ({
                  id: s.id,
                  installment_number: s.installment_number,
                  due_date: s.due_date,
                  base_installment_amount: Number(s.base_installment_amount),
                  penalty_amount: Number(s.penalty_amount),
                  total_due_amount: Number(s.total_due_amount),
                  paid_amount: Number(s.paid_amount),
                  status: s.status,
                })),
              }))}
            />
            {customer.messenger_link && (
              <a href={customer.messenger_link} target="_blank" rel="noopener noreferrer">
                <Button variant="outline" className="border-info/30 text-info hover:bg-info/10">
                  <MessageCircle className="h-4 w-4 mr-2" /> Messenger
                </Button>
              </a>
            )}
        </div>
        </div>
        </div>

        {/* Inline Customer Detail Editor */}
        {editingCustomer && (
          <div className="rounded-2xl border border-gold-500/30 bg-card p-4 sm:p-5 space-y-3 animate-fade-in">
            <h3 className="flex flex-wrap items-center gap-x-2 gap-y-1 pb-2 hairline-b">
              <Pencil className="h-3.5 w-3.5 text-gold-300" aria-hidden />
              <span className="font-deco text-xl font-semibold text-champagne">Edit Customer Details</span>
              <span className="text-[10px] text-muted-foreground font-normal sm:ml-auto">Changes will reflect in generated messages</span>
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Full Name *</label>
                <Input value={editFields.full_name} onChange={e => setEditFields(f => ({ ...f, full_name: e.target.value }))} className="h-8 text-sm" />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Facebook Name</label>
                <Input value={editFields.facebook_name} onChange={e => setEditFields(f => ({ ...f, facebook_name: e.target.value }))} className="h-8 text-sm" />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Messenger Link</label>
                <Input value={editFields.messenger_link} onChange={e => setEditFields(f => ({ ...f, messenger_link: e.target.value }))} className="h-8 text-sm" />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Mobile Number</label>
                <Input value={editFields.mobile_number} onChange={e => setEditFields(f => ({ ...f, mobile_number: e.target.value }))} className="h-8 text-sm" />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Email</label>
                <Input type="email" value={editFields.email} onChange={e => setEditFields(f => ({ ...f, email: e.target.value }))} className="h-8 text-sm" />
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" size="sm" onClick={() => setEditingCustomer(false)} className="h-7 text-xs">Cancel</Button>
              <Button size="sm" onClick={saveCustomerEdit} disabled={editSaving} className="h-7 text-xs gold-gradient text-primary-foreground">
                <Save className="h-3 w-3 mr-1" /> {editSaving ? 'Saving…' : 'Save Changes'}
              </Button>
            </div>
          </div>
        )}

        {/* Contact & notes — the customer row the page already loaded. Shown
            only to users who may edit customers (owner decision, PR #175). */}
        {canEditCustomer && (
        <section aria-label="Contact details" className="rounded-2xl border border-gold-500/15 bg-card p-4 sm:p-5">
          <h2 className="font-deco text-xl font-semibold text-champagne pb-2 mb-3 hairline-b">Contact &amp; notes</h2>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            {([
              { icon: Phone, label: 'Mobile', value: customer.mobile_number },
              { icon: Mail, label: 'Email', value: customer.email },
              { icon: Facebook, label: 'Facebook name', value: customer.facebook_name ? `@${customer.facebook_name}` : null },
              { icon: MessageCircle, label: 'Messenger', value: customer.messenger_link, href: customer.messenger_link },
              { icon: MapPin, label: 'Location', value: customer.location },
            ] as { icon: typeof Phone; label: string; value: string | null; href?: string | null }[]).map(({ icon: Icon, label, value, href }) => (
              <div key={label} className="min-w-0">
                <dt className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.12em] text-ink-muted">
                  <Icon className="h-3 w-3" aria-hidden /> {label}
                </dt>
                <dd className="mt-0.5 truncate text-sm text-card-foreground" title={value ?? undefined}>
                  {value ? (href ? <a href={href} target="_blank" rel="noopener noreferrer" className="text-info hover:underline">{value}</a> : value) : <span className="text-muted-foreground/60">—</span>}
                </dd>
              </div>
            ))}
          </dl>
          {customer.notes && (
            <div className="mt-3 pt-3 hairline-t">
              <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.12em] text-ink-muted">
                <StickyNote className="h-3 w-3" aria-hidden /> Notes
              </p>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-card-foreground">{customer.notes}</p>
            </div>
          )}
        </section>
        )}

        {/* Customer Portal Link */}
        <CustomerPortalShareMenu
          customerId={customer.id}
          customerName={customer.full_name}
          messengerLink={customer.messenger_link}
          customerEmail={customer.email ?? null}
          authUserId={customer.auth_user_id ?? null}
          setupLinkSentAt={(customer as any).setup_link_sent_at ?? null}
        />

        {canManagePin && (
          <>
            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setPinInput(''); setPinDialogOpen(true); }}
                className="h-8 text-xs border-primary/30 text-primary hover:bg-primary/10"
              >
                <KeyRound className="h-3.5 w-3.5 mr-1.5" /> Set Portal PIN
              </Button>
            </div>
            <Dialog open={pinDialogOpen} onOpenChange={setPinDialogOpen}>
              <DialogContent className="bg-card border-border sm:max-w-sm">
                <DialogHeader>
                  <DialogTitle className="text-card-foreground">Set Portal PIN</DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Choose a 4-digit PIN for {customer.full_name}'s portal access. The customer will need this PIN every time they open the portal.
                  </p>
                  <Input
                    type="password"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={4}
                    autoFocus
                    value={pinInput}
                    onChange={e => setPinInput(e.target.value.replace(/\D/g, '').slice(0, 4))}
                    placeholder="••••"
                    className="text-center text-2xl tracking-[0.75em] bg-background border-border"
                  />
                </div>
                <DialogFooter>
                  <Button variant="ghost" onClick={() => setPinDialogOpen(false)} disabled={pinSaving}>Cancel</Button>
                  <Button
                    onClick={handleSetPin}
                    disabled={pinInput.length !== 4 || pinSaving}
                    className="gold-gradient text-primary-foreground"
                  >
                    {pinSaving ? 'Saving…' : 'Set PIN'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        )}

        <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
          <TabsList className="flex w-full max-w-2xl justify-start overflow-x-auto scrollbar-hide sm:grid sm:grid-cols-4 [&>*]:shrink-0">
            <TabsTrigger value="layaway">Layaway Accounts ({accounts.length})</TabsTrigger>
            <TabsTrigger value="cash">Cash Orders</TabsTrigger>
            <TabsTrigger value="loyalty">Loyalty</TabsTrigger>
            <TabsTrigger value="credit">Store Credit</TabsTrigger>
          </TabsList>

          <TabsContent value="layaway" className="mt-5 space-y-6">

        {/* Header — mirrors the Cash Orders tab (Bug #284) */}
        <div className="flex items-end justify-between gap-3 flex-wrap pb-3 hairline-b">
          <div>
            <h3 className="font-deco text-2xl font-semibold leading-tight text-champagne">Layaway Accounts</h3>
            <p className="text-xs text-muted-foreground">{accounts.length} total</p>
          </div>
          {canCreateLayaway && (
            <Link to={newLayawayHref}>
              <Button className="gold-gradient text-primary-foreground font-medium shadow">
                <Plus className="h-4 w-4 mr-1.5" /> New Layaway Order
              </Button>
            </Link>
          )}
        </div>

        {accounts.length === 0 && (
          <IllustratedState
            kind="ledger"
            className="rounded-xl border border-gold-500/15 bg-card py-10"
            text="No layaway accounts for this customer"
            action={canCreateLayaway ? (
              <Link to={newLayawayHref}>
                <Button className="gold-gradient text-primary-foreground font-medium">
                  <Plus className="h-4 w-4 mr-1.5" /> New Layaway Order
                </Button>
              </Link>
            ) : undefined}
          />
        )}

        {/* Desktop: every layaway account at a glance, as the Sales ledger. */}
        {!isMobile && accounts.length > 0 && (
          <DataTable
            variant="ledger"
            showToolbar={false}
            stickyHeader={false}
            columns={accountColumns}
            rows={accounts}
            rowKey={({ account }) => account.id}
            onRowClick={({ account }) => navigate(`/accounts/${account.id}`)}
            rowProps={({ account }) => ({
              tabIndex: 0,
              'aria-label': `Account ${account.invoice_number}. Press Enter to open.`,
              onKeyDown: (e: React.KeyboardEvent<HTMLTableRowElement>) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                if ((e.target as HTMLElement).closest('button, a')) return;
                e.preventDefault();
                navigate(`/accounts/${account.id}`);
              },
            })}
          />
        )}

        {/* All Accounts */}
        {accounts.map(({ account, schedule, penalties, schedulePaymentDates, services: acctServices }) => {
          const currency = account.currency as Currency;
          const totalAmount = Number(account.total_amount);
          const totalPaid = Number(account.total_paid);
          const remainingBalance = Number(account.remaining_balance);
          const progress = totalAmount > 0 ? (totalPaid / totalAmount) * 100 : 0;

          const effectiveStatus = effectiveStatusOf(account, schedule);

          return (
          <div key={account.id} id={`account-${account.id}`} className="rounded-2xl border border-gold-500/15 bg-card p-4 sm:p-5 space-y-4 scroll-mt-24">
              <div className="flex items-center justify-between flex-wrap gap-2 pb-3 hairline-b">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <Link to={`/accounts/${account.id}`} className="rounded-sm transition-colors hover:text-gold-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <h2 className="font-deco text-xl sm:text-2xl font-semibold leading-none text-champagne [font-variant-numeric:lining-nums_tabular-nums]">
                      INV #{account.invoice_number}
                    </h2>
                  </Link>
                  <StatusPill
                    size="md"
                    label={badgeLabel[effectiveStatus] || effectiveStatus}
                    tone={ACCOUNT_STATUS_TONE[effectiveStatus] ?? 'muted'}
                    pulse={effectiveStatus === 'overdue'}
                  />
                  <span className={factPill}>{currency}</span>
                </div>
                <div className="flex gap-2 items-center flex-wrap">
                  {account.status !== 'completed' && account.status !== 'forfeited' && remainingBalance > 0 && (
                    <>
                      <RecordPaymentDialog
                        accountId={account.id}
                        currency={currency}
                        remainingBalance={remainingBalance}
                      />
                      <RecordPaymentDialog
                        accountId={account.id}
                        currency={currency}
                        remainingBalance={remainingBalance}
                        payFullBalance
                      />
                    </>
                  )}
                  {account.status !== 'completed' && account.status !== 'forfeited' && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="outline" size="sm" className="text-xs border-destructive/30 text-destructive hover:bg-destructive/10">
                          <Ban className="h-3 w-3 mr-1" /> Forfeit
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Forfeit INV #{account.invoice_number}?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This will mark the account as forfeited. The remaining balance of {formatCurrency(remainingBalance, currency)} will be written off. This action cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={() => {
                              forfeitAccount.mutate(account.id, {
                                onSuccess: () => {
                                  toast.success(`INV #${account.invoice_number} forfeited`);
                                  queryClient.invalidateQueries({ queryKey: ['customer-detail', customerId] });
                                },
                                onError: (err) => toast.error(err.message),
                              });
                            }}
                          >
                            Forfeit
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </div>
              </div>

              {/* Summary row */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.12em] text-ink-muted">Total</p>
                  <p className="text-sm font-bold text-card-foreground tabular-nums">{formatCurrency(totalAmount, currency)}</p>
                </div>
                {(() => {
                  const dpAmt = Number((account as any).downpayment_amount || 0);
                  if (dpAmt <= 0) return null;
                  const dpPays = (data.accounts.find(a => a.account.id === account.id)?.payments || []).filter(
                    (p: any) => !p.voided_at && ((p.reference_number && String(p.reference_number).startsWith('DP-')) || (p.remarks && String(p.remarks).toLowerCase() === 'downpayment'))
                  );
                  const dpPd = dpPays.reduce((s: number, p: any) => s + Number(p.amount_paid), 0);
                  return (
                    <div>
                      <p className="text-[10px] uppercase tracking-[0.12em] text-ink-muted">Downpayment</p>
                      <p className="text-sm font-bold text-primary tabular-nums">{formatCurrency(dpAmt, currency)}</p>
                      <p className={`text-[10px] ${dpPd >= dpAmt ? 'text-success' : dpPd > 0 ? 'text-warning' : 'text-muted-foreground'}`}>
                        {dpPd >= dpAmt ? '✅ Paid' : dpPd > 0 ? `Paid: ${formatCurrency(dpPd, currency)}` : 'Unpaid'}
                      </p>
                    </div>
                  );
                })()}
                <div>
                  <p className="text-[10px] uppercase tracking-[0.12em] text-ink-muted">Paid</p>
                  <p className="text-sm font-bold text-success tabular-nums">{formatCurrency(totalPaid, currency)}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-[0.12em] text-ink-muted">Remaining</p>
                  <p className="text-sm font-bold text-card-foreground tabular-nums">{formatCurrency(remainingBalance, currency)}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-[0.12em] text-ink-muted">Progress</p>
                  <p className="text-sm font-bold text-primary">{Math.round(progress)}%</p>
                  <div className="mt-1 h-1.5 rounded-full bg-muted overflow-hidden">
                    <div className="h-full gold-gradient rounded-full transition-all" style={{ width: `${progress}%` }} />
                  </div>
                </div>
              </div>

              {/* Schedule */}
              <div className="space-y-1.5">
                <h3 className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-muted flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5 text-gold-300" aria-hidden /> Schedule
                  {account.status === 'completed' && (
                    <StatusPill label="Paid in Full" tone="gold" className="ml-1 normal-case tracking-normal" />
                  )}
                </h3>
                {/* Downpayment row */}
                {(() => {
                  const dpAmt = Number((account as any).downpayment_amount || 0);
                  if (dpAmt <= 0) return null;
                  const dpPays = (data.accounts.find(a => a.account.id === account.id)?.payments || []).filter(
                    (p: any) => !p.voided_at && ((p.reference_number && String(p.reference_number).startsWith('DP-')) || (p.remarks && String(p.remarks).toLowerCase() === 'downpayment'))
                  );
                  const dpPd = dpPays.reduce((s: number, p: any) => s + Number(p.amount_paid), 0);
                  const dpDone = dpPd >= dpAmt;
                  return (
                    <div className={`flex items-center justify-between p-2.5 rounded-lg border ${dpDone ? 'bg-success/5 border-success/10' : dpPd > 0 ? 'bg-warning/5 border-warning/10' : 'bg-primary/5 border-primary/10'}`}>
                      <div className="flex items-center gap-2">
                        <div className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold ${dpDone ? 'bg-success/20 text-success' : 'bg-primary/20 text-primary'}`}>
                          {dpDone ? <Check className="h-3 w-3" /> : 'DP'}
                        </div>
                        <div>
                          <p className="text-xs font-medium text-card-foreground">30% Downpayment</p>
                          <p className="text-[10px] text-muted-foreground">
                            {dpDone ? 'Paid' : dpPd > 0 ? `Partial — ${formatCurrency(dpPd, currency)} paid` : 'Due on order'}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className={`text-xs font-semibold tabular-nums ${dpDone ? 'text-success' : 'text-primary'}`}>
                          {formatCurrency(dpAmt, currency)}
                        </p>
                      </div>
                    </div>
                  );
                })()}
                {schedule.filter(item => item.status !== 'cancelled').map((item) => {
                  const effPaid = item.status === 'paid' || (Number(item.paid_amount) > 0 && Number(item.paid_amount) >= Number(item.total_due_amount));
                  const penaltyAmt = Number(item.penalty_amount);
                  const baseAmt = Number(item.base_installment_amount);
                  const paidAmt = Number(item.paid_amount);
                  const displayDate = new Date(item.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                  return (
                    <div key={item.id}
                      className={`flex items-center justify-between p-2.5 rounded-lg border ${
                        effPaid ? 'bg-success/5 border-success/10' : 'bg-card border-border'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <div className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold ${
                          effPaid ? 'bg-success/20 text-success' : 'bg-muted text-muted-foreground'
                        }`}>
                          {effPaid ? <Check className="h-3 w-3" /> : item.installment_number}
                        </div>
                        <div>
                          <p className="text-xs font-medium text-card-foreground">
                            {displayDate}
                          </p>
                          <p className="text-[10px] text-muted-foreground">
                            {effPaid ? 'Paid' : `Due · Month ${item.installment_number}`}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        {penaltyAmt > 0 ? (
                          <div>
                            <p className={`text-xs font-semibold tabular-nums ${effPaid ? 'text-success' : 'text-card-foreground'}`}>
                              {formatCurrency(Number(item.total_due_amount), currency)}
                            </p>
                            <p className="text-[10px] text-destructive flex items-center gap-1 justify-end">
                              <AlertTriangle className="h-2.5 w-2.5" />
                              {effPaid ? 'Incl.' : '+'}{formatCurrency(penaltyAmt, currency)}
                            </p>
                          </div>
                        ) : (
                          <p className={`text-xs font-semibold tabular-nums ${effPaid ? 'text-success' : 'text-card-foreground'}`}>
                            {effPaid ? formatCurrency(Math.max(paidAmt, Number(item.total_due_amount)), currency) : formatCurrency(baseAmt, currency)}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Additional Services */}
              {(acctServices as any[] || []).length > 0 && (
                <div className="space-y-1.5">
                  <h3 className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-muted flex items-center gap-1.5">
                    <Wrench className="h-3.5 w-3.5 text-gold-300" aria-hidden /> Additional Services
                    <span className="ml-auto text-xs font-bold normal-case tracking-normal text-card-foreground tabular-nums">
                      Total: {formatCurrency((acctServices as any[]).reduce((s: number, svc: any) => s + Number(svc.amount), 0), currency)}
                    </span>
                  </h3>
                  {(acctServices as any[]).map((svc: any) => (
                    <div key={svc.id} className="flex items-center justify-between p-2 rounded-lg border border-border bg-card">
                      <div className="flex items-center gap-2">
                        <div className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-primary">
                          <Wrench className="h-2.5 w-2.5" />
                        </div>
                        <div>
                          <p className="text-xs font-medium text-card-foreground">
                            {svc.service_type === 'change_color' ? 'Change Color' : svc.service_type.charAt(0).toUpperCase() + svc.service_type.slice(1)}
                          </p>
                          {svc.description && <p className="text-[10px] text-muted-foreground">{svc.description}</p>}
                        </div>
                      </div>
                      <p className="text-xs font-semibold tabular-nums text-card-foreground">
                        {formatCurrency(Number(svc.amount), currency)}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {/* Consolidated Customer Message — only when the customer has layaway accounts (Bug #284) */}
        {accounts.length > 0 && (
        <div className="rounded-2xl border border-gold-500/15 bg-card p-4 sm:p-5">
          <h3 className="flex items-center gap-2 pb-2 mb-4 hairline-b">
            <MessageCircle className="h-4 w-4 text-info" aria-hidden />
            <span className="font-deco text-xl font-semibold text-champagne">Consolidated Customer Message</span>
          </h3>
          <div className="rounded-lg bg-muted/50 p-3 sm:p-4 border border-border">
            <pre className="text-[10px] sm:text-xs text-card-foreground whitespace-pre-wrap font-body leading-relaxed">
              {message}
            </pre>
          </div>
          <div className="flex gap-2 mt-4 flex-wrap">
            <Button onClick={handleCopy} variant="outline" size="sm" className="border-primary/30 text-primary hover:bg-primary/10">
              {copied ? <Check className="h-3.5 w-3.5 mr-1" /> : <Copy className="h-3.5 w-3.5 mr-1" />}
              {copied ? 'Copied!' : 'Copy Message'}
            </Button>
            {customer.messenger_link && (
              <a href={customer.messenger_link} target="_blank" rel="noopener noreferrer">
                <Button variant="outline" size="sm" className="border-info/30 text-info hover:bg-info/10">
                  <MessageCircle className="h-3.5 w-3.5 mr-1" /> Messenger
                </Button>
              </a>
            )}
          </div>
        </div>
        )}

          </TabsContent>

          <TabsContent value="cash" className="mt-5">
            {customerId && <CustomerCashOrdersTab customerId={customerId} />}
          </TabsContent>

          <TabsContent value="loyalty" className="mt-5">
            {customerId && <CustomerLoyaltyTab customerId={customerId} />}
          </TabsContent>

          <TabsContent value="credit" className="mt-5">
            {customerId && <CustomerStoreCreditTab customerId={customerId} />}
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
