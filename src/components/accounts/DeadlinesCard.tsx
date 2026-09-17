import { useState } from 'react';
import { CalendarClock, Pencil, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatPHTDisplay } from '@/lib/date-utils';
import { useSetAccountDeadlines, useReactivateWebLayaway } from '@/hooks/use-supabase-data';

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
 * ONCE THE DEPOSIT IS CONFIRMED THE DEADLINE IS SPENT (harness finding 1,
 * 2026-09-15). A layaway whose deposit has landed is still 'active', so the
 * server's status gate let the change through and this card offered the button
 * — while the dialog said, in the same breath, "Only applies while the deposit
 * is unpaid." Staff got a success toast and an audit row for a decision nothing
 * would ever act on. set_account_deadlines now refuses with `already_paid`, and
 * the control is withdrawn here too. WITHDRAWN, NOT HIDDEN: the card still
 * shows the date and says why it can no longer be changed, because a control
 * that simply vanishes teaches nobody anything.
 *
 * Layaway only. A cash order's deadline is expires_at, and the hourly job
 * cancels a pending order with a balance whatever has been paid against it, so
 * a partially-paid cash order's deadline is still live and still moveable.
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
  /**
   * Layaway only: has any money been received? Once it has, the deposit
   * deadline is spent and the server refuses to move it (`already_paid`).
   */
  depositPaid?: boolean;
  /**
   * Web layaway only: when expiry released this plan. Set by
   * expire_web_layaway_atomic and by nothing else, so it is what tells a lapsed
   * deposit apart from a plan a human cancelled — only the first is reactivated.
   */
  expiredAt?: string | null;
  canEdit: boolean;
}

const LIVE_STATUSES: Record<'layaway' | 'cash_order', string[]> = {
  layaway: ['active', 'overdue', 'extension_active', 'reactivated'],
  cash_order: ['pending'],
};

export default function DeadlinesCard({
  entityType, entityId, status, transferDueAt, reference, sourceChannel, depositPaid, expiredAt, canEdit,
}: DeadlinesCardProps) {
  const [open, setOpen] = useState(false);
  const [transfer, setTransfer] = useState('');
  const [reason, setReason] = useState('');
  const setDeadlines = useSetAccountDeadlines();
  const reactivate = useReactivateWebLayaway();
  const [reviveOpen, setReviveOpen] = useState(false);
  const [reviveDue, setReviveDue] = useState('');
  const [reviveReason, setReviveReason] = useState('');

  const isLive = LIVE_STATUSES[entityType].includes(status);
  const overdue = !!transferDueAt && new Date(transferDueAt) < new Date();
  const isWeb = sourceChannel === 'web';
  // The deadline is spent once the deposit is in — see the header.
  const depositLocked = entityType === 'layaway' && depositPaid === true;
  const canChange = canEdit && isLive && !depositLocked;

  // REACTIVATION IS THE EXCEPTION, AND ONLY WHERE IT APPLIES (owner decision
  // 2026-09-15). A web layaway that LAPSED — expiry wrote `cancelled` and
  // stamped expiredAt — can come back with a new deadline and its stock re-held.
  // A plan a human cancelled carries no expiredAt and is not offered this: that
  // was somebody's decision. Cash orders keep their own Revive Order button.
  const canRevive =
    canEdit && entityType === 'layaway' && isWeb && status === 'cancelled' && !!expiredAt;

  // What the hourly job will actually do to THIS order once the date passes.
  const consequence = entityType === 'layaway'
    ? isWeb
      ? 'The hourly job releases the hold unless a deposit is confirmed first.'
      : 'Nothing happens automatically on a Hub-created plan — the hourly job only releases web reservations. This date is a staff reminder.'
    : isWeb
      ? 'The hourly job cancels the order and returns the stock unless the transfer is confirmed.'
      : 'The hourly job cancels the order unless the transfer is confirmed. It holds no website stock, so nothing goes back on sale.';

  // Nothing set and nothing settable: no card rather than an empty one.
  if (!transferDueAt && !canChange && !canRevive) return null;

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

  function openRevive() {
    // A fresh deadline, not the one it already missed. 72 hours is the returning
    // customer's window and the safe default to show; staff can change it.
    const d = new Date(Date.now() + 72 * 3600 * 1000);
    setReviveDue(toPhtInputValue(d.toISOString()));
    setReviveReason('');
    setReviveOpen(true);
  }

  async function doRevive() {
    const iso = fromPhtInputValue(reviveDue);
    if (!iso) {
      toast.error('Pick the new deposit deadline.');
      return;
    }
    try {
      const result = await reactivate.mutateAsync({
        account_id: entityId,
        transfer_due_at: iso,
        reason: reviveReason.trim(),
      });
      // Say what was actually held, not just that it worked: re-taking the stock
      // is the part that can quietly not happen.
      toast.success('Plan reactivated', {
        description: `${result.stock_lines_taken} item line${result.stock_lines_taken === 1 ? '' : 's'} held again, ${result.schedule_rows_restored} instalment${result.schedule_rows_restored === 1 ? '' : 's'} restored.`,
      });
      setReviveOpen(false);
    } catch (err) {
      // out_of_stock lands here and names the piece — see useReactivateWebLayaway.
      toast.error((err as Error).message || 'Could not reactivate the plan');
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
            {overdue && isLive && !depositLocked && (
              <p className={`text-xs ${isWeb ? 'text-destructive' : 'text-muted-foreground'}`}>
                Past the deadline. {consequence}
              </p>
            )}
            {depositLocked && isLive && (
              <p className="text-xs text-muted-foreground">
                The deposit is confirmed, so this deadline no longer applies and cannot be
                changed. The reservation is confirmed; the plan now follows its own schedule.
              </p>
            )}
            {!isLive && !canRevive && (
              <p className="text-xs text-muted-foreground">
                This order is {status} — the deadline is history and cannot be changed.
              </p>
            )}
            {canRevive && (
              <p className="text-xs text-muted-foreground">
                The deposit never arrived, so this reservation was released on{' '}
                {formatPHTDisplay(expiredAt!)} and the piece went back on sale. Reactivating
                takes it off sale again — only possible while it is still in stock.
              </p>
            )}
          </div>
          {canChange && (
            <Button size="sm" variant="outline" onClick={openDialog}>
              <Pencil className="mr-1.5 h-3.5 w-3.5" />
              Change
            </Button>
          )}
          {canRevive && (
            <Button size="sm" variant="outline" onClick={openRevive}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              Reactivate
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

      <Dialog open={reviveOpen} onOpenChange={setReviveOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reactivate this plan</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              This puts the plan back to active with a new deposit deadline and takes the
              piece off sale again. If it has already sold, nothing changes and you will be
              told which item is gone.
            </p>
            <div className="space-y-2">
              <Label htmlFor="revive-due">New deposit deadline (PHT)</Label>
              <Input
                id="revive-due"
                type="datetime-local"
                value={reviveDue}
                onChange={e => setReviveDue(e.target.value)}
                className="bg-background border-border"
              />
              <p className="text-[11px] text-muted-foreground">
                Must be in the future — a past date would be released again by the next
                hourly run.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="revive-reason">
                Reason <span className="text-destructive">*</span>
              </Label>
              <Input
                id="revive-reason"
                name="revive-reason"
                autoComplete="off"
                required
                value={reviveReason}
                onChange={e => setReviveReason(e.target.value)}
                placeholder="Why is this plan coming back?"
                className="bg-background border-border"
              />
              <p className="text-[11px] text-muted-foreground">
                Required. This is the only record of why a released piece was held again.
              </p>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setReviveOpen(false)} disabled={reactivate.isPending}>
              Cancel
            </Button>
            <Button onClick={doRevive} disabled={reactivate.isPending || !reviveDue || !reviveReason.trim()}>
              {reactivate.isPending ? 'Reactivating…' : 'Reactivate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
