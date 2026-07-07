import { forwardRef, useId, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * Floating-label input. PRESENTATION-LAYER ONLY: the `error` prop is a
 * display hint mirroring rules the form's submit handler already enforces
 * — it never blocks submission or changes validation behavior. Wire it
 * from an onBlur check in the consuming form.
 */
interface FloatingFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string | null;
  hint?: string;
}

const FloatingField = forwardRef<HTMLInputElement, FloatingFieldProps>(
  ({ label, error, hint, className, id: idProp, ...props }, ref) => {
    const autoId = useId();
    const id = idProp ?? autoId;
    return (
      <div className="space-y-1">
        <div className="relative">
          <input
            ref={ref}
            id={id}
            placeholder=" "
            aria-invalid={!!error}
            aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
            className={cn(
              'peer h-12 w-full rounded-md border bg-input px-3 pt-4 pb-1 text-sm text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
              'disabled:cursor-not-allowed disabled:opacity-50',
              error ? 'border-danger/60' : 'border-border',
              className,
            )}
            {...props}
          />
          <label
            htmlFor={id}
            className={cn(
              'pointer-events-none absolute left-3 transition-all duration-150',
              // floated (focused or has value)
              'top-1.5 text-[10px] uppercase tracking-[0.08em]',
              // resting (empty + unfocused)
              'peer-placeholder-shown:top-3.5 peer-placeholder-shown:text-sm peer-placeholder-shown:normal-case peer-placeholder-shown:tracking-normal',
              'peer-focus:top-1.5 peer-focus:text-[10px] peer-focus:uppercase peer-focus:tracking-[0.08em]',
              error ? 'text-danger' : 'text-muted-foreground peer-focus:text-gold-300',
            )}
          >
            {label}
          </label>
        </div>
        {error ? (
          <p id={`${id}-error`} className="text-[11px] text-danger">{error}</p>
        ) : hint ? (
          <p id={`${id}-hint`} className="text-[11px] text-muted-foreground">{hint}</p>
        ) : null}
      </div>
    );
  },
);
FloatingField.displayName = 'FloatingField';

export default FloatingField;
