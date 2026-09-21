import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Loader2, Mail, X } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import DataTable, { type DataTableColumn } from '@/components/data-table/DataTable';
import { downloadCsv } from '@/lib/csv';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import { formatPHTDisplay } from '@/lib/date-utils';
import {
  NEWSLETTER_SUBSCRIBER_SELECT,
  isActive,
  isNotTest,
  langLabel,
  newsletterSubscribers,
  type NewsletterSubscriberRow,
} from './newsletter-types';

/**
 * The storefront's mailing list.
 *
 * Read-only in the Hub: rows are written by the `website` edge function, and
 * nothing here sends to them — see docs/NEWSLETTER-SUBSCRIBERS.md §5 for what
 * a send would actually require.
 *
 * Test customers are excluded by `customers.is_test`. A subscriber with no
 * customer at all is kept: most sign-ups are from people the Hub has never
 * sold to, and they are exactly who the list is for.
 */
export function NewsletterSubscribersCard() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const { can } = usePermissions();
  const canManage = can('manage_website_catalog');

  const subscribers = useQuery<NewsletterSubscriberRow[]>({
    queryKey: ['newsletter-subscribers'],
    queryFn: async () => {
      const { data, error } = await newsletterSubscribers()
        .select(NEWSLETTER_SUBSCRIBER_SELECT)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return ((data ?? []) as NewsletterSubscriberRow[]).filter(isNotTest);
    },
  });

  const allRows = useMemo(() => subscribers.data ?? [], [subscribers.data]);
  const active = useMemo(() => allRows.filter(isActive), [allRows]);

  /**
   * `?subscriber=<id>` deep-links one subscriber — the bell sends staff here
   * from a 'newsletter_subscribed' notification. The list is long and the row
   * is one of hundreds, so the param narrows the table to that person rather
   * than dropping them at the top of everything.
   *
   * It is consumed ONCE, as soon as the row it names has loaded: clearing the
   * filter, or coming back to this page later, must not silently re-apply a
   * filter from a notification read days ago. `focusedId` is state, not the
   * URL, so Clear works and the param does not come back.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const subscriberParam = searchParams.get('subscriber');
  const consumedParam = useRef(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!subscriberParam || consumedParam.current || allRows.length === 0) return;
    consumedParam.current = true;
    if (allRows.some(r => r.id === subscriberParam)) {
      setFocusedId(subscriberParam);
      cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    // Functional, so the Website workspace writing ?tab= in the same tick
    // cannot be clobbered by a stale snapshot — this card only exists on the
    // audience tab, and losing the tab would bounce the reader to catalog.
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.delete('subscriber');
      return next;
    }, { replace: true });
  }, [subscriberParam, allRows, setSearchParams]);

  const focused = useMemo(
    () => (focusedId ? allRows.find(r => r.id === focusedId) ?? null : null),
    [focusedId, allRows],
  );
  const rows = useMemo(() => (focused ? [focused] : allRows), [focused, allRows]);

  /**
   * Flip one subscriber's state.
   *
   * Unsubscribing stamps `unsubscribed_at`; re-subscribing clears it and
   * TOUCHES NOTHING ELSE. `consented_at` in particular stays exactly as it
   * was: it records when this person actually consented, and a staff member
   * putting them back on the list is not a fresh act of consent by them.
   * Rewriting it would launder a staff action into the customer's own — and
   * consent is the one field a mailing list is answerable for.
   *
   * Both directions write an audit_logs row. There is no other record: the
   * row itself only ever shows the CURRENT state, so without the log nobody
   * could tell a customer who unsubscribed themselves from one a staff
   * member removed.
   */
  const setSubscribed = useMutation({
    mutationFn: async ({ row, subscribed }: { row: NewsletterSubscriberRow; subscribed: boolean }) => {
      const previous = row.unsubscribed_at;
      const next = subscribed ? null : new Date().toISOString();

      const { error } = await newsletterSubscribers()
        .update({ unsubscribed_at: next })
        .eq('id', row.id);
      if (error) throw error;

      await supabase.from('audit_logs').insert([{
        entity_type: 'newsletter_subscriber',
        entity_id: row.id,
        action: subscribed ? 'resubscribe_newsletter_subscriber' : 'unsubscribe_newsletter_subscriber',
        old_value_json: { unsubscribed_at: previous },
        new_value_json: { unsubscribed_at: next },
        performed_by_user_id: user?.id ?? null,
      }]);
    },
    onSuccess: (_data, { subscribed }) => {
      toast.success(subscribed ? 'Subscriber re-subscribed' : 'Subscriber unsubscribed');
      qc.invalidateQueries({ queryKey: ['newsletter-subscribers'] });
    },
    onError: (err: Error) => {
      toast.error('Could not update subscriber', { description: err.message });
    },
  });

  const columns = useMemo<DataTableColumn<NewsletterSubscriberRow>[]>(
    () => [
      {
        key: 'email',
        header: 'Email',
        cell: r => <span className="text-card-foreground">{r.email}</span>,
        sortValue: r => r.email_norm ?? r.email.toLowerCase(),
        filterValue: r => r.email,
        csvValue: r => r.email,
      },
      {
        key: 'lang',
        header: 'Lang',
        cell: r => <Badge variant="outline" className="text-[10px]">{langLabel(r.lang)}</Badge>,
        sortValue: r => r.lang ?? '',
        filterValue: r => langLabel(r.lang),
        csvValue: r => r.lang ?? '',
      },
      {
        key: 'status',
        header: 'Status',
        cell: r =>
          isActive(r) ? (
            <Badge variant="outline" className="border-success/20 bg-success/10 text-[10px] text-success">Active</Badge>
          ) : (
            <Badge variant="outline" className="border-border bg-muted text-[10px] text-muted-foreground">Unsubscribed</Badge>
          ),
        sortValue: r => (isActive(r) ? 0 : 1),
        filterValue: r => (isActive(r) ? 'Active' : 'Unsubscribed'),
        csvValue: r => (isActive(r) ? 'Active' : 'Unsubscribed'),
      },
      {
        key: 'source',
        header: 'Source',
        cell: r => <span className="text-muted-foreground">{r.source ?? '—'}</span>,
        sortValue: r => r.source ?? '',
        filterValue: r => r.source ?? '',
        csvValue: r => r.source ?? '',
      },
      {
        key: 'customer',
        header: 'Customer',
        cell: r => <span className="text-muted-foreground">{r.customers?.full_name ?? '—'}</span>,
        sortValue: r => r.customers?.full_name ?? '',
        filterValue: r => r.customers?.full_name ?? '',
        csvValue: r => r.customers?.full_name ?? '',
      },
      {
        key: 'consented_at',
        header: 'Consented',
        cell: r => (
          <span className="tabular-nums text-muted-foreground">
            {r.consented_at ? formatPHTDisplay(r.consented_at) : '—'}
          </span>
        ),
        sortValue: r => r.consented_at ?? '',
        csvValue: r => r.consented_at ?? '',
      },
      {
        key: 'unsubscribed_at',
        header: 'Unsubscribed',
        cell: r => (
          <span className="tabular-nums text-muted-foreground">
            {r.unsubscribed_at ? formatPHTDisplay(r.unsubscribed_at) : '—'}
          </span>
        ),
        sortValue: r => r.unsubscribed_at ?? '',
        csvValue: r => r.unsubscribed_at ?? '',
      },
      ...(canManage
        ? [{
            key: 'actions',
            header: '',
            align: 'right' as const,
            hideable: false,
            cell: (r: NewsletterSubscriberRow) => (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={setSubscribed.isPending}
                onClick={() => setSubscribed.mutate({ row: r, subscribed: !isActive(r) })}
              >
                {isActive(r) ? 'Unsubscribe' : 'Re-subscribe'}
              </Button>
            ),
          }]
        : []),
    ],
    [canManage, setSubscribed],
  );

  /**
   * The mailing export, deliberately NOT DataTable's own CSV button.
   *
   * That one exports the visible columns of whatever is on screen, filters
   * and all — useful, and the wrong thing to hand a mailing tool. This is
   * always every ACTIVE subscriber and always the same three columns, so what
   * you upload does not depend on how the table happened to be sorted or
   * filtered when you clicked.
   */
  const exportActive = () => {
    downloadCsv(
      'newsletter-active',
      ['email', 'lang', 'consented_at'],
      active.map(r => [r.email, r.lang ?? '', r.consented_at ?? '']),
    );
  };

  return (
    <Card id="subscribers" ref={cardRef} className="scroll-mt-24">
      <CardHeader className="hairline-b">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Mail className="h-4 w-4 text-primary" />
              Newsletter subscribers{' '}
              {subscribers.data ? `(${active.length} active of ${allRows.length})` : ''}
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Collected by the newsletter form on chajewelsjp.com. The Hub does not send to
              this list — export it for the mailing tool.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={exportActive}
            disabled={active.length === 0}
          >
            <Download className="mr-1.5 h-3.5 w-3.5" /> Export active
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {focused && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-3 text-xs">
            <span className="text-muted-foreground">Showing one subscriber from a notification:</span>
            <span className="text-card-foreground">{focused.email}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => setFocusedId(null)}
            >
              <X className="mr-1 h-3 w-3" /> Show all
            </Button>
          </div>
        )}
        {subscribers.isLoading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : subscribers.isError ? (
          <p className="px-6 py-10 text-sm text-muted-foreground">Couldn't load subscribers.</p>
        ) : allRows.length === 0 ? (
          <p className="px-6 py-10 text-sm text-muted-foreground">No subscribers yet.</p>
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={r => r.id}
            searchText={r => [r.email, r.source ?? '', r.customers?.full_name ?? '']}
            csvName="newsletter-subscribers"
            densityKey="cj-newsletter-subscribers-density"
          />
        )}
      </CardContent>
    </Card>
  );
}
