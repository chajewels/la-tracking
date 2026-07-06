/**
 * Deco Ledger motion system — Cha Jewels Hub
 *
 * ALL framer-motion animations import their timings and variants from this
 * module. No inline one-off durations anywhere in the app.
 *
 * Character: confident, no bounce — this is a financial system.
 * Reduced motion: the app root wraps everything in
 * <MotionConfig reducedMotion="user">, so transform/layout animations
 * collapse automatically for users who prefer reduced motion; opacity
 * fades remain.
 */
import type { Transition, Variants } from 'framer-motion';

/** Durations in seconds (framer-motion convention). */
export const DURATION = {
  /** hovers, row highlights, chevrons */
  micro: 0.12,
  /** page transitions, most enter/exit */
  standard: 0.2,
  /** status changes, emphasis moments */
  emphasis: 0.32,
  /** KPI count-up on first mount */
  countUp: 0.6,
} as const;

/** cubic-bezier(0.22, 1, 0.36, 1) — confident ease-out, no bounce. */
export const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

export const transition = {
  micro: { duration: DURATION.micro, ease: EASE } satisfies Transition,
  standard: { duration: DURATION.standard, ease: EASE } satisfies Transition,
  emphasis: { duration: DURATION.emphasis, ease: EASE } satisfies Transition,
} as const;

/** Page transitions: fade + 8px upward slide on route change. */
export const pageEnter: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: transition.standard },
};

/** Generic fade-in for async content replacing a skeleton. */
export const fadeIn: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: transition.standard },
  exit: { opacity: 0, transition: transition.micro },
};

/** Table row entrance stagger: 20ms/row, capped at 10 rows. */
export const ROW_STAGGER_SECONDS = 0.02;
export const ROW_STAGGER_CAP = 10;

export const staggerContainer: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: ROW_STAGGER_SECONDS } },
};

/** Child of staggerContainer — rows, cards, form fields. */
export const staggerItem: Variants = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0, transition: transition.standard },
};

/**
 * Per-row delay helper when a variants container isn't practical
 * (e.g. plain <tr> mapping). Caps the stagger at ROW_STAGGER_CAP rows.
 */
export function rowDelay(index: number): number {
  return Math.min(index, ROW_STAGGER_CAP) * ROW_STAGGER_SECONDS;
}

/** Drawer slides from the right (280ms) with backdrop fade. */
export const drawerRight: Variants = {
  initial: { x: '100%' },
  animate: { x: 0, transition: { duration: 0.28, ease: EASE } },
  exit: { x: '100%', transition: { duration: 0.28, ease: EASE } },
};

export const backdropFade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: transition.standard },
  exit: { opacity: 0, transition: transition.standard },
};

/** Form fields inside modals/drawers stagger 30ms. */
export const FIELD_STAGGER_SECONDS = 0.03;

export const fieldStaggerContainer: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: FIELD_STAGGER_SECONDS } },
};

/**
 * Status-change pulse: single 320ms color crossfade + subtle scale pulse
 * (1 → 1.04 → 1). Trigger by re-keying the badge on status value.
 */
export const statusPulse: Variants = {
  initial: { scale: 1 },
  animate: {
    scale: [1, 1.04, 1],
    transition: { duration: DURATION.emphasis, ease: EASE },
  },
};

/**
 * KPI count-up config: 600ms ease-out, first mount only.
 * Consumers must guard against re-animation on re-render
 * (e.g. animate a motion value once inside useEffect with an empty
 * dependency list, or track a `hasAnimated` ref).
 */
export const countUpTransition: Transition = {
  duration: DURATION.countUp,
  ease: 'easeOut',
};
