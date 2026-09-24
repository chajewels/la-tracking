import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Page header band (Hub visual refresh, Phase 1): breadcrumb, the page title
 * in the Deco serif, an optional eyebrow / subtitle, actions on the right,
 * and the signature gold hairline beneath. Presentational only.
 */
export interface Crumb {
  label: string;
  to?: string;
}

interface PageHeaderBandProps {
  crumbs: Crumb[];
  /** Omit when the page renders its own title block (e.g. AccountDetail). */
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export default function PageHeaderBand({ crumbs, title, subtitle, actions, className }: PageHeaderBandProps) {
  return (
    <header className={cn('relative pb-4', className)}>
      <nav aria-label="Breadcrumb" className="mb-2">
        <ol className="flex flex-wrap items-center gap-1 text-[11px] uppercase tracking-[0.14em] text-ink-muted">
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <Fragment key={`${c.label}-${i}`}>
                <li>
                  {c.to && !last ? (
                    <Link to={c.to} className="rounded-sm transition-colors hover:text-gold-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      {c.label}
                    </Link>
                  ) : (
                    <span aria-current={last ? 'page' : undefined} className={last ? 'text-gold-300' : undefined}>
                      {c.label}
                    </span>
                  )}
                </li>
                {!last && (
                  <li aria-hidden>
                    <ChevronRight className="h-3 w-3 opacity-50" />
                  </li>
                )}
              </Fragment>
            );
          })}
        </ol>
      </nav>
      {(title || actions) && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            {title && (
              <h1 className="font-deco text-[2.25rem] font-semibold leading-[1.05] tracking-tight text-champagne sm:text-5xl">
                {title}
              </h1>
            )}
            {subtitle && <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {/* Gold hairline — fades out toward the right edge */}
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-gold-500/70 via-gold-500/25 to-transparent"
      />
    </header>
  );
}
