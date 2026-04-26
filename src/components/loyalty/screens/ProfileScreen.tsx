import { User } from 'lucide-react';

export default function ProfileScreen() {
  return (
    <div className="px-5 pt-6 pb-4">
      <h1 className="font-display text-2xl font-semibold text-foreground">Profile</h1>

      <div className="mt-10 rounded-2xl bg-card border-gold-accent shadow-card p-8 text-center space-y-3">
        <User className="h-9 w-9 text-primary mx-auto opacity-60" />
        <p className="font-display text-base font-semibold text-foreground">Coming in Phase 8</p>
        <p className="text-[11px] text-muted-foreground font-body leading-relaxed">
          Member card, loyalty status table, account details, FAQ, and tier
          benefits link.
        </p>
      </div>
    </div>
  );
}
