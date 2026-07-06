import { forwardRef, useCallback, useEffect, useState, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { Currency } from '@/lib/types';

/**
 * Currency amount input that auto-formats with thousands separators as
 * the user types, showing the native symbol. DISPLAY-LAYER ONLY: it emits
 * the same plain numeric value (via onValueChange) the forms already
 * consume — no rounding, no conversion, no business math. JPY input
 * disallows decimals (fractional yen are never displayed per the money
 * rules); PHP allows up to 2.
 */
interface CurrencyInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  currency: Currency;
  value: number | '';
  onValueChange: (value: number | '') => void;
  label?: string;
  error?: string | null;
  hint?: string;
}

function formatDisplay(raw: string, currency: Currency): string {
  if (raw === '') return '';
  const [intPart, decPart] = raw.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (currency === 'JPY') return grouped;
  return decPart !== undefined ? `${grouped}.${decPart}` : grouped;
}

/** Strip formatting → canonical numeric string ('' when empty). */
function sanitize(text: string, currency: Currency): string {
  let s = text.replace(/[^\d.]/g, '');
  if (currency === 'JPY') return s.replace(/\./g, '');
  const firstDot = s.indexOf('.');
  if (firstDot !== -1) {
    s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, '');
    const [i, d] = s.split('.');
    s = `${i}.${(d ?? '').slice(0, 2)}`;
  }
  return s;
}

const CurrencyInput = forwardRef<HTMLInputElement, CurrencyInputProps>(
  ({ currency, value, onValueChange, label, error, hint, className, id, ...props }, ref) => {
    const [text, setText] = useState<string>(value === '' ? '' : String(value));

    // Sync external value changes (e.g. form reset) into the display.
    useEffect(() => {
      const current = sanitize(text, currency);
      const currentNum = current === '' || current === '.' ? '' : Number(current);
      if (value !== currentNum) setText(value === '' ? '' : String(value));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value, currency]);

    const handleChange = useCallback(
      (raw: string) => {
        const clean = sanitize(raw, currency);
        setText(clean);
        if (clean === '' || clean === '.') onValueChange('');
        else onValueChange(Number(clean));
      },
      [currency, onValueChange],
    );

    const symbol = currency === 'JPY' ? '¥' : '₱';
    const display = formatDisplay(text, currency);

    return (
      <div className="space-y-1">
        {label && (
          <label htmlFor={id} className="label-caps block">
            {label}
          </label>
        )}
        <div className="relative">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
            {symbol}
          </span>
          <input
            ref={ref}
            id={id}
            type="text"
            inputMode="decimal"
            value={display}
            onChange={e => handleChange(e.target.value)}
            aria-invalid={!!error}
            className={cn(
              'h-11 w-full rounded-md border bg-input pl-8 pr-3 text-sm text-foreground tabular-nums text-right',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
              'disabled:cursor-not-allowed disabled:opacity-50',
              error ? 'border-danger/60' : 'border-border',
              className,
            )}
            {...props}
          />
        </div>
        {/* A whitespace-only error tints the border without a message
            (used when the form renders its own detailed message below). */}
        {error && error.trim() ? (
          <p className="text-[11px] text-danger">{error}</p>
        ) : hint ? (
          <p className="text-[11px] text-muted-foreground">{hint}</p>
        ) : null}
      </div>
    );
  },
);
CurrencyInput.displayName = 'CurrencyInput';

export default CurrencyInput;
