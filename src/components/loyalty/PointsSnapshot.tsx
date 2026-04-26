import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { useLoyaltyData } from './loyaltyData';

const CG = "'Cormorant Garamond',Georgia,serif";

const P = {
  s: '#111111',
  s2: '#1A1A1A',
  br: '#2A2200',
  gp: '#C9A84C',
  gl: '#E8C96D',
  tp: '#F5F0E8',
  ts: '#9A8F7E',
  gr: 'linear-gradient(135deg,#C9A84C 0%,#E8C96D 50%,#C9A84C 100%)',
} as const;

function useCountUp(target: number, durationMs = 1200, enabled = true) {
  const [value, setValue] = useState(enabled ? 0 : target);
  useEffect(() => {
    if (!enabled) {
      setValue(target);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(target * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs, enabled]);
  return value;
}

export function PointsSnapshot() {
  const { member } = useLoyaltyData();
  const reduce = useReducedMotion();

  const remaining = member?.available_points ?? 0;
  const earned = member?.lifetime_points_earned ?? 0;
  const redeemed = member?.redeemed_points ?? 0;
  const multiplier = member?.current_multiplier ?? 1;

  const animated = useCountUp(remaining, 1200, !reduce);

  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
      className="mx-auto w-full max-w-md rounded-2xl p-6 sm:p-8"
      style={{
        background: P.s,
        border: `1px solid ${P.gp}55`,
        boxShadow: `0 4px 24px ${P.gp}22`,
      }}
    >
      <div
        className="text-center text-xs"
        style={{ color: P.ts, letterSpacing: '0.22em', textTransform: 'uppercase' }}
      >
        Your Points
      </div>

      <div className="mt-4 text-center">
        <div
          style={{
            fontFamily: CG,
            fontSize: 'clamp(48px, 12vw, 72px)',
            lineHeight: 1,
            background: P.gr,
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            fontWeight: 600,
            letterSpacing: '0.02em',
          }}
        >
          {animated.toLocaleString()}
        </div>
        <div
          className="mt-1 text-sm italic"
          style={{ color: P.ts, fontFamily: CG }}
        >
          points available
        </div>
        {multiplier > 1 && (
          <div
            className="mt-2 text-[11px]"
            style={{ color: P.gl, letterSpacing: '0.18em', textTransform: 'uppercase' }}
          >
            {multiplier}× earn rate active
          </div>
        )}
      </div>

      <div
        className="my-5 h-px w-full"
        style={{
          background: `linear-gradient(90deg, transparent 0%, ${P.br} 50%, transparent 100%)`,
        }}
      />

      <div className="space-y-1.5 text-sm" style={{ color: P.tp }}>
        <Row label="Total Earned" value={earned.toLocaleString()} />
        <Row label="Total Redeemed" value={redeemed.toLocaleString()} />
      </div>
    </motion.div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span style={{ color: P.ts }}>{label}</span>
      <span style={{ color: P.tp, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

export default PointsSnapshot;
