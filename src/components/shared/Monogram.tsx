import { cn } from '@/lib/utils';
import { initialsOf } from '@/lib/initials';

const sizes = {
  // Account / cash-order / customer header cards.
  md: 'h-14 w-14 sm:h-16 sm:w-16 text-2xl sm:text-[1.7rem] shadow-[inset_0_0_0_4px_hsl(var(--surface-1)),inset_0_0_0_5px_hsl(var(--gold-500)/0.35)]',
  // Ledger rows and list cards (Customers directory).
  sm: 'h-9 w-9 text-sm shadow-[inset_0_0_0_2px_hsl(var(--surface-1)),inset_0_0_0_3px_hsl(var(--gold-500)/0.3)]',
};

/** Gold monogram disc: header cards (md) and the customer directory's rows and cards (sm). */
export default function Monogram({ name, size = 'md', className }: { name: string | null | undefined; size?: 'sm' | 'md'; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full border border-gold-500/60 bg-gradient-to-br from-gold-500/25 via-gold-500/5 to-transparent font-deco font-semibold text-gold-300',
        sizes[size],
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  );
}
