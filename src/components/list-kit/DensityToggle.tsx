import { useState, useCallback } from 'react';
import { Rows3, Rows4 } from 'lucide-react';
import { Button } from '@/components/ui/button';

export type Density = 'comfortable' | 'compact';

/**
 * Density preference persisted per storage key (one key per surface so the
 * Layaway list and a data table can differ). Defaults to comfortable.
 */
export function useDensity(storageKey: string): [Density, (d: Density) => void] {
  const [density, setDensityState] = useState<Density>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw === 'compact' ? 'compact' : 'comfortable';
    } catch {
      return 'comfortable';
    }
  });
  const setDensity = useCallback(
    (d: Density) => {
      setDensityState(d);
      try {
        localStorage.setItem(storageKey, d);
      } catch {
        /* private mode — preference just doesn't persist */
      }
    },
    [storageKey],
  );
  return [density, setDensity];
}

export default function DensityToggle({
  value,
  onChange,
}: {
  value: Density;
  onChange: (d: Density) => void;
}) {
  const next: Density = value === 'comfortable' ? 'compact' : 'comfortable';
  const Icon = value === 'comfortable' ? Rows3 : Rows4;
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-9 gap-1.5 text-xs"
      onClick={() => onChange(next)}
      title={`Switch to ${next} density`}
      aria-label={`Density: ${value}. Switch to ${next}.`}
    >
      <Icon className="h-3.5 w-3.5" />
      <span className="hidden sm:inline capitalize">{value}</span>
    </Button>
  );
}
