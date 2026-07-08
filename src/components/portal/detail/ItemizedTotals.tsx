import AnimatedNumber from '@/components/portal/shared/AnimatedNumber';

/**
 * Layaway detail — itemized totals card. Full money transparency: every
 * figure is a distinct server-provided field, shown as its own labeled
 * row (never netted, hidden, or summed client-side). Rows with a zero/
 * null value are omitted rather than shown as ₱0.
 */
interface ItemizedTotalsProps {
  currency: string;
  totalAmount: number;
  totalServices: number;
  outstandingPenalties: number;
  totalPaid: number;
  remainingBalance: number;
}

function fmt(amount: number, currency: string): string {
  return currency === 'JPY'
    ? `¥${Math.round(amount).toLocaleString('en-US')}`
    : `₱${amount.toLocaleString('en-US', { minimumFractionDigits: amount % 1 === 0 ? 0 : 2, maximumFractionDigits: amount % 1 === 0 ? 0 : 2 })}`;
}

function Row({ label, amount, currency, tone = 'default', note }: { label: string; amount: number; currency: string; tone?: 'default' | 'primary' | 'danger'; note?: string }) {
  const valueClass = tone === 'primary' ? 'text-primary' : tone === 'danger' ? 'text-destructive' : 'text-foreground';
  return (
    <div className="flex items-center justify-between py-2.5">
      <div>
        <p className="text-sm text-foreground">{label}</p>
        {note && <p className="text-[11px] text-muted-foreground mt-0.5">{note}</p>}
      </div>
      <p className={`text-sm font-semibold tabular-nums ${valueClass}`}>
        <AnimatedNumber value={amount} format={(n) => fmt(n, currency)} />
      </p>
    </div>
  );
}

export default function ItemizedTotals({ currency, totalAmount, totalServices, outstandingPenalties, totalPaid, remainingBalance }: ItemizedTotalsProps) {
  return (
    <div className="rounded-xl bg-card shadow-[0_2px_12px_rgba(43,39,35,0.06)] p-5 sm:p-6">
      <p className="text-[10px] uppercase text-muted-foreground mb-2" style={{ letterSpacing: '0.2em' }}>Itemized Totals</p>
      <div className="divide-y divide-border">
        <Row label="Layaway Amount" amount={totalAmount} currency={currency} note={totalServices > 0 ? 'Includes added services' : undefined} />
        {totalServices > 0 && (
          <Row label="Additional Services" amount={totalServices} currency={currency} note="Already included above" />
        )}
        {outstandingPenalties > 0 && (
          <Row label="Outstanding Penalties" amount={outstandingPenalties} currency={currency} tone="danger" />
        )}
        <Row label="Total Paid to Date" amount={totalPaid} currency={currency} tone="primary" />
        <Row label="Remaining Balance" amount={remainingBalance} currency={currency} tone={remainingBalance > 0 ? 'primary' : 'default'} />
      </div>
    </div>
  );
}
