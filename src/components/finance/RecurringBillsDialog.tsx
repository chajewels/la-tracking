import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Loader2, Pencil, Play, Plus } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { callRpc } from "@/components/finance/useBookedMonths";
import { useRecurringBills } from "@/components/finance/useRecurringBills";
import type { PaidFromAccount } from "@/components/finance/ledger";
import {
  EXPENSE_BOOK_KEY, EXPENSE_GROUPS, PAYMENT_METHODS, type ExpenseCategory, type ExpenseVendor,
  canEnterManually, cleanAmountInput, formatAmount, todayTokyo,
} from "@/components/finance/expenses";
import {
  FREQUENCIES, RECURRING_BILLS_KEY, type BillForm, type Frequency, type RecurringBill,
  billPayload, defaultSpread, dueLabel, emptyBillForm, firstDue, formFromBill, frequencyLabel,
  recurringRefusal, spreadLabel, validateBillForm,
} from "@/components/finance/recurring";

/**
 * Finance → Expenses → "Recurring bills" (Phase 3, owner 2026-10-25). Templates that create one draft
 * expense per cycle for the owner to confirm. Managing needs manage_expenses (server-checked, audited);
 * approve-only users can look. Hidden entirely until the Phase 3 migration exists (PGRST202).
 */

const NO_VENDOR = "__none";
const NO_ACCOUNT = "__none";

function refusal(e: unknown, fallback: string) {
  const code = (e as { code?: string })?.code ?? "";
  toast({ title: recurringRefusal(code) || fallback, variant: "destructive" });
}

export default function RecurringBillsDialog({ canManage, paidFromList, categories, vendors, onChanged }: {
  canManage: boolean; paidFromList: PaidFromAccount[] | null; categories: ExpenseCategory[]; vendors: ExpenseVendor[]; onChanged: () => void;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<BillForm | null>(null);
  const [catchUp, setCatchUp] = useState<{ bill: RecurringBill; date: string } | null>(null);
  const state = useRecurringBills(open);
  const refresh = () => { qc.invalidateQueries({ queryKey: RECURRING_BILLS_KEY }); qc.invalidateQueries({ queryKey: EXPENSE_BOOK_KEY }); onChanged(); };

  const save = useMutation({
    mutationFn: (f: BillForm) => callRpc("upsert_recurring_bill", { p: billPayload(f) }),
    onSuccess: (_, f) => { toast({ title: f.id ? "Bill saved" : "Recurring bill added" }); setForm(null); refresh(); },
    onError: (e) => refusal(e, "Could not save the bill"),
  });
  const toggle = useMutation({
    mutationFn: (v: { id: string; active: boolean }) => callRpc("set_recurring_bill_active", { p_id: v.id, p_active: v.active }),
    onSuccess: (_, v) => { toast({ title: v.active ? "Bill reactivated" : "Bill deactivated" }); refresh(); },
    onError: (e) => refusal(e, "Could not change the bill"),
  });
  const generate = useMutation({
    mutationFn: (v: { bill?: string; date?: string }) => callRpc("generate_recurring_now", { p_bill_id: v.bill ?? null, p_for: v.date ?? null }),
    onSuccess: (out, v) => {
      toast({ title: v.bill ? "Draft created — confirm it in the list" : `Checked all bills: ${out.created ?? 0} new draft${Number(out.created) === 1 ? "" : "s"}` });
      setCatchUp(null); refresh();
    },
    onError: (e) => refusal(e, "Could not generate"),
  });

  const bills = state.data?.available ? state.data.bills : [];
  const today = state.data?.available ? state.data.today : todayTokyo();
  const problem = form ? validateBillForm(form, paidFromList !== null) : null;
  const set = <K extends keyof BillForm>(k: K, v: BillForm[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  return (
    <>
      <Button size="sm" variant="outline" className="h-9" onClick={() => setOpen(true)} data-testid="recurring-open">
        <CalendarClock className="mr-1 h-4 w-4" /> Recurring bills
      </Button>
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setForm(null); setCatchUp(null); } }}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Recurring bills</DialogTitle>
            <DialogDescription>Each bill creates one draft expense on its due day (checked nightly at 00:20). You confirm the real amount and approve it in the Expenses list. Nothing is paid or booked without your approval.</DialogDescription>
          </DialogHeader>

          {!form && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {canManage && <Button size="sm" className="min-h-11" onClick={() => setForm(emptyBillForm(today))}><Plus className="mr-1 h-4 w-4" />Add bill</Button>}
                {canManage && bills.length > 0 && (
                  <Button size="sm" variant="outline" className="min-h-11" disabled={generate.isPending} onClick={() => generate.mutate({})}>
                    {generate.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Play className="mr-1 h-4 w-4" />}Generate due bills now
                  </Button>
                )}
              </div>
              {state.isLoading && <div className="text-sm text-muted-foreground"><Loader2 className="inline h-4 w-4 animate-spin mr-2" />Loading…</div>}
              {state.isError && <div className="text-sm text-destructive">Could not load the bills.</div>}
              {state.data?.available && bills.length === 0 && <p className="text-sm text-muted-foreground py-6 text-center">No recurring bills yet. Add the ones that come every month — the tax accountant, Lovable, Google Workspace, rent…</p>}
              <ul className="divide-y">
                {bills.map((b) => (
                  <li key={b.id} className={`py-2 flex flex-wrap items-center justify-between gap-2 ${b.active ? "" : "opacity-60"}`} data-testid={`bill-${b.id}`}>
                    <div className="min-w-0 space-y-0.5">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{b.name}</span>
                        <span className="tabular-nums">{formatAmount(b.amount, b.currency)}</span>
                        <Badge variant="outline">{frequencyLabel(b.frequency)} · day {b.due_day}</Badge>
                        {b.spread_months && <Badge variant="secondary">{spreadLabel(b.spread_months)}</Badge>}
                        {!b.active && <Badge variant="outline">inactive</Badge>}
                      </p>
                      <p className="text-xs text-muted-foreground">{b.category_name}{b.vendor_name ? ` · ${b.vendor_name}` : ""} · {dueLabel(b, today)}{b.last_generated_on ? ` · last draft ${b.last_generated_on}` : ""}</p>
                    </div>
                    {canManage && (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button size="sm" variant="ghost" className="min-h-11" onClick={() => setForm(formFromBill(b))} aria-label={`Edit ${b.name}`}><Pencil className="h-4 w-4" /></Button>
                        <Button size="sm" variant="ghost" className="min-h-11" onClick={() => setCatchUp({ bill: b, date: b.last_generated_on ?? today })}>One-off draft…</Button>
                        <div className="flex items-center gap-1">
                          <Switch id={`active-${b.id}`} checked={b.active} onCheckedChange={(v) => toggle.mutate({ id: b.id, active: v })} aria-label={`${b.name} active`} />
                          <Label htmlFor={`active-${b.id}`} className="text-xs">Active</Label>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {catchUp && (
                <div className="rounded-md border p-3 space-y-2 text-sm">
                  <div className="font-medium">One-off draft for {catchUp.bill.name}</div>
                  <p className="text-xs text-muted-foreground">For a cycle the Hub did not create (for example a month before the bill was set up). It does not change the schedule.</p>
                  <div className="flex flex-wrap items-end gap-2">
                    <div><Label htmlFor="catchup-date" className="text-xs">Due date</Label><Input id="catchup-date" type="date" className="min-h-11" value={catchUp.date} min={catchUp.bill.starts_on} onChange={(e) => setCatchUp({ ...catchUp, date: e.target.value })} /></div>
                    <Button size="sm" className="min-h-11" disabled={!catchUp.date || generate.isPending} onClick={() => generate.mutate({ bill: catchUp.bill.id, date: catchUp.date })}>Create draft</Button>
                    <Button size="sm" variant="ghost" className="min-h-11" onClick={() => setCatchUp(null)}>Cancel</Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {form && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5"><Label htmlFor="bill-name">Name</Label><Input id="bill-name" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Tax accountant" /></div>
              <div className="space-y-1.5">
                <Label htmlFor="bill-frequency">How often</Label>
                <Select value={form.frequency} onValueChange={(v) => { const f = v as Frequency; setForm((x) => x ? { ...x, frequency: f, spread_months: x.spread ? String(defaultSpread(f)) : x.spread_months } : x); }}>
                  <SelectTrigger id="bill-frequency"><SelectValue /></SelectTrigger>
                  <SelectContent>{FREQUENCIES.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="bill-category">Category</Label>
                <Select value={form.category_id} onValueChange={(v) => set("category_id", v)}>
                  <SelectTrigger id="bill-category"><SelectValue placeholder="Pick a category" /></SelectTrigger>
                  <SelectContent>
                    {EXPENSE_GROUPS.map((g) => {
                      const cats = categories.filter((c) => c.group_key === g.key && c.active && canEnterManually(c));
                      if (cats.length === 0) return null;
                      return <SelectGroup key={g.key}><SelectLabel>{g.label}</SelectLabel>{cats.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectGroup>;
                    })}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="bill-desc">What the expense will say</Label><Input id="bill-desc" value={form.description} onChange={(e) => set("description", e.target.value)} placeholder="e.g. Monthly accounting fee" /></div>
              <div className="space-y-1.5">
                <Label htmlFor="bill-vendor">Vendor (optional)</Label>
                <Select value={form.vendor_id || NO_VENDOR} onValueChange={(v) => set("vendor_id", v === NO_VENDOR ? "" : v)}>
                  <SelectTrigger id="bill-vendor"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value={NO_VENDOR}>No vendor</SelectItem>{vendors.map((v) => <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bill-amount">Expected amount</Label>
                <div className="flex gap-2">
                  <Select value={form.currency} onValueChange={(v) => setForm((x) => x ? { ...x, currency: v as BillForm["currency"], amount: cleanAmountInput(x.amount, v as BillForm["currency"]) } : x)}>
                    <SelectTrigger className="w-[90px]" aria-label="Currency"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="JPY">¥ JPY</SelectItem><SelectItem value="PHP">₱ PHP</SelectItem></SelectContent>
                  </Select>
                  <Input id="bill-amount" inputMode="decimal" value={form.amount} onChange={(e) => set("amount", cleanAmountInput(e.target.value, form.currency))} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bill-method">Paid by</Label>
                <Select value={form.payment_method} onValueChange={(v) => set("payment_method", v as BillForm["payment_method"])}>
                  <SelectTrigger id="bill-method"><SelectValue /></SelectTrigger>
                  <SelectContent>{PAYMENT_METHODS.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              {paidFromList && (
                <div className="space-y-1.5">
                  <Label htmlFor="bill-paid-from">Paid from</Label>
                  <Select value={form.paid_from || NO_ACCOUNT} onValueChange={(v) => set("paid_from", v === NO_ACCOUNT ? "" : v)}>
                    <SelectTrigger id="bill-paid-from"><SelectValue placeholder="Which bank or account?" /></SelectTrigger>
                    <SelectContent><SelectItem value={NO_ACCOUNT}>Not set</SelectItem>{paidFromList.map((a) => <SelectItem key={a.code} value={a.code}>{a.code} {a.name}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              )}
              <div className="space-y-1.5"><Label htmlFor="bill-day">Due day of the month (1–28)</Label><Input id="bill-day" inputMode="numeric" value={form.due_day} onChange={(e) => set("due_day", e.target.value.replace(/\D/g, "").slice(0, 2))} /></div>
              <div className="space-y-1.5"><Label htmlFor="bill-starts">Starts</Label><Input id="bill-starts" type="date" value={form.starts_on} onChange={(e) => set("starts_on", e.target.value)} />
                {/^\d{4}-\d{2}-\d{2}$/.test(form.starts_on) && Number(form.due_day) >= 1 && Number(form.due_day) <= 28 && (
                  <p className="text-xs text-muted-foreground">First draft on {firstDue(form.starts_on, Number(form.due_day))}{form.id ? " (if the schedule changed)" : ""}.</p>
                )}
              </div>
              <div className="space-y-1.5"><Label htmlFor="bill-ends">Ends (optional)</Label><Input id="bill-ends" type="date" value={form.ends_on} onChange={(e) => set("ends_on", e.target.value)} /></div>
              <div className="space-y-1.5 sm:col-span-2 rounded-md border p-3">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="bill-spread">Spread each payment over several months (prepaid)</Label>
                  <Switch id="bill-spread" checked={form.spread} onCheckedChange={(v) => setForm((x) => x ? { ...x, spread: v, spread_months: v && !x.spread_months ? String(defaultSpread(x.frequency)) : x.spread_months } : x)} />
                </div>
                <p className="text-xs text-muted-foreground">For a yearly subscription, insurance or domain paid at once: the ledger books the payment as prepaid and releases one share at each month end, so no single month carries the whole bill.</p>
                {form.spread && (
                  <div className="flex items-center gap-2"><Input className="w-24" inputMode="numeric" aria-label="Months to spread over" value={form.spread_months} onChange={(e) => set("spread_months", e.target.value.replace(/\D/g, "").slice(0, 2))} /><span className="text-sm">months</span></div>
                )}
              </div>
              <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="bill-notes">Notes (optional)</Label><Textarea id="bill-notes" rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} /></div>
              {problem && <p className="text-xs text-destructive sm:col-span-2">{problem}</p>}
            </div>
          )}

          <DialogFooter>
            {form ? (
              <>
                <Button variant="ghost" onClick={() => setForm(null)}>Back</Button>
                <Button disabled={!!problem || save.isPending} onClick={() => form && save.mutate(form)}>{save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : form.id ? "Save bill" : "Add bill"}</Button>
              </>
            ) : (
              <Button variant="ghost" onClick={() => setOpen(false)}>Close</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

