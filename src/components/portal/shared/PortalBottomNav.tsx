import { Home, Wallet, Sparkles, User } from 'lucide-react';

/**
 * Maison mobile navigation shell — the bottom tab bar spec'd for the
 * Customer Portal (Home / Layaway / Loyalty / Profile), hidden ≥1024px
 * where a sidebar/top-nav takes over.
 *
 * Phase 1 scope: this is the presentational SHELL only — structure,
 * styling, touch targets, active state. It is a controlled component
 * (active tab + onChange) and is NOT yet wired into CustomerPortal.tsx
 * or LoyaltyPortal.tsx; those screens still render as separate routes
 * with their own internal navigation today. Wiring this shell in as the
 * unifying nav happens in later phases as Home (Phase 2) and Layaway
 * (Phase 3) are actually rebuilt under it — inserting it now, before
 * those screens exist in Maison form, would risk breaking today's layout
 * with no way to verify against the redesigned content.
 *
 * Distinct from src/components/loyalty/LoyaltyBottomNav.tsx (existing,
 * untouched) — that is LoyaltyPortal's own 5-tab internal nav
 * (Home/Rewards/Points/Notifications/Profile) and stays exactly as-is.
 */
export type PortalTab = 'home' | 'layaway' | 'loyalty' | 'profile';

interface NavTab {
  key: PortalTab;
  label: string;
  icon: typeof Home;
}

const TABS: NavTab[] = [
  { key: 'home', label: 'Home', icon: Home },
  { key: 'layaway', label: 'Layaway', icon: Wallet },
  { key: 'loyalty', label: 'Loyalty', icon: Sparkles },
  { key: 'profile', label: 'Profile', icon: User },
];

interface PortalBottomNavProps {
  active: PortalTab;
  onChange: (tab: PortalTab) => void;
}

export default function PortalBottomNav({ active, onChange }: PortalBottomNavProps) {
  return (
    <nav
      aria-label="Portal navigation"
      className="maison-portal font-body lg:hidden fixed bottom-0 left-0 right-0 z-50 bg-card/97 backdrop-blur-xl border-t border-border"
    >
      <div className="max-w-lg mx-auto flex items-stretch justify-around px-1">
        {TABS.map((tab) => {
          const isActive = active === tab.key;
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => onChange(tab.key)}
              aria-current={isActive ? 'page' : undefined}
              className="relative flex min-h-[52px] flex-1 flex-col items-center justify-center gap-1 py-1.5"
            >
              {isActive && (
                <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 rounded-full bg-primary" />
              )}
              <Icon
                size={22}
                className={`transition-colors ${isActive ? 'text-primary' : 'text-muted-foreground'}`}
                strokeWidth={isActive ? 2 : 1.5}
              />
              <span
                className={`text-[11px] font-medium tracking-wide transition-colors ${
                  isActive ? 'text-primary' : 'text-muted-foreground'
                }`}
              >
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
      <div className="h-[env(safe-area-inset-bottom)]" />
    </nav>
  );
}
