/** Semantic tones for StatusPill — each maps to an existing colour token. */
export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'gold' | 'muted';

/** Layaway account_status → tone. Unknown statuses fall back to muted. */
export const ACCOUNT_STATUS_TONE: Record<string, StatusTone> = {
  active: 'success',
  overdue: 'danger',
  completed: 'gold',
  grace_period: 'warning',
  cancelled: 'muted',
  forfeited: 'warning',
  extension_active: 'info',
  final_forfeited: 'danger',
  final_settlement: 'warning',
  reactivated: 'info',
};

/**
 * cash_orders.status → tone. Same meaning-to-colour mapping as layaway:
 * finished = gold, waiting = warning, lapsed = danger, void = muted.
 */
export const CASH_ORDER_STATUS_TONE: Record<string, StatusTone> = {
  pending: 'warning',
  completed: 'gold',
  expired: 'danger',
  cancelled: 'muted',
};
