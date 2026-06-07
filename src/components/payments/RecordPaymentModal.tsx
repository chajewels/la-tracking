import { useMemo, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useAccounts, type AccountWithCustomer } from '@/hooks/use-supabase-data';
import RecordPaymentDialog from '@/components/payments/RecordPaymentDialog';

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
  // UI-only — RecordPaymentDialog has its own internal paymentType toggle.
  // We don't forward this yet; the selection is for clarity in this wizard.
  const [, setPaymentMode] = useState<PaymentMode>('single');

  const { data: accounts } = useAccounts();

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
              onClick={() => {
                setStep('mode');
              }}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-3"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Back
            </button>
            <RecordPaymentDialog
              accountId={selected.id}
              currency={selected.currency}
              remainingBalance={selected.remaining_balance ?? 0}
              payFullBalance={false}
              schedule={[]}
              invoiceNumber={selected.invoice_number}
              downpaymentRemaining={0}
              onPaymentRecorded={() => {
                onOpenChange(false);
                setStep('search');
                setSelected(null);
                setQuery('');
                setPaymentMode('single');
              }}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
