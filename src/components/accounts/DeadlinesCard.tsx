import { useState } from 'react';
import { CalendarClock, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatPHTDisplay } from '@/lib/date-utils';
import { useSetAccountDeadlines } from '@/hooks/use-supabase-data';

/**
 * The deposit deadline, on a layaway account or a cash order alike.
 *
 * It is a FIELD, not a computed rule (owner decision 2026-09-13). Staff set it
 * at creation and move it while the order is live; an extension is simply a
 * later deadline. An expired or cancelled order is never revived here — if the
 * customer comes back the order is created fresh — so the card shows the date
 * read-only once the order is no longer live.
 *
 * A second field, settlement_due_at, was removed on 2026-09-15 (owner
 * decision): nothing read it and no account ever carried a value. The deposit
 * deadline is the control that matters.
 *
 * A REASON IS REQUIRED to change it (owner decision 2026-09-15) — refused
 * server-side by set-account-deadlines, and the Save button stays disabled
 * without one so staff are told before the round trip rather than after.
 *
 * WHAT HAPPENS AT THE DEADLINE DEPENDS ON WHERE THE ORDER CAME FROM (harness
 * finding 2, 2026-09-15). The card used to promise, on every layaway, that
 * "the hourly job releases the hold" — but auto-expire-cash-orders sweeps
 * layaways with `source_channel = 'web'` only, and Hub-created plans carry a
 * transfer_due_at too (NewAccount.tsx sends it, create-layaway-account stores
 * it). So a Hub plan sat past its deadline while the card said something was
 * about to happen, and nothing was. THE CARD ITSELF STAYS on every order — the
 * date is real and staff set and move it deliberately on Hub plans as well —
 * but the CONSEQUENCE line now tells the truth per channel. On a Hub layaway
 * the deadline is a staff reminder and says so. Cash orders differ again: the
 * hourly job cancels every pending cash order past expires_at, web or not, but
 * only returns stock for a web one, so only that clause is gated.
 *
 * Times are entered and displayed in PHT, the Hub's canonical zone, whatever
 * the browser's own clock says.
 */

/** An ISO timestamp as the value a datetime-local input wants, read in PHT. */
function toPhtInputValue(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/** What staff typed, read as PHT — never as whatever zone the laptop is in. */
function fromPhtInputValue(value: string): string | null {
  if (!value) return null;
  const d = new Date(`${value}:00+08:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export interface DeadlinesCardProps {
  entityType: 'layaway' | 'cash_order';
  entityId: string;
  status: string;
  transferDueAt: string | null;
  reference?: string | null;
  /** Which automation, if any, acts on this deadline. See the header. */
  sourceChannel?: string | null;
  canEdit: boolean;
}

const LIVE_STATUSES: Record<'layaway' | 'cash_order', string[]> = {
  layaway: ['active', 'overdue', 'extension_active', 'reactivated'],
  cash_order: ['pending'],
};

export default function DeadlinesCard({
  entityType, entityId, status, transferDueAt, reference, sourceChannel, canEdit,
}: DeadlinesCardProps) {
  const [open, setOpen] = useState(false);
  const [transfer, setTransfer] = useState('');
  const [reason, setReason] = useState('');
  const setDeadlines = useSetAccountDeadlines();

  const isLive = LIVE_STATUSES[entityType].includes(status);
  const overdue = !!transferDueAt && new Date(transferDueAt) < new Date();
  const isWeb = sourceChannel === 'web';

  // What the hourly job will actually do to THIS order once the date passes.
  const consequence = entityType === 'layaway'
    ? isWeb
      ? 'The hourly job releases the hold unless a deposit is confirmed first.'
      : 'Nothing happens automatically on a Hub-created plan — the hourly job only releases web reservations. This date is a staff reminder.'
    : isWeb
      ? 'The hourly job cancels the order and returns the stock unless the transfer is confirmed.'
      : 'The hourly job cancels the order unless the transfer is confirmed. It holds no website stock, so nothing goes back on sale.';

  // Nothing set and nothing settable: no card rather than an empty one.
  if (!transferDueAt && !(canEdit && isLive)) return null;

  function openDialog() {
    setTransfer(toPhtInputValue(transferDueAt));
    setReason('');
    setOpen(true);
  }

  async function save() {
    // A deadline is moved, never removed (finding 3) — the server refuses null,
    // and Save is disabled without a date, so this is belt and braces.
    const iso = fromPhtInputValue(transfer);
    if (!iso) {
      toast.error('Pick a date. A deadline can be moved but not removed.');
      return;
    }
    try {
      const result = await setDeadlines.mutateAsync({
        entity_type: entityType,
        entity_id: entityId,
        transfer_due_at: iso,
        reason: reason.trim(),
      });
      // Observation A: a backdated deadline is legitimate — it is how staff
      // release a hold deliberately — but it arms the hourly job within the
      // hour, so say so rather than letting a mistyped year pass as routine.
      if (result?.deadline_in_past) {
        toast.warning('Deadline updated — the date you set is in the past.', {
          description: isWeb && entityType === 'layaway'
            ? 'The next hourly run will release this reservation unless a deposit is confirmed first.'
            : consequence,
        });
      } else {
        toast.success('Deadline updated');
      }
      setOpen(false);
    } catch (err) {
      toast.error((err as Error).message || 'Could not update the deadline');
    }
  }

  return (
    <>
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <CalendarClock className="h-4 w-4 text-primary" />
              <p className="text-sm font-medium text-card-foreground">Deadline</p>
              {reference && <span className="font-mono text-xs text-muted-foreground">{reference}</span>}
            </div>
            <p className="text-xs text-muted-foreground">
              {entityType === 'layaway' ? 'Deposit due' : 'Transfer due'}:{' '}
              {transferDueAt ? formatPHTDisplay(transferDueAt) : 'not set'}
            </p>
            {overdue && isLive && (
              <p className={`text-xs ${isWeb ? 'text-destructive' : 'text-muted-foreground'}`}>
                Past the deadline. {consequence}
              </p>
            )}
            {!isLive && (
              <p className="text-xs text-muted-foreground">
                This order is {status} — the deadline is history and cannot be changed.
              </p>
            )}
          </div>
          {canEdit && isLive && (
            <Button size="sm" variant="outline" onClick={openDialog}>
              <Pencil className="mr-1.5 h-3.5 w-3.5" />
              Change
            </Button>
          )}
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Change the deadline</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="transfer-due">
                {entityType === 'layaway' ? 'Deposit due (PHT)' : 'Transfer due (PHT)'}
              </Label>
              <Input
                id="transfer-due"
                type="datetime-local"
                value={transfer}
                onChange={e => setTransfer(e.target.value)}
                className="bg-background border-border"
              />
              <p className="text-[11px] text-muted-foreground">
                {entityType === 'cash_order'
                  ? 'Moves the date the customer sees and the date the hourly job acts on, together.'
                  : 'Only applies while the deposit is unpaid. Once a deposit is confirmed the reservation is confirmed.'}
              </p>
              <p className="text-[11px] text-muted-foreground">{consequence}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="deadline-reason">
                Reason <span className="text-destructive">*</span>
              </Label>
              <Input
                id="deadline-reason"
                name="deadline-reason"
                autoComplete="off"
                required
                value={reason}
                onChange={e => setReason(e.target.value)}
                placeholder="Why is the deadline moving?"
                className="bg-background border-border"
              />
              <p className="text-[11px] text-muted-foreground">
                Required. This is the only record of why the date moved.
              </p>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={setDeadlines.isPending}>
              Cancel
            </Button>
            <Button onClick={save} disabled={setDeadlines.isPending || !transfer || !reason.trim()}>
              {setDeadlines.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
