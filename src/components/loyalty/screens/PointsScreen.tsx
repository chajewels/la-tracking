import { Coins } from 'lucide-react';

export default function PointsScreen() {
  return (
    <div className="px-5 pt-6 pb-4">
      <div>
        <p className="text-[10px] text-muted-foreground font-body tracking-[0.2em] uppercase">
          Your Points, Your Perks
        </p>
        <h1 className="font-display text-2xl font-semibold text-foreground mt-1">My Points</h1>
      </div>

      <div className="mt-10 rounded-2xl bg-card border-gold-accent shadow-card p-8 text-center space-y-3">
        <Coins className="h-9 w-9 text-primary mx-auto opacity-60" />
        <p className="font-display text-base font-semibold text-foreground">Coming in Phase 5</p>
        <p className="text-[11px] text-muted-foreground font-body leading-relaxed">
          Points summary, earn/redeem rules, and full transaction history with
          invoice / spend / multiplier columns.
        </p>
      </div>
    </div>
  );
}
