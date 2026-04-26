import { ArrowLeft, Crown } from 'lucide-react';

interface TiersScreenProps {
  onBack: () => void;
}

export default function TiersScreen({ onBack }: TiersScreenProps) {
  return (
    <div className="px-5 pt-6 pb-4">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 text-[11px] text-primary font-body font-semibold mb-3"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back
      </button>

      <h1 className="font-display text-2xl font-semibold text-foreground">Tier Benefits</h1>

      <div className="mt-10 rounded-2xl bg-card border-gold-accent shadow-card p-8 text-center space-y-3">
        <Crown className="h-9 w-9 text-primary mx-auto opacity-60" />
        <p className="font-display text-base font-semibold text-foreground">Coming in Phase 4</p>
        <p className="text-[11px] text-muted-foreground font-body leading-relaxed">
          Reached via Home → QuickActions. Lists all four tiers, current
          status, multipliers, and full benefit lists.
        </p>
      </div>
    </div>
  );
}
