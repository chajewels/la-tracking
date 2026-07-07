import { useEffect, useMemo } from 'react';
import { palette } from '@/theme/tokens';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { TIER_STATIC, useLoyaltyData, type TierName } from './loyaltyData';

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

const CONFETTI_COUNT = 14;
const CONFETTI_COLORS = [palette.gold500, palette.gold300, palette.champagne, '#FFFFFF'];

export interface TierCelebrationModalProps {
  tierName: TierName;
  isOpen: boolean;
  onClose: () => void;
  direction?: 'upgrade' | 'downgrade';
}

export function TierCelebrationModal({
  tierName,
  isOpen,
  onClose,
  direction = 'upgrade',
}: TierCelebrationModalProps) {
  const reduce = useReducedMotion();
  const tierStatic = TIER_STATIC[tierName];
  const { tiers } = useLoyaltyData();
  const isUpgrade = direction === 'upgrade';
  const dbTier = tiers.find((t) => t.name === tierName);
  const benefits = dbTier?.benefits ?? tierStatic?.benefits ?? [];

  const confetti = useMemo(
    () =>
      Array.from({ length: CONFETTI_COUNT }, (_, i) => ({
        id: i,
        leftPct: Math.random() * 100,
        delay: Math.random() * 0.6,
        duration: 2.4 + Math.random() * 1.6,
        size: 6 + Math.random() * 6,
        rotate: (Math.random() - 0.5) * 720,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      })),
    [isOpen],
  );

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const tierLetters = useMemo(() => Array.from(tierName), [tierName]);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          key="tier-celebration-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          onClick={onClose}
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          style={{
            background: 'rgba(0,0,0,0.75)',
            backdropFilter: 'blur(4px)',
          }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="tier-celebration-title"
        >
          {!reduce && isUpgrade &&
            confetti.map((c) => (
              <motion.span
                key={c.id}
                initial={{ y: '-10vh', opacity: 0, rotate: 0 }}
                animate={{
                  y: '110vh',
                  opacity: [0, 1, 1, 0],
                  rotate: c.rotate,
                }}
                transition={{
                  duration: c.duration,
                  delay: c.delay,
                  ease: 'easeIn',
                }}
                className="pointer-events-none absolute block rounded-sm"
                style={{
                  left: `${c.leftPct}%`,
                  width: c.size,
                  height: c.size * 0.6,
                  background: c.color,
                  boxShadow: `0 0 6px ${c.color}88`,
                  top: 0,
                }}
                aria-hidden="true"
              />
            ))}

          <motion.div
            key="tier-celebration-card"
            initial={{ opacity: 0, scale: 0.92, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-md rounded-2xl p-7 sm:p-8"
            style={{
              background: P.s,
              border: `1px solid ${P.gp}`,
              boxShadow: `0 12px 48px ${P.gp}55, 0 4px 16px rgba(0,0,0,0.5)`,
            }}
          >
            <div
              className="text-center text-xs"
              style={{ color: P.gl, letterSpacing: '0.28em', textTransform: 'uppercase' }}
            >
              {isUpgrade ? '🎉 Congratulations!' : 'Tier Update'}
            </div>

            <div
              className="mt-3 text-center text-sm italic"
              style={{ color: P.ts, fontFamily: CG }}
            >
              {isUpgrade ? "You've reached" : 'Your tier has been adjusted to'}
            </div>

            <h2
              id="tier-celebration-title"
              className="mt-1 text-center"
              style={{
                fontFamily: CG,
                fontSize: 'clamp(36px, 9vw, 52px)',
                lineHeight: 1.05,
                letterSpacing: '0.04em',
              }}
            >
              {tierLetters.map((ch, i) => (
                <motion.span
                  key={i}
                  initial={reduce ? false : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: 0.15 + i * 0.06 }}
                  style={{
                    background: tierStatic?.textGradient ?? P.gr,
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    display: 'inline-block',
                    whiteSpace: ch === ' ' ? 'pre' : 'normal',
                  }}
                >
                  {ch}
                </motion.span>
              ))}
            </h2>

            {benefits.length > 0 && (
              <motion.ul
                initial={reduce ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.7, duration: 0.4 }}
                className="mx-auto mt-5 max-w-xs space-y-1.5 text-sm"
                style={{ color: P.tp }}
              >
                {benefits.map((b) => (
                  <li key={b} className="flex items-start gap-2">
                    <span style={{ color: P.gl }}>◆</span>
                    <span>{b}</span>
                  </li>
                ))}
              </motion.ul>
            )}

            <div className="mt-6 flex justify-center">
              <Button
                onClick={onClose}
                className="px-8"
                style={{
                  background: P.gr,
                  color: '#1A1500',
                  fontWeight: 600,
                  border: 'none',
                }}
              >
                Continue
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default TierCelebrationModal;
