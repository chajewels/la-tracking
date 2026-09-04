import { useState, useCallback } from 'react';
import { Settings, Save, Plus, Trash2, Calendar } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { formatCurrency } from '@/lib/calculations';
import { getConversionRate } from '@/lib/currency-converter';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import type { Currency } from '@/lib/types';

interface ScheduleItem {
  id: string;
  installment_number: number;
  due_date: string;
  base_installment_amount: number;
  status: string;
  paid_amount: number;
}

interface EditAccountDialogProps {
  account: {
    id: string;
    invoice_number: string;
    total_amount: number;
    order_date: string;
    payment_plan_months: number;
    notes: string | null;
    downpayment_amount: number;
    currency: string;
    status: string;
    discount_amount: number;
    discount_type: string | null;
    discount_value: number | null;
    shipping_fee: number;
  };
  schedule: ScheduleItem[];
  items?: Array<{ unit_price_jpy: number; line_total_jpy: number; quantity: number }>;
}

export default function EditAccountDialog({ account, schedule, items }: EditAccountDialogProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const queryClient = useQueryClient();
  const { roles } = useAuth();
  const isAdmin = (roles as any[]).includes('admin');
  const { can } = usePermissions();
  const canEditSchedule = can('edit_schedule');
  const currency = account.currency as Currency;

  // Account fields
  const [totalAmount, setTotalAmount] = useState('');
  const [orderDate, setOrderDate] = useState('');
  const [notes, setNotes] = useState('');
  const [downpayment, setDownpayment] = useState('');
  const [currencyValue, setCurrencyValue] = useState<'PHP' | 'JPY'>(account.currency as 'PHP' | 'JPY');

  // Discount & shipping (descriptive; account currency). Model 1 — these do NOT
  // auto-change total_amount; the admin explicitly clicks "Apply to total".
  const [discountMode, setDiscountMode] = useState<'amount' | 'percent'>(account.discount_type === 'percent' ? 'percent' : 'amount');
  const [discountInput, setDiscountInput] = useState(account.discount_type ? String(account.discount_value ?? '') : '');
  const [shippingInput, setShippingInput] = useState(account.shipping_fee ? String(account.shipping_fee) : '');

  // Items subtotal (line items are stored in JPY) → account currency.
  const itemsSubtotalJpy = (items ?? []).reduce((s, li) => s + (li.line_total_jpy || li.unit_price_jpy * li.quantity), 0);
  const itemsSubtotalAcct = currency === 'PHP' ? Math.round(itemsSubtotalJpy * getConversionRate()) : itemsSubtotalJpy;
  const discountAmount = discountMode === 'percent'
    ? Math.round(itemsSubtotalAcct * (parseFloat(discountInput) || 0) / 100)
    : Math.round(parseFloat(discountInput) || 0);
  const shippingFee = Math.round(parseFloat(shippingInput) || 0);
  const reconciledTotal = Math.max(0, itemsSubtotalAcct - discountAmount + shippingFee);
  const showReconciliation = (items ?? []).length > 0 || discountInput !== '' || shippingInput !== '';

  // Schedule editing
  const [scheduleEdits, setScheduleEdits] = useState<Record<string, { due_date?: string; base_amount?: string }>>({});
  const [newInstallments, setNewInstallments] = useState<Array<{ due_date: string; base_amount: string }>>([]);

  const resetForm = useCallback(() => {
    setTotalAmount(String(account.total_amount));
    setOrderDate(account.order_date);
    setNotes(account.notes || '');
    setDownpayment(String(account.downpayment_amount));
    setCurrencyValue(account.currency as 'PHP' | 'JPY');
    setDiscountMode(account.discount_type === 'percent' ? 'percent' : 'amount');
    setDiscountInput(account.discount_type ? String(account.discount_value ?? '') : '');
    setShippingInput(account.shipping_fee ? String(account.shipping_fee) : '');
    setScheduleEdits({});
    setNewInstallments([]);
  }, [account]);

  const handleOpen = (isOpen: boolean) => {
    if (isOpen) resetForm();
    setOpen(isOpen);
  };

  const updateScheduleEdit = (id: string, field: 'due_date' | 'base_amount', value: string) => {
    setScheduleEdits(prev => ({
      ...prev,
      [id]: { ...prev[id], [field]: value },
    }));
  };

  // Mirrors create-layaway-account: pool = total − DP, floor split, remainder on last editable row.
  // Rows with any money on them (paid_amount > 0 or status paid/cancelled) are frozen; their
  // base amounts are subtracted from the pool and only untouched rows are redistributed.
  const recalcInstallments = (totalStr: string, dpStr: string) => {
    if (!canEditSchedule) return;
    const total = Math.round(parseFloat(totalStr) || 0);
    const dp = Math.round(parseFloat(dpStr) || 0);
    if (total <= 0) return;
    const editableRows = schedule.filter(s => Number(s.paid_amount) === 0 && s.status !== 'paid' && s.status !== 'cancelled');
    if (editableRows.length === 0) return;
    const frozenBase = schedule
      .filter(s => !editableRows.some(e => e.id === s.id))
      .reduce((sum, s) => sum + Number(s.base_installment_amount), 0);
    const pool = total - dp - Math.round(frozenBase);
    if (pool < 0) return;
    const per = Math.floor(pool / editableRows.length);
    const remainder = pool - per * editableRows.length;
    setScheduleEdits(prev => {
      const next = { ...prev };
      editableRows.forEach((row, idx) => {
        const isLast = idx === editableRows.length - 1;
        next[row.id] = { ...next[row.id], base_amount: String(isLast ? per + remainder : per) };
      });
      return next;
    });
  };

  const addNewInstallment = () => {
    const lastItem = schedule[schedule.length - 1];
    const lastDate = lastItem ? new Date(lastItem.due_date) : new Date(account.order_date);
    const nextDate = new Date(lastDate);
    nextDate.setMonth(nextDate.getMonth() + 1);
    setNewInstallments(prev => [...prev, {
      due_date: Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(nextDate),
      base_amount: '',
    }]);
  };

  const removeNewInstallment = (idx: number) => {
    setNewInstallments(prev => prev.filter((_, i) => i !== idx));
  };

  const fnErrorMessage = async (error: unknown, data: unknown): Promise<string> => {
    if ((data as any)?.error) return (data as any).error;
    try {
      const body = await (error as any)?.context?.json();
      if (body?.error) return body.error;
    } catch { /* ignore */ }
    return (error as any)?.message || 'Request failed';
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const user = (await supabase.auth.getUser()).data.user;
      const userId = user?.id;

      // 1. Update account fields if changed
      // total_amount is normally immutable per CLAUDE.md INVARIANT 7, but admins
      // may correct it here. For non-admins, the input is read-only and the
      // guard below strips total_amount from any write attempt.
      const accountUpdates: Record<string, unknown> = {};
      const newTotal = parseFloat(totalAmount);
      if (isAdmin && !isNaN(newTotal) && newTotal !== account.total_amount) {
        const roundedTotal = Math.round(newTotal * 100) / 100;
        accountUpdates.total_amount = roundedTotal;

        // Recompute remaining_balance using canonical formula:
        // remaining = total_amount + Σ(non-waived penalties) + Σ(services) - total_paid
        const [{ data: activePens }, { data: svcs }, { data: pays }] = await Promise.all([
          supabase
            .from('penalty_fees')
            .select('penalty_amount')
            .eq('account_id', account.id)
            .neq('status', 'waived'),
          supabase
            .from('account_services')
            .select('amount')
            .eq('account_id', account.id),
          supabase
            .from('payments')
            .select('amount_paid')
            .eq('account_id', account.id)
            .is('voided_at', null),
        ]);
        const activePenaltySum = (activePens || []).reduce((s: number, p: any) => s + Number(p.penalty_amount), 0);
        const serviceSum = (svcs || []).reduce((s: number, sv: any) => s + Number(sv.amount), 0);
        const totalPaid = (pays || []).reduce((s: number, p: any) => s + Number(p.amount_paid), 0);
        accountUpdates.remaining_balance = Math.max(
          0,
          Math.round((roundedTotal + activePenaltySum + serviceSum - totalPaid) * 100) / 100
        );
      }
      if (orderDate && orderDate !== account.order_date) accountUpdates.order_date = orderDate;
      if (notes !== (account.notes || '')) accountUpdates.notes = notes || null;
      const newDp = parseFloat(downpayment);
      if (!isNaN(newDp) && newDp !== account.downpayment_amount) {
        accountUpdates.downpayment_amount = Math.round(newDp * 100) / 100;
      }
      // Discount & shipping (descriptive — persisted independently of total_amount).
      accountUpdates.discount_amount = discountAmount;
      accountUpdates.discount_type = discountInput === '' ? null : discountMode;
      accountUpdates.discount_value = discountInput === '' ? null : (parseFloat(discountInput) || 0);
      accountUpdates.shipping_fee = shippingFee;
      // Defensive guard: non-admins can never write total_amount from this dialog
      if (!isAdmin) delete (accountUpdates as any).total_amount;

      if (Object.keys(accountUpdates).length > 0) {
        const { error } = await supabase
          .from('layaway_accounts')
          .update(accountUpdates as any)
          .eq('id', account.id);
        if (error) throw error;

        // Audit log for account update
        await (supabase.from('audit_logs') as any).insert([{
          entity_type: 'layaway_account',
          entity_id: account.id,
          action: 'update_account_details',
          old_value_json: {
            total_amount: account.total_amount,
            order_date: account.order_date,
            notes: account.notes,
            downpayment_amount: account.downpayment_amount,
          },
          new_value_json: accountUpdates,
          performed_by_user_id: userId || null,
        }]);
      }

      // 2. Update currency if changed
      if (currencyValue !== account.currency) {
        const { error } = await supabase
          .from('layaway_accounts')
          .update({ currency: currencyValue })
          .eq('id', account.id);
        if (error) throw error;
      }

      // 3. Update schedule items that were edited
      for (const [scheduleId, edits] of Object.entries(scheduleEdits)) {
        if (!canEditSchedule) break;
        const original = schedule.find(s => s.id === scheduleId);
        if (!original) continue;

        const scheduleUpdate: Record<string, unknown> = {};
        if (edits.due_date && edits.due_date !== original.due_date) {
          scheduleUpdate.due_date = edits.due_date;
        }
        if (edits.base_amount) {
          const newAmt = parseFloat(edits.base_amount);
          if (!isNaN(newAmt) && Math.round(newAmt * 100) / 100 !== original.base_installment_amount) {
            scheduleUpdate.base_installment_amount = Math.round(newAmt * 100) / 100;
            scheduleUpdate.total_due_amount = Math.round((newAmt + Number(original.paid_amount > 0 ? 0 : 0)) * 100) / 100;
          }
        }

        if (Object.keys(scheduleUpdate).length > 0) {
          // Use the edit-schedule-item edge function for amount changes to preserve business logic
          if (scheduleUpdate.base_installment_amount !== undefined) {
            const { data, error } = await supabase.functions.invoke('edit-schedule-item', {
              body: { schedule_id: scheduleId, new_base_amount: scheduleUpdate.base_installment_amount as number },
            });
            if (error || data?.error) throw new Error(await fnErrorMessage(error, data));
          }

          // Direct update for due_date changes only
          if (scheduleUpdate.due_date !== undefined) {
            const { error } = await supabase
              .from('layaway_schedule')
              .update({ due_date: scheduleUpdate.due_date as string })
              .eq('id', scheduleId);
            if (error) throw error;

            await (supabase.from('audit_logs') as any).insert([{
              entity_type: 'layaway_schedule',
              entity_id: scheduleId,
              action: 'update_due_date',
              old_value_json: { due_date: original.due_date },
              new_value_json: { due_date: scheduleUpdate.due_date },
              performed_by_user_id: userId || null,
            }]);
          }
        }
      }

      // 4. Add new installments
      for (const newInst of newInstallments) {
        if (!canEditSchedule) break;
        const amount = parseFloat(newInst.base_amount);
        if (isNaN(amount) || amount <= 0 || !newInst.due_date) continue;

        const maxInstNumber = Math.max(
          ...schedule.map(s => s.installment_number),
          0
        );
        const nextNumber = maxInstNumber + 1;
        const roundedAmount = Math.round(amount * 100) / 100;

        const { error } = await supabase
          .from('layaway_schedule')
          .insert({
            account_id: account.id,
            installment_number: nextNumber,
            due_date: newInst.due_date,
            base_installment_amount: roundedAmount,
            total_due_amount: roundedAmount,
            currency: account.currency as 'PHP' | 'JPY',
            status: 'pending',
          });
        if (error) throw error;

        await (supabase.from('audit_logs') as any).insert([{
          entity_type: 'layaway_schedule',
          entity_id: account.id,
          action: 'add_schedule_item',
          new_value_json: { installment_number: nextNumber, due_date: newInst.due_date, base_installment_amount: roundedAmount },
          performed_by_user_id: userId || null,
        }]);
      }

      // Invalidate relevant queries
      queryClient.invalidateQueries({ queryKey: ['account', account.id] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['schedule', account.id] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });

      toast.success('Account details updated');
      setOpen(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to save changes');
    } finally {
      setSaving(false);
    }
  };

  const isDisabledStatus = ['forfeited', 'final_forfeited', 'cancelled', 'completed'].includes(account.status);

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="border-primary/30 text-primary hover:bg-primary/10">
          <Settings className="h-4 w-4 mr-2" /> Manage Invoice
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-card border-border max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-card-foreground flex items-center gap-2">
            <Settings className="h-5 w-5 text-primary" />
            Manage Invoice #{account.invoice_number}
          </DialogTitle>
          <DialogDescription>
            Edit account details and manage the payment schedule.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Account Details Section */}
          <div className="space-y-4">
            <h4 className="text-sm font-semibold text-card-foreground border-b border-border pb-2">Account Details</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label className="text-xs text-muted-foreground">Total Layaway Amount ({currency})</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={totalAmount}
                  onChange={(e) => { setTotalAmount(e.target.value); recalcInstallments(e.target.value, downpayment); }}
                  readOnly={!isAdmin}
                  disabled={!isAdmin || isDisabledStatus}
                  className={`h-9 text-sm tabular-nums ${isAdmin ? 'bg-background' : 'bg-muted cursor-not-allowed'}`}
                  title={isAdmin ? undefined : 'Only admins can edit total_amount. Use Add/Delete Installment otherwise.'}
                />
                {!isAdmin && (
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Read-only. Use Add/Delete Installment to change total amount.
                  </p>
                )}
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">30% Downpayment ({currency})</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={downpayment}
                  onChange={(e) => { setDownpayment(e.target.value); recalcInstallments(totalAmount, e.target.value); }}
                  className="h-9 text-sm bg-background tabular-nums"
                  disabled={isDisabledStatus}
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Order Date</Label>
                <Input
                  type="date"
                  value={orderDate}
                  onChange={(e) => setOrderDate(e.target.value)}
                  className="h-9 text-sm bg-background"
                  disabled={isDisabledStatus}
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Payment Plan</Label>
                <Input
                  value={`${account.payment_plan_months} months`}
                  disabled
                  className="h-9 text-sm bg-muted"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Currency</Label>
                <Select
                  value={currencyValue}
                  onValueChange={(v) => setCurrencyValue(v as 'PHP' | 'JPY')}
                  disabled={isDisabledStatus}
                >
                  <SelectTrigger className="h-9 text-sm bg-background">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PHP">₱ PHP</SelectItem>
                    <SelectItem value="JPY">¥ JPY</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Notes</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                className="text-sm bg-background resize-none"
                placeholder="Account notes..."
                disabled={isDisabledStatus}
              />
            </div>

            {/* Discount & Shipping (descriptive — Model 1: does not auto-change
                the total; admin explicitly clicks "Apply to total") */}
            <div className="space-y-3 border-t border-border pt-4">
              <h5 className="text-xs font-semibold text-card-foreground">Discount &amp; Shipping</h5>
              {isAdmin ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs text-muted-foreground">Discount</Label>
                      <div className="flex rounded-md border border-border overflow-hidden">
                        <button
                          type="button"
                          onClick={() => setDiscountMode('amount')}
                          className={`px-2 py-0.5 text-[11px] ${discountMode === 'amount' ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground'}`}
                        >
                          {currency === 'PHP' ? '₱' : '¥'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setDiscountMode('percent')}
                          className={`px-2 py-0.5 text-[11px] ${discountMode === 'percent' ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground'}`}
                        >
                          %
                        </button>
                      </div>
                    </div>
                    <div className="relative">
                      <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                        {discountMode === 'percent' ? '%' : (currency === 'PHP' ? '₱' : '¥')}
                      </span>
                      <Input
                        type="number"
                        min={0}
                        value={discountInput}
                        onChange={(e) => setDiscountInput(e.target.value)}
                        placeholder="0"
                        className="h-9 text-sm bg-background pl-6 tabular-nums"
                        disabled={isDisabledStatus}
                      />
                    </div>
                    {discountMode === 'percent' && (
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
                        value={shippingInput}
                        onChange={(e) => setShippingInput(e.target.value)}
                        placeholder="0"
                        className="h-9 text-sm bg-background pl-6 tabular-nums"
                        disabled={isDisabledStatus}
                      />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-xs text-muted-foreground space-y-1">
                  <div>
                    Discount:{' '}
                    {account.discount_type
                      ? (account.discount_type === 'percent'
                          ? `${account.discount_value}% (${formatCurrency(account.discount_amount, currency)})`
                          : formatCurrency(account.discount_amount, currency))
                      : '—'}
                  </div>
                  <div>Shipping: {account.shipping_fee ? formatCurrency(account.shipping_fee, currency) : '—'}</div>
                </div>
              )}

              {/* Reconciliation readout — account currency */}
              {showReconciliation && (
                <div className="rounded-lg border border-border bg-background p-3 text-xs space-y-1">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Items subtotal</span>
                    <span className="tabular-nums text-card-foreground">{formatCurrency(itemsSubtotalAcct, currency)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">− Discount</span>
                    <span className="tabular-nums text-card-foreground">{formatCurrency(discountAmount, currency)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">+ Shipping</span>
                    <span className="tabular-nums text-card-foreground">{formatCurrency(shippingFee, currency)}</span>
                  </div>
                  <div className="flex justify-between border-t border-border pt-1 font-medium">
                    <span className="text-card-foreground">= Reconciled</span>
                    <span className="tabular-nums text-card-foreground">{formatCurrency(reconciledTotal, currency)}</span>
                  </div>
                  <div className="flex items-center justify-between pt-1">
                    <span className="text-muted-foreground">Current total: {formatCurrency(account.total_amount, currency)}</span>
                    {isAdmin && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs border-primary/30 text-primary hover:bg-primary/10"
                        onClick={() => setTotalAmount(String(reconciledTotal))}
                        disabled={isDisabledStatus}
                      >
                        Apply to total
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Schedule Management Section */}
          <div className="space-y-3">
            <div className="flex items-center justify-between border-b border-border pb-2">
              <h4 className="text-sm font-semibold text-card-foreground">Payment Schedule</h4>
              {!isDisabledStatus && (
                <Button variant="outline" size="sm" onClick={addNewInstallment} disabled={!canEditSchedule} title={!canEditSchedule ? 'Requires Edit Schedule permission' : undefined} className="h-7 text-xs border-primary/30 text-primary hover:bg-primary/10">
                  <Plus className="h-3 w-3 mr-1" /> Add Installment
                </Button>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Months auto-recalculate when Total or Downpayment changes; you can still adjust any row before saving.
            </p>

            {/* Existing schedule items */}
            <div className="space-y-2">
              {schedule.map((item) => {
                const edits = scheduleEdits[item.id] || {};
                const isPaid = item.status === 'paid';
                const isEditable = !isPaid && !isDisabledStatus && item.status !== 'cancelled';

                return (
                  <div key={item.id} className={`grid grid-cols-[2rem_1fr_6rem_6rem] gap-2 items-center p-2 rounded-lg border ${
                    isPaid ? 'bg-success/5 border-success/10' : 'bg-background border-border'
                  }`}>
                    <span className="text-xs font-bold text-muted-foreground text-center">{item.installment_number}</span>
                    <Input
                      type="date"
                      value={edits.due_date ?? item.due_date}
                      onChange={(e) => updateScheduleEdit(item.id, 'due_date', e.target.value)}
                      className="h-8 text-xs bg-background"
                      disabled={!isEditable || !canEditSchedule}
                      title={!canEditSchedule ? 'Requires Edit Schedule permission' : undefined}
                    />
                    <Input
                      type="number"
                      step="0.01"
                      value={edits.base_amount ?? String(item.base_installment_amount)}
                      onChange={(e) => updateScheduleEdit(item.id, 'base_amount', e.target.value)}
                      className="h-8 text-xs bg-background tabular-nums"
                      disabled={!isEditable || !canEditSchedule}
                      title={!canEditSchedule ? 'Requires Edit Schedule permission' : undefined}
                    />
                    <span className={`text-[10px] text-center font-medium ${
                      isPaid ? 'text-success' : item.status === 'overdue' ? 'text-destructive' : 'text-muted-foreground'
                    }`}>
                      {isPaid ? '✅ Paid' : item.status === 'partially_paid' ? '🔶 Partial' : item.status === 'overdue' ? '⚠️ Overdue' : 'Pending'}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* New installments */}
            {newInstallments.map((inst, idx) => (
              <div key={`new-${idx}`} className="grid grid-cols-[2rem_1fr_6rem_2rem] gap-2 items-center p-2 rounded-lg border border-primary/20 bg-primary/5">
                <span className="text-xs font-bold text-primary text-center">+</span>
                <Input
                  type="date"
                  value={inst.due_date}
                  onChange={(e) => {
                    setNewInstallments(prev => prev.map((item, i) => i === idx ? { ...item, due_date: e.target.value } : item));
                  }}
                  className="h-8 text-xs bg-background"
                />
                <Input
                  type="number"
                  step="0.01"
                  placeholder="Amount"
                  value={inst.base_amount}
                  onChange={(e) => {
                    setNewInstallments(prev => prev.map((item, i) => i === idx ? { ...item, base_amount: e.target.value } : item));
                  }}
                  className="h-8 text-xs bg-background tabular-nums"
                />
                <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive"
                  onClick={() => removeNewInstallment(idx)}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}

            {schedule.length === 0 && newInstallments.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">No schedule entries. Click "Add Installment" to create one.</p>
            )}

            {/* Schedule summary */}
            {schedule.length > 0 && (
              <div className="flex justify-between text-xs text-muted-foreground px-2 pt-2 border-t border-border">
                <span>Schedule total:</span>
                <span className="tabular-nums font-medium">
                  {formatCurrency(schedule.reduce((s, i) => s + i.base_installment_amount, 0), currency)}
                </span>
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="mt-4">
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            onClick={handleSave}
            disabled={saving || isDisabledStatus}
            className="gold-gradient text-primary-foreground"
          >
            {saving ? <><Calendar className="h-4 w-4 mr-2 animate-spin" /> Saving...</> : <><Save className="h-4 w-4 mr-2" /> Save Changes</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
