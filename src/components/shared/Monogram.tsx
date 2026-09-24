import { cn } from '@/lib/utils';
import { initialsOf } from '@/lib/initials';

/** Gold monogram disc used in the account / cash-order header cards. */
export default function Monogram({ name, className }: { name: string | null | undefined; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex h-14 w-14 sm:h-16 sm:w-16 shrink-0 items-center justify-center rounded-full border border-gold-500/60 bg-gradient-to-br from-gold-500/25 via-gold-500/5 to-transparent font-deco text-2xl sm:text-[1.7rem] font-semibold text-gold-300 shadow-[inset_0_0_0_4px_hsl(var(--surface-1)),inset_0_0_0_5px_hsl(var(--gold-500)/0.35)]',
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  );
}
