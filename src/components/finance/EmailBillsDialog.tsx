import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Inbox, Loader2, Mail, Paperclip, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { callRpc } from "@/components/finance/useBookedMonths";
import { useEmailBills } from "@/components/finance/useEmailBills";
import { EXPENSE_BOOK_KEY, type ExpenseCategory, type ExpenseForm, todayTokyo, formatAmount } from "@/components/finance/expenses";
import {
  EMAIL_BILLS_KEY, EMAIL_STATUS_LABEL, type EmailBill,
  confidenceLabel, emailBillRefusal, groupByStatus, lastRunLabel, prefillFromEmail, whyLabel,
} from "@/components/finance/email-bills";

/**
 * Finance → Expenses → "Emails" (Phase 4, owner 2026-10-26). The last 30 days of mail the reader looked
 * at, grouped by outcome, with "Make expense" (opens the normal Add dialog prefilled; the email's stored
 * attachment is copied onto the new draft afterwards), "Dismiss", "Check mail now" and the on/off switch
 * (admin). Hidden until the Phase 4 migration exists (PGRST202).
 */

function refusal(e: unknown, fallback: string) {
  const code = (e as { code?: string })?.code ?? "";
  toast({ title: emailBillRefusal(code) || fallback, variant: "destructive" });
}

function dateTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Tokyo", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default function EmailBillsDialog({ canManage, canAdmin, categories, onMakeExpense, onChanged }: {
  canManage: boolean; canAdmin: boolean; categories: ExpenseCategory[];
  /** Opens the Add dialog prefilled from the email; saving there calls email_bill_make_expense and copies the attachment. */
  onMakeExpense: (message: EmailBill, prefill: Partial<ExpenseForm>) => void;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const state = useEmailBills(open);
  const refresh = () => { qc.invalidateQueries({ queryKey: EMAIL_BILLS_KEY }); qc.invalidateQueries({ queryKey: EXPENSE_BOOK_KEY }); onChanged(); };

  const check = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("expenses-email-bills", { body: { trigger: "manual" } });
      if (error) {
        // A non-2xx reply carries its body on error.context (FunctionsHttpError); that is where the code lives.
        let code = (data as { error?: string } | null)?.error ?? "";
        try {
          const res = (error as { context?: Response }).context;
          if (res && typeof res.json === "function") code = ((await res.clone().json()) as { error?: string })?.error ?? code;
        } catch { /* body not JSON — fall back to the generic sentence */ }
        throw Object.assign(new Error(error.message), { code });
      }
      const out = data as { ok?: boolean; error?: string; skipped?: string; looked_at?: number; drafted?: number; matched?: number; needs_review?: number; skipped_count?: number };
      if (out?.error) throw Object.assign(new Error(out.error), { code: out.error });
      return out;
    },
    onSuccess: (out) => {
      if (out.skipped === "disabled") toast({ title: "Email bills are turned off" });
      else toast({ title: `Checked ${out.looked_at ?? 0} new email${out.looked_at === 1 ? "" : "s"}`, description: `${out.drafted ?? 0} draft(s), ${out.matched ?? 0} matched, ${out.needs_review ?? 0} to review` });
      refresh();
    },
    onError: (e) => refusal(e, "Could not check the mailbox"),
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => callRpc("email_bill_dismiss", { p_message_id: id }),
    onSuccess: () => { toast({ title: "Dismissed" }); refresh(); },
    onError: (e) => refusal(e, "Could not dismiss"),
  });
  const toggle = useMutation({
    mutationFn: (v: boolean) => callRpc("set_email_bills_enabled", { p_enabled: v }),
    onSuccess: (_, v) => { toast({ title: v ? "Email bills turned on" : "Email bills turned off" }); refresh(); },
    onError: (e) => refusal(e, "Could not change the setting"),
  });

  const makeExpense = (m: EmailBill) => {
    onMakeExpense(m, prefillFromEmail(m, todayTokyo(), categories));
    setOpen(false);
  };

  return (
    <>
      <Button size="sm" variant="outline" className="min-h-11" onClick={() => setOpen(true)} data-testid="email-bills-open">
        <Mail className="mr-1 h-4 w-4" /> Emails
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Emailed bills</DialogTitle>
            <DialogDescription>
              The Hub reads the sales@ mailbox every 30 minutes (read-only) and turns bills into draft expenses for you to confirm. Nothing is approved automatically.
            </DialogDescription>
          </DialogHeader>
          {state.isLoading && <div className="text-sm text-muted-foreground"><Loader2 className="inline h-4 w-4 animate-spin mr-2" />Loading…</div>}
          {state.isError && <div className="text-sm text-destructive">Could not load the emails.</div>}
          {state.data?.available && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm">
                <div>
                  <div className="font-medium">{state.data.enabled ? `Reading ${state.data.mailbox}` : "Turned off"}</div>
                  <div className="text-xs text-muted-foreground">{lastRunLabel(state.data.last_run)}</div>
                  {!state.data.enabled && <div className="text-xs text-amber-700 dark:text-amber-400 mt-1">Turn on once Google Admin has granted the Hub's service account the Gmail read permission.</div>}
                  {state.data.last_run?.note && <div className="text-xs text-destructive mt-1">{state.data.last_run.note.split("\n")[0]}</div>}
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {canAdmin && (
                    <div className="flex items-center gap-2">
                      <Switch id="email-bills-enabled" checked={state.data.enabled} onCheckedChange={(v) => toggle.mutate(v)} aria-label="Email bills on or off" />
                      <Label htmlFor="email-bills-enabled" className="text-xs">On</Label>
                    </div>
                  )}
                  {canManage && (
                    <Button size="sm" variant="outline" className="min-h-11" disabled={check.isPending} onClick={() => check.mutate()}>
                      {check.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1 h-4 w-4" />}Check mail now
                    </Button>
                  )}
                </div>
              </div>

              {state.data.messages.length === 0 && (
                <p className="text-sm text-muted-foreground py-6 text-center"><Inbox className="inline h-4 w-4 mr-1" />No emails looked at in the last 30 days.</p>
              )}
              {groupByStatus(state.data.messages).map((g) => (
                <div key={g.status}>
                  <div className="font-medium text-sm mb-1">{EMAIL_STATUS_LABEL[g.status]} ({g.items.length})</div>
                  <ul className="divide-y">
                    {g.items.map((m) => (
                      <li key={m.gmail_message_id} className="py-2 flex flex-wrap items-start justify-between gap-2" data-testid={`email-${m.gmail_message_id}`}>
                        <div className="min-w-0 space-y-0.5 text-sm">
                          <p className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{m.subject || "(no subject)"}</span>
                            {m.attachments.length > 0 && <Paperclip className="h-3 w-3 text-muted-foreground" aria-label={`${m.attachments.length} attachment(s)`} />}
                            {m.confidence != null && <Badge variant="outline">{confidenceLabel(m.confidence)}</Badge>}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {m.from_name || m.from_email || "unknown sender"} · {dateTime(m.received_at)}
                            {typeof m.extracted.amount === "number" && m.extracted.currency && m.extracted.currency !== "OTHER" ? ` · ${formatAmount(Number(m.extracted.amount), m.extracted.currency as "JPY" | "PHP")}` : ""}
                            {m.extracted.currency === "OTHER" && typeof m.extracted.amount === "number" ? ` · ${m.extracted.amount} (other currency)` : ""}
                            {m.matched_description ? ` · attached to “${m.matched_description}”` : ""}
                            {m.expense_status ? ` · expense ${m.expense_status}` : ""}
                          </p>
                          {whyLabel(m) && <p className="text-xs text-muted-foreground">{whyLabel(m)}</p>}
                        </div>
                        {canManage && (m.status === "needs_review" || m.status === "skipped" || m.status === "error") && (
                          <div className="flex gap-2">
                            <Button size="sm" className="min-h-11" onClick={() => makeExpense(m)}>Make expense</Button>
                            <Button size="sm" variant="ghost" className="min-h-11" disabled={dismiss.isPending} onClick={() => dismiss.mutate(m.gmail_message_id)}>Dismiss</Button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
          <DialogFooter><Button variant="ghost" className="min-h-11" onClick={() => setOpen(false)}>Close</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

