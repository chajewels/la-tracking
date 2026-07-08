/**
 * Maison motion system — Cha Jewels Customer Portal
 *
 * ALL Portal framer-motion animations import their timings and variants
 * from this module — never from the Hub's src/theme/motion.ts, and never
 * inline one-off durations. framer-motion itself is a shared library
 * dependency (already installed for the Hub); this file is a separate,
 * Portal-owned config, not a re-export.
 *
 * Character: hospitality, not throughput — slightly slower and softer
 * than the ERP's confident-no-bounce posture.
 *
 * Reduced motion: no Portal-wide MotionConfig wrapper exists yet (Phase 1
 * doesn't mount a shared Portal layout shell — CustomerPortal.tsx and
 * LoyaltyPortal.tsx render as standalone routes). Until a shared layout
 * lands in a later phase, every animated Portal component must check
 * `useReducedMotion()` from framer-motion itself and collapse to a fade
 * or the final static value — see AnimatedNumber.tsx for the pattern.
 */
import type { Transition, Variants } from 'framer-motion';

/** Durations in seconds (framer-motion convention). */
export const DURATION = {
  /** hovers, taps, small state changes */
  micro: 0.14,
  /** page transitions, most enter/exit */
  standard: 0.24,
  /** status changes, emphasis moments (payment confirmation glow, etc.) */
  emphasis: 0.4,
  /** points/¥ count-up on first mount */
  countUp: 0.7,
} as const;

/** cubic-bezier(0.22, 1, 0.36, 1) — same confident ease-out curve as the
 *  Hub; only the durations above are slower/softer for Portal. */
export const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

export const transition = {
  micro: { duration: DURATION.micro, ease: EASE } satisfies Transition,
  standard: { duration: DURATION.standard, ease: EASE } satisfies Transition,
  emphasis: { duration: DURATION.emphasis, ease: EASE } satisfies Transition,
} as const;

/** Page transitions: gentle fade + 12px rise (240ms). */
export const pageEnter: Variants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: transition.standard },
};

/** Generic fade-in for async content replacing a skeleton. */
export const fadeIn: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: transition.standard },
  exit: { opacity: 0, transition: transition.micro },
};

/** List/card entrance stagger — e.g. the points ledger, statement list. */
export const ROW_STAGGER_SECONDS = 0.03;
export const ROW_STAGGER_CAP = 10;

export const staggerContainer: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: ROW_STAGGER_SECONDS } },
};

export const staggerItem: Variants = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: transition.standard },
};

/**
 * Per-row delay helper when a variants container isn't practical.
 * Caps the stagger at ROW_STAGGER_CAP rows.
 */
export function rowDelay(index: number): number {
  return Math.min(index, ROW_STAGGER_CAP) * ROW_STAGGER_SECONDS;
}

/**
 * ¥/points count-up config: 700ms ease-out, first mount only. Consumers
 * must guard against re-animation on re-render (ref guard) — see
 * AnimatedNumber.tsx.
 */
export const countUpTransition: Transition = {
  duration: DURATION.countUp,
  ease: 'easeOut',
};
