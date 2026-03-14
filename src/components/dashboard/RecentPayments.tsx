import { mockPayments, mockAccounts } from '@/lib/mock-data';
import { formatCurrency } from '@/lib/calculations';

export default function RecentPayments() {
  const sorted = [...mockPayments].sort((a, b) => 
    new Date(b.payment_date).getTime() - new Date(a.payment_date).getTime()
  ).slice(0, 6);

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <h3 className="text-sm font-semibold text-card-foreground mb-4">Recent Payments</h3>
      <div className="space-y-3">
        {sorted.map((p) => {
          const account = mockAccounts.find(a => a.id === p.account_id);
          return (
            <div key={p.id} className="flex items-center justify-between py-2 border-b border-border last:border-0">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-success/10 text-success text-xs font-bold">
                  {account?.customer.name.charAt(0)}
                </div>
                <div>
                  <p className="text-sm font-medium text-card-foreground">{account?.customer.name}</p>
                  <p className="text-xs text-muted-foreground">INV #{account?.invoice_number} · {p.recorded_by}</p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-sm font-semibold text-success tabular-nums">
                  +{formatCurrency(p.amount, p.currency)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {new Date(p.payment_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
