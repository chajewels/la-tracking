import { memo, useMemo } from 'react';
import { cn } from '@/lib/utils';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const SPECIAL = '#';

interface AlphabetNavProps {
  customers: { full_name: string }[];
  activeLetter: string | null;
  onSelect: (letter: string | null) => void;
  viewMode: 'all' | 'filter' | 'grouped';
}

function getLetterCounts(customers: { full_name: string }[]) {
  const counts: Record<string, number> = {};
  for (const c of customers) {
    const first = c.full_name.charAt(0).toUpperCase();
    const key = /[A-Z]/.test(first) ? first : SPECIAL;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

const AlphabetNav = memo(function AlphabetNav({ customers, activeLetter, onSelect, viewMode }: AlphabetNavProps) {
  const counts = useMemo(() => getLetterCounts(customers), [customers]);

  const allLetters = [...LETTERS, SPECIAL];

  if (viewMode === 'all') return null;

  return (
    <div className="sticky top-0 z-20 bg-background/80 backdrop-blur-md hairline-b py-3">
      <div className="flex flex-wrap gap-1.5 justify-center px-2">
        {allLetters.map(letter => {
          const count = counts[letter] || 0;
          const isActive = activeLetter === letter;
          return (
            <button
              key={letter}
              onClick={() => onSelect(isActive ? null : letter)}
              disabled={count === 0 && viewMode === 'filter'}
              className={cn(
                'relative flex flex-col items-center justify-center min-w-[2.25rem] h-9 rounded-full font-deco text-sm font-semibold transition-all duration-200',
                // Lift only for a fine pointer, and never under reduced motion.
                'motion-safe:[@media(hover:hover)_and_(pointer:fine)]:hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                isActive
                  ? 'border border-gold-500/70 bg-gold-500/15 text-gold-300 shadow-[0_0_12px_hsl(var(--gold-500)/0.25)]'
                  : count > 0
                    ? 'bg-card border border-gold-500/15 text-card-foreground hover:border-gold-500/50 hover:text-gold-300'
                    : 'bg-muted/30 text-muted-foreground/40 cursor-not-allowed'
              )}
            >
              <span>{letter}</span>
              {count > 0 && (
                <span className={cn(
                  'absolute -top-1.5 -right-1 font-sans text-[9px] font-bold rounded-full min-w-[16px] h-4 flex items-center justify-center px-1',
                  isActive ? 'bg-gold-500 text-primary-foreground' : 'bg-gold-500/20 text-gold-300'
                )}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
});

export default AlphabetNav;
export { getLetterCounts, LETTERS, SPECIAL };
