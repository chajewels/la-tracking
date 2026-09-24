import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Dialog / panel heading in the Deco Ledger style (Hub visual refresh,
 * Phase 2B): the display serif for the title and the 1px gold hairline under
 * the header block. Presentation only — callers keep their own title element
 * (DialogTitle for Radix dialogs, so the accessible name is unchanged) and
 * pass it in; this wraps the icon + title row and the description.
 */
export const decoTitleClass = 'font-deco text-2xl font-semibold leading-tight tracking-tight text-champagne';

export default function DecoDialogHeader({
  icon,
  title,
  description,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5 pb-3 hairline-b', className)}>
      <div className="flex items-center gap-2.5">
        {icon && <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-gold-500/40 bg-gold-500/10 text-gold-300 [&_svg]:h-4 [&_svg]:w-4">{icon}</span>}
        {title}
      </div>
      {description}
    </div>
  );
}
