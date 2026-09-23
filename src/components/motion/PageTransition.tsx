import { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { pageEnter } from '@/theme/motion';

/**
 * Route-change transition: 200ms fade + a damped 8px spring entrance.
 * AppLayout remounts on every route change (each page instantiates it),
 * so a mount animation here fires exactly once per navigation.
 * Reduced motion collapses to fade-only via the app-root <MotionConfig>.
 */
export default function PageTransition({ children }: { children: ReactNode }) {
  return (
    <motion.div variants={pageEnter} initial="initial" animate="animate" className="flex-1 flex flex-col min-w-0">
      {children}
    </motion.div>
  );
}
