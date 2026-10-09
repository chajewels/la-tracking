import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import StatusPill from '@/components/shared/StatusPill';
import { formatPHTDisplay } from '@/lib/date-utils';

/**
 * Paidy cases (follow-up review 2026-10-04, docs/PAIDY.md "Follow-up"): the
 * durable list of Paidy payments the Hub could not settle by itself — a close
 * Paidy refused, a capture it could not record, a refund before recording
 * (owner: a staff decision), an authorisation with no order. Staff resolve a
 * case with a written reason (resolve_paidy_case: confirm_payment, audited).
 * "Record this capture" re-queues a captured payment that has no live
 * submission; the Hub then records it from Paidy's read-back.
 *
 * paidy_cases is not in the generated types yet (types.ts is Lovable's), so
 * it is read through an untyped client handle at the call site.
 */
interface PaidyCase {
  id: string;
  kind: string;
  paidy_payment_id: string;
  cash_order_id: string | null;
  detail: Record<string, unknown> | null;
  opened_at: string;
  last_seen_at: string;
  attempts: number;
  cash_order?: { invoice_number: string | null; web_reference: string | null } | null;
}

const KIND_LABEL: Record<string, { label: string; help: string }> = {
  close_failed: { label: 'Release pending', help: 'Rejected in the Hub, but Paidy did not accept the release yet. The hourly check retries. Do not capture it in Paidy.' },
  captured_unrecorded: { label: 'Captured, not recorded', help: 'Paidy took the money; the Hub has not recorded it.' },
  captured_no_submission: { label: 'Captured after reject', help: 'Paidy took the money but its submission was rejected or cancelled. Record it, or refund it in the Paidy dashboard.' },
  refund_before_record: { label: 'Refund before recording', help: 'Paidy shows a refund on a payment the Hub has not recorded. The order was not changed — decide what happens.' },
  refund_after_record: { label: 'Refund on a recorded payment', help: 'Paidy shows a refund on a recorded payment. The order was not changed — decide what happens.' },
  record_failed: { label: 'Recording failed', help: 'Paidy captured it but the Hub refused to record it (amount, order closed, …). Check the detail.' },
  unmatched_authorization: { label: 'No matching order', help: 'A Paidy authorisation the Hub could not file. Check the Paidy dashboard.' },
  provider_unreadable: { label: 'Unknown to Paidy', help: 'Paidy did not recognise this payment id when the Hub asked.' },
  stale_authorization: { label: 'Authorised on a closed order', help: 'The order was cancelled or expired while Paidy still holds the authorisation. Reject its submission (that releases it); do not capture it in Paidy.' },
};

const RESOLUTIONS: { value: string; label: string }[] = [
  { value: 'handled_in_paidy', label: 'Handled in the Paidy dashboard' },
  { value: 'refunded_in_paidy', label: 'Refunded in the Paidy dashboard' },
  { value: 'released', label: 'Released (closed) in Paidy' },
  { value: 'record_capture', label: 'Record this capture in the Hub' },
  { value: 'end_submission', label: 'Will not be recorded — end its submission' },
  { value: 'no_action', label: 'No action needed' },
];

const CAPTURE_KINDS = new Set(['captured_unrecorded', 'captured_no_submission', 'record_failed']);

function detailLine(d: Record<string, unknown> | null): string {
  if (!d) return '';
  const parts: string[] = [];
  const yen = (v: unknown) => `¥${Math.round(Number(v) || 0).toLocaleString('en-US')}`;
  if (d.captured_jpy != null) parts.push(`captured ${yen(d.captured_jpy)}`);
  if (d.refund_jpy != null) parts.push(`refund ${yen(d.refund_jpy)}`);
  if (d.submitted_jpy != null) parts.push(`submitted ${yen(d.submitted_jpy)}`);
  if (typeof d.reason === 'string') parts.push(d.reason);
  if (typeof d.error === 'string') parts.push(d.error);
  if (typeof d.order_ref === 'string') parts.push(`order_ref ${d.order_ref}`);
  return parts.join(' · ');
}

export default function PaidyCasesPanel({ canResolve }: { canResolve: boolean }) {
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<PaidyCase | null>(null);
  const [resolution, setResolution] = useState('handled_in_paidy');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any;
  const { data: cases = [] } = useQuery({
    queryKey: ['paidy-cases-open'],
    staleTime: 30_000,
    queryFn: async (): Promise<PaidyCase[]> => {
      const { data, error } = await db
        .from('paidy_cases')
        .select('id, kind, paidy_payment_id, cash_order_id, detail, opened_at, last_seen_at, attempts, cash_order:cash_orders(invoice_number, web_reference)')
        .eq('status', 'open')
        .order('opened_at', { ascending: true })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as PaidyCase[];
    },
  });

  // PR 3 / PA10 (owner 2026-10-08): notifications this key could not answer
  // are PARKED, never dropped — the count and the oldest one are shown here
  // so a stalled recovery is visible; they drain by themselves when the
  // matching key is in. No new page.
  const { data: parked = { count: 0, oldest: null as string | null } } = useQuery({
    queryKey: ['paidy-parked-events'],
    staleTime: 60_000,
    queryFn: async (): Promise<{ count: number; oldest: string | null }> => {
      const { data, error, count } = await db
        .from('paidy_webhook_events')
        .select('received_at, parked_reason', { count: 'exact' })
        .is('processed_at', null)
        .not('parked_reason', 'is', null)
        .order('received_at', { ascending: true })
        .limit(1);
      if (error) throw error;
      const first = (data ?? [])[0] as { received_at?: string } | undefined;
      return { count: count ?? 0, oldest: first?.received_at ?? null };
    },
  });

  if (cases.length === 0 && parked.count === 0) return null;

  const submit = async () => {
    if (!target) return;
    setSaving(true);
    // M2 (Paidy QC 2026-10-09): ending the submission of a payment Paidy
    // still holds AUTHORISED first closes it at Paidy (paidy-staff-action);
    // the database refuses end_submission until it is no longer authorised.
    if (resolution === 'end_submission') {
      const { data: closed, error: closeErr } = await supabase.functions.invoke('paidy-staff-action', {
        body: { action: 'close_authorization', case_id: target.id },
      });
      if (closeErr || !closed?.ok) {
        let code = String(closed?.error ?? '');
        let message = String(closed?.message ?? '');
        const ctx = (closeErr as { context?: unknown } | null)?.context;
        if (ctx instanceof Response) {
          try { const j = await ctx.clone().json(); code = String(j?.error ?? code); message = String(j?.message ?? message); } catch { /* keep */ }
        }
        setSaving(false);
        toast.error('The Paidy authorisation was not closed', { description: message || code || 'Try again in a few minutes.' });
        return;
      }
    }
    const { data, error } = await db.rpc('resolve_paidy_case', { p_case_id: target.id, p_resolution: resolution, p_note: note });
    setSaving(false);
    const err = error?.message ?? (data && !data.ok ? String(data.error) : null);
    if (err) {
      const msg: Record<string, string> = {
        reason_required: 'Write a short reason (at least 5 characters).',
        forbidden: 'You need the Confirm payment permission to resolve Paidy cases.',
        submission_exists: 'A live submission already exists for this payment — Confirm it instead.',
        paidy_refunded: 'Paidy shows a refund on this capture; it cannot be recorded as paid.',
        paidy_not_captured: 'Paidy has not captured this payment.',
        not_a_capture_case: 'Only a captured payment can be recorded.',
        no_paidy_record: 'This case has no Paidy record to end.',
        authorization_open: 'Paidy still holds this authorisation. The Hub closes it at Paidy first — try again; if it keeps failing, wait for the hourly check.',
        orphan_capture_unsettled: 'Paidy took this money and the Hub has no record of it. A note cannot settle it: record the capture, or refund it in full in the Paidy dashboard and the hourly check closes the case.',
      };
      toast.error('Could not resolve the case', { description: msg[err] ?? err });
      return;
    }
    toast.success(resolution === 'record_capture' ? 'Re-queued — the Hub records it from Paidy' : resolution === 'end_submission' ? 'Submission ended — the order is open again' : 'Case resolved');
    setTarget(null);
    setNote('');
    queryClient.invalidateQueries({ queryKey: ['paidy-cases-open'] });
    queryClient.invalidateQueries({ queryKey: ['payment-submissions'] });
  };

  return (
    <section className="rounded-xl border border-warning/30 bg-warning/5 p-3 sm:p-4 space-y-2" aria-label="Paidy cases">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-warning shrink-0" />
        <h2 className="text-sm font-semibold text-foreground">Paidy cases</h2>
        <StatusPill label={`${cases.length} open`} tone="warning" />
        {parked.count > 0 && (
          <StatusPill
            label={`${parked.count} parked notification${parked.count === 1 ? '' : 's'}${parked.oldest ? ` · oldest ${formatPHTDisplay(parked.oldest)} PHT` : ''}`}
            tone="info"
          />
        )}
      </div>
      {parked.count > 0 && (
        <p className="text-xs text-muted-foreground">
          Parked notifications are Paidy events this environment's key cannot read (a test payment while live keys are in, or the reverse, or an id Paidy does not know). They are retried daily and never discarded; they drain by themselves once the matching key is in.
        </p>
      )}
      <ul className="space-y-2">
        {cases.map((c) => {
          const k = KIND_LABEL[c.kind] ?? { label: c.kind, help: '' };
          const ref = c.cash_order?.web_reference || c.cash_order?.invoice_number || '—';
          return (
            <li key={c.id} className="rounded-lg border border-border/60 bg-card p-2.5 flex flex-col sm:flex-row sm:items-center gap-2 min-w-0">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <StatusPill label={k.label} tone={c.kind === 'close_failed' ? 'info' : 'warning'} />
                  <span className="font-mono text-xs text-muted-foreground break-all">{c.paidy_payment_id}</span>
                  <span className="text-xs text-foreground">· {ref}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">{k.help}</p>
                {detailLine(c.detail) && <p className="text-[11px] text-muted-foreground mt-0.5 break-words">{detailLine(c.detail)}</p>}
              </div>
              {canResolve && (
                <Button size="sm" variant="outline" className="shrink-0 self-start sm:self-center" onClick={() => {
                  setTarget(c);
                  setResolution(CAPTURE_KINDS.has(c.kind) ? 'record_capture' : 'handled_in_paidy');
                  setNote('');
                }}>
                  Resolve
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      <Dialog open={!!target} onOpenChange={(o) => { if (!o) setTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Resolve Paidy case</DialogTitle>
            <DialogDescription>
              {target ? (KIND_LABEL[target.kind]?.help ?? target.kind) : ''} "Record this capture" re-queues the payment so the Hub records it from Paidy. "End its submission" first closes the authorisation at Paidy if Paidy still holds it, then rejects the waiting Paidy submission so the customer can pay another way. Nothing else changes on the order.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Select value={resolution} onValueChange={setResolution}>
              <SelectTrigger aria-label="Resolution"><SelectValue /></SelectTrigger>
              <SelectContent>
                {RESOLUTIONS.filter((r) => r.value !== 'record_capture' || (target && CAPTURE_KINDS.has(target.kind))).map((r) => (
                  <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was done, and why (required)" rows={3} />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTarget(null)}>Cancel</Button>
            <Button onClick={submit} disabled={saving || note.trim().length < 5}>{saving ? 'Saving…' : 'Resolve'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
