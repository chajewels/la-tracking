import { Currency } from '@/lib/types';

type CurrencyFilter = Currency | 'ALL';

interface CurrencyToggleProps {
  value: CurrencyFilter;
  onChange: (value: CurrencyFilter) => void;
}

const options: { value: CurrencyFilter; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'PHP', label: '₱ PHP' },
  { value: 'JPY', label: '¥ JPY' },
];

export default function CurrencyToggle({ value, onChange }: CurrencyToggleProps) {
  return (
    <div className="inline-flex items-center rounded-lg border border-border bg-muted p-0.5 gap-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all ${
            value === opt.value
              ? 'bg-card text-card-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export type { CurrencyFilter };
