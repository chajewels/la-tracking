import { motion } from 'framer-motion';
import { useLoyaltyData, type LoyaltyTransactionData } from './loyaltyData';

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

interface EventMeta {
  icon: string;
  title: string;
}

function eventMeta(tx: LoyaltyTransactionData): EventMeta {
  switch (tx.source) {
    case 'bonus':
      return { icon: '🎁', title: 'Promo Bonus' };
    case 'expired':
      return { icon: '⏰', title: 'Points Expired' };
    case 'adjusted':
      return { icon: '⚙️', title: 'Points Adjusted' };
    case 'redeemed':
      return { icon: '💎', title: 'Points Redeemed' };
    case 'earned':
    default:
      return tx.type === 'redeemed'
        ? { icon: '💎', title: 'Points Redeemed' }
        : { icon: '✨', title: 'Points Earned' };
  }
}

const fmtSignedPts = (n: number) =>
  `${n > 0 ? '+' : ''}${n.toLocaleString()} pts`;

export function RecentActivity() {
  const { transactions } = useLoyaltyData();

  // Group consecutive same-day rows under one date header.
  const groups: Array<{ day: string; rows: LoyaltyTransactionData[] }> = [];
  for (const tx of transactions) {
    const day = tx.date;
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

      {transactions.length === 0 ? (
        <p
          className="mt-6 text-center text-sm italic"
          style={{ color: P.ts, fontFamily: CG }}
        >
          No activity yet — your first purchase will appear here once you earn
          points!
        </p>
      ) : (
        <div className="relative mt-5 pl-4">
          <div
            className="pointer-events-none absolute left-0 top-1 bottom-1 w-px"
            style={{ background: P.br }}
          />
          {groups.map((g, gi) => (
            <div key={`${g.day}-${gi}`} className={gi > 0 ? 'mt-4' : ''}>
              <div
                className="mb-2 text-[11px]"
                style={{ color: P.ts, letterSpacing: '0.12em' }}
              >
                📅 {g.day}
              </div>
              <ul className="space-y-2">
                {g.rows.map((tx, idx) => (
                  <Row key={tx.id} tx={tx} index={idx} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ tx, index }: { tx: LoyaltyTransactionData; index: number }) {
  const meta = eventMeta(tx);
  const isPositive = tx.points > 0;
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
          {fmtSignedPts(tx.points)}
        </span>
        {tx.description && (
          <span style={{ color: P.ts }}> · {tx.description}</span>
        )}
      </div>
    </motion.li>
  );
}

export default RecentActivity;
