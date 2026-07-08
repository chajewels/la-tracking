import { useEffect, useRef, useState } from 'react';
import { animate, useReducedMotion } from 'framer-motion';
import { countUpTransition } from '@/theme/portal-motion';

/**
 * The ONE count-up component for the Customer Portal — every counted KPI
 * value (points balance, ¥ amounts, % paid) reuses this; never hand-roll
 * count-up logic per screen. Mirrors the Hub's AnimatedNumber semantics
 * exactly (src/components/shared/AnimatedNumber.tsx) but draws timing
 * from portal-motion.ts, not the Hub's motion.ts — separate token source.
 *
 * KPI value definition (apply consistently across the Portal): a KPI
 * value is the primary headline figure of a titled card — points
 * balance, remaining balance, % paid. Table/ledger rows, list items, and
 * footnote figures are NOT KPI values and never count up.
 *
 * Animates 0→value ONCE per mount (ref guard, never on re-render);
 * intermediate frames go through `format`, and the settled text is
 * format(value) — byte-identical to the unanimated markup. Reduced
 * motion renders the final value immediately.
 */
interface AnimatedNumberProps {
  value: number;
  format?: (n: number) => string;
  className?: string;
}

const defaultFormat = (n: number) => Math.round(n).toLocaleString('en-US');

export default function AnimatedNumber({ value, format, className }: AnimatedNumberProps) {
  const prefersReducedMotion = useReducedMotion();
  const [frame, setFrame] = useState<string | null>(null);
  const hasAnimatedRef = useRef(false);

  useEffect(() => {
    if (hasAnimatedRef.current || prefersReducedMotion) return;
    hasAnimatedRef.current = true;
    const fmt = format ?? defaultFormat;
    const controls = animate(0, value, {
      ...countUpTransition,
      onUpdate: (v) => setFrame(fmt(v)),
      onComplete: () => setFrame(null),
    });
    return () => controls.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fmt = format ?? defaultFormat;
  return <span className={className}>{frame ?? fmt(value)}</span>;
}
