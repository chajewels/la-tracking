import AnimatedNumber from '@/components/portal/shared/AnimatedNumber';

/**
 * Layaway detail — celebratory banner shown when an account's
 * status_label is "Fully Paid". totalPaid/totalObligation are the exact
 * server-provided figures, no client-side arithmetic.
 */
interface CompletedPlanBannerProps {
  currency: string;
  totalPaid: number;
  totalObligation: number;
}

function fmt(amount: number, currency: string): string {
  return currency === 'JPY'
    ? `¥${Math.round(amount).toLocaleString('en-US')}`
    : `₱${amount.toLocaleString('en-US', { minimumFractionDigits: amount % 1 === 0 ? 0 : 2, maximumFractionDigits: amount % 1 === 0 ? 0 : 2 })}`;
}

export default function CompletedPlanBanner({ currency, totalPaid, totalObligation }: CompletedPlanBannerProps) {
  return (
    <div className="rounded-xl bg-card shadow-[0_2px_12px_rgba(43,39,35,0.06)] p-6 sm:p-7 text-center">
      <p className="text-3xl mb-2">🎉</p>
      <p className="font-display text-2xl text-foreground">Fully Paid</p>
      <p className="text-sm text-muted-foreground mt-1">Thank you for your continued trust in Cha Jewels.</p>
      <div className="flex items-center justify-center gap-8 mt-5">
        <div>
          <p className="text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: '0.15em' }}>Total Paid</p>
          <p className="font-display text-xl text-primary tabular-nums mt-0.5">
            <AnimatedNumber value={totalPaid} format={(n) => fmt(n, currency)} />
          </p>
        </div>
        <div className="w-px h-10 bg-border" />
        <div>
          <p className="text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: '0.15em' }}>Total Obligation</p>
          <p className="font-display text-xl text-foreground tabular-nums mt-0.5">
            <AnimatedNumber value={totalObligation} format={(n) => fmt(n, currency)} />
          </p>
        </div>
      </div>
    </div>
  );
}
