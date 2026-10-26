import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Download, FileText, Loader2, Printer } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { downloadCsv } from "@/lib/csv";
import { callRpc } from "@/components/finance/useBookedMonths";
import { shiftMonth } from "@/components/finance/expenses";
import { dayLabel, formatNative, formatYen, ledgerRefusal, sourceTypeLabel } from "@/components/finance/ledger";
import { AgeingTables, BalanceSheetTable, CashFlowTable, IncomeStatementTable } from "@/components/finance/StatementTables";
import {
  JOURNAL_CSV_HEADER, STATEMENTS_KEY, STATEMENT_CSV_HEADER, type StatementRangeMode, type Statements,
  exportFileName, flaggedLines, journalCsvRows, normaliseJournalExport, normaliseStatements, rangeLabel, statementCsvRows, statementRange, statementRefusal, taxPackHref, validateFlags,
} from "@/components/finance/statements";

/**
 * Finance → Ledger → Statements (Expenses Phase 7, owner 2026-10-26 D1–D6).
 * Income statement in the accountant's 試算表 layout with prior-period / prior-year columns and flags, balance
 * sheet, indirect cash flow with its tie-out, receivable ageing and the 90-day collections forecast — all
 * read-only from `get_statements`. Admins edit the two flag thresholds here. The 税理士 pack is the same data
 * on a printable page (/finance/tax-pack), and the CSVs carry a UTF-8 BOM so Excel reads the 勘定科目 names.
 */

function refusal(e: unknown, fallback: string) {
  const code = (e as { code?: string })?.code ?? "";
  toast({ title: statementRefusal(code) || ledgerRefusal(code) || fallback, variant: "destructive" });
}

export default function StatementsSection({ thisMonth, startMonth, canAdmin }: { thisMonth: string; startMonth: number; canAdmin: boolean }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<StatementRangeMode>("month");
  const [month, setMonth] = useState(shiftMonth(thisMonth, -1));
  const r = statementRange(mode, month, startMonth);
  const step = mode === "month" ? 1 : mode === "quarter" ? 3 : mode === "fy" ? 12 : 1;

  const q = useQuery<Statements>({
    queryKey: [...STATEMENTS_KEY, r.from, r.to],
    staleTime: 15_000,
    queryFn: async () => normaliseStatements(await callRpc("get_statements", { p_from: r.from, p_to: r.to })),
  });
  const s = q.data;

  const [exporting, setExporting] = useState(false);
  const exportJournals = async () => {
    setExporting(true);
    try {
      const rows: unknown[][] = [];
      let offset = 0;
      for (let page = 0; page < 20; page++) {
        const out = normaliseJournalExport(await callRpc("get_journal_export", { p_from: r.from, p_to: r.to, p_offset: offset }));
        rows.push(...journalCsvRows(out.rows, sourceTypeLabel));
        offset += out.returned;
        if (!out.truncated || out.returned === 0) break;
      }
      downloadCsv(exportFileName("journals", r.from, r.to), JOURNAL_CSV_HEADER, rows, { bom: true, exactName: true });
      toast({ title: `${rows.length} journal line${rows.length === 1 ? "" : "s"} exported` });
    } catch (e) {
      refusal(e, "Could not export the journals");
    } finally {
      setExporting(false);
    }
  };
  const exportStatement = () => {
    if (!s) return;
    downloadCsv(exportFileName("income-statement", r.from, r.to), STATEMENT_CSV_HEADER, statementCsvRows(s.income_statement.lines), { bom: true, exactName: true });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-base">Statements</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={mode} onValueChange={(v) => setMode(v as StatementRangeMode)}>
                <SelectTrigger className="w-[150px] min-h-11" aria-label="Range"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="month">Month</SelectItem>
                  <SelectItem value="quarter">Quarter</SelectItem>
                  <SelectItem value="fy">Fiscal year</SelectItem>
                  <SelectItem value="ytd">Year to date</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="outline" size="icon" className="h-11 w-11" aria-label="Earlier" onClick={() => setMonth(shiftMonth(month, -step))}><ChevronLeft className="h-4 w-4" /></Button>
              <span className="min-w-[180px] text-center text-sm font-medium">{r.label}</span>
              <Button variant="outline" size="icon" className="h-11 w-11" aria-label="Later" onClick={() => setMonth(shiftMonth(month, step))}><ChevronRight className="h-4 w-4" /></Button>
              <span className="text-xs text-muted-foreground">{dayLabel(r.from)} – {dayLabel(r.to)}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <Button asChild variant="outline" size="sm" className="min-h-11"><a href={taxPackHref(r.from, r.to)} target="_blank" rel="noreferrer"><Printer className="h-4 w-4 mr-1" />税理士 pack (print / PDF)</a></Button>
            <Button variant="outline" size="sm" className="min-h-11" onClick={exportJournals} disabled={exporting}>{exporting ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Download className="h-4 w-4 mr-1" />}Journals CSV</Button>
            <Button variant="outline" size="sm" className="min-h-11" onClick={exportStatement} disabled={!s}><FileText className="h-4 w-4 mr-1" />Statement CSV</Button>
            {s && <span className="text-xs text-muted-foreground">{s.journal_count} journal{s.journal_count === 1 ? "" : "s"} in the period{s.comparisons.prior.available ? ` · compared with ${rangeLabel(s.comparisons.prior.from, s.comparisons.prior.to)}` : ""}</span>}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {q.isLoading && <div className="text-sm text-muted-foreground"><Loader2 className="inline h-4 w-4 animate-spin mr-2" />Building the statements…</div>}
          {q.isError && <div className="text-sm text-destructive">Could not build the statements. Try again in a moment.</div>}
          {s && (
            <>
              <FlagThresholds s={s} canAdmin={canAdmin} onSaved={() => qc.invalidateQueries({ queryKey: STATEMENTS_KEY })} />
              <FlagSummary s={s} />
            </>
          )}
        </CardContent>
      </Card>

      {s && (
        <>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">損益計算書 · Income statement</CardTitle></CardHeader>
            <CardContent><IncomeStatementTable s={s} /></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">貸借対照表 · Balance sheet</CardTitle></CardHeader>
            <CardContent><BalanceSheetTable s={s} /></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">キャッシュ・フロー計算書 · Cash flow (indirect)</CardTitle></CardHeader>
            <CardContent><CashFlowTable cf={s.cash_flow} /></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">売掛金年齢表 · Receivable ageing and collections forecast</CardTitle></CardHeader>
            <CardContent><AgeingTables a={s.ageing} /></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Notes for the 税理士</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div>
                <div className="font-medium">Booked outside the Hub</div>
                <p className="text-xs text-muted-foreground">These appear in the accountant's 試算表 but never in the Hub's books, so the statements above do not include them:</p>
                <ul className="mt-1 flex flex-wrap gap-2">{s.outside_hub.map((o) => <li key={o.label}><Badge variant="outline">{o.label_ja} · {o.label}</Badge></li>)}</ul>
              </div>
              <CurrencyChecks s={s} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function FlagThresholds({ s, canAdmin, onSaved }: { s: Statements; canAdmin: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [pct, setPct] = useState(String(s.flags.pct));
  const [jpy, setJpy] = useState(String(s.flags.jpy));
  const save = useMutation({
    mutationFn: () => callRpc("set_statement_flags", { p_pct: Number(pct.trim()), p_jpy: Number(jpy.replace(/[,\s¥]/g, "")) }),
    onSuccess: () => { toast({ title: "Flag thresholds saved" }); setEditing(false); onSaved(); },
    onError: (e) => refusal(e, "Could not save the thresholds"),
  });
  const err = validateFlags(pct, jpy);
  if (!canAdmin) return null;
  return (
    <div className="flex flex-wrap items-end gap-2 text-sm">
      {editing ? (
        <>
          <div><Label className="text-xs" htmlFor="flag-pct">Flag when a line moves ≥ %</Label><Input id="flag-pct" inputMode="decimal" className="min-h-11 w-[110px]" value={pct} onChange={(e) => setPct(e.target.value)} /></div>
          <div><Label className="text-xs" htmlFor="flag-jpy">or ≥ ¥</Label><Input id="flag-jpy" inputMode="numeric" className="min-h-11 w-[150px]" value={jpy} onChange={(e) => setJpy(e.target.value)} /></div>
          <Button size="sm" className="min-h-11" disabled={!!err || save.isPending} onClick={() => save.mutate()}>{save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}</Button>
          <Button size="sm" variant="ghost" className="min-h-11" onClick={() => { setEditing(false); setPct(String(s.flags.pct)); setJpy(String(s.flags.jpy)); }}>Cancel</Button>
          {err && <span className="text-xs text-destructive">{err}</span>}
        </>
      ) : (
        <Button size="sm" variant="ghost" className="min-h-11 px-2" onClick={() => setEditing(true)}>Flag thresholds: ±{s.flags.pct}% or ±¥{s.flags.jpy.toLocaleString("en-US")} · change</Button>
      )}
    </div>
  );
}

function FlagSummary({ s }: { s: Statements }) {
  const flagged = flaggedLines(s.income_statement.lines);
  if (!s.comparisons.prior.available) return <p className="text-xs text-muted-foreground">No comparison column: the prior period ({rangeLabel(s.comparisons.prior.from, s.comparisons.prior.to)}) is before the ledger start.</p>;
  if (flagged.length === 0) return <p className="text-xs text-muted-foreground">No line moved past the flag thresholds against {rangeLabel(s.comparisons.prior.from, s.comparisons.prior.to)}.</p>;
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm">
      <div className="font-medium">{flagged.length} line{flagged.length === 1 ? "" : "s"} moved past the flag thresholds</div>
      <ul className="mt-1 text-xs space-y-0.5">
        {flagged.map((l) => <li key={l.key}>{l.label_ja} {l.label}: {formatYen(l.prior ?? 0)} → {formatYen(l.cur)}{l.delta_pct != null ? ` (${l.delta_pct > 0 ? "+" : ""}${l.delta_pct}%)` : ""}</li>)}
      </ul>
    </div>
  );
}

export function CurrencyChecks({ s }: { s: Statements }) {
  const c = s.currency_checks;
  return (
    <div>
      <div className="font-medium">Domestic / export check</div>
      <p className="text-xs text-muted-foreground">A sale counts as export when the plan or order is in pesos and domestic when in yen. {c.count === 0 ? "Every sale in the period agrees with the customer's country." : `${c.count} sale${c.count === 1 ? "" : "s"} in the period ${c.count === 1 ? "has" : "have"} a currency that disagrees with the customer's country — check these before the 税理士 relies on the split:`}</p>
      {c.rows.length > 0 && (
        <ul className="mt-1 text-xs space-y-0.5">
          {c.rows.map((x) => (
            <li key={`${x.kind}-${x.id}`}>{dayLabel(x.order_date)} · {x.kind === "layaway" ? "Plan" : "Order"} {x.invoice_number} · {formatNative(x.amount, x.currency)} · customer in {x.country ?? "(no country)"}</li>
          ))}
          {c.count > c.rows.length && <li className="text-muted-foreground">…and {c.count - c.rows.length} more</li>}
        </ul>
      )}
    </div>
  );
}
