import { type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { transition } from '@/theme/motion';

interface BulkActionBarProps {
  count: number;
  onClear: () => void;
  /** Action buttons — client-side only (export, copy). Reminder sends and
   *  other edge-function actions are deliberately NOT offered here. */
  children: ReactNode;
}

/**
 * Floating action bar shown while a bulk selection is active.
 * Slides up from the bottom (motion-config standard timing).
 */
export default function BulkActionBar({ count, onClear, children }: BulkActionBarProps) {
  return (
    <AnimatePresence>
      {count > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0, transition: transition.standard }}
          exit={{ opacity: 0, y: 24, transition: transition.micro }}
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 rounded-lg border border-gold-500/40 bg-surface-2/95 px-3 py-2 shadow-xl backdrop-blur-md"
          role="toolbar"
          aria-label="Bulk actions"
        >
          <span className="text-xs font-semibold text-champagne tabular-nums pr-1">
            {count} selected
          </span>
          <span className="w-px h-5 bg-gold-500/40" aria-hidden />
          {children}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={onClear}
            aria-label="Clear selection"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
