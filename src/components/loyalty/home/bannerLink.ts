import type { LoyaltyTab } from '@/components/loyalty/LoyaltyBottomNav';

/**
 * Parse a banner / promo link_target string and dispatch.
 *
 * Supported formats:
 *   tab:home, tab:rewards, tab:points, tab:notifications,
 *   tab:profile, tab:tiers     → switch loyalty portal tab
 *   http(s)://...              → open in new tab
 *   anything else / null       → no-op
 */
const VALID_TABS: ReadonlySet<string> = new Set([
  'home',
  'rewards',
  'points',
  'notifications',
  'profile',
  'tiers',
]);

export function dispatchBannerLink(
  linkTarget: string | null | undefined,
  setTab: (tab: LoyaltyTab) => void,
): void {
  if (!linkTarget) return;
  const v = linkTarget.trim();
  if (!v) return;

  if (v.startsWith('tab:')) {
    const tab = v.slice(4).toLowerCase();
    if (VALID_TABS.has(tab)) {
      setTab(tab as LoyaltyTab);
    }
    return;
  }

  if (v.startsWith('http://') || v.startsWith('https://')) {
    window.open(v, '_blank', 'noopener,noreferrer');
    return;
  }
}
