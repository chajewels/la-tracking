import { useEffect, useRef, useState } from 'react';
import { animate, useReducedMotion } from 'framer-motion';
import { countUpTransition } from '@/theme/motion';

/**
 * Count-up for bespoke KPI values — mirrors StatCard's count-up semantics
 * exactly: animates 0→value ONCE per mount (ref guard, never on re-render),
 * intermediate frames go through `format`, and on completion the settled
 * text is format(value) so the final rendered string is byte-identical to
 * the unanimated markup. Reduced motion renders the final value immediately.
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
