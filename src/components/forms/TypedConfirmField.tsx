import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';

/**
 * Typed-confirmation gate for destructive actions. Embeds inside an
 * EXISTING confirmation dialog and arms/disarms the dialog's existing
 * action button — it never changes what the mutation does, its payload,
 * or who can call it (permission gates stay wherever they already are).
 * Traceability is a feature: pair with the dialog's existing reason
 * field where one exists.
 */
interface TypedConfirmFieldProps {
  /** The word the user must type exactly (e.g. "VOID", an invoice #). */
  word: string;
  onArmedChange: (armed: boolean) => void;
  /** Optional custom prompt; defaults to Type WORD to confirm. */
  prompt?: string;
}

export default function TypedConfirmField({ word, onArmedChange, prompt }: TypedConfirmFieldProps) {
  const [value, setValue] = useState('');

  useEffect(() => {
    onArmedChange(value.trim() === word);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, word]);

  // Reset when the required word changes (dialog reused for another target).
  useEffect(() => {
    setValue('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [word]);

  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">
        {prompt ?? (
          <>
            Type <span className="font-mono font-semibold text-danger">{word}</span> to confirm — this
            action is recorded with your name and timestamp.
          </>
        )}
      </p>
      <Input
        value={value}
        onChange={e => setValue(e.target.value)}
        placeholder={word}
        autoComplete="off"
        spellCheck={false}
        className="h-9 font-mono text-sm"
        aria-label={`Type ${word} to confirm`}
      />
    </div>
  );
}
