import { useState, useCallback, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ROUTES } from '@/constants/routes';
import { ArrowLeft, Copy, Check, CheckCircle2, MessageCircle, Calendar, AlertTriangle, MapPin, Pencil, X, Ban, Wrench, Save } from 'lucide-react';
import CustomerPortalShareMenu from '@/components/customers/CustomerPortalShareMenu';
import AppLayout from '@/components/layout/AppLayout';
import CountrySelect from '@/components/customers/CountrySelect';
import { LocationType, parseLocation, toLocationString } from '@/lib/countries';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import RecordPaymentDialog from '@/components/payments/RecordPaymentDialog';
import MultiInvoicePaymentDialog from '@/components/payments/MultiInvoicePaymentDialog';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { toast } from 'sonner';
import { useCustomerAccounts, useForfeitAccount } from '@/hooks/use-supabase-data';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import {
  isEffectivelyPaid, isPartiallyPaid, remainingDue, getUnpaidScheduleItems, getMessageSchedulePaymentCoverage,
  ordinal, SERVICE_LABELS, accountProgress, getNextPaymentStatementDate,
} from '@/lib/business-rules';

export default function CustomerDetail() {
  const { customerId } = useParams();
  const { data, isLoading } = useCustomerAccounts(customerId);
  const [copied, setCopied] = useState(false);
  const [editingLocation, setEditingLocation] = useState(false);
  const [locationType, setLocationType] = useState<LocationType>('japan');
  const [country, setCountry] = useState('');
  const queryClient = useQueryClient();
  const forfeitAccount = useForfeitAccount();

  // Portal link for split payment confirmation message
  const [portalLink, setPortalLink] = useState<string | null>(null);
  useEffect(() => {
    if (!customerId) return;
    (async () => {
      const { data: tokenRow } = await (supabase as any)
        .from('customer_portal_tokens')
        .select('token')
        .eq('customer_id', customerId)
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (tokenRow?.token) {
        setPortalLink(`https://chajewelslayaway.web.app/portal?token=${tokenRow.token}`);
      }
    })();
  }, [customerId]);

  // --- Inline customer detail editing (hooks must be before early returns) ---
  const [editingCustomer, setEditingCustomer] = useState(false);
  const [editFields, setEditFields] = useState({
    full_name: '', facebook_name: '', messenger_link: '', mobile_number: '', email: '',
  });
  const [editSaving, setEditSaving] = useState(false);

  const customer = data?.customer;

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

  // Filter accounts: only include active/open invoices for consolidated message
  const activeAccounts = accounts.filter(a => 
    !['completed', 'cancelled'].includes(a.account.status)
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

      const paymentParts = activePayments.map((p: any) => {
        const amt = Number(p.amount_paid);
        if (currency === 'JPY') return Math.round(amt).toLocaleString('en-US');
        const rounded = Math.round(amt * 100) / 100;
        return rounded % 1 === 0
          ? rounded.toLocaleString('en-US')
          : rounded.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      });
      const paymentBreakdownText = activePayments.length > 0
        ? `${paymentParts.join(' + ')} = ${formatCurrency(totalPaid, currency)}`
        : formatCurrency(totalPaid, currency);
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
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <Link to={ROUTES.CUSTOMERS}>
            <Button variant="ghost" size="icon" className="text-muted-foreground">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="flex-1">
            <h1 className="text-xl sm:text-2xl font-bold text-foreground font-display">{customer.full_name}</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {customer.customer_code} · {accounts.filter(a => a.account.status !== 'forfeited' && a.account.status !== 'cancelled').length} active account{accounts.filter(a => a.account.status !== 'forfeited' && a.account.status !== 'cancelled').length !== 1 ? 's' : ''}
              {customer.facebook_name && ` · @${customer.facebook_name}`}
            </p>
            {/* Location */}
            <div className="flex items-center gap-2 mt-1">
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
                  <Button variant="ghost" size="icon" className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground" onClick={() => {
                    const parsed = parseLocation((customer as any).location);
                    setLocationType(parsed.locationType);
                    setCountry(parsed.country);
                    setEditingLocation(true);
                  }}><Pencil className="h-3 w-3" /></Button>
                </div>
              )}
            </div>
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button variant="outline" size="sm" onClick={startEditCustomer} className="border-primary/30 text-primary hover:bg-primary/10">
              <Pencil className="h-3.5 w-3.5 mr-1.5" /> Edit Details
            </Button>
            <MultiInvoicePaymentDialog
              customerId={customer.id}
              customerName={customer.full_name}
              accounts={accounts.map(({ account }) => ({
                id: account.id,
                invoice_number: account.invoice_number,
                currency: account.currency,
                remaining_balance: Number(account.remaining_balance),
                total_amount: Number(account.total_amount),
                total_paid: Number(account.total_paid),
                status: account.status,
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

        {/* Inline Customer Detail Editor */}
        {editingCustomer && (
          <div className="rounded-xl border border-primary/20 bg-card p-4 space-y-3 animate-fade-in">
            <h3 className="text-sm font-semibold text-card-foreground flex items-center gap-2">
              <Pencil className="h-3.5 w-3.5 text-primary" /> Edit Customer Details
              <span className="text-[10px] text-muted-foreground font-normal ml-auto">Changes will reflect in generated messages</span>
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

        {/* Customer Portal Link */}
        <CustomerPortalShareMenu customerId={customer.id} customerName={customer.full_name} messengerLink={customer.messenger_link} />

        {/* All Accounts */}
        {accounts.map(({ account, schedule, penalties, schedulePaymentDates, services: acctServices }) => {
          const currency = account.currency as Currency;
          const totalAmount = Number(account.total_amount);
          const totalPaid = Number(account.total_paid);
          const remainingBalance = Number(account.remaining_balance);
          const progress = totalAmount > 0 ? (totalPaid / totalAmount) * 100 : 0;

          return (
          <div key={account.id} className="rounded-xl border border-border bg-card p-4 sm:p-5 space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-3">
                  <Link to={`/accounts/${account.id}`} className="hover:text-primary transition-colors">
                    <h2 className="text-base sm:text-lg font-bold text-card-foreground font-display">
                      INV #{account.invoice_number}
                    </h2>
                  </Link>
                  <Badge variant="outline" className={`text-xs ${
                    account.status === 'completed' ? 'bg-success/10 text-success border-success/20' :
                    account.status === 'overdue' ? 'bg-destructive/10 text-destructive border-destructive/20' :
                    account.status === 'forfeited' ? 'bg-muted text-muted-foreground border-border' :
                    'bg-primary/10 text-primary border-primary/20'
                  }`}>
                    {account.status}
                  </Badge>
                  <Badge variant="outline" className="text-xs">{currency}</Badge>
                </div>
                <div className="flex gap-2 items-center">
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
                  <p className="text-[10px] text-muted-foreground uppercase">Total</p>
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
                      <p className="text-[10px] text-muted-foreground uppercase">Downpayment</p>
                      <p className="text-sm font-bold text-primary tabular-nums">{formatCurrency(dpAmt, currency)}</p>
                      <p className={`text-[10px] ${dpPd >= dpAmt ? 'text-success' : dpPd > 0 ? 'text-warning' : 'text-muted-foreground'}`}>
                        {dpPd >= dpAmt ? '✅ Paid' : dpPd > 0 ? `Paid: ${formatCurrency(dpPd, currency)}` : 'Unpaid'}
                      </p>
                    </div>
                  );
                })()}
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase">Paid</p>
                  <p className="text-sm font-bold text-success tabular-nums">{formatCurrency(totalPaid, currency)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase">Remaining</p>
                  <p className="text-sm font-bold text-card-foreground tabular-nums">{formatCurrency(remainingBalance, currency)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase">Progress</p>
                  <p className="text-sm font-bold text-primary">{Math.round(progress)}%</p>
                  <div className="mt-1 h-1.5 rounded-full bg-muted overflow-hidden">
                    <div className="h-full gold-gradient rounded-full transition-all" style={{ width: `${progress}%` }} />
                  </div>
                </div>
              </div>

              {/* Schedule */}
              <div className="space-y-1.5">
                <h3 className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5 text-primary" /> Schedule
                  {account.status === 'completed' && (
                    <Badge variant="outline" className="text-[10px] bg-success/10 text-success border-success/20 ml-1">Paid in Full</Badge>
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
                  const actualPayDate = schedulePaymentDates?.[item.id];
                  const displayDate = effPaid && actualPayDate
                    ? new Date(actualPayDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                    : new Date(item.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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
                  <h3 className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                    <Wrench className="h-3.5 w-3.5 text-primary" /> Additional Services
                    <span className="ml-auto text-xs font-bold text-card-foreground tabular-nums">
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

        {/* Consolidated Customer Message */}
        <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
          <h3 className="text-sm font-semibold text-card-foreground mb-4 flex items-center gap-2">
            <MessageCircle className="h-4 w-4 text-info" /> Consolidated Customer Message
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
      </div>
    </AppLayout>
  );
}
