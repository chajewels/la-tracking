import { useReducedMotion } from 'framer-motion';

/**
 * Uniform recharts animation config — spread onto every animatable series
 * element (Line, Area, Bar, Pie). Draw-in matches the motion system's
 * emphasis timing family and disables entirely under reduced motion.
 */
export function useChartAnimation() {
  const prefersReducedMotion = useReducedMotion();
  return {
    isAnimationActive: !prefersReducedMotion,
    animationDuration: 800,
    animationEasing: 'ease-out' as const,
  };
}
