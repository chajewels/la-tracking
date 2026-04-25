import { motion } from 'framer-motion';

const CG = "'Cormorant Garamond',Georgia,serif";

const P = {
  s: '#111111',
  s2: '#1A1A1A',
  br: '#2A2200',
  gp: '#C9A84C',
  gl: '#E8C96D',
  tp: '#F5F0E8',
  ts: '#9A8F7E',
} as const;

const POSITIVE = '#D4AF37';
const NEGATIVE = '#B85450';

const TIER_MULTIPLIER: Record<string, number> = {
  glimmer: 1,
  radiant: 1.5,
  elite: 2,
  'crown vip': 3,
};

export type LoyaltyTransactionType =
  | 'earned'
  | 'bonus'
  | 'redeemed'
  | 'expired'
  | 'adjusted';

export interface LoyaltyTxRow {
  id: string;
  transaction_type: LoyaltyTransactionType;
  points_amount: number;
  spend_amount_jpy: number | null;
  invoice_number: string | null;
  tier_at_time: string | null;
  notes: string | null;
  created_at: string;
}

export interface RecentActivityProps {
  transactions: LoyaltyTxRow[];
  maxItems?: number;
  onViewAll?: () => void;
}

const fmtDayHeader = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
const ymd = (iso: string) => new Date(iso).toISOString().split('T')[0];

const extractAfterPrefix = (notes: string | null, prefix: string) => {
  if (!notes) return null;
  return notes.startsWith(prefix) ? notes.slice(prefix.length).trim() : null;
};

interface EventMeta {
  icon: string;
  title: string;
  /** Parts rendered after the points pill, joined with " · ". */
  suffix: string[];
}

function eventMeta(tx: LoyaltyTxRow): EventMeta {
  switch (tx.transaction_type) {
    case 'earned': {
      const tierName = tx.tier_at_time?.trim() || '';
      const mult = TIER_MULTIPLIER[tierName.toLowerCase()];
      const tierTag = tierName
        ? mult != null
          ? `${tierName} ${mult}x`
          : tierName
        : '';
      const inv = tx.invoice_number ? `INV #${tx.invoice_number}` : '';
      return {
        icon: '✨',
        title: 'Points Earned',
        suffix: [inv, tierTag].filter(Boolean),
      };
    }
    case 'bonus': {
      const promoName = extractAfterPrefix(tx.notes, 'Promo:') ?? tx.notes ?? '';
      return {
        icon: '🎁',
        title: 'Promo Bonus',
        suffix: promoName ? [`"${promoName}"`] : [],
      };
    }
    case 'redeemed': {
      const redemptionType = extractAfterPrefix(tx.notes, 'Redemption:');
      const inv = tx.invoice_number ? `INV #${tx.invoice_number}` : '';
      return {
        icon: '💎',
        title: 'Points Redeemed',
        suffix: [inv, redemptionType ?? ''].filter(Boolean),
      };
    }
    case 'expired':
      return {
        icon: '⏰',
        title: 'Points Expired',
        suffix: ['6 months inactivity'],
      };
    case 'adjusted':
      return {
        icon: '⚙️',
        title: 'Points Adjusted',
        suffix: tx.notes ? [tx.notes] : [],
      };
  }
}

const fmtSignedPts = (n: number) =>
  `${n > 0 ? '+' : ''}${n.toLocaleString()} pts`;

export function RecentActivity({
  transactions,
  maxItems = 10,
  onViewAll,
}: RecentActivityProps) {
  const sorted = [...transactions].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  const visible = sorted.slice(0, maxItems);
  const overflow = Math.max(0, sorted.length - visible.length);

  // Group consecutive same-day rows under one date header.
  const groups: Array<{ day: string; rows: LoyaltyTxRow[] }> = [];
  for (const tx of visible) {
    const day = ymd(tx.created_at);
    const tail = groups[groups.length - 1];
    if (tail && tail.day === day) tail.rows.push(tx);
    else groups.push({ day, rows: [tx] });
  }

  return (
    <div
      className="mx-auto w-full max-w-md rounded-2xl p-6 sm:p-8"
      style={{
        background: P.s,
        border: `1px solid ${P.br}`,
        boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
      }}
    >
      <div
        className="text-center text-xs"
        style={{ color: P.ts, letterSpacing: '0.22em', textTransform: 'uppercase' }}
      >
        Recent Activity
      </div>

      {visible.length === 0 ? (
        <p
          className="mt-6 text-center text-sm italic"
          style={{ color: P.ts, fontFamily: CG }}
        >
          No activity yet — your first purchase will appear here once you earn
          points!
        </p>
      ) : (
        <div className="relative mt-5 pl-4">
          {/* Left-side accent rail */}
          <div
            className="pointer-events-none absolute left-0 top-1 bottom-1 w-px"
            style={{ background: P.br }}
          />
          {groups.map((g, gi) => (
            <div key={g.day} className={gi > 0 ? 'mt-4' : ''}>
              <div
                className="mb-2 text-[11px]"
                style={{ color: P.ts, letterSpacing: '0.12em' }}
              >
                📅 {fmtDayHeader(g.rows[0].created_at)}
              </div>
              <ul className="space-y-2">
                {g.rows.map((tx, idx) => (
                  <Row key={tx.id} tx={tx} index={idx} />
                ))}
              </ul>
            </div>
          ))}

          {overflow > 0 && (
            <div className="mt-5 text-center text-xs" style={{ color: P.ts }}>
              {onViewAll ? (
                <button
                  onClick={onViewAll}
                  className="underline-offset-2 hover:underline"
                  style={{ color: P.gl }}
                >
                  + {overflow} more event{overflow === 1 ? '' : 's'}
                </button>
              ) : (
                <span>+ {overflow} more event{overflow === 1 ? '' : 's'}</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ tx, index }: { tx: LoyaltyTxRow; index: number }) {
  const meta = eventMeta(tx);
  const isPositive = tx.points_amount > 0;
  const amountColor = isPositive ? POSITIVE : NEGATIVE;

  return (
    <motion.li
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.25, delay: index * 0.04 }}
      className="rounded-md px-3 py-2 transition-colors"
      style={{ background: 'transparent' }}
      onMouseEnter={(e) => (e.currentTarget.style.background = P.s2)}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <div className="flex items-baseline gap-2">
        <span aria-hidden="true">{meta.icon}</span>
        <span
          className="text-sm"
          style={{ color: P.tp, fontFamily: CG, letterSpacing: '0.02em' }}
        >
          {meta.title}
        </span>
      </div>
      <div
        className="mt-0.5 pl-6 text-xs"
        style={{ color: P.ts, fontVariantNumeric: 'tabular-nums' }}
      >
        <span style={{ color: amountColor, fontWeight: 600 }}>
          {fmtSignedPts(tx.points_amount)}
        </span>
        {meta.suffix.length > 0 && (
          <span style={{ color: P.ts }}> · {meta.suffix.join(' · ')}</span>
        )}
      </div>
    </motion.li>
  );
}

export default RecentActivity;
