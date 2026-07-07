import { motion } from 'framer-motion';
import { ArrowUpDown, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { transition } from '@/theme/motion';

export interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

export interface SortOption {
  key: string;
  label: string;
}

interface SortMenuProps {
  options: SortOption[];
  value: SortState | null;
  onChange: (next: SortState | null) => void;
}

/**
 * List sort control: pick a field, click again to flip direction,
 * "Default order" restores the list's natural ordering.
 * The direction chevron rotates with the motion-config micro timing.
 */
export default function SortMenu({ options, value, onChange }: SortMenuProps) {
  const activeLabel = value ? options.find(o => o.key === value.key)?.label : null;

  const pick = (key: string) => {
    if (!value || value.key !== key) onChange({ key, dir: 'asc' });
    else if (value.dir === 'asc') onChange({ key, dir: 'desc' });
    else onChange(null);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 gap-1.5 text-xs">
          <ArrowUpDown className="h-3.5 w-3.5" />
          {activeLabel ? (
            <span className="flex items-center gap-1">
              {activeLabel}
              <motion.span
                animate={{ rotate: value?.dir === 'asc' ? 180 : 0 }}
                transition={transition.micro}
                className="inline-block text-gold-300"
              >
                ▾
              </motion.span>
            </span>
          ) : (
            'Sort'
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        <DropdownMenuLabel className="label-caps">Sort by</DropdownMenuLabel>
        {options.map(o => (
          <DropdownMenuItem key={o.key} onClick={() => pick(o.key)} className="text-xs justify-between">
            {o.label}
            {value?.key === o.key && (
              <span className="text-gold-300 text-[10px]">{value.dir === 'asc' ? '↑ asc' : '↓ desc'}</span>
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onChange(null)} className="text-xs justify-between">
          Default order
          {!value && <Check className="h-3 w-3 text-gold-300" />}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Shared comparator: sorts a copy of `rows` by the accessor for `sort.key`. */
export function sortRows<T>(
  rows: T[],
  sort: SortState | null,
  accessors: Record<string, (row: T) => string | number | null | undefined>,
): T[] {
  if (!sort) return rows;
  const acc = accessors[sort.key];
  if (!acc) return rows;
  const mul = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = acc(a);
    const vb = acc(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mul;
    return String(va).localeCompare(String(vb)) * mul;
  });
}
