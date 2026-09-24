import { cn } from '@/lib/utils';

/**
 * Original gold line illustrations for empty / loading states (Hub visual
 * refresh). Hand-drawn inline SVG — no external asset — stroked in the gold
 * token via currentColor, so they sit on any surface. Purely decorative:
 * aria-hidden, the one line of text beside them carries the meaning.
 *
 *   ledger — an open ledger book with a faceted gem resting on the page
 *   gem    — a single faceted gem (loading / "nothing yet")
 *   scroll — a receipt ribbon with a gem clasp (payments)
 */
export type IllustrationKind = 'ledger' | 'gem' | 'scroll';

function Paths({ kind }: { kind: IllustrationKind }) {
  if (kind === 'gem') {
    return (
      <>
        <path d="M40 22h40l14 16-34 44-34-44z" />
        <path d="M26 38h68M40 22l8 16 12-16 12 16 8-16M48 38l12 44 12-44" />
        <path d="M98 20l3-6 3 6-3 6z M18 60l2-4 2 4-2 4z" strokeWidth={1} />
      </>
    );
  }
  if (kind === 'scroll') {
    return (
      <>
        <path d="M34 18h52v70l-6-5-7 5-7-5-6 5-7-5-6 5-7-5-6 5z" />
        <path d="M44 34h32M44 44h24M44 54h28M44 64h18" strokeWidth={1} />
        <path d="M60 86l-8 8 8 10 8-10z" />
        <path d="M94 26l3-6 3 6-3 6z" strokeWidth={1} />
      </>
    );
  }
  return (
    <>
      <path d="M12 34c14-6 32-6 48 4 16-10 34-10 48-4v52c-14-6-32-6-48 4-16-10-34-10-48-4z" />
      <path d="M60 38v52" />
      <path d="M22 48c10-3 20-3 28 1M22 58c10-3 20-3 28 1M22 68c10-3 20-3 28 1" strokeWidth={1} />
      <path d="M76 44h20l6 7-16 19-16-19z M70 51h32 M80 44l6 26 6-26" />
      <path d="M100 22l3-6 3 6-3 6z" strokeWidth={1} />
    </>
  );
}

interface LedgerIllustrationProps {
  kind?: IllustrationKind;
  className?: string;
}

export function LedgerIllustration({ kind = 'ledger', className }: LedgerIllustrationProps) {
  return (
    <svg
      viewBox="0 0 120 110"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={cn('h-20 w-24 text-gold-500/80', className)}
    >
      <Paths kind={kind} />
    </svg>
  );
}

interface IllustratedStateProps {
  kind?: IllustrationKind;
  /** The single line of text. */
  text: string;
  action?: React.ReactNode;
  className?: string;
}

/** Illustration + one line of text (+ optional action), centred. */
export default function IllustratedState({ kind = 'ledger', text, action, className }: IllustratedStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 py-8 text-center', className)}>
      <LedgerIllustration kind={kind} />
      <p className="text-sm text-muted-foreground">{text}</p>
      {action}
    </div>
  );
}
