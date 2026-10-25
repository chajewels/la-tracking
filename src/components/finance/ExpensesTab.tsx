import { useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban, Check, ChevronLeft, ChevronRight, FileText, Loader2, Paperclip, Pencil, Plus, Receipt, Search,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { isMissingFunction } from "@/components/website/shipping-fees";
import { callRpc } from "@/components/finance/useBookedMonths";
import {
  EXPENSE_BOOK_KEY, EXPENSE_GROUPS, EXPENSE_RECEIPT_BUCKET, PAYMENT_METHODS, STATUS_LABEL,
  type Expense, type ExpenseBookState, type ExpenseFilters, type ExpenseForm, type ExpenseGroupKey,
  type SourceFilter, type StatusFilter, SOURCE_FILTERS,
  canEnterManually, cleanAmountInput, detailLines, emptyExpenseForm, expensePayload, expenseRefusal, filterExpenses,
  monthFromSearch, sourceLabel,
  formFromExpense, formatAmount, formatYen, groupLabel, monthKeyTokyo, monthLabel, normaliseBook,
  paymentMethodLabel, previewJpy, receiptContentType, receiptPath, receiptProblem, shiftMonth, totalsByGroup,
  validateExpenseForm,
} from "@/components/finance/expenses";

/**
 * Finance → Expenses (Phase 1, owner 2026-10-25; plan claude/expenses-plan-2026-10-25.md).
 * Shown to holders of manage_expenses or approve_expenses (sidebar + Finance.tsx gate). Reading needs
 * manage_expenses or approve_expenses; adding/editing drafts and attaching receipts
 * need manage_expenses; Approve and Void need approve_expenses — every action is
 * re-checked and audited server-side (migration 20261230100000_expenses_ledger.sql).
 *
 * Until that migration is applied the RPCs do not exist (PGRST202): the tab says
 * "Waiting for the database update" instead of erroring.
 */

const NO_VENDOR = "__none";
const NEW_VENDOR = "__new";

function statusVariant(s: Expense["status"]): "default" | "secondary" | "outline" {
  if (s === "approved") return "default";
  if (s === "draft") return "secondary";
  return "outline";
}

function dateLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

export default function ExpensesTab() {
  const qc = useQueryClient();
  const location = useLocation();
  const [month, setMonth] = useState<string>(() => monthFromSearch(location.search) ?? monthKeyTokyo());
  const [filters, setFilters] = useState<ExpenseFilters>({ status: "all", group: "all", source: "all", search: "" });
  const [openDetails, setOpenDetails] = useState<Record<string, boolean>>({});
  const [form, setForm] = useState<ExpenseForm | null>(null);
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [voiding, setVoiding] = useState<Expense | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [vendorMode, setVendorMode] = useState<"pick" | "new">("pick");
  const [approving, setApproving] = useState<Expense | null>(null);

  const state = useQuery<ExpenseBookState>({
    queryKey: [...EXPENSE_BOOK_KEY, month],
    queryFn: async () => {
      try {
        const out = await callRpc("get_expense_book", { p_month: `${month}-01` });
        return { available: true, book: normaliseBook(out) };
      } catch (e) {
        if (isMissingFunction(e)) return { available: false };
        throw e;
      }
    },
    staleTime: 30_000,
  });
  const book = state.data?.available ? state.data.book : null;
  const expenses = useMemo(() => book?.expenses ?? [], [book]);
  const totals = useMemo(() => totalsByGroup(expenses), [expenses]);
  const shown = useMemo(() => filterExpenses(expenses, filters), [expenses, filters]);
  const refresh = () => qc.invalidateQueries({ queryKey: EXPENSE_BOOK_KEY });

  const onError = (e: Error & { code?: string }) => {
    toast({ title: "Not saved", description: expenseRefusal(e.code ?? e.message), variant: "destructive" });
  };

  const save = useMutation({
    mutationFn: async (v: { form: ExpenseForm; file: File | null }) => {
      const out = await callRpc("upsert_expense", { p: expensePayload(v.form) });
      const saved = out.expense as { id: string } | undefined;
      // From here on the draft exists: a retry must edit it, never insert a second one.
      if (saved?.id && !v.form.id) setForm((f) => (f ? { ...f, id: saved.id } : f));
      if (v.file && saved?.id) {
        try {
          const path = receiptPath(saved.id, v.file.name);
          const { error } = await supabase.storage.from(EXPENSE_RECEIPT_BUCKET)
            .upload(path, v.file, { cacheControl: "3600", upsert: false, contentType: receiptContentType(v.file) || undefined });
          if (error) return { created: !v.form.id, receiptFailed: true };
          await callRpc("attach_expense_receipt", { p_id: saved.id, p_path: path });
        } catch {
          return { created: !v.form.id, receiptFailed: true };
        }
      }
      return { created: !v.form.id, receiptFailed: false };
    },
    onSuccess: (r) => {
      toast({ title: r.created ? "Expense added as a draft" : "Expense saved" });
      if (r.receiptFailed) {
        toast({ title: "Receipt not uploaded", description: "The expense was saved. Edit it to try the receipt again.", variant: "destructive" });
      }
      setForm(null);
      setReceiptFile(null);
    },
    onError,
    onSettled: refresh,
  });

  const approve = useMutation({
    mutationFn: (id: string) => callRpc("approve_expense", { p_id: id }),
    onSuccess: () => {
      toast({ title: "Expense approved" });
      setApproving(null);
    },
    onError,
    onSettled: refresh,
  });

  const voidMut = useMutation({
    mutationFn: (v: { id: string; reason: string }) => callRpc("void_expense", { p_id: v.id, p_reason: v.reason }),
    onSuccess: () => {
      toast({ title: "Expense voided" });
      setVoiding(null);
      setVoidReason("");
    },
    onError,
    onSettled: refresh,
  });

  const openReceipt = async (path: string) => {
    const { data, error } = await supabase.storage.from(EXPENSE_RECEIPT_BUCKET).createSignedUrl(path, 600);
    if (error || !data?.signedUrl) {
      toast({ title: "Could not open the receipt", variant: "destructive" });
      return;
    }
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  };

  const formError = form ? validateExpenseForm(form) : null;
  const fileError = receiptFile ? receiptProblem(receiptFile) : null;
  const set = <K extends keyof ExpenseForm>(k: K, v: ExpenseForm[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const preview = form && book ? previewJpy(Number(form.amount), form.currency, book.php_jpy_rate) : null;
  const editing = form?.id ? expenses.find((e) => e.id === form.id) : undefined;

  const openForm = (f: ExpenseForm) => {
    setForm(f);
    setReceiptFile(null);
    setVendorMode("pick");
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center justify-between gap-3 text-base">
          <span className="flex items-center gap-2">
            <Receipt className="h-4 w-4 text-primary" />
            Expenses
          </span>
          <span className="flex items-center gap-1" data-testid="expenses-month-nav">
            <Button size="icon" variant="ghost" aria-label="Previous month" onClick={() => setMonth((m) => shiftMonth(m, -1))}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-[9rem] text-center text-sm font-medium" data-testid="expenses-month">{monthLabel(month)}</span>
            <Button size="icon" variant="ghost" aria-label="Next month" onClick={() => setMonth((m) => shiftMonth(m, 1))}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </span>
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4 text-sm">
        {state.isLoading && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        )}
        {state.data?.available === false && (
          <p className="rounded-md border border-dashed p-3 text-muted-foreground" data-testid="expenses-waiting">
            Waiting for the database update. Expenses appear here once the expenses migration has been applied.
          </p>
        )}
        {state.isError && (
          <p className="text-destructive" data-testid="expenses-read-error">Could not read the expenses. Try again in a moment.</p>
        )}

        {book && (
          <>
            {/* Totals */}
            <div className="grid gap-3 sm:grid-cols-2" data-testid="expenses-totals">
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">Approved this month</p>
                <p className="text-xl font-semibold" data-testid="expenses-total-approved">{formatYen(totals.approvedJpy)}</p>
              </div>
              <div className="rounded-md border border-dashed p-3">
                <p className="text-xs text-muted-foreground">Drafts waiting for approval (not counted)</p>
                <p className="text-xl font-semibold text-muted-foreground" data-testid="expenses-total-drafts">{formatYen(totals.draftJpy)}</p>
              </div>
            </div>
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" data-testid="expenses-groups">
              {totals.groups.map((g) => (
                <li key={g.key}>
                  <button
                    type="button"
                    onClick={() => setFilters((f) => ({ ...f, group: f.group === g.key ? "all" : g.key }))}
                    className={`w-full rounded-md border p-2.5 text-left transition-colors hover:bg-muted/50 ${filters.group === g.key ? "border-primary" : ""}`}
                    aria-pressed={filters.group === g.key}
                    data-testid={`expenses-group-${g.key}`}
                  >
                    <p className="text-xs text-muted-foreground">{g.label}</p>
                    <p className="font-semibold">{formatYen(g.approvedJpy)}</p>
                    {g.draftCount > 0 && (
                      <p className="text-xs text-muted-foreground">+ {formatYen(g.draftJpy)} in {g.draftCount} draft{g.draftCount === 1 ? "" : "s"}</p>
                    )}
                  </button>
                </li>
              ))}
            </ul>

            {/* Filters + add */}
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="expenses-status" className="text-xs">Status</Label>
                <Select value={filters.status} onValueChange={(v) => setFilters((f) => ({ ...f, status: v as StatusFilter }))}>
                  <SelectTrigger id="expenses-status" className="h-9 w-[9rem]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="draft">Drafts</SelectItem>
                    <SelectItem value="approved">Approved</SelectItem>
                    <SelectItem value="void">Void</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="expenses-group" className="text-xs">Group</Label>
                <Select value={filters.group} onValueChange={(v) => setFilters((f) => ({ ...f, group: v as "all" | ExpenseGroupKey }))}>
                  <SelectTrigger id="expenses-group" className="h-9 w-[13rem]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All groups</SelectItem>
                    {EXPENSE_GROUPS.map((g) => <SelectItem key={g.key} value={g.key}>{g.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="expenses-source" className="text-xs">Source</Label>
                <Select value={filters.source} onValueChange={(v) => setFilters((f) => ({ ...f, source: v as SourceFilter }))}>
                  <SelectTrigger id="expenses-source" className="h-9 w-[10rem]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {SOURCE_FILTERS.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="relative min-w-[12rem] flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  className="h-9 pl-8" placeholder="Search description, vendor, category"
                  value={filters.search} onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
                  aria-label="Search expenses"
                />
              </div>
              {book.can_manage && (
                <Button size="sm" className="h-9" onClick={() => openForm(emptyExpenseForm())} data-testid="expenses-add">
                  <Plus className="mr-1 h-4 w-4" /> Add expense
                </Button>
              )}
            </div>

            {/* List */}
            {shown.length === 0 ? (
              <p className="rounded-md border border-dashed p-4 text-center text-muted-foreground" data-testid="expenses-empty">
                {expenses.length === 0 ? `No expenses in ${monthLabel(month)} yet.` : "No expenses match these filters."}
              </p>
            ) : (
              <ul className="divide-y rounded-md border" data-testid="expenses-list">
                {shown.map((e) => (
                  <li key={e.id} className={`flex flex-wrap items-start justify-between gap-3 px-3 py-2.5 ${e.status === "void" ? "opacity-60" : ""}`} data-testid={`expense-${e.id}`}>
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="text-xs tabular-nums text-muted-foreground">{dateLabel(e.expense_date)}</span>
                        <span className={`font-medium ${e.status === "void" ? "line-through" : ""}`}>{e.description}</span>
                        <Badge variant={statusVariant(e.status)}>{STATUS_LABEL[e.status]}</Badge>
                        {e.source !== "manual" && <Badge variant="outline">{sourceLabel(e.source)}</Badge>}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {e.vendor_name ? `${e.vendor_name} · ` : ""}{groupLabel(e.group_key)} → {e.category_name} · {paymentMethodLabel(e.payment_method)}
                      </p>
                      {e.status === "void" && e.void_reason && (
                        <p className="text-xs text-muted-foreground">Void: {e.void_reason}</p>
                      )}
                      {e.notes && <p className="text-xs text-muted-foreground">{e.notes}</p>}
                      {detailLines(e.details).length > 0 && (
                        <div className="text-xs">
                          <button
                            type="button"
                            className="inline-flex min-h-[44px] items-center text-primary underline-offset-2 hover:underline sm:min-h-0"
                            aria-expanded={!!openDetails[e.id]}
                            onClick={() => setOpenDetails((o) => ({ ...o, [e.id]: !o[e.id] }))}
                            data-testid={`expense-details-toggle-${e.id}`}
                          >
                            {openDetails[e.id] ? "Hide details" : `Details (${detailLines(e.details).length})`}
                          </button>
                          {openDetails[e.id] && (
                            <ul className="mt-1.5 divide-y rounded-md border" data-testid={`expense-details-${e.id}`}>
                              {detailLines(e.details).map((d, i) => (
                                <li key={`${d.name}-${i}`} className="flex items-center justify-between gap-3 px-2.5 py-1.5">
                                  <span className="min-w-0"><span className="font-medium text-foreground">{d.name}</span> <span className="text-muted-foreground">· {d.meta}</span></span>
                                  <span className="tabular-nums text-foreground">{formatAmount(d.amount, "PHP")}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <div className="text-right">
                        <p className="font-semibold tabular-nums">{formatAmount(e.amount, e.currency)}</p>
                        {e.currency === "PHP" && (
                          <p className="text-xs tabular-nums text-muted-foreground">= {formatYen(e.amount_jpy)}</p>
                        )}
                      </div>
                      {e.receipt_path ? (
                        <Button size="icon" variant="ghost" className="h-11 w-11" aria-label="Open receipt" title="Open receipt" onClick={() => openReceipt(e.receipt_path as string)}>
                          <FileText className="h-4 w-4" />
                        </Button>
                      ) : (
                        <span className="inline-flex h-11 w-11 items-center justify-center text-muted-foreground/40" title="No receipt">
                          <Paperclip className="h-4 w-4" aria-hidden="true" />
                          <span className="sr-only">No receipt</span>
                        </span>
                      )}
                      {e.status === "draft" && book.can_manage && (
                        <Button size="sm" variant="outline" onClick={() => openForm(formFromExpense(e))} disabled={save.isPending}>
                          <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
                        </Button>
                      )}
                      {e.status === "draft" && book.can_approve && (
                        <Button size="sm" onClick={() => setApproving(e)} disabled={approve.isPending} data-testid={`expense-approve-${e.id}`}>
                          <Check className="mr-1 h-3.5 w-3.5" /> Approve
                        </Button>
                      )}
                      {e.status !== "void" && book.can_approve && (
                        <Button size="sm" variant="ghost" className="text-destructive" onClick={() => { setVoiding(e); setVoidReason(""); }}>
                          <Ban className="mr-1 h-3.5 w-3.5" /> Void
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">
              Totals count approved expenses only. Peso amounts are converted at the Hub's peso rate
              ({book.php_jpy_rate != null ? `¥1 = ₱${book.php_jpy_rate}` : "not set"}); the rate is fixed when the expense is approved.
              Expenses are never deleted — a wrong one is voided with a reason.
            </p>
          </>
        )}
      </CardContent>

      {/* Add / edit */}
      <Dialog open={form !== null} onOpenChange={(o) => { if (!o && !save.isPending) { setForm(null); setReceiptFile(null); } }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{form?.id ? "Edit expense" : "Add expense"}</DialogTitle>
            <DialogDescription>Saved as a draft. It counts in the totals once it is approved.</DialogDescription>
          </DialogHeader>
          {form && book && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="expense-date">Date</Label>
                <Input id="expense-date" type="date" value={form.expense_date} onChange={(e) => set("expense_date", e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="expense-method">Paid by</Label>
                <Select value={form.payment_method} onValueChange={(v) => set("payment_method", v as ExpenseForm["payment_method"])}>
                  <SelectTrigger id="expense-method"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PAYMENT_METHODS.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="expense-vendor">Vendor</Label>
                {vendorMode === "new" ? (
                  <div className="flex gap-2">
                    <Input id="expense-vendor" autoFocus value={form.new_vendor_name} maxLength={120}
                      placeholder="e.g. Vercel, BDO, tax accountant" onChange={(e) => set("new_vendor_name", e.target.value)} />
                    <Button type="button" variant="outline" onClick={() => { setVendorMode("pick"); set("new_vendor_name", ""); }}>
                      Pick from list
                    </Button>
                  </div>
                ) : (
                  <Select
                    value={form.vendor_id || NO_VENDOR}
                    onValueChange={(v) => {
                      if (v === NEW_VENDOR) { setVendorMode("new"); set("vendor_id", ""); return; }
                      if (v === NO_VENDOR) { set("vendor_id", ""); return; }
                      const vendor = book.vendors.find((x) => x.id === v);
                      setForm((f) => (f ? {
                        ...f, vendor_id: v, new_vendor_name: "",
                        category_id: f.category_id || vendor?.default_category_id || "",
                      } : f));
                    }}
                  >
                    <SelectTrigger id="expense-vendor"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_VENDOR}>No vendor</SelectItem>
                      {book.vendors.map((v) => <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>)}
                      <SelectItem value={NEW_VENDOR}>+ New vendor…</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="expense-category">Category</Label>
                <Select value={form.category_id} onValueChange={(v) => set("category_id", v)}>
                  <SelectTrigger id="expense-category"><SelectValue placeholder="Pick a category" /></SelectTrigger>
                  <SelectContent>
                    {EXPENSE_GROUPS.map((g) => {
                      const cats = book.categories.filter((c) => c.group_key === g.key && canEnterManually(c));
                      if (cats.length === 0) return null;
                      return (
                        <SelectGroup key={g.key}>
                          <SelectLabel>{g.label}</SelectLabel>
                          {cats.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                        </SelectGroup>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="expense-description">What it was for</Label>
                <Input id="expense-description" value={form.description} maxLength={500}
                  placeholder="e.g. Vercel October invoice" onChange={(e) => set("description", e.target.value)} />
              </div>

              <div className="grid grid-cols-[6.5rem_1fr] gap-2 sm:col-span-2">
                <div className="space-y-1.5">
                  <Label htmlFor="expense-currency">Currency</Label>
                  <Select value={form.currency} onValueChange={(v) => setForm((f) => (f ? {
                    ...f, currency: v as ExpenseForm["currency"], amount: cleanAmountInput(f.amount, v as ExpenseForm["currency"]),
                  } : f))}>
                    <SelectTrigger id="expense-currency"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="JPY">¥ JPY</SelectItem>
                      <SelectItem value="PHP">₱ PHP</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="expense-amount">Amount</Label>
                  <Input id="expense-amount" value={form.amount} inputMode="decimal"
                    placeholder={form.currency === "JPY" ? "15000" : "10000.00"}
                    onChange={(e) => set("amount", cleanAmountInput(e.target.value, form.currency))} />
                </div>
              </div>
              {form.currency === "PHP" && (
                <p className="text-xs text-muted-foreground sm:col-span-2" data-testid="expense-jpy-preview">
                  {preview != null && book.php_jpy_rate != null
                    ? `≈ ${formatYen(preview)} at ¥1 = ₱${book.php_jpy_rate}. The rate is fixed when the expense is approved.`
                    : "The yen amount appears once you enter the amount."}
                </p>
              )}

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="expense-receipt">Receipt (photo or PDF, up to 10 MB)</Label>
                {editing?.receipt_path && !receiptFile && (
                  <p className="text-xs text-muted-foreground">
                    A receipt is attached.{" "}
                    <button type="button" className="underline" onClick={() => openReceipt(editing.receipt_path as string)}>Open it</button>
                    {" "}— choosing a new file replaces it.
                  </p>
                )}
                <Input id="expense-receipt" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf"
                  onChange={(e) => setReceiptFile(e.target.files?.[0] ?? null)} />
                {fileError && <p className="text-xs text-destructive">{fileError}</p>}
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="expense-notes">Notes (optional)</Label>
                <Textarea id="expense-notes" rows={2} value={form.notes} maxLength={2000} onChange={(e) => set("notes", e.target.value)} />
              </div>
            </div>
          )}
          {formError && form && (form.description || form.amount || form.category_id) && (
            <p className="text-xs text-destructive" data-testid="expense-form-error">{formError}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setForm(null); setReceiptFile(null); }} disabled={save.isPending}>Cancel</Button>
            <Button
              onClick={() => form && save.mutate({ form, file: receiptFile })}
              disabled={!!formError || !!fileError || save.isPending || (vendorMode === "new" && !form?.new_vendor_name.trim())}
              data-testid="expense-save"
            >
              {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Approve */}
      <Dialog open={approving !== null} onOpenChange={(o) => { if (!o && !approve.isPending) setApproving(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Approve this expense?</DialogTitle>
            <DialogDescription>
              {approving ? `${approving.description} — ${formatAmount(approving.amount, approving.currency)}${approving.currency === "PHP" ? ` (≈ ${formatYen(approving.amount_jpy)})` : ""}. ` : ""}
              Once approved it counts in the totals and is locked{approving?.currency === "PHP" ? "; the peso rate is fixed now" : ""}. A mistake can only be voided.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApproving(null)} disabled={approve.isPending}>Cancel</Button>
            <Button onClick={() => approving && approve.mutate(approving.id)} disabled={approve.isPending} data-testid="expense-approve-confirm">
              {approve.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Approve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Void */}
      <Dialog open={voiding !== null} onOpenChange={(o) => { if (!o && !voidMut.isPending) setVoiding(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Void this expense?</DialogTitle>
            <DialogDescription>
              {voiding ? `${voiding.description} — ${formatAmount(voiding.amount, voiding.currency)}. ` : ""}
              It stays in the list, crossed out, and no longer counts. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="expense-void-reason">Reason</Label>
            <Textarea id="expense-void-reason" rows={2} value={voidReason} maxLength={500}
              placeholder="e.g. Entered twice" onChange={(e) => setVoidReason(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVoiding(null)} disabled={voidMut.isPending}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={voidReason.trim().length < 3 || voidMut.isPending}
              onClick={() => voiding && voidMut.mutate({ id: voiding.id, reason: voidReason.trim() })}
            >
              {voidMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Void expense
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
