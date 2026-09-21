import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, MessageSquare, X } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import DataTable, { type DataTableColumn } from '@/components/data-table/DataTable';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import { formatPHTDisplay } from '@/lib/date-utils';

/**
 * Messages from the contact form on chajewelsjp.com.
 *
 * The row is written by the `website` edge function and is never edited here
 * beyond its triage state: a staff member opens the drawer, reads what the
 * person actually wrote, and sets a status and a note. Nothing in the Hub
 * replies — the reply happens in email, and `replied` records that it did.
 *
 * Every status change and every note writes an audit_logs row, for the same
 * reason the subscriber card does: the row itself only ever shows the CURRENT
 * state, so without the log nobody could tell who closed an enquiry or when.
 *
 * contact_inquiries is not in src/integrations/supabase/types.ts (it is reached
 * through the `as any` table cast every website_* table uses — the types
 * regenerate on Lovable's next deploy).
 */

export const CONTACT_STATUSES = ['new', 'replied', 'closed'] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export interface ContactInquiryRow {
  id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  message: string | null;
  lang: string | null;
  page: string | null;
  customer_id: string | null;
  status: ContactStatus | null;
  staff_note: string | null;
  created_at: string;
  customers?: { full_name: string | null } | null;
}

const CONTACT_INQUIRY_SELECT =
  'id, full_name, email, phone, message, lang, page, customer_id, status, staff_note, created_at, customers(full_name)';

const statusOf = (r: ContactInquiryRow): ContactStatus =>
  (CONTACT_STATUSES as readonly string[]).includes(r.status ?? '') ? (r.status as ContactStatus) : 'new';

const STATUS_CHIP: Record<ContactStatus, string> = {
  new: 'border-primary/30 bg-primary/10 text-primary',
  replied: 'border-success/20 bg-success/10 text-success',
  closed: 'border-border bg-muted text-muted-foreground',
};

const STATUS_LABEL: Record<ContactStatus, string> = {
  new: 'New', replied: 'Replied', closed: 'Closed',
};

export function ContactInquiriesCard() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const { can } = usePermissions();
  const canManage = can('manage_website_catalog');

  const inquiries = useQuery<ContactInquiryRow[]>({
    queryKey: ['contact-inquiries'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('contact_inquiries' as any)
        .select(CONTACT_INQUIRY_SELECT)
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as unknown as ContactInquiryRow[];
    },
  });

  const rows = useMemo(() => inquiries.data ?? [], [inquiries.data]);
  const openCount = useMemo(() => rows.filter(r => statusOf(r) === 'new').length, [rows]);

  /**
   * `?inquiry=<id>` deep-links one message — the bell sends staff here from a
   * 'contact_inquiry' notification. Consumed ONCE, as soon as the row it names
   * has loaded, exactly like `?subscriber=` on the card below: coming back to
   * this tab later must not silently re-open a drawer from a notification read
   * days ago.
   *
   * The delete is a functional update so it keeps `tab=audience` — this card
   * only exists on that tab, and dropping the tab would bounce the reader back
   * to catalog as they close the drawer.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const inquiryParam = searchParams.get('inquiry');
  const consumedParam = useRef(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!inquiryParam || consumedParam.current || rows.length === 0) return;
    consumedParam.current = true;
    if (rows.some(r => r.id === inquiryParam)) {
      setOpenId(inquiryParam);
      cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.delete('inquiry');
      return next;
    }, { replace: true });
  }, [inquiryParam, rows, setSearchParams]);

  const open = useMemo(
    () => (openId ? rows.find(r => r.id === openId) ?? null : null),
    [openId, rows],
  );

  /** Draft note, seeded from the row each time the drawer opens on a new one. */
  const [note, setNote] = useState('');
  useEffect(() => { setNote(open?.staff_note ?? ''); }, [open?.id, open?.staff_note]);

  const triage = useMutation({
    mutationFn: async ({ row, status, staff_note }: { row: ContactInquiryRow; status: ContactStatus; staff_note: string }) => {
      const previous = { status: statusOf(row), staff_note: row.staff_note };
      const next = { status, staff_note: staff_note.trim() || null };

      const { error } = await supabase
        .from('contact_inquiries' as any)
        .update(next)
        .eq('id', row.id);
      if (error) throw error;

      await supabase.from('audit_logs').insert([{
        entity_type: 'contact_inquiry',
        entity_id: row.id,
        action: 'triage_contact_inquiry',
        old_value_json: previous,
        new_value_json: next,
        performed_by_user_id: user?.id ?? null,
      }]);
    },
    onSuccess: () => {
      toast.success('Inquiry updated');
      qc.invalidateQueries({ queryKey: ['contact-inquiries'] });
    },
    onError: (err: Error) => toast.error('Could not update inquiry', { description: err.message }),
  });

  const columns = useMemo<DataTableColumn<ContactInquiryRow>[]>(() => [
    {
      key: 'created_at',
      header: 'Received',
      cell: r => (
        <span className="whitespace-nowrap tabular-nums text-xs text-muted-foreground">
          {formatPHTDisplay(r.created_at)}
        </span>
      ),
      sortValue: r => r.created_at,
      csvValue: r => r.created_at,
    },
    {
      key: 'full_name',
      header: 'Name',
      cell: r => <span className="font-medium text-card-foreground">{r.full_name ?? '—'}</span>,
      sortValue: r => r.full_name ?? '',
      filterValue: r => r.full_name ?? '',
      csvValue: r => r.full_name ?? '',
    },
    {
      key: 'contact',
      header: 'Contact',
      cell: r => (
        <div className="text-xs">
          <div>{r.email ?? '—'}</div>
          {r.phone && <div className="text-muted-foreground">{r.phone}</div>}
        </div>
      ),
      sortValue: r => r.email ?? '',
      filterValue: r => [r.email ?? '', r.phone ?? ''].join(' '),
      csvValue: r => [r.email ?? '', r.phone ?? ''].filter(Boolean).join(' / '),
    },
    {
      key: 'message',
      header: 'Message',
      cellClassName: 'max-w-[24rem]',
      cell: r => (
        <span className="block truncate text-xs text-muted-foreground">{r.message ?? '—'}</span>
      ),
      filterValue: r => r.message ?? '',
      csvValue: r => r.message ?? '',
    },
    {
      key: 'page',
      header: 'Page',
      cell: r => <span className="text-xs text-muted-foreground">{r.page ?? '—'}</span>,
      sortValue: r => r.page ?? '',
      filterValue: r => r.page ?? '',
      csvValue: r => r.page ?? '',
    },
    {
      key: 'lang',
      header: 'Lang',
      cell: r => <Badge variant="outline" className="text-[10px] uppercase">{r.lang ?? '—'}</Badge>,
      sortValue: r => r.lang ?? '',
      filterValue: r => r.lang ?? '',
      csvValue: r => r.lang ?? '',
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
      key: 'status',
      header: 'Status',
      cell: r => {
        const s = statusOf(r);
        return <Badge variant="outline" className={`text-[10px] ${STATUS_CHIP[s]}`}>{STATUS_LABEL[s]}</Badge>;
      },
      sortValue: r => CONTACT_STATUSES.indexOf(statusOf(r)),
      filterValue: r => STATUS_LABEL[statusOf(r)],
      csvValue: r => statusOf(r),
    },
  ], []);

  return (
    <>
      <Card id="contact-inquiries" ref={cardRef} className="scroll-mt-24">
        <CardHeader className="hairline-b">
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageSquare className="h-4 w-4 text-primary" />
            Contact inquiries {inquiries.data ? `(${openCount} new of ${rows.length})` : ''}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Messages from the contact form on chajewelsjp.com. Open one to read it and record what
            happened — the Hub does not send the reply.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {inquiries.isLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : inquiries.isError ? (
            <p className="px-6 py-10 text-sm text-muted-foreground">Couldn't load inquiries.</p>
          ) : rows.length === 0 ? (
            <p className="px-6 py-10 text-sm text-muted-foreground">No inquiries yet.</p>
          ) : (
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={r => r.id}
              onRowClick={r => setOpenId(r.id)}
              searchText={r => [r.full_name ?? '', r.email ?? '', r.phone ?? '', r.message ?? '', r.page ?? '']}
              csvName="contact-inquiries"
              densityKey="cj-contact-inquiries-density"
            />
          )}
        </CardContent>
      </Card>

      <Sheet open={!!open} onOpenChange={o => !o && setOpenId(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          {open && (
            <>
              <SheetHeader className="text-left">
                <SheetTitle className="flex flex-wrap items-center gap-2">
                  {open.full_name ?? 'Contact inquiry'}
                  <Badge variant="outline" className={`text-[10px] ${STATUS_CHIP[statusOf(open)]}`}>
                    {STATUS_LABEL[statusOf(open)]}
                  </Badge>
                </SheetTitle>
              </SheetHeader>

              <dl className="mt-4 space-y-2 text-sm">
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 text-muted-foreground">Received</dt>
                  <dd className="tabular-nums">{formatPHTDisplay(open.created_at)}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 text-muted-foreground">Email</dt>
                  <dd className="break-all">
                    {open.email ? <a className="underline" href={`mailto:${open.email}`}>{open.email}</a> : '—'}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 text-muted-foreground">Phone</dt>
                  <dd>{open.phone ? <a className="underline" href={`tel:${open.phone}`}>{open.phone}</a> : '—'}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 text-muted-foreground">Page</dt>
                  <dd className="break-all">{open.page ?? '—'}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 text-muted-foreground">Language</dt>
                  <dd className="uppercase">{open.lang ?? '—'}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 text-muted-foreground">Customer</dt>
                  <dd>{open.customers?.full_name ?? 'Not a Hub customer'}</dd>
                </div>
              </dl>

              <div className="mt-5 space-y-1.5">
                <Label className="text-xs text-muted-foreground">Message</Label>
                <p className="whitespace-pre-wrap rounded-lg border border-border bg-muted/30 p-3 text-sm">
                  {open.message ?? '—'}
                </p>
              </div>

              <div className="mt-5 space-y-1.5">
                <Label htmlFor="contact-staff-note">Staff note</Label>
                <Textarea
                  id="contact-staff-note"
                  rows={4}
                  value={note}
                  onChange={e => setNote(e.target.value)}
                  disabled={!canManage}
                  placeholder="What was done about this — who replied, and how."
                />
              </div>

              {canManage ? (
                <div className="mt-5 flex flex-wrap gap-2">
                  {CONTACT_STATUSES.map(s => (
                    <Button
                      key={s}
                      type="button"
                      variant={statusOf(open) === s ? 'default' : 'outline'}
                      size="sm"
                      disabled={triage.isPending}
                      onClick={() => triage.mutate({ row: open, status: s, staff_note: note })}
                    >
                      {triage.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                      Mark {STATUS_LABEL[s].toLowerCase()}
                    </Button>
                  ))}
                </div>
              ) : (
                <p className="mt-5 text-xs text-muted-foreground">
                  You can read this inquiry but not change its status.
                </p>
              )}

              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-5"
                onClick={() => setOpenId(null)}
              >
                <X className="mr-1 h-3.5 w-3.5" /> Close
              </Button>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
