import { Bell } from 'lucide-react';

export default function NotificationsScreen() {
  return (
    <div className="px-5 pt-6 pb-4">
      <div>
        <p className="text-[10px] text-muted-foreground font-body tracking-[0.2em] uppercase">
          Stay Updated
        </p>
        <h1 className="font-display text-2xl font-semibold text-foreground mt-1">
          Notifications
        </h1>
      </div>

      <div className="mt-10 rounded-2xl bg-card border-gold-accent shadow-card p-8 text-center space-y-3">
        <Bell className="h-9 w-9 text-primary mx-auto opacity-60" />
        <p className="font-display text-base font-semibold text-foreground">Coming in Phase 7</p>
        <p className="text-[11px] text-muted-foreground font-body leading-relaxed">
          Tier / points / redemption / milestone alerts grouped by Today /
          Yesterday / Earlier.
        </p>
      </div>
    </div>
  );
}
