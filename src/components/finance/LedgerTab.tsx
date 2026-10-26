import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, BookOpen, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Download, Loader2, Lock, LockOpen,
  Play, Plus, RotateCcw, Trash2,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { isMissingFunction } from "@/components/website/shipping-fees";
import { callRpc } from "@/components/finance/useBookedMonths";
import { monthKeyTokyo, shiftMonth, todayTokyo } from "@/components/finance/expenses";
import CostOfGoodsSection from "@/components/finance/CostOfGoodsSection";
import ClearingFxSection from "@/components/finance/ClearingFxSection";
import { costCoverageLabel, normaliseRealProfit } from "@/components/finance/cogs";
import {
  JOURNAL_KIND_LABEL, KIND_LABEL, KIND_ORDER, LEDGER_COA_KEY, LEDGER_JOURNALS_KEY, LEDGER_STATUS_KEY, LEDGER_TB_KEY, SOURCE_TYPES,
  type GlAccount, type Journal, type JournalKind, type LedgerState, type ManualJournalForm, type MethodKind, type Period, type RangeMode,
  dayLabel, emptyManualForm, emptyManualLine, fiscalYearOf, formatNative, formatYen, lastRunLabel, ledgerRefusal, lineYen, longMonth,
  manualPayload, manualTotals, naturalBalance, normaliseAccounts, normaliseJournals, normaliseStatus, normaliseTrialBalance, postingSummary,
  profitSummary, rangeFor, sourceLink, sourceTypeLabel, trialBalanceTotals, validateManualForm,
} from "@/components/finance/ledger";

/**
 * Finance → Ledger (Expenses Phase 2b, owner 2026-10-25; plan claude/expenses-phase2b-ledger-plan-2026-10-25.md).
 * Shown with view_ledger. Post now / manual journals / reversals / mappings need post_journal; closing and
 * reopening months and the start date need close_period — all re-checked and audited server-side
 * (migration 20270101100000_general_ledger_core.sql). Before that migration is applied the RPCs do not exist
 * (PGRST202) and the tab says "Waiting for the database update".
 */

const METHOD_KINDS: { value: MethodKind; label: string }[] = [
  { value: "bank", label: "Bank account" }, { value: "cash", label: "Cash" }, { value: "clearing", label: "Provider clearing" },
  { value: "cod", label: "Carrier (COD)" }, { value: "non_cash", label: "Not money (discount / credit)" }, { value: "suspense", label: "Unknown" },
];

function refusalToast(e: unknown, fallback: string) {
  const code = (e as { code?: string })?.code ?? "";
  toast({ title: ledgerRefusal(code) || fallback, variant: "destructive" });
}

export default function LedgerTab() {
  const qc = useQueryClient();
  const today = todayTokyo();
  const thisMonth = monthKeyTokyo();
  const [view, setView] = useState<"journals" | "trial" | "cogs" | "clearing" | "accounts" | "periods">("journals");
  const [checkPending, setCheckPending] = useState(false);

  const state = useQuery<LedgerState>({
    queryKey: [...LEDGER_STATUS_KEY, checkPending],
    staleTime: 15_000,
    queryFn: async () => {
      try {
        const out = await callRpc("get_ledger_status", { p_check_pending: checkPending });
        return { available: true, status: normaliseStatus(out) };
      } catch (e) {
        if (isMissingFunction(e)) return { available: false };
        throw e;
      }
    },
  });

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: LEDGER_STATUS_KEY });
    qc.invalidateQueries({ queryKey: LEDGER_JOURNALS_KEY });
    qc.invalidateQueries({ queryKey: LEDGER_TB_KEY });
    qc.invalidateQueries({ queryKey: LEDGER_COA_KEY });
  };

  const postNow = useMutation({
    mutationFn: () => callRpc("gl_post_now"),
    onSuccess: (out) => {
      toast({ title: `Posted ${out.posted ?? 0}, reversed ${out.reversed ?? 0}${Number(out.moved) ? `, ${out.moved} moved to an open month` : ""}` });
      refreshAll();
    },
    onError: (e) => refusalToast(e, "Posting failed"),
  });

  if (state.isLoading) return <div className="p-6 text-sm text-muted-foreground"><Loader2 className="inline h-4 w-4 animate-spin mr-2" />Loading the ledger…</div>;
  if (state.isError) return <div className="p-6 text-sm text-destructive">Could not load the ledger. Try again in a moment.</div>;
  if (!state.data || !state.data.available) {
    return (
      <Card><CardContent className="p-6 text-sm text-muted-foreground">
        Waiting for the database update — the ledger appears here once the Finance → Ledger migration is applied.
      </CardContent></Card>
    );
  }
  const s = state.data.status;
  const closedPeriods = s.periods.filter((p) => p.status === "closed").map((p) => p.period_start);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 font-medium"><BookOpen className="h-4 w-4" />{postingSummary(s)}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {lastRunLabel(s.last_run)}{s.last_run?.note ? <span className="text-destructive"> · {s.last_run.note.split("\n")[0]}</span> : null}
                {s.ledger_start_date ? ` · Ledger starts ${dayLabel(s.ledger_start_date)}` : ""}
                {s.php_jpy_rate ? ` · ₱1 = ¥${(1 / s.php_jpy_rate).toFixed(2)} (system rate)` : " · peso rate not set"}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {!s.ledger_start_date && s.can_close && <StartLedgerDialog onDone={refreshAll} />}
              {s.ledger_start_date && !s.pending && (
                <Button size="sm" variant="outline" className="min-h-11" onClick={() => setCheckPending(true)}>Check for unposted events</Button>
              )}
              {s.ledger_start_date && s.can_post && (
                <Button size="sm" className="min-h-11" onClick={() => postNow.mutate()} disabled={postNow.isPending}>
                  {postNow.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Play className="h-4 w-4 mr-1" />}Post now
                </Button>
              )}
              {s.ledger_start_date && s.can_post && (
                <ManualJournalDialog rate={s.php_jpy_rate} ledgerStart={s.ledger_start_date} today={today} closedPeriods={closedPeriods} onDone={refreshAll} />
              )}
            </div>
          </div>
          {s.unmapped_methods.length > 0 && s.ledger_start_date && (
            <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm">
              <div className="flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4 text-amber-600" />Payment spellings not mapped to an account ({s.unmapped_methods.length})</div>
              <p className="text-xs text-muted-foreground mt-1">These payments are posted to 1190 Unidentified receipts until you say which account they went to. Mapping reposts them.</p>
              <div className="mt-2 space-y-2">
                {s.unmapped_methods.map((m) => <MapSpellingRow key={m.spelling} spelling={m.spelling} rows={m.rows} canPost={s.can_post} onDone={refreshAll} />)}
              </div>
            </div>
          )}
          {s.expenses_without_paid_from.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm">
              <div className="flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4 text-amber-600" />Approved expenses with no "Paid from" account ({s.expenses_without_paid_from.length})</div>
              <p className="text-xs text-muted-foreground mt-1">They are posted against 1190 Unidentified receipts. Open the expense in Finance → Expenses and set which bank or cash account paid it.</p>
              <ul className="mt-2 space-y-1">
                {s.expenses_without_paid_from.slice(0, 8).map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span>{dayLabel(e.expense_date)} · {e.description} · {formatNative(e.amount, e.currency)}</span>
                    <Link className="text-primary underline text-xs" to={`/finance?tab=expenses&month=${e.expense_date.slice(0, 7)}`}>Open month</Link>
                  </li>
                ))}
                {s.expenses_without_paid_from.length > 8 && <li className="text-xs text-muted-foreground">…and {s.expenses_without_paid_from.length - 8} more</li>}
              </ul>
            </div>
          )}
          {s.moved_count > 0 && (
            <p className="text-xs text-muted-foreground">{s.moved_count} journal{s.moved_count === 1 ? "" : "s"} landed in a later month because the original month was already closed (the original date is kept on each).</p>
          )}
        </CardContent>
      </Card>

      <Tabs value={view} onValueChange={(v) => setView(v as typeof view)}>
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="journals">Journals</TabsTrigger>
          <TabsTrigger value="trial">Trial balance</TabsTrigger>
          <TabsTrigger value="cogs">Cost of goods</TabsTrigger>
          <TabsTrigger value="clearing">Clearing &amp; FX</TabsTrigger>
          <TabsTrigger value="accounts">Accounts</TabsTrigger>
          <TabsTrigger value="periods">Months</TabsTrigger>
        </TabsList>
        <TabsContent value="journals"><JournalsView canPost={s.can_post} thisMonth={thisMonth} startMonth={s.fiscal_year_start_month} onChanged={refreshAll} /></TabsContent>
        <TabsContent value="trial"><TrialBalanceView thisMonth={thisMonth} startMonth={s.fiscal_year_start_month} /></TabsContent>
        <TabsContent value="cogs"><CostOfGoodsSection thisMonth={thisMonth} today={today} canPost={s.can_post} onChanged={refreshAll} /></TabsContent>
        <TabsContent value="clearing"><ClearingFxSection thisMonth={thisMonth} today={today} onChanged={refreshAll} /></TabsContent>
        <TabsContent value="accounts"><AccountsView canAdmin={s.can_admin} canPost={s.can_post} onChanged={refreshAll} /></TabsContent>
        <TabsContent value="periods"><PeriodsView periods={s.periods} canClose={s.can_close} ledgerStart={s.ledger_start_date} thisMonth={thisMonth} startMonth={s.fiscal_year_start_month} onChanged={refreshAll} /></TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------

function RangePicker({ mode, setMode, month, setMonth, startMonth }: {
  mode: RangeMode; setMode: (m: RangeMode) => void; month: string; setMonth: (m: string) => void; startMonth: number;
}) {
  const r = rangeFor(mode, month, startMonth);
  const step = mode === "month" ? 1 : mode === "quarter" ? 3 : 12;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={mode} onValueChange={(v) => setMode(v as RangeMode)}>
        <SelectTrigger className="w-[130px] min-h-11" aria-label="Range"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="month">Month</SelectItem>
          <SelectItem value="quarter">Quarter</SelectItem>
          <SelectItem value="fy">Fiscal year</SelectItem>
        </SelectContent>
      </Select>
      <Button variant="outline" size="icon" className="h-11 w-11" aria-label="Earlier" onClick={() => setMonth(shiftMonth(month, -step))}><ChevronLeft className="h-4 w-4" /></Button>
      <span className="min-w-[180px] text-center text-sm font-medium">{r.label}</span>
      <Button variant="outline" size="icon" className="h-11 w-11" aria-label="Later" onClick={() => setMonth(shiftMonth(month, step))}><ChevronRight className="h-4 w-4" /></Button>
      <span className="text-xs text-muted-foreground">{dayLabel(r.from)} – {dayLabel(r.to)}</span>
    </div>
  );
}

function JournalsView({ canPost, thisMonth, startMonth, onChanged }: { canPost: boolean; thisMonth: string; startMonth: number; onChanged: () => void }) {
  const [mode, setMode] = useState<RangeMode>("month");
  const [month, setMonth] = useState(thisMonth);
  const [kind, setKind] = useState<"all" | JournalKind>("all");
  const [source, setSource] = useState("all");
  const [account, setAccount] = useState("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(0); }, 350);
    return () => clearTimeout(t);
  }, [searchInput]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const r = rangeFor(mode, month, startMonth);
  const limit = 100;

  const coa = useQuery({ queryKey: LEDGER_COA_KEY, staleTime: 60_000, queryFn: async () => normaliseAccounts((await callRpc("get_chart_of_accounts", { p_as_of: null })).accounts) });

  const q = useQuery({
    queryKey: [...LEDGER_JOURNALS_KEY, r.from, r.to, kind, source, account, search, page],
    staleTime: 15_000,
    queryFn: async () => {
      const out = await callRpc("get_ledger", {
        p_from: r.from, p_to: r.to,
        p_account: account === "all" ? null : account,
        p_source_type: source === "all" ? null : source,
        p_kind: kind === "all" ? null : kind,
        p_search: search.trim() || null,
        p_limit: limit, p_offset: page * limit,
      });
      return { total: Number(out.total ?? 0), sum: Number(out.sum_jpy ?? 0), journals: normaliseJournals(out.journals) };
    },
  });

  const reverse = useMutation({
    mutationFn: (v: { id: string; reason: string }) => callRpc("reverse_journal", { p_id: v.id, p_reason: v.reason }),
    onSuccess: () => { toast({ title: "Journal reversed" }); onChanged(); },
    onError: (e) => refusalToast(e, "Could not reverse"),
  });

  const resetPage = () => setPage(0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-base">Journals</CardTitle>
          <RangePicker mode={mode} setMode={(m) => { setMode(m); resetPage(); }} month={month} setMonth={(m) => { setMonth(m); resetPage(); }} startMonth={startMonth} />
        </div>
        <div className="flex flex-wrap gap-2 pt-2">
          <Select value={kind} onValueChange={(v) => { setKind(v as typeof kind); resetPage(); }}>
            <SelectTrigger className="w-[150px] min-h-11" aria-label="Journal kind"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All kinds</SelectItem>
              {(Object.keys(JOURNAL_KIND_LABEL) as JournalKind[]).map((k) => <SelectItem key={k} value={k}>{JOURNAL_KIND_LABEL[k]}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={source} onValueChange={(v) => { setSource(v); resetPage(); }}>
            <SelectTrigger className="w-[220px] min-h-11" aria-label="Source"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              {SOURCE_TYPES.map((t) => <SelectItem key={t} value={t}>{sourceTypeLabel(t)}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={account} onValueChange={(v) => { setAccount(v); resetPage(); }}>
            <SelectTrigger className="w-[260px] min-h-11" aria-label="Account"><SelectValue placeholder="Account" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All accounts</SelectItem>
              {(coa.data ?? []).map((a) => <SelectItem key={a.code} value={a.code}>{a.code} {a.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Input className="min-h-11 w-[220px]" aria-label="Search journals" placeholder="Search invoice, memo, #" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {q.isLoading && <div className="text-sm text-muted-foreground"><Loader2 className="inline h-4 w-4 animate-spin mr-2" />Loading…</div>}
        {q.isError && <div className="text-sm text-destructive">Could not load journals.</div>}
        {q.data && (
          <>
            <div className="text-xs text-muted-foreground">{q.data.total.toLocaleString("en-US")} journal{q.data.total === 1 ? "" : "s"} · posted total {formatYen(q.data.sum)}</div>
            {q.data.journals.length === 0 && <div className="text-sm text-muted-foreground py-6 text-center">No journals in this range.</div>}
            <ul className="divide-y">
              {q.data.journals.map((j) => (
                <JournalRow key={j.id} j={j} open={!!open[j.id]} toggle={() => setOpen((o) => ({ ...o, [j.id]: !o[j.id] }))}
                  canPost={canPost} onReverse={(reason) => reverse.mutate({ id: j.id, reason })} />
              ))}
            </ul>
            {q.data.total > limit && (
              <div className="flex items-center justify-between pt-2 text-sm">
                <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                <span>Page {page + 1} of {Math.ceil(q.data.total / limit)}</span>
                <Button variant="outline" size="sm" disabled={(page + 1) * limit >= q.data.total} onClick={() => setPage((p) => p + 1)}>Next</Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function JournalRow({ j, open, toggle, canPost, onReverse }: { j: Journal; open: boolean; toggle: () => void; canPost: boolean; onReverse: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  const [asking, setAsking] = useState(false);
  const link = sourceLink(j);
  const reversible = canPost && j.status === "posted" && (j.kind === "manual" || j.kind === "opening");
  return (
    <li className="py-2">
      <button type="button" className="w-full text-left flex flex-wrap items-center gap-2 min-h-[44px]" onClick={toggle} aria-expanded={open}>
        {open ? <ChevronUp className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />}
        <span className="text-xs text-muted-foreground w-[64px]">#{j.journal_no}</span>
        <span className="text-sm w-[110px]">{dayLabel(j.entry_date)}</span>
        <span className="flex-1 text-sm">{j.description}</span>
        <Badge variant={j.kind === "auto" ? "secondary" : j.kind === "reversal" ? "outline" : "default"}>{JOURNAL_KIND_LABEL[j.kind]}</Badge>
        {j.status === "reversed" && <Badge variant="outline" className="line-through">reversed</Badge>}
        {j.entry_date !== j.source_date && <Badge variant="outline" title={`Event dated ${dayLabel(j.source_date)}; that month was closed`}>moved</Badge>}
        <span className="text-sm font-medium tabular-nums">{formatYen(j.total_jpy)}</span>
      </button>
      {open && (
        <div className="ml-6 mt-1 space-y-1 text-sm">
          <table className="w-full text-sm">
            <tbody>
              {j.lines.map((l) => (
                <tr key={l.id} className="border-t">
                  <td className="py-1 pr-2 w-[72px] text-muted-foreground">{l.account_code}</td>
                  <td className="py-1 pr-2">{l.account_name}{l.memo ? <span className="text-muted-foreground"> · {l.memo}</span> : null}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{l.debit > 0 ? formatNative(l.debit, l.currency) : ""}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{l.credit > 0 ? formatNative(l.credit, l.currency) : ""}</td>
                  <td className="py-1 text-right tabular-nums text-muted-foreground w-[110px]">{l.currency === "PHP" ? `≈ ${formatYen(l.debit > 0 ? l.debit_jpy : l.credit_jpy)}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground pt-1">
            <span>{sourceTypeLabel(j.source_type)}</span>
            {j.entry_date !== j.source_date && <span>Event date {dayLabel(j.source_date)}</span>}
            {j.reason && <span>Reason: {j.reason}</span>}
            {link && <Link to={link} className="text-primary underline">Open source</Link>}
            {reversible && !asking && <Button variant="ghost" size="sm" className="min-h-11" onClick={() => setAsking(true)}><RotateCcw className="h-3 w-3 mr-1" />Reverse</Button>}
          </div>
          {asking && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Input className="min-h-11 w-[280px]" aria-label="Reason for the reversal" placeholder="Why is this reversed? (≥ 3 characters)" value={reason} onChange={(e) => setReason(e.target.value)} />
              <Button size="sm" className="min-h-11" disabled={reason.trim().length < 3} onClick={() => { onReverse(reason.trim()); setAsking(false); setReason(""); }}>Confirm reversal</Button>
              <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>Cancel</Button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------

function TrialBalanceView({ thisMonth, startMonth }: { thisMonth: string; startMonth: number }) {
  const [mode, setMode] = useState<RangeMode>("month");
  const [month, setMonth] = useState(thisMonth);
  const r = rangeFor(mode, month, startMonth);
  const q = useQuery({
    queryKey: [...LEDGER_TB_KEY, r.from, r.to],
    staleTime: 15_000,
    queryFn: async () => normaliseTrialBalance((await callRpc("get_trial_balance", { p_from: r.from, p_to: r.to })).rows),
  });
  const rows = q.data ?? [];
  const totals = trialBalanceTotals(rows);
  const profit = profitSummary(rows);
  const real = useQuery({
    queryKey: ["finance", "ledger", "real-profit", r.from, r.to],
    staleTime: 15_000,
    queryFn: async () => normaliseRealProfit(await callRpc("fc_real_profit", { p_from: r.from, p_to: r.to })),
  });
  const coverage = real.data && real.data.ledger_started ? costCoverageLabel(real.data.sales_with_cost, real.data.sales_total) : null;

  const exportCsv = () => {
    const head = ["code", "name", "kind", "opening_jpy", "debit_jpy", "credit_jpy", "closing_jpy"];
    const body = rows.map((x) => [x.code, `"${x.name.replace(/"/g, '""')}"`, x.kind, x.opening_jpy, x.debit_jpy, x.credit_jpy, x.closing_jpy].join(","));
    const blob = new Blob([[head.join(","), ...body].join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `trial-balance-${r.from}-${r.to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-base">Trial balance</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <RangePicker mode={mode} setMode={setMode} month={month} setMonth={setMonth} startMonth={startMonth} />
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={rows.length === 0}><Download className="h-4 w-4 mr-1" />CSV</Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {q.isLoading && <div className="text-sm text-muted-foreground"><Loader2 className="inline h-4 w-4 animate-spin mr-2" />Loading…</div>}
        {q.isError && <div className="text-sm text-destructive">Could not load the trial balance.</div>}
        {q.data && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-sm">
              <Stat label="Revenue" value={profit.revenue} />
              <Stat label="Cost of sales" value={profit.cogs} sub={coverage ?? undefined} />
              <Stat label="Gross profit" value={profit.gross} sub={real.data && real.data.ledger_started && real.data.sales_with_cost < real.data.sales_total ? "incomplete until every sale has a cost" : undefined} />
              <Stat label="Operating expenses" value={profit.expenses} />
              <Stat label="Operating profit" value={profit.operating} strong />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr><th className="text-left py-1">Account</th><th className="text-right py-1">Opening</th><th className="text-right py-1">Debits</th><th className="text-right py-1">Credits</th><th className="text-right py-1">Closing</th><th className="text-right py-1">Balance</th></tr>
                </thead>
                <tbody>
                  {KIND_ORDER.map((k) => {
                    const group = rows.filter((x) => x.kind === k);
                    if (group.length === 0) return null;
                    return [
                      <tr key={`h-${k}`} className="border-t bg-muted/40"><td colSpan={6} className="py-1 font-medium">{KIND_LABEL[k]}</td></tr>,
                      ...group.map((x) => (
                        <tr key={x.code} className="border-t">
                          <td className="py-1"><span className="text-muted-foreground mr-2">{x.code}</span>{x.name}{x.contra ? <span className="text-xs text-muted-foreground"> (contra)</span> : null}</td>
                          <td className="py-1 text-right tabular-nums">{formatYen(x.opening_jpy)}</td>
                          <td className="py-1 text-right tabular-nums">{x.debit_jpy ? formatYen(x.debit_jpy) : ""}</td>
                          <td className="py-1 text-right tabular-nums">{x.credit_jpy ? formatYen(x.credit_jpy) : ""}</td>
                          <td className="py-1 text-right tabular-nums">{formatYen(x.closing_jpy)}</td>
                          <td className="py-1 text-right tabular-nums font-medium">{formatYen(naturalBalance(x))}</td>
                        </tr>
                      )),
                    ];
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t font-medium">
                    <td className="py-1">Total movements</td><td></td>
                    <td className="py-1 text-right tabular-nums">{formatYen(totals.debit)}</td>
                    <td className="py-1 text-right tabular-nums">{formatYen(totals.credit)}</td>
                    <td colSpan={2} className="py-1 text-right text-xs">{totals.balanced ? "Debits = credits" : <span className="text-destructive">Debits ≠ credits — tell Claude</span>}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">Closing = opening + debits − credits (debit-positive). Balance shows each account the way an accountant reads it. All figures in yen at the system rate; peso lines keep their native amount on each journal.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, strong, sub }: { label: string; value: number; strong?: boolean; sub?: string }) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`tabular-nums ${strong ? "font-semibold" : ""} ${value < 0 ? "text-destructive" : ""}`}>{formatYen(value)}</div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function AccountsView({ canAdmin, canPost, onChanged }: { canAdmin: boolean; canPost: boolean; onChanged: () => void }) {
  const q = useQuery({
    queryKey: [...LEDGER_COA_KEY, "full"],
    staleTime: 30_000,
    queryFn: async () => {
      const out = await callRpc("get_chart_of_accounts", { p_as_of: null });
      return { accounts: normaliseAccounts(out.accounts), map: (out.method_map ?? []) as { spelling: string; account_code: string; kind: MethodKind }[] };
    },
  });
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ code: "", name: "", kind: "expense" as GlAccount["kind"] });
  const upsert = useMutation({
    mutationFn: (p: Record<string, unknown>) => callRpc("upsert_gl_account", { p }),
    onSuccess: () => { toast({ title: "Account saved" }); setAdding(false); setForm({ code: "", name: "", kind: "expense" }); q.refetch(); onChanged(); },
    onError: (e) => refusalToast(e, "Could not save the account"),
  });
  const accounts = q.data?.accounts ?? [];
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-base">Chart of accounts</CardTitle>
          {canAdmin && <Button size="sm" variant="outline" onClick={() => setAdding((a) => !a)}><Plus className="h-4 w-4 mr-1" />Add account</Button>}
        </div>
        {adding && (
          <div className="flex flex-wrap items-end gap-2 pt-2">
            <div><Label className="text-xs" htmlFor="acct-code">Code (4 digits)</Label><Input id="acct-code" className="min-h-11 w-[110px]" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.replace(/\D/g, "").slice(0, 4) })} /></div>
            <div><Label className="text-xs" htmlFor="acct-name">Name</Label><Input id="acct-name" className="min-h-11 w-[260px]" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div><Label className="text-xs">Kind</Label>
              <Select value={form.kind} onValueChange={(v) => setForm({ ...form, kind: v as GlAccount["kind"] })}>
                <SelectTrigger className="min-h-11 w-[170px]" aria-label="Account kind"><SelectValue /></SelectTrigger>
                <SelectContent>{KIND_ORDER.map((k) => <SelectItem key={k} value={k}>{KIND_LABEL[k]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <Button size="sm" disabled={!/^[1-6]\d{3}$/.test(form.code) || form.name.trim().length === 0 || upsert.isPending} onClick={() => upsert.mutate({ code: form.code, name: form.name.trim(), kind: form.kind })}>Save</Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {q.isLoading && <div className="text-sm text-muted-foreground"><Loader2 className="inline h-4 w-4 animate-spin mr-2" />Loading…</div>}
        {q.isError && <div className="text-sm text-destructive">Could not load the chart of accounts.</div>}
        {q.data && KIND_ORDER.map((k) => {
          const group = accounts.filter((a) => a.kind === k);
          if (group.length === 0) return null;
          return (
            <div key={k}>
              <div className="font-medium text-sm mb-1">{KIND_LABEL[k]}</div>
              <table className="w-full text-sm">
                <tbody>
                  {group.map((a) => (
                    <tr key={a.code} className={`border-t ${a.active ? "" : "opacity-50"}`}>
                      <td className="py-1 w-[64px] text-muted-foreground">{a.code}</td>
                      <td className="py-1">{a.name}{a.contra ? <span className="text-xs text-muted-foreground"> (contra)</span> : null}{a.currency_hint ? <span className="text-xs text-muted-foreground"> · {a.currency_hint}</span> : null}{!a.active ? <span className="text-xs"> · inactive</span> : null}</td>
                      <td className="py-1 text-right tabular-nums">{formatYen(a.balance_jpy ?? 0)}</td>
                      {canAdmin && (
                        <td className="py-1 text-right w-[90px]">
                          {!a.system_key && (
                            <Button variant="ghost" size="sm" className="min-h-11" onClick={() => upsert.mutate({ code: a.code, name: a.name, active: !a.active })}>
                              {a.active ? "Deactivate" : "Activate"}
                            </Button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
        {q.data && (
          <div>
            <div className="font-medium text-sm mb-1">Payment spellings → accounts</div>
            <p className="text-xs text-muted-foreground mb-2">How each spelling typed into a payment's method maps to a ledger account. Cash picks 1010 or 1020 by the row's currency.</p>
            <div className="grid md:grid-cols-2 gap-1 text-sm">
              {q.data.map.map((m) => {
                const acc = accounts.find((a) => a.code === m.account_code);
                return canPost
                  ? <MapSpellingRow key={m.spelling} spelling={m.spelling} rows={0} canPost current={m.account_code} currentKind={m.kind} onDone={() => { q.refetch(); onChanged(); }} />
                  : <div key={m.spelling} className="flex justify-between border-t py-1"><span>{m.spelling}</span><span className="text-muted-foreground">{m.account_code} {acc?.name ?? ""}</span></div>;
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MapSpellingRow({ spelling, rows, canPost, current, currentKind, onDone }: {
  spelling: string; rows: number; canPost: boolean; current?: string; currentKind?: MethodKind; onDone: () => void;
}) {
  const coa = useQuery({ queryKey: LEDGER_COA_KEY, staleTime: 60_000, queryFn: async () => normaliseAccounts((await callRpc("get_chart_of_accounts", { p_as_of: null })).accounts) });
  const [code, setCode] = useState(current ?? "");
  const [kind, setKind] = useState<MethodKind>(currentKind ?? "bank");
  const save = useMutation({
    mutationFn: () => callRpc("set_payment_method_map", { p_spelling: spelling, p_account_code: code, p_kind: kind }),
    onSuccess: (out) => {
      const rp = (out.repost ?? {}) as Record<string, unknown>;
      toast({ title: `"${spelling}" → ${code}${Number(rp.posted) ? ` · ${rp.posted} journal${Number(rp.posted) === 1 ? "" : "s"} reposted` : ""}` });
      onDone();
    },
    onError: (e) => refusalToast(e, "Could not save the mapping"),
  });
  const candidates = (coa.data ?? []).filter((a) => a.active && (a.kind === "asset" && a.code < "1200" || a.code === "2300" || a.code === "4160" || a.code === "4170"));
  const changed = code !== (current ?? "") || kind !== (currentKind ?? "bank");
  return (
    <div className="flex flex-wrap items-center gap-2 border-t py-1">
      <span className="min-w-[140px]">{spelling}{rows > 0 ? <span className="text-xs text-muted-foreground"> · {rows} row{rows === 1 ? "" : "s"}</span> : null}</span>
      <Select value={code} onValueChange={setCode} disabled={!canPost}>
        <SelectTrigger className="min-h-11 w-[240px]" aria-label={`Account for ${spelling}`}><SelectValue placeholder="Account" /></SelectTrigger>
        <SelectContent>{candidates.map((a) => <SelectItem key={a.code} value={a.code}>{a.code} {a.name}</SelectItem>)}</SelectContent>
      </Select>
      <Select value={kind} onValueChange={(v) => setKind(v as MethodKind)} disabled={!canPost}>
        <SelectTrigger className="min-h-11 w-[200px]" aria-label={`Kind of account for ${spelling}`}><SelectValue /></SelectTrigger>
        <SelectContent>{METHOD_KINDS.map((k) => <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>)}</SelectContent>
      </Select>
      {canPost && <Button size="sm" className="min-h-11" disabled={!code || !changed || save.isPending} onClick={() => save.mutate()}>{save.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}</Button>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function PeriodsView({ periods, canClose, ledgerStart, thisMonth, startMonth, onChanged }: {
  periods: Period[];
  canClose: boolean; ledgerStart: string | null; thisMonth: string; startMonth: number; onChanged: () => void;
}) {
  const [fy, setFy] = useState(fiscalYearOf(thisMonth, startMonth));
  const [reopening, setReopening] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const close = useMutation({
    mutationFn: (p: string) => callRpc("close_period", { p_period_start: p, p_note: null }),
    onSuccess: () => { toast({ title: "Month closed" }); onChanged(); },
    onError: (e) => refusalToast(e, "Could not close the month"),
  });
  const reopen = useMutation({
    mutationFn: (v: { p: string; reason: string }) => callRpc("reopen_period", { p_period_start: v.p, p_reason: v.reason }),
    onSuccess: () => { toast({ title: "Month reopened" }); setReopening(null); setReason(""); onChanged(); },
    onError: (e) => refusalToast(e, "Could not reopen the month"),
  });
  const months = useMemo(() => {
    const out: string[] = [];
    const first = startMonth === 1 ? `${fy}-01` : `${fy - 1}-${String(startMonth).padStart(2, "0")}`;
    let k = first;
    for (let i = 0; i < 12; i++) { out.push(k); k = shiftMonth(k, 1); }
    return out;
  }, [fy, startMonth]);
  const byStart = new Map(periods.map((p) => [p.period_start, p]));
  const lastClosed = periods.filter((p) => p.status === "closed").map((p) => p.period_start).sort().pop() ?? null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-base">Months (fiscal year {startMonth === 5 ? "May – April" : `starts month ${startMonth}`})</CardTitle>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" className="h-11 w-11" aria-label="Earlier year" onClick={() => setFy((y) => y - 1)}><ChevronLeft className="h-4 w-4" /></Button>
            <span className="text-sm font-medium min-w-[70px] text-center">FY{fy}</span>
            <Button variant="outline" size="icon" className="h-11 w-11" aria-label="Later year" onClick={() => setFy((y) => y + 1)}><ChevronRight className="h-4 w-4" /></Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">Close a month once the accountant has it. Months close in order; a closed month refuses new entries — anything that changes later lands in the next open month with its original date kept.</p>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {months.map((m) => {
            const key = `${m}-01`;
            const p = byStart.get(key);
            const closed = p?.status === "closed";
            const beforeStart = ledgerStart ? key < ledgerStart.slice(0, 7) + "-01" : true;
            const ended = m < thisMonth;
            const canCloseThis = canClose && !closed && !beforeStart && ended;
            const canReopenThis = canClose && closed && lastClosed === key;
            return (
              <li key={m} className="flex flex-wrap items-center justify-between gap-2 py-2 min-h-[44px]">
                <div className="flex items-center gap-2 text-sm">
                  {closed ? <Lock className="h-4 w-4 text-muted-foreground" /> : <LockOpen className="h-4 w-4 text-muted-foreground" />}
                  <span className="font-medium">{longMonth(m)}</span>
                  {closed && p?.closed_at && <span className="text-xs text-muted-foreground">closed {new Date(p.closed_at).toLocaleDateString("en-GB", { timeZone: "Asia/Tokyo" })}</span>}
                  {beforeStart && <span className="text-xs text-muted-foreground">before the ledger start</span>}
                  {!ended && !beforeStart && <span className="text-xs text-muted-foreground">{m === thisMonth ? "current month" : "future"}</span>}
                </div>
                <div className="flex items-center gap-2">
                  {canCloseThis && <Button size="sm" variant="outline" className="min-h-11" onClick={() => close.mutate(key)} disabled={close.isPending}><Lock className="h-3 w-3 mr-1" />Close</Button>}
                  {canReopenThis && reopening !== key && <Button size="sm" variant="ghost" className="min-h-11" onClick={() => setReopening(key)}><LockOpen className="h-3 w-3 mr-1" />Reopen</Button>}
                  {reopening === key && (
                    <>
                      <Input className="min-h-11 w-[240px]" aria-label="Reason for reopening" placeholder="Why reopen? (≥ 3 characters)" value={reason} onChange={(e) => setReason(e.target.value)} />
                      <Button size="sm" className="min-h-11" disabled={reason.trim().length < 3 || reopen.isPending} onClick={() => reopen.mutate({ p: key, reason: reason.trim() })}>Confirm</Button>
                      <Button size="sm" variant="ghost" onClick={() => { setReopening(null); setReason(""); }}>Cancel</Button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function StartLedgerDialog({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const m = useMutation({
    mutationFn: () => callRpc("set_ledger_start", { p_date: date }),
    onSuccess: () => { toast({ title: `Ledger starts ${dayLabel(date)}` }); setOpen(false); onDone(); },
    onError: (e) => refusalToast(e, "Could not set the start date"),
  });
  const ok = /^\d{4}-\d{2}-01$/.test(date);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}><Play className="h-4 w-4 mr-1" />Start the ledger</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start the ledger</DialogTitle>
            <DialogDescription>Journals are posted for every payment, sale, forfeiture, store-credit move, refund and approved expense from this date on. Opening balances (from the accountant) are then entered as an opening journal dated on this day. The date must be the first of a month and cannot change once journals exist.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="ledger-start">Start date (first of a month)</Label>
            <Input id="ledger-start" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            {date && !ok && <p className="text-xs text-destructive">Pick the first day of a month.</p>}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={!ok || m.isPending} onClick={() => m.mutate()}>{m.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Start"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ManualJournalDialog({ rate, ledgerStart, today, closedPeriods, onDone }: {
  rate: number | null; ledgerStart: string; today: string; closedPeriods: string[]; onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ManualJournalForm>(() => emptyManualForm(today));
  const coa = useQuery({ queryKey: LEDGER_COA_KEY, staleTime: 60_000, enabled: open, queryFn: async () => normaliseAccounts((await callRpc("get_chart_of_accounts", { p_as_of: null })).accounts) });
  const accounts = (coa.data ?? []).filter((a) => a.active);
  const totals = manualTotals(form, rate);
  const problem = validateManualForm(form, rate, ledgerStart, today, closedPeriods);
  const post = useMutation({
    mutationFn: () => callRpc("post_manual_journal", { p: manualPayload(form) }),
    onSuccess: (out) => {
      const j = (out.journal ?? {}) as Record<string, unknown>;
      toast({ title: `Journal #${j.journal_no ?? ""} posted` });
      setOpen(false); setForm(emptyManualForm(today)); onDone();
    },
    onError: (e) => refusalToast(e, "Could not post the journal"),
  });
  const setLine = (i: number, patch: Partial<ManualJournalForm["lines"][number]>) =>
    setForm((f) => ({ ...f, lines: f.lines.map((l, k) => (k === i ? { ...l, ...patch } : l)) }));
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}><Plus className="h-4 w-4 mr-1" />Manual journal</Button>
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setForm(emptyManualForm(today)); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Manual journal</DialogTitle>
            <DialogDescription>For entries the Hub has no event for: owner draws, capital, opening balances, corrections. Debits and credits must match in yen. Posted journals can only be reversed, never edited.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid md:grid-cols-3 gap-3">
              <div><Label htmlFor="mj-date">Date</Label><Input id="mj-date" type="date" value={form.entry_date} min={ledgerStart} max={today} onChange={(e) => setForm({ ...form, entry_date: e.target.value })} /></div>
              <div>
                <Label>Kind</Label>
                <Select value={form.kind} onValueChange={(v) => setForm({ ...form, kind: v as ManualJournalForm["kind"], entry_date: v === "opening" ? ledgerStart : form.entry_date })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="manual">Manual entry</SelectItem><SelectItem value="opening">Opening balances</SelectItem></SelectContent>
                </Select>
              </div>
              <div><Label htmlFor="mj-desc">Description</Label><Input id="mj-desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="e.g. Owner capital contribution" /></div>
            </div>
            <div className="space-y-2">
              {form.lines.map((l, i) => (
                <div key={l.key} className="grid grid-cols-12 gap-2 items-end">
                  <div className="col-span-12 md:col-span-5">
                    {i === 0 && <Label className="text-xs">Account</Label>}
                    <Select value={l.account} onValueChange={(v) => setLine(i, { account: v })}>
                      <SelectTrigger className="min-h-11" aria-label={`Line ${i + 1} account`}><SelectValue placeholder="Account" /></SelectTrigger>
                      <SelectContent>{accounts.map((a) => <SelectItem key={a.code} value={a.code}>{a.code} {a.name}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="col-span-4 md:col-span-2">
                    {i === 0 && <Label className="text-xs">Side</Label>}
                    <Select value={l.side} onValueChange={(v) => setLine(i, { side: v as "dr" | "cr" })}>
                      <SelectTrigger className="min-h-11" aria-label={`Line ${i + 1} side`}><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="dr">Debit</SelectItem><SelectItem value="cr">Credit</SelectItem></SelectContent>
                    </Select>
                  </div>
                  <div className="col-span-4 md:col-span-2">
                    {i === 0 && <Label className="text-xs">Currency</Label>}
                    <Select value={l.currency} onValueChange={(v) => setLine(i, { currency: v as "JPY" | "PHP" })}>
                      <SelectTrigger className="min-h-11" aria-label={`Line ${i + 1} currency`}><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="JPY">¥ JPY</SelectItem><SelectItem value="PHP">₱ PHP</SelectItem></SelectContent>
                    </Select>
                  </div>
                  <div className="col-span-4 md:col-span-2">
                    {i === 0 && <Label className="text-xs">Amount</Label>}
                    <Input className="min-h-11" inputMode="decimal" aria-label={`Line ${i + 1} amount`} value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value.replace(/[^\d.]/g, "") })} />
                    {l.currency === "PHP" && lineYen(l, rate) != null && <div className="text-[11px] text-muted-foreground">≈ {formatYen(lineYen(l, rate)!)}</div>}
                  </div>
                  <div className="col-span-12 md:col-span-1 flex justify-end">
                    <Button variant="ghost" size="icon" className="h-11 w-11" aria-label="Remove line" disabled={form.lines.length <= 2} onClick={() => setForm({ ...form, lines: form.lines.filter((_, k) => k !== i) })}><Trash2 className="h-4 w-4" /></Button>
                  </div>
                </div>
              ))}
              <Button variant="outline" size="sm" disabled={form.lines.length >= 50} onClick={() => setForm({ ...form, lines: [...form.lines, emptyManualLine(totals.debit > totals.credit ? "cr" : "dr")] })}><Plus className="h-4 w-4 mr-1" />Add line</Button>
            </div>
            <div className="flex flex-wrap justify-between text-sm">
              <span>Debits {formatYen(totals.debit)} · Credits {formatYen(totals.credit)}</span>
              <span className={totals.balanced ? "text-green-700" : "text-muted-foreground"}>{totals.balanced ? "Balanced" : `Difference ${formatYen(totals.debit - totals.credit)}`}</span>
            </div>
            <div><Label htmlFor="mj-reason">Note (optional)</Label><Textarea id="mj-reason" rows={2} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></div>
            {problem && <p className="text-xs text-destructive">{problem}</p>}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={!!problem || post.isPending} onClick={() => post.mutate()}>{post.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Post journal"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

