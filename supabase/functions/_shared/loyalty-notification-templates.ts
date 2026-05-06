// loyalty-notification-templates — Phase 4.2
//
// Pure template builders for auto-trigger notifications. Each export
// returns { title, body } where title <= 100 chars and body <= 500 chars
// to match the loyalty_notifications CHECK constraints.
//
// No side effects. No DB calls. No I/O. Edge functions import these,
// then pass the output to emitNotification (Phase 4.2 C3) which handles
// the actual INSERT.

const PORTAL_BASE = 'https://portal.chajewelsjp.com';

// Tier multiplier lookup — kept in sync with loyalty_tiers.points_multiplier.
// Embedded here so the templates stay pure (no DB lookup); update when
// the tier ladder changes.
const TIER_MULTIPLIERS: Record<string, number> = {
  'Glimmer': 1,
  'Radiant': 2,
  'Elite': 2,
  'Crown VIP': 3,
};

function multiplierFor(tierName: string): number {
  return TIER_MULTIPLIERS[tierName] ?? 1;
}

function fmt(n: number): string {
  // Defensive: NaN / Infinity → '0' instead of leaking 'NaN' to customers
  if (!Number.isFinite(n)) return '0';
  return Math.trunc(n).toLocaleString('en-US');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

// ─────────── Public API ─────────────────────────────────────────────

export interface NotificationTemplate {
  title: string;
  body: string;
}

export function buildPointsEarnedNotification(args: {
  points: number;
  invoiceNumber: string;
}): NotificationTemplate {
  const { points, invoiceNumber } = args;
  const inv = invoiceNumber?.trim() || '—';
  return {
    title: truncate(`+${fmt(points)} points earned ✨`, 100),
    body: truncate(
      `You earned ${fmt(points)} loyalty points on invoice ${inv}. Keep collecting toward your next reward.`,
      500,
    ),
  };
}

export function buildTierUpgradeNotification(args: {
  oldTier: string;
  newTier: string;
}): NotificationTemplate {
  const { oldTier, newTier } = args;
  const mult = multiplierFor(newTier);
  return {
    title: truncate(`Tier upgraded — welcome to ${newTier}! 🎉`, 100),
    body: truncate(
      `Congratulations! You moved up from ${oldTier} to ${newTier}. Enjoy ${mult}x points on every qualifying purchase plus all ${newTier} member perks.`,
      500,
    ),
  };
}

export function buildTierDowngradeNotification(args: {
  oldTier: string;
  newTier: string;
}): NotificationTemplate {
  const { oldTier, newTier } = args;
  return {
    title: truncate(`Tier change — now ${newTier}`, 100),
    body: truncate(
      `Your tier has changed from ${oldTier} to ${newTier} due to recent inactivity. Make a qualifying purchase to climb back to ${oldTier} and restore your higher earnings.`,
      500,
    ),
  };
}

export function buildRedemptionApprovedNotification(args: {
  rewardName: string;
  points: number;
}): NotificationTemplate {
  const { rewardName, points } = args;
  const safeName = truncate((rewardName || 'Your reward').trim(), 80);
  return {
    title: truncate(`Reward approved 🎁`, 100),
    body: truncate(
      `Your redemption for "${safeName}" has been approved. ${fmt(points)} points were used. We'll be in touch about next steps.`,
      500,
    ),
  };
}

export function buildRedemptionCancelledNotification(args: {
  rewardName: string;
  reason: string;
}): NotificationTemplate {
  const { rewardName, reason } = args;
  const safeName = truncate((rewardName || 'Your reward').trim(), 80);
  // Reason can be long admin free-text; cap at 300 chars to leave room
  // for the wrapping copy and stay well under the 500 char body limit.
  const safeReason = truncate((reason || 'No reason provided').trim(), 300);
  return {
    title: truncate(`Redemption cancelled`, 100),
    body: truncate(
      `Your redemption for "${safeName}" was cancelled. Reason: ${safeReason}`,
      500,
    ),
  };
}

export function buildPreExpiryNotification(args: {
  daysUntilExpiry: number;
  points: number;
}): NotificationTemplate {
  const { daysUntilExpiry, points } = args;
  const days = Math.max(0, Math.trunc(daysUntilExpiry));
  const dayLabel = days === 1 ? '1 day' : `${fmt(days)} days`;
  return {
    title: truncate(`${fmt(points)} points expiring soon ⏳`, 100),
    body: truncate(
      `Your ${fmt(points)} loyalty points expire in ${dayLabel}. Make a qualifying purchase to keep your balance and tier active.`,
      500,
    ),
  };
}

export function buildExpiryFiredNotification(args: {
  pointsLost: number;
}): NotificationTemplate {
  const { pointsLost } = args;
  return {
    title: truncate(`Points expired`, 100),
    body: truncate(
      `Your ${fmt(pointsLost)} loyalty points have expired due to 6 months of inactivity. Make a qualifying purchase to start earning again.`,
      500,
    ),
  };
}

export function buildWelcomeNotification(args: {
  firstName?: string | null;
  points: number;
}): NotificationTemplate {
  const { firstName, points } = args;
  const name = (firstName || '').trim().split(' ')[0] || 'there';
  return {
    title: truncate(`Welcome to Cha Jewels Loyalty! 💎`, 100),
    body: truncate(
      `Hi ${name}! You've earned your first ${fmt(points)} loyalty points. Visit your portal to explore rewards and track your tier progress: ${PORTAL_BASE}/loyalty`,
      500,
    ),
  };
}
