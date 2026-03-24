import { useState, useCallback } from 'react';
import { Settings, Save, Plus, Trash2, Calendar } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { formatCurrency } from '@/lib/calculations';
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
  };
  schedule: ScheduleItem[];
}

export default function EditAccountDialog({ account, schedule }: EditAccountDialogProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const queryClient = useQueryClient();
  const currency = account.currency as Currency;

  // Account fields
  const [totalAmount, setTotalAmount] = useState('');
  const [orderDate, setOrderDate] = useState('');
  const [notes, setNotes] = useState('');
  const [downpayment, setDownpayment] = useState('');

  // Schedule editing
  const [scheduleEdits, setScheduleEdits] = useState<Record<string, { due_date?: string; base_amount?: string }>>({});
  const [newInstallments, setNewInstallments] = useState<Array<{ due_date: string; base_amount: string }>>([]);

  const resetForm = useCallback(() => {
    setTotalAmount(String(account.total_amount));
    setOrderDate(account.order_date);
    setNotes(account.notes || '');
    setDownpayment(String(account.downpayment_amount));
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

  const addNewInstallment = () => {
    const lastItem = schedule[schedule.length - 1];
    const lastDate = lastItem ? new Date(lastItem.due_date) : new Date(account.order_date);
    const nextDate = new Date(lastDate);
    nextDate.setMonth(nextDate.getMonth() + 1);
    setNewInstallments(prev => [...prev, {
      due_date: nextDate.toISOString().split('T')[0],
      base_amount: '',
    }]);
  };

  const removeNewInstallment = (idx: number) => {
    setNewInstallments(prev => prev.filter((_, i) => i !== idx));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const user = (await supabase.auth.getUser()).data.user;
      const userId = user?.id;

      // 1. Update account fields if changed
      const accountUpdates: Record<string, unknown> = {};
      const newTotal = parseFloat(totalAmount);
      if (!isNaN(newTotal) && newTotal !== account.total_amount) {
        accountUpdates.total_amount = Math.round(newTotal * 100) / 100;
        accountUpdates.remaining_balance = Math.max(0, Math.round((newTotal - Number(account.total_amount) + Number(account.total_amount)) * 100) / 100);
      }
      if (orderDate && orderDate !== account.order_date) accountUpdates.order_date = orderDate;
      if (notes !== (account.notes || '')) accountUpdates.notes = notes || null;
      const newDp = parseFloat(downpayment);
      if (!isNaN(newDp) && newDp !== account.downpayment_amount) {
        accountUpdates.downpayment_amount = Math.round(newDp * 100) / 100;
      }

      if (Object.keys(accountUpdates).length > 0) {
        const { error } = await supabase
          .from('layaway_accounts')
          .update(accountUpdates)
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

      // 2. Update schedule items that were edited
      for (const [scheduleId, edits] of Object.entries(scheduleEdits)) {
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
            if (error) throw error;
            if (data?.error) throw new Error(data.error);
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

      // 3. Add new installments
      for (const newInst of newInstallments) {
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
                  onChange={(e) => setTotalAmount(e.target.value)}
                  className="h-9 text-sm bg-background tabular-nums"
                  disabled={isDisabledStatus}
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">30% Downpayment ({currency})</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={downpayment}
                  onChange={(e) => setDownpayment(e.target.value)}
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
          </div>

          {/* Schedule Management Section */}
          <div className="space-y-3">
            <div className="flex items-center justify-between border-b border-border pb-2">
              <h4 className="text-sm font-semibold text-card-foreground">Payment Schedule</h4>
              {!isDisabledStatus && (
                <Button variant="outline" size="sm" onClick={addNewInstallment} className="h-7 text-xs border-primary/30 text-primary hover:bg-primary/10">
                  <Plus className="h-3 w-3 mr-1" /> Add Installment
                </Button>
              )}
            </div>

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
                      disabled={!isEditable}
                    />
                    <Input
                      type="number"
                      step="0.01"
                      value={edits.base_amount ?? String(item.base_installment_amount)}
                      onChange={(e) => updateScheduleEdit(item.id, 'base_amount', e.target.value)}
                      className="h-8 text-xs bg-background tabular-nums"
                      disabled={!isEditable}
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
