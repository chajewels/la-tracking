import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { MATCH_FIELD_LABELS, type CustomerMatch, type CustomerMatchField } from '@/lib/customer-matches';

interface CustomerMatchListProps {
  matches: CustomerMatch[];
  /** Explanatory line under the title. */
  description: string;
  /** When set, each match gets the confirm checkbox + "Use this customer". Omit for read-only. */
  onUse?: (match: CustomerMatch) => void;
  /** customer_id currently being loaded after "Use this customer". */
  usingId?: string | null;
}

// Duplicate-customer prevention (owner rules 2026-09-23): lists every existing
// customer that matches, with the matched fields highlighted. There is no
// "create anyway" — the only action offered is to use the existing account.
export default function CustomerMatchList({ matches, description, onUse, usingId }: CustomerMatchListProps) {
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});

  const field = (label: string, value: string | null, key: CustomerMatchField | null, hits: CustomerMatchField[]) => {
    const hit = key !== null && hits.includes(key);
    return (
      <div className="min-w-0">
        <dt className="text-[10px] uppercase tracking-[0.12em] text-ink-muted">{label}</dt>
        <dd className={cn('text-xs break-words', hit ? 'font-semibold text-warning' : 'text-foreground')}>
          {value || '—'}
          {hit && <span className="sr-only"> (matched)</span>}
        </dd>
      </div>
    );
  };

  return (
    <Alert className="border-warning/50 bg-warning/5" role="alert">
      <AlertTriangle className="h-4 w-4 text-warning" />
      <AlertTitle className="font-deco text-xl font-semibold leading-tight text-champagne">Existing customer found</AlertTitle>
      <AlertDescription>
        <p className="text-xs text-muted-foreground mb-3 pb-3 hairline-b">{description}</p>
        <ul className="space-y-3">
          {matches.map((m) => (
            <li key={m.customer_id} className="rounded-lg border border-gold-500/20 bg-card p-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-gold-300">{m.customer_code || 'No code'}</span>
                {m.has_login
                  ? <Badge variant="outline" className="text-[10px]">Has portal login</Badge>
                  : <Badge variant="outline" className="text-[10px] text-muted-foreground">No login</Badge>}
                <span className="text-[11px] text-muted-foreground">
                  Matched on: {m.matched_on.map((f) => MATCH_FIELD_LABELS[f] ?? f).join(', ')}
                </span>
              </div>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
                {field('Full name', m.full_name, 'full_name', m.matched_on)}
                {field('Facebook name', m.facebook_name, 'facebook_name', m.matched_on)}
                {field('Mobile', m.mobile_number, 'mobile', m.matched_on)}
                {field('Email', m.email, 'email', m.matched_on)}
                {field('Location', m.location, null, m.matched_on)}
              </dl>
              {onUse && (
                <div className="flex flex-col sm:flex-row sm:items-center gap-2 pt-1">
                  <label className="flex items-center gap-2 text-xs cursor-pointer">
                    <Checkbox
                      checked={!!confirmed[m.customer_id]}
                      onCheckedChange={(v) => setConfirmed((c) => ({ ...c, [m.customer_id]: v === true }))}
                    />
                    I confirmed these details with the customer
                  </label>
                  <Button
                    type="button"
                    size="sm"
                    className="sm:ml-auto"
                    disabled={!confirmed[m.customer_id] || !!usingId}
                    onClick={() => onUse(m)}
                  >
                    {usingId === m.customer_id ? 'Loading…' : 'Use this customer'}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
