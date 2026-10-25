import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, Wallet } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { EXPENSE_BOOK_KEY, expenseRefusal, monthKeyTokyo, monthLabel, todayTokyo } from "@/components/finance/expenses";
import { callRpc, useBookedMonths } from "@/components/finance/useBookedMonths";
import {
  BOOKED_MONTHS_KEY, RPC_BY_SOURCE, SOURCE_LABEL,
  type BookingLine, type BookingSource,
  activeBooking, bookableLines, bookedSummary, bookingProblem, bookingRefusal, dialogRows, driftWarning,
  expensesLink, formatPeso, monthProblemFor, sumLines, wasVoided, yenPreview,
} from "@/components/finance/mark-paid";

/**
 * "Mark as paid" block (Expenses Phase 2, owner 2026-10-25), rendered under the GRAND TOTAL
 * of Timesheet → Cost Master and under Commissions → Payout Breakdown. Shown only when the
 * page passes canMarkPaid (= approve_expenses). States:
 *   - not booked → button → confirm dialog → one approved expense in Finance → Expenses
 *   - booked     → "Paid on … · ₱… (≈ ¥…)" + link to the Expenses tab; a drift warning when the
 *                  screen now computes a different total
 *   - voided     → button again, with a note that the previous booking was voided
 * Until the Phase 2 migration is applied the RPCs do not exist: the block says so and does nothing.
 */

export default function MarkPaidPanel({ source, monthKey, lines, canMarkPaid }: {
  source: BookingSource;
  monthKey: string;
  lines: BookingLine[];
  canMarkPaid: boolean;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [paidOn, setPaidOn] = useState<string>(() => todayTokyo());
  const state = useBookedMonths(source, canMarkPaid);

  const months = state.data?.available ? state.data.months : [];
  const rate = state.data?.available ? state.data.rate : null;
  const booking = activeBooking(months, monthKey);
  const voided = wasVoided(months, monthKey);
  const ok = bookableLines(source, lines);
  const total = sumLines(source, ok);
  const today = todayTokyo();
  // Two checks: the month/lines rule decides whether the button is usable; the full rule
  // (incl. the paid-on date) decides whether the dialog's confirm is usable — so a date typed
  // wrongly in the dialog can never lock the button.
  const monthProblem = monthProblemFor(source, monthKey, lines, monthKeyTokyo());
  const problem = bookingProblem(source, monthKey, lines, paidOn, monthKeyTokyo(), today);
  const drift = driftWarning(booking, sumLines(source, bookableLines(source, lines)));

  const book = useMutation({
    mutationFn: () => callRpc(RPC_BY_SOURCE[source], { p_month: `${monthKey}-01`, p_paid_on: paidOn, p_lines: ok }),
    onSuccess: () => {
      toast({ title: `${SOURCE_LABEL[source]} for ${monthLabel(monthKey)} marked as paid`, description: `${formatPeso(total)} booked in Finance → Expenses.` });
      setOpen(false);
    },
    onError: (e: Error & { code?: string }) => {
      const code = e.code ?? e.message;
      toast({ title: "Not booked", description: bookingRefusal(code) || expenseRefusal(code), variant: "destructive" });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: BOOKED_MONTHS_KEY });
      qc.invalidateQueries({ queryKey: EXPENSE_BOOK_KEY });
    },
  });

  if (!canMarkPaid) return null;

  if (state.isError) {
    const code = (state.error as Error & { code?: string })?.code ?? (state.error as Error)?.message ?? "";
    return (
      <p className="mt-3 rounded-md border border-dashed p-3 text-xs text-destructive" data-testid="mark-paid-error">
        Could not load the booking state: {expenseRefusal(code)}
      </p>
    );
  }

  if (state.data?.available === false) {
    return (
      <p className="mt-3 rounded-md border border-dashed p-3 text-xs text-muted-foreground" data-testid="mark-paid-waiting">
        Mark as paid will appear here once the expenses update is applied to the database.
      </p>
    );
  }

  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border bg-card p-3 text-sm" data-testid={`mark-paid-${source}`}>
      {booking ? (
        <div className="min-w-0 space-y-1">
          <p className="flex flex-wrap items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-primary" aria-hidden="true" />
            <span className="font-medium">{bookedSummary(booking)}</span>
            <span className="rounded-full border px-2 py-0.5 text-xs uppercase tracking-wide text-muted-foreground">{booking.status}</span>
          </p>
          {drift && (
            <p className="flex items-start gap-1.5 text-xs text-warning" data-testid="mark-paid-drift">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /> {drift}
            </p>
          )}
        </div>
      ) : (
        <div className="min-w-0 space-y-1">
          <p className="text-muted-foreground">
            {monthLabel(monthKey)} · {SOURCE_LABEL[source]} · <span className="font-medium text-foreground">{formatPeso(total)}</span>
            {rate != null && total > 0 && <span className="text-muted-foreground"> {yenPreview(total, rate)}</span>}
          </p>
          {voided && <p className="text-xs text-muted-foreground" data-testid="mark-paid-voided">The previous booking for this month was voided.</p>}
          {monthProblem && <p className="text-xs text-muted-foreground" aria-live="polite" data-testid="mark-paid-month-problem">{monthProblem}</p>}
        </div>
      )}
      <div className="flex items-center gap-2">
        {booking ? (
          <Button asChild size="sm" variant="outline">
            <Link to={expensesLink(booking.expense_date.slice(0, 7))}>View in Expenses <ExternalLink className="ml-1 h-3.5 w-3.5" /></Link>
          </Button>
        ) : (
          <Button size="sm" onClick={() => { setPaidOn(today); setOpen(true); }} disabled={state.isLoading || !!monthProblem} data-testid="mark-paid-button">
            <Wallet className="mr-1 h-4 w-4" /> Mark as paid
          </Button>
        )}
      </div>

      <Dialog open={open} onOpenChange={(o) => { if (!o && !book.isPending) { setOpen(false); setPaidOn(today); } }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Mark {SOURCE_LABEL[source].toLowerCase()} as paid — {monthLabel(monthKey)}</DialogTitle>
            <DialogDescription>
              One approved expense of {formatPeso(total)} {rate != null ? yenPreview(total, rate) : ""} is booked in Finance → Expenses with this breakdown. It can only be undone by voiding that expense.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor={`paid-on-${source}`}>Paid on</Label>
              <Input id={`paid-on-${source}`} type="date" value={paidOn} min={`${monthKey}-01`} max={today} onChange={(e) => setPaidOn(e.target.value)} className="w-48" />
            </div>
            <ul className="divide-y rounded-md border text-sm" data-testid="mark-paid-rows">
              {dialogRows(source, ok).map((r, i) => (
                <li key={`${r.name}-${i}`} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="min-w-0">
                    <span className="font-medium">{r.name}</span>
                    <span className="block text-xs text-muted-foreground">{r.meta}</span>
                  </span>
                  <span className="tabular-nums">{formatPeso(r.amount)}</span>
                </li>
              ))}
              <li className="flex items-center justify-between gap-3 bg-muted/30 px-3 py-2 font-semibold">
                <span>Total</span><span className="tabular-nums">{formatPeso(total)}</span>
              </li>
            </ul>
            {problem && <p className="text-xs text-destructive" data-testid="mark-paid-problem">{problem}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={book.isPending}>Cancel</Button>
            <Button onClick={() => book.mutate()} disabled={!!problem || book.isPending} data-testid="mark-paid-confirm">
              {book.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Mark as paid
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
