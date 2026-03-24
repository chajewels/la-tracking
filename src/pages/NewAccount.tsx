import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { ROUTES } from '@/constants/routes';
import { ArrowLeft, UserPlus, ChevronDown, ChevronUp, Banknote, Copy, Check, MessageCircle, Wand2, Save, AlertTriangle } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { generateScheduleDates, calculateInstallments, formatCurrency } from '@/lib/calculations';
import { Currency, PaymentPlan } from '@/lib/types';
import { toast } from 'sonner';
import { useCustomers, useAccounts, useCreateAccount, DbCustomer } from '@/hooks/use-supabase-data';
import NewCustomerDialog from '@/components/customers/NewCustomerDialog';
import { Badge } from '@/components/ui/badge';
import { useAccountDraft, clearAccountDraft } from '@/hooks/use-account-draft';

type RemainingDpOption = 'split' | 'add_to_installments';
type InstallmentMode = 'equal' | 'custom';

interface SplitAllocation {
  account_id: string;
  amount: string; // string for input binding
}

export default function NewAccount() {
  const navigate = useNavigate();
  const { data: customers } = useCustomers();
  const { data: allAccounts } = useAccounts();
  const createAccount = useCreateAccount();
  const { initialDraft, persistDraft, clearDraft, restored, markRestored } = useAccountDraft();
  const draftRestoredRef = useRef(false);

  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [currency, setCurrency] = useState<Currency>('PHP');
  const [totalAmount, setTotalAmount] = useState('');
  const [orderDate, setOrderDate] = useState('');
  const [paymentPlan, setPaymentPlan] = useState<PaymentPlan>(3);
  const [downpaymentInput, setDownpaymentInput] = useState('');
  const [downpaymentPaid, setDownpaymentPaid] = useState('');
  const [remainingDpOption, setRemainingDpOption] = useState<RemainingDpOption>('split');

  // Custom installment mode
  const [installmentMode, setInstallmentMode] = useState<InstallmentMode>('equal');
  const [customAmounts, setCustomAmounts] = useState<string[]>([]);

  // Split payment state
  const [enableSplitPayment, setEnableSplitPayment] = useState(false);
  const [lumpSumInput, setLumpSumInput] = useState('');
  const [splitAllocations, setSplitAllocations] = useState<SplitAllocation[]>([]);
  const [splitExpanded, setSplitExpanded] = useState(true);
  const [splitMessageDialog, setSplitMessageDialog] = useState<string | null>(null);
  const [splitMsgCopied, setSplitMsgCopied] = useState(false);

  // Track if form has unsaved changes
  const [formDirty, setFormDirty] = useState(false);
  const [draftSavedIndicator, setDraftSavedIndicator] = useState(false);
  const [showLeaveDialog, setShowLeaveDialog] = useState(false);
  const submittedRef = useRef(false);
  const pendingNavRef = useRef<string | null>(null);

  // Restore draft on mount
  useEffect(() => {
    if (initialDraft && !draftRestoredRef.current) {
      draftRestoredRef.current = true;
      setInvoiceNumber(initialDraft.invoiceNumber || '');
      setCustomerId(initialDraft.customerId || '');
      setCurrency(initialDraft.currency || 'PHP');
      setTotalAmount(initialDraft.totalAmount || '');
      setOrderDate(initialDraft.orderDate || '');
      setPaymentPlan(initialDraft.paymentPlan || 3);
      setDownpaymentInput(initialDraft.downpaymentInput || '');
      setDownpaymentPaid(initialDraft.downpaymentPaid || '');
      setRemainingDpOption(initialDraft.remainingDpOption || 'split');
      setInstallmentMode(initialDraft.installmentMode || 'equal');
      setCustomAmounts(initialDraft.customAmounts || []);
      setEnableSplitPayment(initialDraft.enableSplitPayment || false);
      setLumpSumInput(initialDraft.lumpSumInput || '');
      setFormDirty(true);
      markRestored();
    }
  }, [initialDraft, markRestored]);

  // Auto-save draft on changes
  useEffect(() => {
    if (!formDirty && !invoiceNumber && !customerId && !totalAmount) return;
    
    const timer = setTimeout(() => {
      persistDraft({
        invoiceNumber,
        customerId,
        currency,
        totalAmount,
        orderDate,
        paymentPlan,
        downpaymentInput,
        downpaymentPaid,
        remainingDpOption,
        installmentMode,
        customAmounts,
        enableSplitPayment,
        lumpSumInput,
      });
      if (formDirty) {
        setDraftSavedIndicator(true);
        setTimeout(() => setDraftSavedIndicator(false), 2000);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [invoiceNumber, customerId, currency, totalAmount, orderDate, paymentPlan, downpaymentInput, downpaymentPaid, remainingDpOption, installmentMode, customAmounts, enableSplitPayment, lumpSumInput, formDirty, persistDraft]);

  // Mark form as dirty on any change
  const markDirty = useCallback(() => {
    if (!formDirty) setFormDirty(true);
  }, [formDirty]);

  // Browser beforeunload protection
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (formDirty && !submittedRef.current) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [formDirty]);

  // Navigation guard helper
  const guardedNavigate = useCallback((path: string) => {
    if (formDirty && !submittedRef.current) {
      pendingNavRef.current = path;
      setShowLeaveDialog(true);
    } else {
      navigate(path);
    }
  }, [formDirty, navigate]);

  const amount = parseInt(totalAmount) || 0;
  const downpaymentAmount = parseInt(downpaymentInput) || 0;
  const lumpSum = parseInt(lumpSumInput) || 0;

  // Existing active/overdue accounts for selected customer
  const customerAccounts = useMemo(() => {
    if (!customerId || !allAccounts) return [];
    return allAccounts.filter(
      a => a.customer_id === customerId &&
        (a.status === 'active' || a.status === 'overdue') &&
        Number(a.remaining_balance) > 0
    );
  }, [customerId, allAccounts]);

  // Calculate split payment amounts
  const totalAllocatedToExisting = useMemo(() =>
    splitAllocations.reduce((sum, a) => sum + (parseInt(a.amount) || 0), 0),
    [splitAllocations]
  );

  const effectiveDpPaid = enableSplitPayment
    ? Math.max(0, lumpSum - totalAllocatedToExisting)
    : parseInt(downpaymentPaid) || 0;

  const dpPaid = effectiveDpPaid;
  const remainingDp = Math.max(0, downpaymentAmount - dpPaid);
  const hasShortDp = downpaymentAmount > 0 && dpPaid > 0 && dpPaid < downpaymentAmount;

  const baseForInstallments = Math.max(0, amount - downpaymentAmount);
  const installmentTotal = hasShortDp
    ? baseForInstallments + remainingDp
    : baseForInstallments;

  const previewDates = orderDate ? generateScheduleDates(orderDate, paymentPlan) : [];

  // Initialize custom amounts when switching to custom mode or changing plan
  const initCustomAmounts = useCallback(() => {
    const equalAmts = (() => {
      if (installmentTotal <= 0) return Array(paymentPlan).fill(0);
      if (hasShortDp && remainingDpOption === 'split') {
        const baseInstallments = calculateInstallments(baseForInstallments, paymentPlan);
        const dpPerMonth = Math.floor(remainingDp / paymentPlan);
        const dpRemainder = remainingDp - dpPerMonth * paymentPlan;
        return baseInstallments.map((base, i) => base + dpPerMonth + (i === paymentPlan - 1 ? dpRemainder : 0));
      }
      if (hasShortDp && remainingDpOption === 'add_to_installments') {
        const installments = calculateInstallments(baseForInstallments, paymentPlan);
        if (installments.length > 0) installments[0] += remainingDp;
        return installments;
      }
      return calculateInstallments(installmentTotal, paymentPlan);
    })();
    setCustomAmounts(equalAmts.map(String));
  }, [installmentTotal, paymentPlan, hasShortDp, remainingDpOption, baseForInstallments, remainingDp]);

  const previewInstallments = (() => {
    if (installmentMode === 'custom' && customAmounts.length === paymentPlan) {
      return customAmounts.map(v => parseInt(v) || 0);
    }
    if (installmentTotal <= 0) return [];
    if (hasShortDp && remainingDpOption === 'split') {
      const baseInstallments = calculateInstallments(baseForInstallments, paymentPlan);
      const dpPerMonth = Math.floor(remainingDp / paymentPlan);
      const dpRemainder = remainingDp - dpPerMonth * paymentPlan;
      return baseInstallments.map((base, i) => base + dpPerMonth + (i === paymentPlan - 1 ? dpRemainder : 0));
    }
    if (hasShortDp && remainingDpOption === 'add_to_installments') {
      const installments = calculateInstallments(baseForInstallments, paymentPlan);
      if (installments.length > 0) installments[0] += remainingDp;
      return installments;
    }
    return calculateInstallments(installmentTotal, paymentPlan);
  })();

  // Custom installment validation
  const customTotal = installmentMode === 'custom'
    ? customAmounts.reduce((s, v) => s + (parseInt(v) || 0), 0)
    : 0;
  const expectedInstallmentTotal = Math.max(0, amount - downpaymentAmount);
  const customMismatch = installmentMode === 'custom' && customAmounts.length === paymentPlan && customTotal !== expectedInstallmentTotal;

  const updateCustomAmount = (index: number, value: string) => {
    setCustomAmounts(prev => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
    markDirty();
  };

  const autoAdjustLastMonth = () => {
    if (customAmounts.length !== paymentPlan) return;
    const sumExceptLast = customAmounts.slice(0, -1).reduce((s, v) => s + (parseInt(v) || 0), 0);
    const lastAmount = Math.max(0, expectedInstallmentTotal - sumExceptLast);
    setCustomAmounts(prev => {
      const next = [...prev];
      next[next.length - 1] = String(lastAmount);
      return next;
    });
    markDirty();
  };

  // Toggle an existing account in the split allocation list
  const toggleAccount = (accountId: string) => {
    setSplitAllocations(prev => {
      const exists = prev.find(a => a.account_id === accountId);
      if (exists) return prev.filter(a => a.account_id !== accountId);
      return [...prev, { account_id: accountId, amount: '' }];
    });
    markDirty();
  };

  const updateAllocationAmount = (accountId: string, value: string) => {
    setSplitAllocations(prev =>
      prev.map(a => a.account_id === accountId ? { ...a, amount: value } : a)
    );
    markDirty();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!invoiceNumber || !customerId || !totalAmount || !orderDate) {
      toast.error('Please fill in all required fields');
      return;
    }

    // Custom installment validation
    if (installmentMode === 'custom') {
      if (customMismatch) {
        toast.error(`Total installments (${formatCurrency(customTotal, currency)}) must match remaining balance (${formatCurrency(expectedInstallmentTotal, currency)})`);
        return;
      }
      if (customAmounts.some(v => (parseInt(v) || 0) <= 0)) {
        toast.error('All installment amounts must be greater than zero');
        return;
      }
    }

    if (enableSplitPayment) {
      if (lumpSum <= 0) {
        toast.error('Please enter the total lump sum amount');
        return;
      }
      if (effectiveDpPaid <= 0) {
        toast.error('Lump sum must cover at least some downpayment for the new account');
        return;
      }
      for (const alloc of splitAllocations) {
        const allocAmount = parseInt(alloc.amount) || 0;
        if (allocAmount <= 0) continue;
        const acct = customerAccounts.find(a => a.id === alloc.account_id);
        if (acct && allocAmount > Number(acct.remaining_balance)) {
          toast.error(`Allocation for ${acct.invoice_number} exceeds remaining balance`);
          return;
        }
      }
    } else {
      if (downpaymentAmount > 0 && !downpaymentPaid) {
        toast.error('Please enter the downpayment amount paid');
        return;
      }
    }

    try {
      const validAllocations = enableSplitPayment
        ? splitAllocations
            .filter(a => (parseInt(a.amount) || 0) > 0)
            .map(a => ({ account_id: a.account_id, amount: parseInt(a.amount) || 0 }))
        : undefined;

      const result = await createAccount.mutateAsync({
        customer_id: customerId,
        invoice_number: invoiceNumber,
        currency,
        total_amount: amount,
        order_date: orderDate,
        payment_plan_months: paymentPlan,
        downpayment_amount: downpaymentAmount,
        downpayment_paid: dpPaid,
        remaining_dp_option: hasShortDp ? remainingDpOption : undefined,
        split_allocations: validAllocations,
        lump_sum_total: enableSplitPayment ? lumpSum : undefined,
        custom_installments: installmentMode === 'custom'
          ? customAmounts.map(v => parseInt(v) || 0)
          : undefined,
      });

      // Mark as submitted to allow navigation
      submittedRef.current = true;
      clearDraft();
      setFormDirty(false);

      toast.success(`Layaway account #${invoiceNumber} created successfully`);

      // Generate consolidated split payment message
      if (validAllocations && validAllocations.length > 0 && result?.split_payments?.length > 0) {
        const customerName = selectedCustomer?.full_name || 'Customer';
        const totalReceived = lumpSum;
        const splitPayments: Array<{ account_id: string; invoice_number: string; amount: number; completed: boolean }> = result.split_payments;
        
        // Build the new account line (downpayment)
        const newAcctCompleted = dpPaid >= amount; // unlikely but handle
        const allLines: Array<{ inv: string; amt: number; completed: boolean; currency: Currency }> = [];
        
        // Add new account first
        allLines.push({ inv: invoiceNumber, amt: dpPaid, completed: newAcctCompleted, currency });
        
        // Add split payment lines
        for (const sp of splitPayments) {
          const targetAcct = customerAccounts.find(a => a.id === sp.account_id);
          const acctCurrency = (targetAcct?.currency as Currency) || currency;
          allLines.push({ inv: sp.invoice_number, amt: sp.amount, completed: sp.completed, currency: acctCurrency });
        }

        let msg = `Dear ${customerName},\n\n`;
        msg += `Thank you for your payment. ${formatCurrency(totalReceived, currency)} has been received.\n\n`;
        
        for (const line of allLines) {
          msg += `Inv # ${line.inv} - ${formatCurrency(line.amt, line.currency)}`;
          if (line.completed) msg += ` (PAID OFF)`;
          msg += `\n`;
        }
        
        msg += `\n━━━━━━━━━━━━━━━━━━\n`;
        msg += `\nThank you for your continued trust in Cha Jewels. We appreciate your business! 💛`;

        setSplitMessageDialog(msg);
      } else {
        navigate(ROUTES.ACCOUNTS);
      }
    } catch (err: any) {
      console.error('Create account error:', err);
      const msg = err.message || 'Failed to create account';
      if (msg.includes('duplicate key') || msg.includes('invoice_number')) {
        toast.error(`Invoice number "${invoiceNumber}" already exists. Please use a different invoice number.`);
      } else {
        toast.error(msg);
      }
    }
  };

  const selectedCustomer = customers?.find(c => c.id === customerId);

  return (
    <AppLayout>
      <div className="animate-fade-in max-w-2xl space-y-6">
        <div className="flex items-center gap-4">
          <Link to={ROUTES.ACCOUNTS} onClick={(e) => {
            e.preventDefault();
            guardedNavigate(ROUTES.ACCOUNTS);
          }}>
            <Button variant="ghost" size="icon" className="text-muted-foreground">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="flex-1">
            <h1 className="text-2xl font-bold text-foreground font-display">New Layaway Account</h1>
            <p className="text-sm text-muted-foreground mt-0.5">Create a new payment plan</p>
          </div>
          {/* Draft status indicators */}
          <div className="flex items-center gap-2">
            {restored && (
              <Badge variant="outline" className="text-xs border-primary/40 text-primary gap-1 animate-fade-in">
                <Save className="h-3 w-3" />
                Draft restored
              </Badge>
            )}
            {draftSavedIndicator && !restored && (
              <Badge variant="outline" className="text-xs border-muted-foreground/30 text-muted-foreground gap-1 animate-fade-in">
                <Save className="h-3 w-3" />
                Draft saved
              </Badge>
            )}
            {formDirty && !draftSavedIndicator && !restored && (
              <Badge variant="outline" className="text-xs border-accent/40 text-accent-foreground/60 gap-1">
                Unsaved changes
              </Badge>
            )}
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="rounded-xl border border-border bg-card p-6 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-card-foreground">Invoice Number *</Label>
                <Input
                  value={invoiceNumber}
                  onChange={(e) => { setInvoiceNumber(e.target.value); markDirty(); }}
                  placeholder="e.g. 19200"
                  className="bg-background border-border"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-card-foreground">Customer *</Label>
                <div className="flex gap-2">
                  <Select value={customerId} onValueChange={(v) => {
                    setCustomerId(v);
                    setSplitAllocations([]);
                    setEnableSplitPayment(false);
                    markDirty();
                  }}>
                    <SelectTrigger className="bg-background border-border flex-1">
                      <SelectValue placeholder="Select customer" />
                    </SelectTrigger>
                    <SelectContent>
                      {(customers || []).map(c => (
                        <SelectItem key={c.id} value={c.id}>{c.full_name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <NewCustomerDialog
                    onCreated={(c) => { setCustomerId(c.id); markDirty(); }}
                    trigger={
                      <Button type="button" variant="outline" size="icon" className="shrink-0" title="Add new customer">
                        <UserPlus className="h-4 w-4" />
                      </Button>
                    }
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-card-foreground">Currency *</Label>
                <Select value={currency} onValueChange={(v) => { setCurrency(v as Currency); markDirty(); }}>
                  <SelectTrigger className="bg-background border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PHP">PHP – Philippine Peso</SelectItem>
                    <SelectItem value="JPY">JPY – Japanese Yen</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-card-foreground">Total Amount *</Label>
                <Input
                  type="number"
                  value={totalAmount}
                  onChange={(e) => { setTotalAmount(e.target.value); markDirty(); }}
                  placeholder="e.g. 83311"
                  className="bg-background border-border"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-card-foreground">Downpayment Amount *</Label>
                <Input
                  type="number"
                  value={downpaymentInput}
                  onChange={(e) => { setDownpaymentInput(e.target.value); markDirty(); }}
                  placeholder="Enter downpayment amount"
                  className="bg-background border-border"
                />
              </div>
              {!enableSplitPayment && (
                <div className="space-y-2">
                  <Label className="text-card-foreground">Downpayment Paid *</Label>
                  <Input
                    type="number"
                    value={downpaymentPaid}
                    onChange={(e) => { setDownpaymentPaid(e.target.value); markDirty(); }}
                    placeholder={downpaymentAmount > 0 ? `e.g. ${downpaymentAmount}` : 'Amount actually paid'}
                    className="bg-background border-border"
                  />
                </div>
              )}
              {enableSplitPayment && (
                <div className="space-y-2">
                  <Label className="text-card-foreground">DP from Lump Sum</Label>
                  <div className="flex h-9 items-center rounded-md border border-border bg-muted/50 px-3">
                    <span className="text-sm font-semibold text-primary tabular-nums">
                      {formatCurrency(effectiveDpPaid, currency)}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">Auto-calculated from lump sum minus allocations</p>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-card-foreground">Order Date *</Label>
                <Input
                  type="date"
                  value={orderDate}
                  onChange={(e) => { setOrderDate(e.target.value); markDirty(); }}
                  className="bg-background border-border"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-card-foreground">Payment Plan *</Label>
                <div className="flex gap-2">
                  {([3, 6] as const).map(plan => (
                    <button
                      key={plan}
                      type="button"
                      onClick={() => {
                        setPaymentPlan(plan);
                        if (installmentMode === 'custom') {
                          setCustomAmounts(Array(plan).fill('0'));
                        }
                        markDirty();
                      }}
                      className={`flex-1 rounded-lg border py-2.5 text-sm font-medium transition-colors ${
                        paymentPlan === plan
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border bg-background text-muted-foreground hover:border-primary/50'
                      }`}
                    >
                      {plan} Months
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Installment Mode Toggle */}
            <div className="space-y-2">
              <Label className="text-card-foreground">Installment Structure</Label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => { setInstallmentMode('equal'); markDirty(); }}
                  className={`flex-1 rounded-lg border py-2.5 text-sm font-medium transition-colors ${
                    installmentMode === 'equal'
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-background text-muted-foreground hover:border-primary/50'
                  }`}
                >
                  Equal Installments
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setInstallmentMode('custom');
                    initCustomAmounts();
                    markDirty();
                  }}
                  className={`flex-1 rounded-lg border py-2.5 text-sm font-medium transition-colors ${
                    installmentMode === 'custom'
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-background text-muted-foreground hover:border-primary/50'
                  }`}
                >
                  Custom Installments
                </button>
              </div>
            </div>
          </div>

          {/* Split Payment Section — only if customer has existing accounts */}
          {customerId && customerAccounts.length > 0 && (
            <div className="rounded-xl border border-accent/40 bg-card p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Banknote className="h-5 w-5 text-primary" />
                  <div>
                    <h3 className="text-sm font-semibold text-card-foreground">Split Lump Sum Payment</h3>
                    <p className="text-xs text-muted-foreground">
                      {selectedCustomer?.full_name} has {customerAccounts.length} active account{customerAccounts.length > 1 ? 's' : ''} with outstanding balance
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="enable-split"
                    checked={enableSplitPayment}
                    onCheckedChange={(checked) => {
                      setEnableSplitPayment(!!checked);
                      if (!checked) {
                        setSplitAllocations([]);
                        setLumpSumInput('');
                      }
                      markDirty();
                    }}
                  />
                  <Label htmlFor="enable-split" className="text-sm cursor-pointer text-card-foreground">Enable</Label>
                </div>
              </div>

              {enableSplitPayment && (
                <div className="space-y-4 pt-2">
                  {/* Total Lump Sum Input */}
                  <div className="space-y-2">
                    <Label className="text-card-foreground">Total Lump Sum from Customer *</Label>
                    <Input
                      type="number"
                      value={lumpSumInput}
                      onChange={(e) => { setLumpSumInput(e.target.value); markDirty(); }}
                      placeholder="Total amount customer is paying"
                      className="bg-background border-border text-lg font-semibold"
                    />
                  </div>

                  {/* Existing accounts list */}
                  <div className="space-y-2">
                    <button
                      type="button"
                      onClick={() => setSplitExpanded(!splitExpanded)}
                      className="flex items-center gap-2 text-sm font-medium text-card-foreground hover:text-primary transition-colors"
                    >
                      Allocate to Existing Accounts
                      {splitExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    </button>

                    {splitExpanded && (
                      <div className="space-y-2">
                        {customerAccounts.map(acct => {
                          const isSelected = splitAllocations.some(a => a.account_id === acct.id);
                          const alloc = splitAllocations.find(a => a.account_id === acct.id);
                          return (
                            <div
                              key={acct.id}
                              className={`rounded-lg border p-3 transition-colors ${
                                isSelected ? 'border-primary/50 bg-primary/5' : 'border-border bg-background'
                              }`}
                            >
                              <div className="flex items-center gap-3">
                                <Checkbox
                                  checked={isSelected}
                                  onCheckedChange={() => toggleAccount(acct.id)}
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className="text-sm font-medium text-card-foreground">
                                      INV #{acct.invoice_number}
                                    </span>
                                    <Badge variant="outline" className="text-xs">
                                      {acct.currency}
                                    </Badge>
                                    <Badge
                                      variant={acct.status === 'overdue' ? 'destructive' : 'secondary'}
                                      className="text-xs"
                                    >
                                      {acct.status}
                                    </Badge>
                                  </div>
                                  <p className="text-xs text-muted-foreground mt-0.5">
                                    Balance: {formatCurrency(Number(acct.remaining_balance), acct.currency as Currency)}
                                  </p>
                                </div>
                                {isSelected && (
                                  <div className="w-36">
                                    <Input
                                      type="number"
                                      value={alloc?.amount || ''}
                                      onChange={(e) => updateAllocationAmount(acct.id, e.target.value)}
                                      placeholder="Amount"
                                      className="bg-background border-border text-right text-sm h-8"
                                      max={Number(acct.remaining_balance)}
                                    />
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Split Summary */}
                  {lumpSum > 0 && (
                    <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-2">
                      <h4 className="text-xs font-semibold text-primary uppercase tracking-wide">Payment Breakdown</h4>
                      <div className="flex items-center justify-between py-1">
                        <span className="text-sm text-card-foreground">Total Lump Sum</span>
                        <span className="text-sm font-bold text-card-foreground tabular-nums">
                          {formatCurrency(lumpSum, currency)}
                        </span>
                      </div>
                      {splitAllocations.filter(a => (parseInt(a.amount) || 0) > 0).map(alloc => {
                        const acct = customerAccounts.find(a => a.id === alloc.account_id);
                        const allocAmt = parseInt(alloc.amount) || 0;
                        return (
                          <div key={alloc.account_id} className="flex items-center justify-between py-1">
                            <span className="text-sm text-muted-foreground">
                              → INV #{acct?.invoice_number || '?'}
                              {acct?.currency !== currency && (
                                <span className="text-xs ml-1">({acct?.currency})</span>
                              )}
                            </span>
                            <span className="text-sm font-medium text-destructive tabular-nums">
                              - {formatCurrency(allocAmt, (acct?.currency || currency) as Currency)}
                            </span>
                          </div>
                        );
                      })}
                      <div className="border-t border-primary/20 pt-2 flex items-center justify-between">
                        <span className="text-sm font-medium text-card-foreground">→ New Account DP</span>
                        <span className={`text-sm font-bold tabular-nums ${effectiveDpPaid >= downpaymentAmount ? 'text-primary' : 'text-destructive'}`}>
                          {formatCurrency(effectiveDpPaid, currency)}
                        </span>
                      </div>
                      {effectiveDpPaid < downpaymentAmount && downpaymentAmount > 0 && (
                        <p className="text-xs text-destructive">
                          ⚠ Remaining DP not fully covered. Short by {formatCurrency(downpaymentAmount - effectiveDpPaid, currency)}
                        </p>
                      )}
                      {lumpSum < totalAllocatedToExisting && (
                        <p className="text-xs text-destructive">
                          ⚠ Allocations exceed lump sum by {formatCurrency(totalAllocatedToExisting - lumpSum, currency)}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Downpayment Summary */}
          {amount > 0 && downpaymentAmount > 0 && (
            <div className="rounded-xl border border-primary/20 bg-card p-6 space-y-3">
              <h3 className="text-sm font-semibold text-card-foreground">Downpayment Summary</h3>
              <div className="flex items-center justify-between py-2 border-b border-border">
                <span className="text-sm text-card-foreground">Downpayment Amount</span>
                <span className="text-sm font-semibold text-card-foreground tabular-nums">
                  {formatCurrency(downpaymentAmount, currency)}
                </span>
              </div>
              {dpPaid > 0 && (
                <>
                  <div className="flex items-center justify-between py-2 border-b border-border">
                    <span className="text-sm text-card-foreground">Downpayment Paid</span>
                    <span className="text-sm font-semibold text-primary tabular-nums">
                      {formatCurrency(dpPaid, currency)}
                    </span>
                  </div>
                  {hasShortDp && (
                    <div className="flex items-center justify-between py-2 border-b border-border">
                      <span className="text-sm font-medium text-destructive">Remaining Downpayment</span>
                      <span className="text-sm font-bold text-destructive tabular-nums">
                        {formatCurrency(remainingDp, currency)}
                      </span>
                    </div>
                  )}
                </>
              )}
              <div className="flex items-center justify-between py-2">
                <span className="text-sm text-muted-foreground">Remaining for Installments</span>
                <span className="text-sm font-semibold text-card-foreground tabular-nums">
                  {formatCurrency(baseForInstallments, currency)}
                </span>
              </div>

              {/* Remaining DP distribution option */}
              {hasShortDp && (
                <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4 space-y-3">
                  <p className="text-sm font-medium text-destructive">
                    Short downpayment: {formatCurrency(remainingDp, currency)} remaining. How should this be handled?
                  </p>
                  <RadioGroup
                    value={remainingDpOption}
                    onValueChange={(v) => { setRemainingDpOption(v as RemainingDpOption); markDirty(); }}
                    className="space-y-2"
                  >
                    <div className="flex items-start gap-3 rounded-lg border border-border bg-background p-3">
                      <RadioGroupItem value="split" id="dp-split" className="mt-0.5" />
                      <Label htmlFor="dp-split" className="cursor-pointer space-y-1">
                        <span className="text-sm font-medium text-card-foreground">Split evenly across installments</span>
                        <p className="text-xs text-muted-foreground">
                          Add {formatCurrency(Math.floor(remainingDp / paymentPlan), currency)}/month to each installment
                        </p>
                      </Label>
                    </div>
                    <div className="flex items-start gap-3 rounded-lg border border-border bg-background p-3">
                      <RadioGroupItem value="add_to_installments" id="dp-first" className="mt-0.5" />
                      <Label htmlFor="dp-first" className="cursor-pointer space-y-1">
                        <span className="text-sm font-medium text-card-foreground">Add to first installment</span>
                        <p className="text-xs text-muted-foreground">
                          First payment will be {formatCurrency((previewInstallments[0] || 0), currency)}
                        </p>
                      </Label>
                    </div>
                  </RadioGroup>
                </div>
              )}
            </div>
          )}

          {/* Schedule Preview / Custom Installment Editor */}
          {previewDates.length > 0 && (installmentTotal > 0 || installmentMode === 'custom') && (
            <div className="rounded-xl border border-primary/20 bg-card p-6">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-card-foreground">
                  {installmentMode === 'custom' ? 'Custom Schedule' : 'Schedule Preview'} ({paymentPlan} months)
                </h3>
                {installmentMode === 'custom' && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={autoAdjustLastMonth}
                    className="gap-1.5 text-xs"
                  >
                    <Wand2 className="h-3.5 w-3.5" />
                    Auto-adjust last month
                  </Button>
                )}
              </div>

              <div className="space-y-2">
                {previewDates.map((date, i) => (
                  <div key={i} className="flex items-center justify-between py-2 border-b border-border last:border-0 gap-3">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-bold text-muted-foreground shrink-0">
                        {i + 1}
                      </span>
                      <span className="text-sm text-card-foreground truncate">
                        {new Date(date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                      </span>
                    </div>
                    {installmentMode === 'custom' ? (
                      <Input
                        type="number"
                        value={customAmounts[i] || ''}
                        onChange={(e) => updateCustomAmount(i, e.target.value)}
                        className="w-32 bg-background border-border text-right text-sm h-8 tabular-nums"
                        placeholder="Amount"
                      />
                    ) : (
                      <span className="text-sm font-semibold text-card-foreground tabular-nums">
                        {formatCurrency(previewInstallments[i] || 0, currency)}
                      </span>
                    )}
                  </div>
                ))}
              </div>

              {/* Custom mode: running total and validation */}
              {installmentMode === 'custom' && (
                <div className={`mt-4 rounded-lg border p-3 ${customMismatch ? 'border-destructive/50 bg-destructive/5' : 'border-primary/20 bg-primary/5'}`}>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-card-foreground">Installment Total</span>
                    <span className={`text-sm font-bold tabular-nums ${customMismatch ? 'text-destructive' : 'text-primary'}`}>
                      {formatCurrency(customTotal, currency)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-xs text-muted-foreground">Required (Total − Downpayment)</span>
                    <span className="text-xs font-medium text-muted-foreground tabular-nums">
                      {formatCurrency(expectedInstallmentTotal, currency)}
                    </span>
                  </div>
                  {customMismatch && (
                    <p className="text-xs text-destructive mt-2 font-medium">
                      ⚠ Mismatch of {formatCurrency(Math.abs(customTotal - expectedInstallmentTotal), currency)} — installments must equal remaining balance
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => guardedNavigate(ROUTES.ACCOUNTS)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={createAccount.isPending}
              className="gold-gradient text-primary-foreground font-medium"
            >
              {createAccount.isPending ? 'Creating…' : 'Create Account'}
            </Button>
          </div>
        </form>
      </div>

      {/* Leave Confirmation Dialog */}
      <Dialog open={showLeaveDialog} onOpenChange={setShowLeaveDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Unsaved Changes
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            You have unsaved changes. Are you sure you want to leave? Your draft will be saved and can be restored when you return.
          </p>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowLeaveDialog(false)}>
              Stay
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setShowLeaveDialog(false);
                setFormDirty(false);
                submittedRef.current = true;
                navigate(pendingNavRef.current || ROUTES.ACCOUNTS);
                pendingNavRef.current = null;
              }}
            >
              Leave Page
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Split Payment Consolidated Message Dialog */}
      <Dialog open={!!splitMessageDialog} onOpenChange={(open) => {
        if (!open) {
          setSplitMessageDialog(null);
          navigate('/accounts');
        }
      }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageCircle className="h-5 w-5 text-primary" />
              Split Payment Confirmation
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">Copy this message to send to the customer via Messenger:</p>
          <div className="rounded-lg border border-border bg-muted/30 p-4 max-h-[400px] overflow-y-auto">
            <pre className="text-sm text-card-foreground whitespace-pre-wrap font-sans leading-relaxed">
              {splitMessageDialog}
            </pre>
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setSplitMessageDialog(null);
                navigate(ROUTES.ACCOUNTS);
              }}
            >
              Close
            </Button>
            <Button
              onClick={() => {
                if (splitMessageDialog) {
                  navigator.clipboard.writeText(splitMessageDialog);
                  setSplitMsgCopied(true);
                  toast.success('Message copied to clipboard');
                  setTimeout(() => setSplitMsgCopied(false), 2000);
                }
              }}
              className="gap-2"
            >
              {splitMsgCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {splitMsgCopied ? 'Copied!' : 'Copy Message'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
