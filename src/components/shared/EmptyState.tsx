import { type ComponentType, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw, type LucideProps } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Shared empty/error states (master-prompt spec): empty states carry a
 * primary action; error states speak plain language with a Retry —
 * never a raw error string or stack trace.
 */

interface EmptyStateProps {
  icon: ComponentType<LucideProps>;
  title: string;
  description?: string;
  /** Primary action, e.g. a "New Account" link/button. */
  action?: ReactNode;
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="rounded-xl border border-border bg-card p-10 text-center">
      <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-gold-500/10">
        <Icon className="h-6 w-6 text-gold-300" aria-hidden />
      </span>
      <p className="text-sm font-medium text-card-foreground">{title}</p>
      {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

interface ErrorStateProps {
  /** Plain-language explanation — never a raw error message. */
  message: string;
  onRetry?: () => void;
  compact?: boolean;
}

export function ErrorState({ message, onRetry, compact }: ErrorStateProps) {
  return (
    <div className={`rounded-xl border border-danger/25 bg-card text-center ${compact ? 'p-5' : 'p-8'}`}>
      <AlertTriangle className="mx-auto mb-2 h-6 w-6 text-danger" aria-hidden />
      <p className="text-sm text-card-foreground">{message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Try again
        </Button>
      )}
    </div>
  );
}
