/**
 * Maps loyalty_transactions rows to the activity items the loyalty screens
 * render (RecentActivity, PointsScreen). Bug #283, 2026-09-17.
 *
 * CUSTOMER view: never renders loyalty_transactions.notes — notes are
 * staff/internal text (UUIDs, enum names, bug references). 0-point member
 * events render as neutral milestones ('enrolled', 'tier_changed'); every
 * other 0-point row is hidden. Point rows show "Invoice #N" or a fixed
 * per-type label.
 * STAFF view (Customer -> Loyalty tab): keeps the note, but a 0-point row is
 * a neutral event, never a red "redeemed 0".
 */
import type { LoyaltyTransactionData } from '@/components/loyalty/loyaltyData';
import { pt } from '@/i18n/portal';

export interface LoyaltyLedgerRow {
  id: string;
  transaction_type: string;
  points_amount: number | null;
  spend_amount_jpy: number | null;
  invoice_number: string | null;
  tier_at_time: string | null;
  notes?: string | null;
  created_at: string;
}

const TYPE_LABEL_KEYS: Record<string, string> = {
  earned: 'loyalty.activityTypeEarned',
  bonus: 'loyalty.activityTypeBonus',
  birthday_bonus: 'loyalty.activityTypeBirthday',
  redeemed: 'loyalty.activityTypeRedeemed',
  expired: 'loyalty.activityTypeExpired',
  adjusted: 'loyalty.activityTypeAdjusted',
  refunded: 'loyalty.activityTypeRefunded',
  revoked: 'loyalty.activityTypeRevoked',
};

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function typeLabel(transactionType: string): string {
  return pt(TYPE_LABEL_KEYS[transactionType] ?? 'loyalty.activityTypeOther');
}

export function toCustomerActivity(tx: LoyaltyLedgerRow): LoyaltyTransactionData | null {
  const points = tx.points_amount ?? 0;
  const date = fmtDate(tx.created_at);
  if (points === 0) {
    if (tx.transaction_type === 'enrolled') {
      return {
        id: tx.id, date, type: 'event', points: 0,
        description: pt('loyalty.activityJoined'),
        source: pt('loyalty.activitySourceMembership'),
        invoice_number: null, spend_amount_jpy: null, tier_multiplier: null,
      };
    }
    if (tx.transaction_type === 'tier_changed') {
      return {
        id: tx.id, date, type: 'event', points: 0,
        description: tx.tier_at_time
          ? pt('loyalty.activityTierNamed', { tier: tx.tier_at_time })
          : pt('loyalty.activityTier'),
        source: pt('loyalty.activitySourceMembership'),
        invoice_number: null, spend_amount_jpy: null, tier_multiplier: null,
      };
    }
    return null;
  }
  return {
    id: tx.id, date,
    type: points > 0 ? 'earned' : 'redeemed',
    points,
    description: tx.invoice_number ? `Invoice #${tx.invoice_number}` : typeLabel(tx.transaction_type),
    source: typeLabel(tx.transaction_type),
    invoice_number: tx.invoice_number ?? null,
    spend_amount_jpy: tx.spend_amount_jpy ?? null,
    tier_multiplier: null,
  };
}

export function toStaffActivity(tx: LoyaltyLedgerRow): LoyaltyTransactionData {
  const points = tx.points_amount ?? 0;
  return {
    id: tx.id,
    date: fmtDate(tx.created_at),
    type: points > 0 ? 'earned' : points < 0 ? 'redeemed' : 'event',
    points,
    description: tx.invoice_number
      ? `Invoice #${tx.invoice_number}`
      : tx.notes ?? tx.transaction_type,
    source: tx.transaction_type,
    invoice_number: tx.invoice_number ?? null,
    spend_amount_jpy: tx.spend_amount_jpy ?? null,
    tier_multiplier: null,
  };
}
