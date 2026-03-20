import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, UserPlus } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { generateScheduleDates, calculateInstallments, formatCurrency } from '@/lib/calculations';
import { Currency, PaymentPlan } from '@/lib/types';
import { toast } from 'sonner';
import { useCustomers, useCreateAccount, DbCustomer } from '@/hooks/use-supabase-data';
import NewCustomerDialog from '@/components/customers/NewCustomerDialog';

type RemainingDpOption = 'split' | 'add_to_installments';

export default function NewAccount() {
  const navigate = useNavigate();
  const { data: customers } = useCustomers();
  const createAccount = useCreateAccount();

  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [currency, setCurrency] = useState<Currency>('PHP');
  const [totalAmount, setTotalAmount] = useState('');
  const [orderDate, setOrderDate] = useState('');
  const [paymentPlan, setPaymentPlan] = useState<PaymentPlan>(3);
  const [downpaymentInput, setDownpaymentInput] = useState('');
  const [downpaymentPaid, setDownpaymentPaid] = useState('');
  const [remainingDpOption, setRemainingDpOption] = useState<RemainingDpOption>('split');

  const amount = parseInt(totalAmount) || 0;
  const downpaymentAmount = parseInt(downpaymentInput) || 0;
  const dpPaid = parseInt(downpaymentPaid) || 0;
  const remainingDp = Math.max(0, downpaymentAmount - dpPaid);
  const hasShortDp = downpaymentAmount > 0 && dpPaid > 0 && dpPaid < downpaymentAmount;

  // Calculate installment base: total minus full DP target, then add remaining DP back based on option
  const baseForInstallments = Math.max(0, amount - downpaymentAmount);
  const installmentTotal = hasShortDp
    ? baseForInstallments + remainingDp
    : baseForInstallments;

  const previewDates = orderDate ? generateScheduleDates(orderDate, paymentPlan) : [];

  // Build preview installments based on option
  const previewInstallments = (() => {
    if (installmentTotal <= 0) return [];
    if (hasShortDp && remainingDpOption === 'split') {
      // Remaining DP split evenly across months, added on top of base installments
      const baseInstallments = calculateInstallments(baseForInstallments, paymentPlan);
      const dpPerMonth = Math.floor(remainingDp / paymentPlan);
      const dpRemainder = remainingDp - dpPerMonth * paymentPlan;
      return baseInstallments.map((base, i) => base + dpPerMonth + (i === paymentPlan - 1 ? dpRemainder : 0));
    }
    // add_to_installments: remaining DP added to first installment
    if (hasShortDp && remainingDpOption === 'add_to_installments') {
      const installments = calculateInstallments(baseForInstallments, paymentPlan);
      if (installments.length > 0) installments[0] += remainingDp;
      return installments;
    }
    return calculateInstallments(installmentTotal, paymentPlan);
  })();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!invoiceNumber || !customerId || !totalAmount || !orderDate) {
      toast.error('Please fill in all required fields');
      return;
    }
    if (downpaymentAmount > 0 && !downpaymentPaid) {
      toast.error('Please enter the downpayment amount paid');
      return;
    }
    try {
      await createAccount.mutateAsync({
        customer_id: customerId,
        invoice_number: invoiceNumber,
        currency,
        total_amount: amount,
        order_date: orderDate,
        payment_plan_months: paymentPlan,
        downpayment_amount: downpaymentAmount,
        downpayment_paid: dpPaid,
        remaining_dp_option: hasShortDp ? remainingDpOption : undefined,
      });
      toast.success(`Layaway account #${invoiceNumber} created successfully`);
      navigate('/accounts');
    } catch (err: any) {
      toast.error(err.message || 'Failed to create account');
    }
  };

  return (
    <AppLayout>
      <div className="animate-fade-in max-w-2xl space-y-6">
        <div className="flex items-center gap-4">
          <Link to="/accounts">
            <Button variant="ghost" size="icon" className="text-muted-foreground">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-foreground font-display">New Layaway Account</h1>
            <p className="text-sm text-muted-foreground mt-0.5">Create a new payment plan</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="rounded-xl border border-border bg-card p-6 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-card-foreground">Invoice Number *</Label>
                <Input
                  value={invoiceNumber}
                  onChange={(e) => setInvoiceNumber(e.target.value)}
                  placeholder="e.g. 19200"
                  className="bg-background border-border"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-card-foreground">Customer *</Label>
                <div className="flex gap-2">
                  <Select value={customerId} onValueChange={setCustomerId}>
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
                    onCreated={(c) => setCustomerId(c.id)}
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
                <Select value={currency} onValueChange={(v) => setCurrency(v as Currency)}>
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
                  onChange={(e) => setTotalAmount(e.target.value)}
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
                  onChange={(e) => setDownpaymentInput(e.target.value)}
                  placeholder="Enter downpayment amount"
                  className="bg-background border-border"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-card-foreground">Downpayment Paid *</Label>
                <Input
                  type="number"
                  value={downpaymentPaid}
                  onChange={(e) => setDownpaymentPaid(e.target.value)}
                  placeholder={downpaymentAmount > 0 ? `e.g. ${downpaymentAmount}` : 'Amount actually paid'}
                  className="bg-background border-border"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-card-foreground">Order Date *</Label>
                <Input
                  type="date"
                  value={orderDate}
                  onChange={(e) => setOrderDate(e.target.value)}
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
                      onClick={() => setPaymentPlan(plan)}
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
          </div>

          {/* Downpayment Summary */}
          {amount > 0 && downpaymentAmount > 0 && (
            <div className="rounded-xl border border-primary/20 bg-card p-6 space-y-3">
              <h3 className="text-sm font-semibold text-card-foreground">Downpayment Summary</h3>
              <div className="flex items-center justify-between py-2 border-b border-border">
                <span className="text-sm text-card-foreground">30% Downpayment Target</span>
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
                    onValueChange={(v) => setRemainingDpOption(v as RemainingDpOption)}
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

          {/* Schedule Preview */}
          {previewDates.length > 0 && installmentTotal > 0 && (
            <div className="rounded-xl border border-primary/20 bg-card p-6">
              <h3 className="text-sm font-semibold text-card-foreground mb-3">Schedule Preview ({paymentPlan} months)</h3>
              <div className="space-y-2">
                {previewDates.map((date, i) => (
                  <div key={i} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                    <div className="flex items-center gap-3">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-bold text-muted-foreground">
                        {i + 1}
                      </span>
                      <span className="text-sm text-card-foreground">
                        {new Date(date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                      </span>
                    </div>
                    <span className="text-sm font-semibold text-card-foreground tabular-nums">
                      {formatCurrency(previewInstallments[i] || 0, currency)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-3">
            <Link to="/accounts">
              <Button variant="outline">Cancel</Button>
            </Link>
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
    </AppLayout>
  );
}