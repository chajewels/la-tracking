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

const MAX_RESULTS = 8;

export default function RecordPaymentModal({ open, onOpenChange }: RecordPaymentModalProps) {
  const [step, setStep] = useState<'search' | 'record'>('search');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<AccountWithCustomer | null>(null);

  const { data: accounts } = useAccounts();

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return (accounts ?? [])
      .filter((a) => a.status === 'active' || a.status === 'overdue')
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
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        {step === 'search' || !selected ? (
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
                    setStep('record');
                  }}
                  className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-muted transition-colors text-sm"
                >
                  <span className="font-medium text-foreground">
                    {account.invoice_number}
                  </span>
                  <span className="text-muted-foreground ml-2">
                    {account.customers?.full_name}
                  </span>
                  <span className="float-right text-xs text-muted-foreground">
                    {account.currency} · ¥{account.remaining_balance?.toLocaleString()} remaining
                  </span>
                </button>
              ))}
              {results.length === 0 && query.length > 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  No active accounts found
                </p>
              )}
            </div>
          </>
        ) : (
          <>
            <button
              onClick={() => { setStep('search'); setSelected(null); }}
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
              }}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
