import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Copy, MessageCircle, Check, AlertTriangle, Calendar, Pencil, Ban, X, Save, RotateCcw } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import RecordPaymentDialog from '@/components/payments/RecordPaymentDialog';
import PenaltyWaiverPanel from '@/components/penalties/PenaltyWaiverPanel';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { toast } from 'sonner';
import { useAccount, useSchedule, usePayments, usePenalties, useVoidPayment, useEditPayment, useRestorePayment } from '@/hooks/use-supabase-data';
import { Skeleton } from '@/components/ui/skeleton';

export default function AccountDetail() {
  const { id } = useParams();
  const { data: account, isLoading: accountLoading } = useAccount(id);
  const { data: schedule } = useSchedule(id);
  const { data: payments } = usePayments(id);
  const { data: penalties } = usePenalties(id);
  const [copied, setCopied] = useState(false);
  const voidPayment = useVoidPayment();
  const editPayment = useEditPayment();
  const restorePayment = useRestorePayment();
  const [voidTarget, setVoidTarget] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDate, setEditDate] = useState('');
  const [editMethod, setEditMethod] = useState('');
  const [editRemarks, setEditRemarks] = useState('');

  if (accountLoading) {
    return (
      <AppLayout>
        <div className="space-y-6 max-w-5xl">
          <Skeleton className="h-10 w-64" />
          <div className="grid grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
          </div>
        </div>
      </AppLayout>
    );
  }

  if (!account) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-64">
          <p className="text-muted-foreground">Account not found</p>
        </div>
      </AppLayout>
    );
  }

  const currency = account.currency as Currency;
  const totalAmount = Number(account.total_amount);
  const totalPaid = Number(account.total_paid);
  const remainingBalance = Number(account.remaining_balance);
  const progress = totalAmount > 0 ? (totalPaid / totalAmount) * 100 : 0;

  const unpaidPenalties = (penalties || []).filter(p => p.status === 'unpaid');
  const totalPenalty = unpaidPenalties.reduce((s, p) => s + Number(p.penalty_amount), 0);

  // Build message from schedule data
  const scheduleItems = schedule || [];
  const unpaidSchedule = scheduleItems.filter(s => s.status !== 'paid');
  const ordinals = ['1st', '2nd', '3rd', '4th', '5th', '6th'];
  const getRemainingDue = (item: { total_due_amount: number | string; paid_amount: number | string }) =>
    Math.max(0, Number(item.total_due_amount) - Number(item.paid_amount));

  let message = `✨ Cha Jewels Layaway Payment Summary\n\n`;
  message += `Inv # ${account.invoice_number}\n`;
  if (totalPenalty > 0) {
    message += `Total Layaway Amount: ${formatCurrency(totalAmount, currency)} + ${formatCurrency(totalPenalty, currency)} (Penalty)\n`;
  } else {
    message += `Total Layaway Amount: ${formatCurrency(totalAmount, currency)}\n`;
  }
  message += `Amount Paid: ${formatCurrency(totalPaid, currency)}\n`;
  message += `Remaining Balance: ${formatCurrency(remainingBalance, currency)}\n\n`;
  message += `================\n\n`;
  message += `Payment Schedule:\n\n`;
  scheduleItems.forEach((item, idx) => {
    const isPaid = item.status === 'paid';
    const isPartial = item.status === 'partially_paid';
    const dateStr = new Date(item.due_date).toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
    const penalty = Number(item.penalty_amount);
    const totalDue = Number(item.total_due_amount);
    const paid = Number(item.paid_amount);
    const remainingDue = getRemainingDue(item);

    if (isPaid) {
      message += `✅ ${ordinals[idx] || `${idx + 1}th`} month ${dateStr}: ${formatCurrency(totalDue, currency)} — PAID\n`;
    } else if (isPartial) {
      message += `${ordinals[idx] || `${idx + 1}th`} month ${dateStr}: ${formatCurrency(remainingDue, currency)} remaining (${formatCurrency(paid, currency)} paid of ${formatCurrency(totalDue, currency)})${penalty > 0 ? `, includes ${formatCurrency(penalty, currency)} penalty` : ''} — PARTIAL\n`;
    } else if (penalty > 0) {
      message += `${ordinals[idx] || `${idx + 1}th`} month ${dateStr}: ${formatCurrency(totalDue, currency)} due (includes ${formatCurrency(penalty, currency)} penalty)\n`;
    } else {
      message += `${ordinals[idx] || `${idx + 1}th`} month ${dateStr}: ${formatCurrency(remainingDue, currency)}\n`;
    }
  });
  if (unpaidSchedule.length > 0) {
    const nextDate = new Date(unpaidSchedule[0].due_date).toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
    message += `\nPlease note your next monthly payment is on ${nextDate}. Please expect another payment reminder from us.\n\n`;
    message += `Thank you for your continued trust in Cha Jewels. We appreciate your business! 💛`;
  }

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
          <Link to="/accounts">
            <Button variant="ghost" size="icon" className="text-muted-foreground">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-xl sm:text-2xl font-bold text-foreground font-display">INV #{account.invoice_number}</h1>
              <Badge variant="outline" className="bg-success/10 text-success border-success/20 text-xs">
                {account.status}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">
              {account.customers?.full_name} · {account.payment_plan_months}-Month Plan · {currency}
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            {remainingBalance > 0 && (
              <RecordPaymentDialog
                accountId={account.id}
                currency={currency}
                remainingBalance={remainingBalance}
              />
            )}
            {account.customers?.messenger_link && (
              <a href={account.customers.messenger_link} target="_blank" rel="noopener noreferrer">
                <Button variant="outline" className="border-info/30 text-info hover:bg-info/10">
                  <MessageCircle className="h-4 w-4 mr-2" /> Messenger
                </Button>
              </a>
            )}
          </div>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
          <div className="rounded-xl border border-border bg-card p-3 sm:p-4">
            <p className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider mb-1">Total Amount</p>
            <p className="text-lg sm:text-xl font-bold text-card-foreground font-display tabular-nums">
              {formatCurrency(totalAmount, currency)}
            </p>
          </div>
          <div className="rounded-xl border border-success/20 bg-card p-3 sm:p-4">
            <p className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider mb-1">Total Paid</p>
            <p className="text-lg sm:text-xl font-bold text-success font-display tabular-nums">
              {formatCurrency(totalPaid, currency)}
            </p>
          </div>
          <div className="rounded-xl border border-primary/20 bg-card p-3 sm:p-4">
            <p className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider mb-1">Remaining</p>
            <p className="text-lg sm:text-xl font-bold text-card-foreground font-display tabular-nums">
              {formatCurrency(remainingBalance, currency)}
            </p>
          </div>
          <div className="rounded-xl border border-border bg-card p-3 sm:p-4">
            <p className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider mb-1">Progress</p>
            <p className="text-lg sm:text-xl font-bold text-primary font-display">{Math.round(progress)}%</p>
            <div className="mt-2 h-2 rounded-full bg-muted overflow-hidden">
              <div className="h-full gold-gradient rounded-full transition-all" style={{ width: `${progress}%` }} />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Payment Schedule */}
          <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
            <h3 className="text-sm font-semibold text-card-foreground mb-4 flex items-center gap-2">
              <Calendar className="h-4 w-4 text-primary" /> Payment Schedule
            </h3>
            <div className="space-y-2">
              {scheduleItems.map((item) => {
                const isPaid = item.status === 'paid';
                const isPartial = item.status === 'partially_paid';
                const penaltyAmt = Number(item.penalty_amount);
                const paidAmt = Number(item.paid_amount);
                const totalDue = Number(item.total_due_amount);
                const remainingDue = getRemainingDue(item);
                return (
                  <div key={item.id}
                    className={`flex items-center justify-between p-2.5 sm:p-3 rounded-lg border ${
                      isPaid ? 'bg-success/5 border-success/10' : isPartial ? 'bg-primary/5 border-primary/10' : 'bg-card border-border'
                    }`}
                  >
                    <div className="flex items-center gap-2 sm:gap-3">
                      <div className={`flex h-6 w-6 sm:h-7 sm:w-7 items-center justify-center rounded-full text-[10px] sm:text-xs font-bold ${
                        isPaid ? 'bg-success/20 text-success' : isPartial ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'
                      }`}>
                        {isPaid ? <Check className="h-3 w-3" /> : item.installment_number}
                      </div>
                      <div>
                        <p className="text-xs sm:text-sm font-medium text-card-foreground">
                          {new Date(item.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </p>
                        <p className="text-[10px] sm:text-xs text-muted-foreground">
                          {isPaid ? 'Paid' : isPartial ? 'Partially Paid' : `Month ${item.installment_number}`}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className={`text-xs sm:text-sm font-semibold tabular-nums ${isPaid ? 'text-success' : isPartial ? 'text-primary' : 'text-card-foreground'}`}>
                        {formatCurrency(isPaid ? paidAmt : remainingDue, currency)}
                      </p>
                      {isPartial ? (
                        <p className="text-[10px] text-muted-foreground tabular-nums">
                          Paid {formatCurrency(paidAmt, currency)} of {formatCurrency(totalDue, currency)}
                        </p>
                      ) : penaltyAmt > 0 && !isPaid ? (
                        <p className="text-[10px] text-destructive flex items-center gap-1 justify-end">
                          <AlertTriangle className="h-2.5 w-2.5" />
                          Includes {formatCurrency(penaltyAmt, currency)} penalty
                        </p>
                      ) : null}
                    </div>
                  </div>
                );
              })}
              {scheduleItems.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">No schedule generated yet</p>
              )}
            </div>
          </div>

          {/* Customer Message */}
          <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
            <h3 className="text-sm font-semibold text-card-foreground mb-4 flex items-center gap-2">
              <MessageCircle className="h-4 w-4 text-info" /> Customer Message
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
              {account.customers?.messenger_link && (
                <a href={account.customers.messenger_link} target="_blank" rel="noopener noreferrer">
                  <Button variant="outline" size="sm" className="border-info/30 text-info hover:bg-info/10">
                    <MessageCircle className="h-3.5 w-3.5 mr-1" /> Messenger
                  </Button>
                </a>
              )}
            </div>
          </div>
        </div>

        {/* Penalty Waiver Panel */}
        {unpaidPenalties.length > 0 && (
          <PenaltyWaiverPanel
            accountId={account.id}
            invoiceNumber={account.invoice_number}
            currency={currency}
            penalties={unpaidPenalties.map(p => ({
              id: p.id,
              scheduleId: p.schedule_id,
              amount: Number(p.penalty_amount),
              stage: p.penalty_stage,
            }))}
          />
        )}

        {/* Payment History */}
        <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
          <h3 className="text-sm font-semibold text-card-foreground mb-4">Payment History</h3>
          {(!payments || payments.length === 0) ? (
            <p className="text-sm text-muted-foreground">No payments recorded yet</p>
          ) : (
            <div className="space-y-2">
              {payments.map((p) => {
                const isVoided = !!(p as any).voided_at;
                const isEditing = editingId === p.id;

                if (isEditing) {
                  return (
                    <div key={p.id} className="p-3 rounded-lg border border-primary/30 bg-muted/30 space-y-2">
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <div>
                          <label className="text-[10px] text-muted-foreground uppercase">Date</label>
                          <Input type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} className="h-8 text-xs bg-background" />
                        </div>
                        <div>
                          <label className="text-[10px] text-muted-foreground uppercase">Method</label>
                          <Select value={editMethod} onValueChange={setEditMethod}>
                            <SelectTrigger className="h-8 text-xs bg-background"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="cash">Cash</SelectItem>
                              <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                              <SelectItem value="gcash">GCash</SelectItem>
                              <SelectItem value="other">Other</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <label className="text-[10px] text-muted-foreground uppercase">Amount (read-only)</label>
                          <Input disabled value={formatCurrency(Number(p.amount_paid), p.currency as Currency)} className="h-8 text-xs bg-muted" />
                        </div>
                      </div>
                      <div>
                        <label className="text-[10px] text-muted-foreground uppercase">Notes</label>
                        <Textarea value={editRemarks} onChange={(e) => setEditRemarks(e.target.value)} rows={1} className="text-xs bg-background resize-none" />
                      </div>
                      <div className="flex gap-2 justify-end">
                        <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                          <X className="h-3 w-3 mr-1" /> Cancel
                        </Button>
                        <Button size="sm" className="gold-gradient text-primary-foreground" disabled={editPayment.isPending}
                          onClick={async () => {
                            try {
                              await editPayment.mutateAsync({
                                id: p.id,
                                date_paid: editDate,
                                payment_method: editMethod,
                                remarks: editRemarks || undefined,
                              });
                              toast.success('Payment updated');
                              setEditingId(null);
                            } catch (err: any) {
                              toast.error(err.message || 'Failed to update');
                            }
                          }}>
                          <Save className="h-3 w-3 mr-1" /> Save
                        </Button>
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={p.id} className={`flex items-center justify-between py-2 px-2 rounded-lg border-b border-border last:border-0 ${isVoided ? 'opacity-50 line-through' : ''}`}>
                    <div className="flex-1">
                      <p className="text-xs sm:text-sm text-card-foreground">
                        {new Date(p.date_paid).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                      </p>
                      <p className="text-[10px] sm:text-xs text-muted-foreground">
                        {p.payment_method || 'Cash'}
                        {p.remarks && ` · ${p.remarks}`}
                        {isVoided && ` · VOIDED${(p as any).void_reason ? `: ${(p as any).void_reason}` : ''}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <p className={`text-xs sm:text-sm font-semibold tabular-nums ${isVoided ? 'text-muted-foreground' : 'text-success'}`}>
                        {isVoided ? '' : '+'}{formatCurrency(Number(p.amount_paid), p.currency as Currency)}
                      </p>
                      {!isVoided && (
                        <div className="flex gap-1">
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground"
                            onClick={() => {
                              setEditingId(p.id);
                              setEditDate(p.date_paid);
                              setEditMethod(p.payment_method || 'cash');
                              setEditRemarks(p.remarks || '');
                            }}>
                            <Pencil className="h-3 w-3" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive"
                            onClick={() => { setVoidTarget(p.id); setVoidReason(''); }}>
                            <Ban className="h-3 w-3" />
                          </Button>
                        </div>
                      )}
                      {isVoided && (
                        <Button variant="ghost" size="sm"
                          className="h-7 text-xs text-muted-foreground hover:text-success"
                          style={{ textDecoration: 'none' }}
                          disabled={restorePayment.isPending}
                          onClick={async () => {
                            try {
                              await restorePayment.mutateAsync({ payment_id: p.id });
                              toast.success('Payment restored successfully');
                            } catch (err: any) {
                              toast.error(err.message || 'Failed to restore payment');
                            }
                          }}>
                          <RotateCcw className="h-3 w-3 mr-1" />
                          {restorePayment.isPending ? 'Restoring…' : 'Restore'}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Void Confirmation Dialog */}
        <AlertDialog open={!!voidTarget} onOpenChange={(open) => { if (!open) setVoidTarget(null); }}>
          <AlertDialogContent className="bg-card border-border">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-card-foreground">Void Payment</AlertDialogTitle>
              <AlertDialogDescription>
                This will reverse the payment and restore the balance. The payment record will be kept for audit purposes. Amount changes require voiding and re-entering.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground">Reason (optional)</label>
              <Textarea value={voidReason} onChange={(e) => setVoidReason(e.target.value)} rows={2} placeholder="e.g. Recorded wrong amount" className="bg-background border-border text-sm resize-none" />
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel className="border-border">Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                disabled={voidPayment.isPending}
                onClick={async () => {
                  if (!voidTarget) return;
                  try {
                    await voidPayment.mutateAsync({ payment_id: voidTarget, reason: voidReason || undefined });
                    toast.success('Payment voided successfully');
                    setVoidTarget(null);
                  } catch (err: any) {
                    toast.error(err.message || 'Failed to void payment');
                  }
                }}>
                {voidPayment.isPending ? 'Voiding…' : 'Void Payment'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </AppLayout>
  );
}
