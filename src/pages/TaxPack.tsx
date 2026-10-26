import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Download, Loader2, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePermissions } from "@/contexts/PermissionsContext";
import { downloadCsv } from "@/lib/csv";
import { toast } from "@/hooks/use-toast";
import { callRpc } from "@/components/finance/useBookedMonths";
import { monthKeyTokyo, todayTokyo } from "@/components/finance/expenses";
import { KIND_LABEL, KIND_ORDER, LEDGER_TB_KEY, dayLabel, formatYen, ledgerRefusal, naturalBalance, normaliseAccounts, normaliseTrialBalance, sourceTypeLabel } from "@/components/finance/ledger";
import { FX_KEY, RATE_HISTORY_KEY, normaliseFx, normaliseRateHistory } from "@/components/finance/clearing";
import { AgeingTables, BalanceSheetTable, CashFlowTable, IncomeStatementTable } from "@/components/finance/StatementTables";
import { CurrencyChecks } from "@/components/finance/StatementsSection";
import {
  COMPANY_NAME_JA, JOURNAL_CSV_HEADER, STATEMENTS_KEY, TRIAL_BALANCE_CSV_HEADER, type Statements,
  collectJournalRows, exportFileName, fiscalYearSpan, normaliseJournalExport, normaliseStatements, parseTaxPackParams, rangeLabel, statementRefusal, trialBalanceCsvRows,
} from "@/components/finance/statements";

/**
 * /finance/tax-pack?from=YYYY-MM-DD&to=YYYY-MM-DD — the 税理士 pack (Expenses Phase 7, D1).
 * A print-ready page: cover, 試算表 (trial balance with 勘定科目), 損益計算書, 貸借対照表, キャッシュ・フロー, 売掛金年齢表,
 * the month-end peso revaluation, and the notes. "Print / Save as PDF" uses the browser's own print dialog —
 * no PDF library (dependencies are frozen). Opens from Ledger → Statements and Ledger → Months. view_ledger.
 */
function refusal(e: unknown, fallback: string) {
  const code = (e as { code?: string })?.code ?? "";
  toast({ title: statementRefusal(code) || ledgerRefusal(code) || fallback, variant: "destructive" });
}

export default function TaxPack() {
  const { can, loading } = usePermissions();
  const location = useLocation();
  const thisMonth = monthKeyTokyo();
  const { from, to } = parseTaxPackParams(location.search, thisMonth);
  const allowed = can("view_ledger");

  const s = useQuery<Statements>({
    queryKey: [...STATEMENTS_KEY, from, to], staleTime: 15_000, enabled: allowed,
    queryFn: async () => normaliseStatements(await callRpc("get_statements", { p_from: from, p_to: to })),
  });
  const tb = useQuery({
    queryKey: [...LEDGER_TB_KEY, from, to], staleTime: 15_000, enabled: allowed,
    queryFn: async () => normaliseTrialBalance((await callRpc("get_trial_balance", { p_from: from, p_to: to })).rows),
  });
  const coa = useQuery({
    queryKey: ["finance", "ledger", "accounts", "names"], staleTime: 60_000, enabled: allowed,
    queryFn: async () => normaliseAccounts((await callRpc("get_chart_of_accounts", { p_as_of: null })).accounts),
  });
  const fx = useQuery({
    queryKey: [...FX_KEY, to.slice(0, 7)], staleTime: 15_000, enabled: allowed,
    queryFn: async () => normaliseFx(await callRpc("get_fx_revaluation", { p_month: `${to.slice(0, 7)}-01` })),
  });
  const rates = useQuery({
    queryKey: RATE_HISTORY_KEY, staleTime: 60_000, enabled: allowed,
    queryFn: async () => normaliseRateHistory(await callRpc("get_rate_history")),
  });
  const nameJa = (code: string) => (coa.data ?? []).find((a) => a.code === code)?.name_ja ?? "";

  const [exporting, setExporting] = useState(false);
  const exportJournals = async () => {
    setExporting(true);
    try {
      const { rows, capped } = await collectJournalRows(
        async (offset) => normaliseJournalExport(await callRpc("get_journal_export", { p_from: from, p_to: to, p_offset: offset })), sourceTypeLabel);
      downloadCsv(exportFileName("journals", from, to), JOURNAL_CSV_HEADER, rows, { bom: true, exactName: true });
      if (capped) toast({ title: `Export stopped at ${rows.length.toLocaleString("en-US")} lines — narrow the range for the rest`, variant: "destructive" });
    } catch (e) {
      refusal(e, "Could not export the journals");
    } finally {
      setExporting(false);
    }
  };
  const exportTb = () => {
    if (!tb.data) return;
    downloadCsv(exportFileName("trial-balance", from, to), TRIAL_BALANCE_CSV_HEADER, trialBalanceCsvRows(tb.data, nameJa), { bom: true, exactName: true });
  };

  if (loading) return <div className="min-h-screen flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  if (!allowed) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 p-6 text-sm">
        <p>The 税理士 pack needs the "View ledger" permission.</p>
        <Button asChild variant="outline"><Link to="/finance">Back to Finance</Link></Button>
      </div>
    );
  }
  const data = s.data;
  const periodRates = (rates.data?.history ?? []).filter((h) => h.effective_from >= from && h.effective_from <= to);
  const rateAtStart = (rates.data?.history ?? []).filter((h) => h.effective_from <= from).sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0];

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto my-4 w-[min(960px,96vw)] print:my-0 print:w-full">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 print:hidden">
          <Button asChild variant="ghost" size="sm" className="min-h-11"><Link to="/finance?tab=ledger"><ArrowLeft className="h-4 w-4 mr-1" />Ledger</Link></Button>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" className="min-h-11" onClick={exportTb} disabled={!tb.data}><Download className="h-4 w-4 mr-1" />Trial balance CSV</Button>
            <Button size="sm" variant="outline" className="min-h-11" onClick={exportJournals} disabled={exporting}>{exporting ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Download className="h-4 w-4 mr-1" />}Journals CSV</Button>
            <Button size="sm" className="min-h-11" onClick={() => window.print()} disabled={!data}><Printer className="h-4 w-4 mr-1" />Print / Save as PDF</Button>
          </div>
        </div>

        {s.isLoading && <div className="p-6 text-sm text-muted-foreground"><Loader2 className="inline h-4 w-4 animate-spin mr-2" />Building the pack…</div>}
        {s.isError && <div className="p-6 text-sm text-destructive">{statementRefusal((s.error as { code?: string })?.code ?? "") ?? "Could not build the pack. Check the dates in the address bar and try again."}</div>}

        {data && (
          <div className="statement-print-area tax-pack rounded-xl border border-border bg-card p-6 sm:p-8 text-card-foreground space-y-8">
            <section className="tax-pack-cover">
              <p className="font-display text-xl tracking-wide">{COMPANY_NAME_JA}</p>
              <h1 className="text-2xl font-semibold mt-2">決算資料 · Financial statements pack</h1>
              <p className="mt-1 text-sm">対象期間 / Period: <strong>{dayLabel(data.from)} – {dayLabel(data.to)}</strong> ({rangeLabel(data.from, data.to)})</p>
              <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 text-sm max-w-xl">
                <dt className="text-muted-foreground">作成日 / Prepared</dt><dd>{dayLabel(todayTokyo())}</dd>
                <dt className="text-muted-foreground">会計年度 / Fiscal year</dt><dd>starts {dayLabel(data.fiscal_year_start)} ({fiscalYearSpan(data.fiscal_year_start_month)})</dd>
                <dt className="text-muted-foreground">帳簿開始日 / Ledger start</dt><dd>{data.ledger_start ? dayLabel(data.ledger_start) : "not set"}</dd>
                <dt className="text-muted-foreground">仕訳数 / Journals in the period</dt><dd>{data.journal_count.toLocaleString("en-US")}</dd>
                <dt className="text-muted-foreground">為替レート / Peso rate</dt>
                <dd>{data.rate ? `₱1 = ¥${(1 / data.rate).toFixed(2)} (${data.rate} PHP per JPY) today` : "not set"}{rateAtStart ? `; ${rateAtStart.rate} at the start of the period` : ""}{periodRates.length > 0 ? `; changed ${periodRates.length} time${periodRates.length === 1 ? "" : "s"} in the period (${periodRates.map((h) => `${dayLabel(h.effective_from)} → ${h.rate}`).join(", ")})` : "; unchanged in the period"}</dd>
              </dl>
              <p className="mt-4 text-xs text-muted-foreground">
                All amounts in yen, tax-inclusive, as recorded in the Cha Jewels Hub ledger. Peso transactions are converted at the Hub rate on the day they were booked; peso balances are revalued at each month end (為替差損益).
                Sales are split 国内 / 輸出 by the currency of the plan or order. Items the accountant books outside the Hub are listed in the notes.
              </p>
            </section>

            <section className="tax-pack-section">
              <h2 className="text-lg font-semibold mb-2">試算表 · Trial balance</h2>
              {tb.data ? <TrialBalance rows={tb.data} nameJa={nameJa} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
            </section>
            <section className="tax-pack-section">
              <h2 className="text-lg font-semibold mb-2">損益計算書 · Income statement</h2>
              <IncomeStatementTable s={data} />
            </section>
            <section className="tax-pack-section">
              <h2 className="text-lg font-semibold mb-2">貸借対照表 · Balance sheet</h2>
              <BalanceSheetTable s={data} />
            </section>
            <section className="tax-pack-section">
              <h2 className="text-lg font-semibold mb-2">キャッシュ・フロー計算書 · Cash flow statement (indirect)</h2>
              <CashFlowTable cf={data.cash_flow} />
            </section>
            <section className="tax-pack-section">
              <h2 className="text-lg font-semibold mb-2">売掛金年齢表 · Receivable ageing</h2>
              <AgeingTables a={data.ageing} />
            </section>
            <section className="tax-pack-section">
              <h2 className="text-lg font-semibold mb-2">外貨建資産・負債の評価替え · Peso revaluation at {fx.data ? dayLabel(fx.data.month_end) : "month end"}</h2>
              {fx.data && fx.data.rows.length > 0 ? (
                <table className="w-full text-sm statement-table">
                  <thead className="text-xs text-muted-foreground"><tr><th className="text-left py-1">Account</th><th className="text-right py-1">₱ balance</th><th className="text-right py-1">Carrying ¥</th><th className="text-right py-1">At {fx.data.rate_used}</th><th className="text-right py-1">This month's adjustment</th></tr></thead>
                  <tbody>
                    {fx.data.rows.map((r) => (
                      <tr key={r.account} className="border-t">
                        <td className="py-1"><span className="text-muted-foreground mr-2">{r.account}</span>{nameJa(r.account) ? <span className="mr-2">{nameJa(r.account)}</span> : null}<span className="text-muted-foreground">{r.name}</span></td>
                        <td className="py-1 text-right tabular-nums">₱{r.native_php.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        <td className="py-1 text-right tabular-nums">{formatYen(r.carrying_jpy)}</td>
                        <td className="py-1 text-right tabular-nums">{formatYen(r.target_jpy)}</td>
                        <td className="py-1 text-right tabular-nums">{formatYen(r.increment_jpy)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="text-sm text-muted-foreground">No peso balances to revalue.</p>}
              <p className="text-xs text-muted-foreground mt-2">Unrealised; posted to 4950 為替差益 / 6800 為替差損 by the month-end revaluation journal.</p>
            </section>
            <section className="tax-pack-section space-y-3 text-sm">
              <h2 className="text-lg font-semibold">注記 · Notes</h2>
              <div>
                <div className="font-medium">Hub外で計上される項目 · Booked outside the Hub</div>
                <p className="text-xs text-muted-foreground">Not in these statements; the accountant books them directly: {data.outside_hub.map((o) => `${o.label_ja} (${o.label})`).join(", ")}.</p>
              </div>
              <CurrencyChecks s={data} />
              <div>
                <div className="font-medium">Basis</div>
                <p className="text-xs text-muted-foreground">
                  Derived double-entry ledger: every sale, payment, refund, fee, payroll, commission, cost of goods and expense is posted from the Hub's own records; manual journals and the opening balances are the only typed entries.
                  Revenue is recognised when the first payment of a plan or order arrives; forfeited and cancelled plans reverse their sale; penalty and forfeiture income are recognised when collected or forfeited.
                  Comparison columns are blank before the ledger start.{data.ledger_start === data.from ? " This period begins at the ledger start, so the opening balances appear as capital and cash movements in the cash flow." : ""}
                  {" "}3900 役員引出金 is the owner's drawings shown as a deduction from equity; the accountant reclassifies it (役員貸付金 or 役員報酬) at year end.
                </p>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function TrialBalance({ rows, nameJa }: { rows: ReturnType<typeof normaliseTrialBalance>; nameJa: (code: string) => string }) {
  const debit = rows.reduce((s, r) => s + r.debit_jpy, 0);
  const credit = rows.reduce((s, r) => s + r.credit_jpy, 0);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm statement-table">
        <thead className="text-xs text-muted-foreground">
          <tr><th className="text-left py-1">科目 / Account</th><th className="text-right py-1">期首残高 Opening</th><th className="text-right py-1">借方 Debit</th><th className="text-right py-1">貸方 Credit</th><th className="text-right py-1">期末残高 Closing</th><th className="text-right py-1">残高 Balance</th></tr>
        </thead>
        <tbody>
          {KIND_ORDER.map((k) => {
            const group = rows.filter((x) => x.kind === k && (x.opening_jpy !== 0 || x.debit_jpy !== 0 || x.credit_jpy !== 0));
            if (group.length === 0) return null;
            return [
              <tr key={`h-${k}`} className="border-t bg-muted/40"><td colSpan={6} className="py-1 font-medium">{KIND_LABEL[k]}</td></tr>,
              ...group.map((x) => (
                <tr key={x.code} className="border-t">
                  <td className="py-1"><span className="text-muted-foreground mr-2">{x.code}</span>{nameJa(x.code) ? <span className="mr-2">{nameJa(x.code)}</span> : null}<span className="text-muted-foreground">{x.name}</span>{x.contra ? <span className="text-xs text-muted-foreground"> (contra)</span> : null}</td>
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
          <tr className="border-t font-medium"><td className="py-1">合計 / Total movements</td><td></td><td className="py-1 text-right tabular-nums">{formatYen(debit)}</td><td className="py-1 text-right tabular-nums">{formatYen(credit)}</td><td colSpan={2} className="py-1 text-right text-xs">{debit === credit ? "借方 = 貸方" : "Debits ≠ credits"}</td></tr>
        </tfoot>
      </table>
    </div>
  );
}

