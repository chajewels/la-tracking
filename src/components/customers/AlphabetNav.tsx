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
    <div className="sticky top-0 z-20 bg-background/80 backdrop-blur-md border-b border-border py-3">
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
                'relative flex flex-col items-center justify-center min-w-[2.25rem] h-9 rounded-full text-xs font-semibold transition-all duration-200',
                'hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                isActive
                  ? 'gold-gradient text-primary-foreground shadow-lg shadow-primary/30'
                  : count > 0
                    ? 'bg-card border border-border text-card-foreground hover:border-primary/50 hover:text-primary'
                    : 'bg-muted/30 text-muted-foreground/40 cursor-not-allowed'
              )}
            >
              <span>{letter}</span>
              {count > 0 && (
                <span className={cn(
                  'absolute -top-1.5 -right-1 text-[9px] font-bold rounded-full min-w-[16px] h-4 flex items-center justify-center px-1',
                  isActive ? 'bg-background text-primary' : 'bg-primary/20 text-primary'
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
