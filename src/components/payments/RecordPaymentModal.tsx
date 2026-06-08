import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useAccounts, type AccountWithCustomer } from '@/hooks/use-supabase-data';
import { supabase } from '@/integrations/supabase/client';
import RecordPaymentDialog from '@/components/payments/RecordPaymentDialog';
import MultiInvoicePaymentDialog from '@/components/payments/MultiInvoicePaymentDialog';

interface ScheduleRow {
  id: string;
  installment_number: number;
  due_date: string;
  base_installment_amount: number;
  penalty_amount: number;
  total_due_amount: number;
  paid_amount: number;
  status: string;
}

interface RecordPaymentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialInvoice?: string | null;
  initialPaymentMethod?: string | null;
  initialPaymentMode?: 'single' | 'split' | null;
  initialAmount?: number | null;
}

type PaymentMode = 'single' | 'split';
type Step = 'search' | 'mode' | 'record';

const MAX_RESULTS = 8;
const ACTIVE_STATUSES = [
  'active', 'overdue', 'extension_active', 'reactivated', 'final_settlement',
];

export default function RecordPaymentModal({ open, onOpenChange, initialInvoice, initialPaymentMethod, initialPaymentMode, initialAmount }: RecordPaymentModalProps) {
  const [step, setStep] = useState<Step>('search');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<AccountWithCustomer | null>(null);
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('single');
  // Schedule data per account, keyed by account_id. Populated when the staff
  // selects Split mode so the MultiInvoicePaymentDialog can show "Next due"
  // figures the same way CustomerDetail does.
  const [scheduleMap, setScheduleMap] = useState<Record<string, ScheduleRow[]>>({});

  const { data: accounts } = useAccounts();

  // When entering Split mode for a selected customer, fetch the live schedule
  // for every account that belongs to that customer. Keyed cache prevents
  // re-fetching accounts we've already loaded in this session.
  useEffect(() => {
    if (paymentMode !== 'split' || !selected || !accounts) return;
    const customerAccountIds = accounts
      .filter((a) => a.customer_id === selected.customer_id)
      .map((a) => a.id);
    const missing = customerAccountIds.filter((id) => !(id in scheduleMap));
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('layaway_schedule')
        .select('id, account_id, installment_number, due_date, base_installment_amount, penalty_amount, total_due_amount, paid_amount, status')
        .in('account_id', missing)
        .order('installment_number', { ascending: true });
      if (cancelled || !data) return;
      const additions: Record<string, ScheduleRow[]> = {};
      for (const id of missing) additions[id] = [];
      for (const row of data as any[]) {
        const list = additions[row.account_id] ?? (additions[row.account_id] = []);
        list.push({
          id: row.id,
          installment_number: row.installment_number,
          due_date: row.due_date,
          base_installment_amount: Number(row.base_installment_amount ?? 0),
          penalty_amount: Number(row.penalty_amount ?? 0),
          total_due_amount: Number(row.total_due_amount ?? 0),
          paid_amount: Number(row.paid_amount ?? 0),
          status: row.status,
        });
      }
      setScheduleMap((prev) => ({ ...prev, ...additions }));
    })();
    return () => { cancelled = true; };
  }, [paymentMode, selected, accounts, scheduleMap]);

  useEffect(() => {
    if (open && initialInvoice && accounts) {
      setQuery(initialInvoice);
      const match = accounts.find(
        (a) =>
          String(a.invoice_number) === String(initialInvoice) &&
          ACTIVE_STATUSES.includes(a.status),
      );
      if (match) {
        setSelected(match);
        if (initialPaymentMode === 'split') {
          setPaymentMode('split');
          setStep('record');
        } else if (initialPaymentMode === 'single') {
          setPaymentMode('single');
          setStep('record');
        } else {
          setStep('mode');
        }
      }
    }
  }, [open, initialInvoice, accounts, initialPaymentMode]);

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
      setScheduleMap({});
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
              <RecordPaymentDialog
                accountId={selected.id}
                currency={selected.currency}
                remainingBalance={selected.remaining_balance ?? 0}
                payFullBalance={false}
                schedule={[]}
                invoiceNumber={selected.invoice_number}
                downpaymentRemaining={0}
                initialPaymentMethod={initialPaymentMethod ?? undefined}
                onPaymentRecorded={() => {
                  onOpenChange(false);
                  setStep('search');
                  setSelected(null);
                  setQuery('');
                  setPaymentMode('single');
                }}
              />
            ) : (
              <MultiInvoicePaymentDialog
                customerId={selected.customer_id}
                customerName={selected.customers?.full_name ?? ''}
                initialPaymentMethod={initialPaymentMethod ?? undefined}
                initialAmount={initialAmount ?? null}
                initialInvoice={initialInvoice ?? null}
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
                    schedule: scheduleMap[a.id] ?? [],
                  }))}
              />
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
