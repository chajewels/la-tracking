import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Loader2 } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useAccounts, type AccountWithCustomer } from '@/hooks/use-supabase-data';
import { supabase } from '@/integrations/supabase/client';
import RecordPaymentDialog from '@/components/payments/RecordPaymentDialog';
import MultiInvoicePaymentDialog from '@/components/payments/MultiInvoicePaymentDialog';

interface RecordPaymentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type PaymentMode = 'single' | 'split';
type Step = 'search' | 'mode' | 'record';

const MAX_RESULTS = 8;
const ACTIVE_STATUSES = [
  'active', 'overdue', 'extension_active', 'reactivated', 'final_settlement',
];

export default function RecordPaymentModal({ open, onOpenChange }: RecordPaymentModalProps) {
  const [step, setStep] = useState<Step>('search');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<AccountWithCustomer | null>(null);
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('single');
  const [scheduleData, setScheduleData] = useState<any[]>([]);
  const [paymentsData, setPaymentsData] = useState<any[]>([]);
  const [scheduleLoading, setScheduleLoading] = useState(false);

  const { data: accounts } = useAccounts();

  useEffect(() => {
    if (step !== 'record' || !selected) return;
    let cancelled = false;
    setScheduleLoading(true);
    Promise.all([
      supabase
        .from('schedule_with_actuals' as any)
        .select('*')
        .eq('account_id', selected.id)
        .order('installment_number', { ascending: true }),
      supabase
        .from('payments')
        .select('*')
        .eq('account_id', selected.id),
    ]).then(([scheduleRes, paymentsRes]) => {
      if (cancelled) return;
      const normalized = ((scheduleRes.data as any[]) || []).map((row: any) => ({
        ...row,
        paid_amount: row.allocated ?? 0,
        status: row.computed_status ?? row.db_status,
        total_due_amount: row.actual_remaining ?? row.total_due_amount,
      }));
      setScheduleData(normalized);
      setPaymentsData((paymentsRes.data as any[]) || []);
      setScheduleLoading(false);
    });
    return () => { cancelled = true; };
  }, [step, selected]);

  const downpaymentRemaining = useMemo(() => {
    if (!selected) return 0;
    const downpaymentAmount = Number((selected as any).downpayment_amount ?? 0);
    if (downpaymentAmount <= 0) return 0;
    const isDp = (p: any) =>
      (p.reference_number && String(p.reference_number).startsWith('DP-')) ||
      (p.remarks && /\bdown(payment)?\b|\bdp\b/i.test(String(p.remarks)));
    const active = paymentsData.filter((p) => !p.voided_at);
    const taggedDpPaid = active
      .filter(isDp)
      .reduce((s, p) => s + Number(p.amount_paid), 0);
    const totalPaidAll = active.reduce((s, p) => s + Number(p.amount_paid), 0);
    const dpPaidAmount = taggedDpPaid > 0
      ? taggedDpPaid
      : (totalPaidAll >= downpaymentAmount ? downpaymentAmount : 0);
    return Math.max(0, downpaymentAmount - dpPaidAmount);
  }, [selected, paymentsData]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return (accounts ?? [])
      .filter((a) => ACTIVE_STATUSES.includes(a.status))
      .filter((a) => {
        const inv = String(a.invoice_number ?? '').toLowerCase();
        const name = String(a.customers?.full_name ?? '').toLowerCase();
        return inv.includes(q) || name.includes(q);
      })
      .slice(0, MAX_RESULTS);
  }, [accounts, query]);

  const handleClose = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      // Reset the wizard so the next open starts fresh.
      setStep('search');
      setSelected(null);
      setQuery('');
      setPaymentMode('single');
      setScheduleData([]);
      setPaymentsData([]);
      setScheduleLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        {step === 'search' && (
          <>
            <DialogHeader>
              <DialogTitle>Record Payment</DialogTitle>
              <DialogDescription>
                Search for an account or customer to record a payment against.
              </DialogDescription>
            </DialogHeader>

            <Input
              autoFocus
              placeholder="Search invoice # or customer name..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="mt-2"
            />

            <div className="mt-3 max-h-64 overflow-y-auto space-y-1">
              {results.map((account) => (
                <button
                  key={account.id}
                  onClick={() => {
                    setSelected(account);
                    setStep('mode');
                  }}
                  className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-muted transition-colors border border-border mb-1"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-semibold text-sm text-foreground">
                      #{account.invoice_number}
                    </span>
                    <span className="text-xs font-medium capitalize px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                      {account.status}
                    </span>
                  </div>
                  <div className="flex items-center justify-between mt-0.5">
                    <span className="text-sm text-muted-foreground">
                      {account.customers?.full_name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Balance: {account.currency} {(account.remaining_balance ?? 0).toLocaleString()}
                    </span>
                  </div>
                </button>
              ))}
              {results.length === 0 && query.length > 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  No active accounts found
                </p>
              )}
            </div>
          </>
        )}

        {step === 'mode' && selected && (
          <>
            <button
              onClick={() => {
                setStep('search');
                setSelected(null);
              }}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-3"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Back
            </button>
            <DialogHeader>
              <DialogTitle>Record Payment</DialogTitle>
              <DialogDescription>
                #{selected.invoice_number} · {selected.customers?.full_name}
              </DialogDescription>
            </DialogHeader>
            <div className="mt-4 space-y-3">
              <p className="text-sm font-medium text-foreground">
                Select payment type
              </p>
              <button
                onClick={() => {
                  setPaymentMode('single');
                  setStep('record');
                }}
                className="w-full text-left px-4 py-3 rounded-lg border border-border hover:bg-muted transition-colors"
              >
                <p className="font-medium text-sm text-foreground">
                  Single Payment
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Record one installment or downpayment
                </p>
              </button>
              <button
                onClick={() => {
                  setPaymentMode('split');
                  setStep('record');
                }}
                className="w-full text-left px-4 py-3 rounded-lg border border-border hover:bg-muted transition-colors"
              >
                <p className="font-medium text-sm text-foreground">
                  Split Payment
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Split amount across multiple months
                </p>
              </button>
            </div>
          </>
        )}

        {step === 'record' && selected && (
          <>
            <button
              onClick={() => setStep('mode')}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-3"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Back
            </button>

            {paymentMode === 'single' ? (
              scheduleLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <RecordPaymentDialog
                  accountId={selected.id}
                  currency={selected.currency}
                  remainingBalance={selected.remaining_balance ?? 0}
                  payFullBalance={false}
                  schedule={scheduleData}
                  invoiceNumber={selected.invoice_number}
                  downpaymentRemaining={downpaymentRemaining}
                  onPaymentRecorded={() => {
                    onOpenChange(false);
                    setStep('search');
                    setSelected(null);
                    setQuery('');
                    setPaymentMode('single');
                    setScheduleData([]);
                    setPaymentsData([]);
                    setScheduleLoading(false);
                  }}
                />
              )
            ) : (
              <MultiInvoicePaymentDialog
                customerId={selected.customer_id}
                customerName={selected.customers?.full_name ?? ''}
                accounts={(accounts ?? [])
                  .filter((a) => a.customer_id === selected.customer_id)
                  .map((a) => ({
                    id: a.id,
                    invoice_number: a.invoice_number,
                    currency: a.currency,
                    remaining_balance: Number(a.remaining_balance ?? 0),
                    total_amount: Number(a.total_amount ?? 0),
                    total_paid: Number(a.total_paid ?? 0),
                    status: a.status,
                  }))}
              />
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
