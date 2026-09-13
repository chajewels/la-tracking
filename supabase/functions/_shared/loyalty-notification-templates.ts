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
  /** The level the member earned (unchanged by the step-down). */
  earnedTier?: string | null;
  /** Spend still needed to regain the earned level, in JPY. */
  regainJpy?: number | null;
}): NotificationTemplate {
  const { oldTier, newTier, earnedTier, regainJpy } = args;
  const regain = earnedTier && regainJpy != null
    ? ` The level you earned is ${earnedTier}: spend ¥${fmt(regainJpy)} more and it comes back.`
    : ` Make a qualifying purchase to climb back to ${oldTier}.`;
  return {
    title: truncate(`レベル一時変更中 / Level temporarily reduced — now ${newTier}`, 100),
    body: truncate(
      `180日間お買い上げがなかったため、レベルが ${oldTier} から ${newTier} に1段階下がりました。 / 180 days passed without a purchase, so your level stepped down from ${oldTier} to ${newTier}.${regain}`,
      500,
    ),
  };
}

export function buildStepdownWarningNotification(args: {
  currentTier: string;
  nextLowerTier: string;
  daysLeft: number;
  stepDownDate: string;
}): NotificationTemplate {
  const { currentTier, nextLowerTier, daysLeft, stepDownDate } = args;
  const days = Math.max(0, Math.trunc(daysLeft));
  return {
    title: truncate(`あと${fmt(days)}日でレベルが1段階下がります / Your level steps down in ${fmt(days)} days`, 100),
    body: truncate(
      `${stepDownDate} までにお買い上げがない場合、レベルは ${currentTier} から ${nextLowerTier} に下がります。それまでのお買い上げで維持されます。 / Without a purchase by ${stepDownDate}, your level steps down from ${currentTier} to ${nextLowerTier}. Any purchase before then keeps it.`,
      500,
    ),
  };
}

export function buildLevelRestoredNotification(args: {
  oldTier: string;
  newTier: string;
}): NotificationTemplate {
  const { oldTier, newTier } = args;
  const mult = multiplierFor(newTier);
  return {
    title: truncate(`レベルが元に戻りました / Your level is back — ${newTier}`, 100),
    body: truncate(
      `ご購入ありがとうございます。レベルが ${oldTier} から ${newTier} に戻り、ポイント倍率 ${mult}倍が再び適用されます。 / Thank you for your purchase. Your level is back from ${oldTier} to ${newTier}, and your ${mult}x points rate applies again.`,
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
