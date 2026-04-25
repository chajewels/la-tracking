import { motion, useReducedMotion } from 'framer-motion';

const CG = "'Cormorant Garamond',Georgia,serif";

const P = {
  s: '#111111',
  s2: '#1A1A1A',
  br: '#2A2200',
  gp: '#C9A84C',
  gl: '#E8C96D',
  tp: '#F5F0E8',
  ts: '#9A8F7E',
  gr: 'linear-gradient(90deg,#C9A84C 0%,#E8C96D 50%,#C9A84C 100%)',
} as const;

const fmtJpy = (n: number) => `¥${Math.round(n).toLocaleString()}`;

export interface TierRow {
  name: string;
  min_spend_jpy: number;
  color_hex: string | null;
}

export interface VipProgressSectionProps {
  currentTierName: string;
  cumulativeSpendJpy: number;
  tiers: TierRow[]; // sorted by min_spend_jpy ASC
}

export function VipProgressSection({
  currentTierName,
  cumulativeSpendJpy,
  tiers,
}: VipProgressSectionProps) {
  const reduce = useReducedMotion();

  const sorted = [...tiers].sort((a, b) => a.min_spend_jpy - b.min_spend_jpy);
  const currentIdx = sorted.findIndex(
    (t) => t.name.toLowerCase() === currentTierName.toLowerCase(),
  );
  const currentTier = currentIdx >= 0 ? sorted[currentIdx] : null;
  const nextTier = currentIdx >= 0 && currentIdx < sorted.length - 1
    ? sorted[currentIdx + 1]
    : null;

  const isMaxTier = currentIdx === sorted.length - 1 && currentIdx >= 0;

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
        Tier Progress
      </div>

      {isMaxTier ? (
        <div className="mt-5 text-center">
          <div className="text-4xl">👑</div>
          <div
            className="mt-2 text-lg sm:text-xl"
            style={{
              fontFamily: CG,
              background: P.gr,
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
            }}
          >
            Maximum Tier Achieved
          </div>
          <div
            className="mt-2 text-xs italic"
            style={{ color: P.ts, fontFamily: CG }}
          >
            Cumulative spend: {fmtJpy(cumulativeSpendJpy)}
          </div>
        </div>
      ) : currentTier && nextTier ? (
        <Progress
          currentTier={currentTier}
          nextTier={nextTier}
          cumulativeSpendJpy={cumulativeSpendJpy}
          reduce={!!reduce}
        />
      ) : (
        <div
          className="mt-5 text-center text-xs italic"
          style={{ color: P.ts }}
        >
          Tier data unavailable
        </div>
      )}
    </div>
  );
}

function Progress({
  currentTier,
  nextTier,
  cumulativeSpendJpy,
  reduce,
}: {
  currentTier: TierRow;
  nextTier: TierRow;
  cumulativeSpendJpy: number;
  reduce: boolean;
}) {
  const span = Math.max(1, nextTier.min_spend_jpy - currentTier.min_spend_jpy);
  const within = Math.max(0, cumulativeSpendJpy - currentTier.min_spend_jpy);
  const pct = Math.min(100, Math.max(0, (within / span) * 100));
  const toNext = Math.max(0, nextTier.min_spend_jpy - cumulativeSpendJpy);

  return (
    <>
      <div className="mt-4 flex items-baseline justify-between text-sm" style={{ color: P.tp }}>
        <div>
          <div
            className="text-[10px]"
            style={{ color: P.ts, letterSpacing: '0.2em', textTransform: 'uppercase' }}
          >
            Current
          </div>
          <div style={{ fontFamily: CG, fontSize: '18px' }}>{currentTier.name}</div>
        </div>
        <div className="text-right">
          <div
            className="text-[10px]"
            style={{ color: P.ts, letterSpacing: '0.2em', textTransform: 'uppercase' }}
          >
            Next
          </div>
          <div style={{ fontFamily: CG, fontSize: '18px', color: P.gl }}>
            {nextTier.name}
          </div>
        </div>
      </div>

      <div
        className="mt-4 flex items-baseline justify-between text-xs"
        style={{ color: P.tp, fontVariantNumeric: 'tabular-nums' }}
      >
        <span>{fmtJpy(cumulativeSpendJpy)} / {fmtJpy(nextTier.min_spend_jpy)}</span>
        <span style={{ color: P.gl }}>{Math.round(pct)}%</span>
      </div>

      <div
        className="mt-2 h-2.5 w-full overflow-hidden rounded-full"
        style={{ background: P.s2, border: `1px solid ${P.br}` }}
      >
        <motion.div
          initial={reduce ? false : { width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 1, ease: 'easeOut' }}
          className="h-full rounded-full"
          style={{ background: P.gr, boxShadow: `0 0 8px ${P.gp}66` }}
        />
      </div>

      <div
        className="mt-3 text-center text-xs italic"
        style={{ color: P.ts, fontFamily: CG }}
      >
        {fmtJpy(toNext)} to {nextTier.name}
      </div>
    </>
  );
}

export default VipProgressSection;
