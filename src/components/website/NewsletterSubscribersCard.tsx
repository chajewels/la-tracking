import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Loader2, Mail } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import DataTable, { type DataTableColumn } from '@/components/data-table/DataTable';
import { downloadCsv } from '@/lib/csv';
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

  const rows = useMemo(() => subscribers.data ?? [], [subscribers.data]);
  const active = useMemo(() => rows.filter(isActive), [rows]);

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
    ],
    [],
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
    <Card id="subscribers" className="scroll-mt-24">
      <CardHeader className="hairline-b">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Mail className="h-4 w-4 text-primary" />
              Newsletter subscribers{' '}
              {subscribers.data ? `(${active.length} active of ${rows.length})` : ''}
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
        {subscribers.isLoading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : subscribers.isError ? (
          <p className="px-6 py-10 text-sm text-muted-foreground">Couldn't load subscribers.</p>
        ) : rows.length === 0 ? (
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
