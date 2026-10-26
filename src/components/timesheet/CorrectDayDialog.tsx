import { useMemo, useState } from 'react';
import { History, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { dailyHours, dailySalary, formatHours, formatPHP2, type TimesheetEntry, type TimesheetProfile } from '@/lib/timesheetEngine';
import { isoToWall, zonedWallToISO } from '@/lib/timesheetTime';
import {
  COMMENT_MAX, PUNCH_KEYS, PUNCH_LABEL, type PunchKey, type TimesheetCorrection,
  changedPunchLines, commentProblem, correctedAtLabel, correctionRefusal, dayLabel,
} from '@/lib/timesheetCorrections';

/**
 * Consolidation → "Correct day" (owner-confirmed 2026-10-26; docs/TIMESHEET-SPEC.md "Corrections").
 * Admin + can_view_all only (the caller decides when to open it; correct_timesheet_day re-checks).
 * Times are wall-clock in the STAFF MEMBER'S profile timezone, composed exactly like My Timesheet
 * (a 00:00 PM out is midnight = end of day). A reason is required; every save is permanent history.
 */
export default function CorrectDayDialog({
  open, onClose, onSaved, staffName, profile, workDate, entry, history,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  staffName: string;
  profile: TimesheetProfile;
  workDate: string;
  entry: TimesheetEntry | null;
  history: TimesheetCorrection[];
}) {
  const tz = profile.timezone || 'Asia/Manila';
  const initial = useMemo(() => {
    const out = {} as Record<PunchKey, string>;
    for (const k of PUNCH_KEYS) out[k] = isoToWall(entry ? entry[k] : null, tz);
    return out;
  }, [entry, tz]);
  const [times, setTimes] = useState<Record<PunchKey, string>>(initial);
  const [comment, setComment] = useState('');
  const [saving, setSaving] = useState(false);

  const composed = useMemo(() => {
    const out = { work_date: workDate } as TimesheetEntry;
    for (const k of PUNCH_KEYS) out[k] = times[k] ? zonedWallToISO(workDate, times[k], tz) : null;
    return out;
  }, [times, workDate, tz]);
  const hours = dailyHours(composed, tz);
  const salary = dailySalary(hours, profile);

  const changed = PUNCH_KEYS.some(k => times[k] !== initial[k]);
  const commentError = commentProblem(comment);

  const save = async () => {
    if (!changed || commentError) return;
    setSaving(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await supabase.rpc('correct_timesheet_day' as any, {
        p_user_id: profile.user_id, p_work_date: workDate,
        p_am_in: composed.am_in, p_am_out: composed.am_out, p_pm_in: composed.pm_in, p_pm_out: composed.pm_out,
        p_comment: comment.trim(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      const out = (data ?? {}) as { ok?: boolean; error?: string };
      if (error || !out.ok) {
        toast.error(correctionRefusal(error ? undefined : out.error));
        return;
      }
      toast.success(`Day corrected — ${staffName}, ${dayLabel(workDate)}`);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !saving) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto" data-testid="correct-day-dialog">
        <DialogHeader>
          <DialogTitle>Correct day — {staffName}, {dayLabel(workDate)}</DialogTitle>
          <DialogDescription>
            Times are in {tz}. A 00:00 PM out means midnight (end of the day). The staff member sees the reason,
            and can no longer change this day.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {PUNCH_KEYS.map(k => (
            <div key={k} className="space-y-1">
              <Label htmlFor={`correct-${k}`} className="text-xs">{PUNCH_LABEL[k]}</Label>
              <Input id={`correct-${k}`} type="time" step={60} value={times[k]}
                onChange={(e) => setTimes(t => ({ ...t, [k]: e.target.value }))} />
            </div>
          ))}
        </div>

        <p className="text-sm" data-testid="correct-preview">
          Hours <span className="font-semibold tabular-nums">{hours > 0 ? formatHours(hours) : '0'}</span>
          {' · '}Daily pay <span className="font-semibold tabular-nums">{salary > 0 ? formatPHP2(salary) : '₱0'}</span>
        </p>

        <div className="space-y-1">
          <Label htmlFor="correct-comment">Reason for correction</Label>
          <Textarea id="correct-comment" rows={3} maxLength={COMMENT_MAX} value={comment} onChange={(e) => setComment(e.target.value)}
            placeholder="e.g. Forgot to punch out; confirmed with her on chat" />
          {comment.trim().length > 0 && commentError && <p className="text-xs text-destructive">{commentError}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={!changed || !!commentError || saving} data-testid="correct-save">
            {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Correct day
          </Button>
        </DialogFooter>

        {history.length > 0 && (
          <div className="space-y-2 border-t border-border pt-3" data-testid="correct-history">
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground">
              <History className="h-3.5 w-3.5" /> History
            </p>
            <ul className="space-y-2">
              {history.map(c => (
                <li key={c.id} className="rounded-md border border-border p-2 text-xs" data-testid="correct-history-item">
                  <p className="font-medium">{correctedAtLabel(c.corrected_at)} · {c.corrected_by_name || 'Admin'}</p>
                  {changedPunchLines(c, tz).map(l => <p key={l} className="tabular-nums text-muted-foreground">{l}</p>)}
                  <p className="mt-0.5">{c.comment}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
