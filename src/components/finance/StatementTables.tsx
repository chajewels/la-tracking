import { AlertTriangle } from "lucide-react";
import { dayLabel, formatYen } from "@/components/finance/ledger";
import {
  BS_SECTIONS, BS_SECTION_LABEL, BS_GROUP_LABEL, CF_SECTIONS, CF_SECTION_LABEL, FORECAST_BUCKETS, LAYAWAY_BUCKETS, ORDER_BUCKETS, PL_SECTIONS, PL_SECTION_LABEL,
  type Ageing, type CashFlow, type PlLine, type Statements,
  bsGroups, bsSectionTotal, cfSectionLines, deltaPctLabel, pctLabel, plSectionLines, rangeLabel, signedYen,
} from "@/components/finance/statements";

/**
 * The statement tables (Expenses Phase 7). Presentational only — shared by the Statements tab and the
 * printable 税理士 pack so both show exactly the same figures. Every number comes from `get_statements`.
 */

const yen = (n: number) => <span className={`tabular-nums ${n < 0 ? "text-destructive" : ""}`}>{formatYen(n)}</span>;
const yenOrDash = (n: number | null) => (n == null ? <span className="text-muted-foreground">—</span> : yen(n));

export function IncomeStatementTable({ s, ja = true }: { s: Statements; ja?: boolean }) {
  const { prior, prior_year } = s.comparisons;
  const lines = s.income_statement.lines;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm statement-table">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className="text-left py-1">{ja ? "科目 / Line" : "Line"}</th>
            <th className="text-right py-1">{rangeLabel(s.from, s.to)}</th>
            <th className="text-right py-1">{prior.available ? rangeLabel(prior.from, prior.to) : "Prior period"}</th>
            <th className="text-right py-1">Δ</th>
            <th className="text-right py-1">Δ %</th>
            <th className="text-right py-1">{prior_year.available ? rangeLabel(prior_year.from, prior_year.to) : "Prior year"}</th>
          </tr>
        </thead>
        <tbody>
          {PL_SECTIONS.map((sec) => {
            const ls = plSectionLines(lines, sec);
            if (ls.length === 0) return null;
            return [
              <tr key={`h-${sec}`} className="border-t bg-muted/40"><td colSpan={6} className="py-1 font-medium">{ja ? `${PL_SECTION_LABEL[sec].ja} · ` : ""}{PL_SECTION_LABEL[sec].en}</td></tr>,
              ...ls.map((l) => <PlRow key={l.key} l={l} ja={ja} />),
            ];
          })}
        </tbody>
      </table>
      <p className="text-xs text-muted-foreground mt-2">
        Gross margin {pctLabel(s.income_statement.gross_margin_pct)} · operating margin {pctLabel(s.income_statement.operating_margin_pct)}.
        {!prior.available && " The prior period is before the ledger start, so Δ is blank."}
        {" "}Flags: a line moves by at least {s.flags.pct}% or ¥{s.flags.jpy.toLocaleString("en-US")} against the prior period.
      </p>
    </div>
  );
}

function PlRow({ l, ja }: { l: PlLine; ja: boolean }) {
  const total = l.level === 0;
  const sub = l.level === 2;
  return (
    <tr className={`border-t ${total ? "font-semibold bg-muted/20" : ""} ${sub ? "text-muted-foreground" : ""}`}>
      <td className={`py-1 ${sub ? "pl-6" : l.level === 1 ? "pl-3" : ""}`}>
        {ja && l.label_ja ? <span className="mr-2">{l.label_ja}</span> : null}
        <span className={ja && l.label_ja ? "text-muted-foreground" : ""}>{l.label}</span>
        {l.flag && l.level >= 1 ? <AlertTriangle className="inline h-3.5 w-3.5 ml-1 text-amber-600 print:text-black" aria-label="Flagged change" /> : null}
      </td>
      <td className="py-1 text-right">{yen(l.cur)}</td>
      <td className="py-1 text-right">{yenOrDash(l.prior)}</td>
      <td className="py-1 text-right tabular-nums">{l.prior == null ? <span className="text-muted-foreground">—</span> : signedYen(l.delta)}</td>
      <td className="py-1 text-right tabular-nums">{deltaPctLabel(l.delta_pct)}</td>
      <td className="py-1 text-right">{yenOrDash(l.prior_year)}</td>
    </tr>
  );
}

export function BalanceSheetTable({ s, ja = true }: { s: Statements; ja?: boolean }) {
  const bs = s.balance_sheet;
  const half = (sections: typeof BS_SECTIONS) => sections.map((sec) => {
    const groups = bsGroups(bs.lines, sec);
    const tot = bsSectionTotal(bs.lines, sec);
    if (groups.length === 0) return null;
    return [
      <tr key={`h-${sec}`} className="border-t bg-muted/40"><td colSpan={3} className="py-1 font-medium">{ja ? `${BS_SECTION_LABEL[sec].ja} · ` : ""}{BS_SECTION_LABEL[sec].en}</td></tr>,
      ...groups.flatMap((g) => [
        ...(g.lines.length > 1 || sec === "current_assets"
          ? [<tr key={`g-${sec}-${g.group}`} className="border-t text-muted-foreground"><td className="py-1 pl-2">{ja ? `${BS_GROUP_LABEL[g.group].ja} · ` : ""}{BS_GROUP_LABEL[g.group].en}</td><td className="py-1 text-right">{yen(g.cur)}</td><td className="py-1 text-right">{yen(g.prior)}</td></tr>]
          : []),
        ...g.lines.map((l) => (
          <tr key={l.key} className="border-t">
            <td className="py-1 pl-5">{l.code ? <span className="text-muted-foreground mr-2">{l.code}</span> : null}{ja && l.label_ja ? <span className="mr-2">{l.label_ja}</span> : null}<span className={ja && l.label_ja ? "text-muted-foreground" : ""}>{l.label}</span>{l.contra ? <span className="text-xs text-muted-foreground"> (contra)</span> : null}</td>
            <td className="py-1 text-right">{yen(l.cur)}</td>
            <td className="py-1 text-right">{yen(l.prior)}</td>
          </tr>
        )),
      ]),
      <tr key={`t-${sec}`} className="border-t font-semibold"><td className="py-1">{ja ? `${BS_SECTION_LABEL[sec].ja}合計 · ` : ""}Total {BS_SECTION_LABEL[sec].en.toLowerCase()}</td><td className="py-1 text-right">{yen(tot.cur)}</td><td className="py-1 text-right">{yen(tot.prior)}</td></tr>,
    ];
  });
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm statement-table">
        <thead className="text-xs text-muted-foreground">
          <tr><th className="text-left py-1">{ja ? "科目 / Account" : "Account"}</th><th className="text-right py-1">{dayLabel(bs.as_of)}</th><th className="text-right py-1">{dayLabel(bs.prior_as_of)}</th></tr>
        </thead>
        <tbody>
          {half(["current_assets", "fixed_assets"])}
          <tr className="border-t font-semibold bg-muted/20"><td className="py-1">{ja ? "資産合計 · " : ""}Total assets</td><td className="py-1 text-right">{yen(bs.totals.assets)}</td><td className="py-1 text-right">{yen(bs.totals.prior_assets)}</td></tr>
          {half(["current_liabilities", "fixed_liabilities", "equity"])}
          <tr className="border-t font-semibold bg-muted/20"><td className="py-1">{ja ? "負債・純資産合計 · " : ""}Total liabilities and equity</td><td className="py-1 text-right">{yen(bs.totals.liabilities + bs.totals.equity)}</td><td className="py-1 text-right">{yen(bs.totals.prior_liabilities + bs.totals.prior_equity)}</td></tr>
        </tbody>
      </table>
      <p className={`text-xs mt-2 ${bs.totals.check === 0 && bs.totals.prior_check === 0 ? "text-muted-foreground" : "text-destructive"}`}>
        {bs.totals.check === 0 && bs.totals.prior_check === 0
          ? "Assets = liabilities + equity on both dates. Equity includes the profit of the fiscal year to date and of earlier years since the ledger start."
          : `Assets − liabilities − equity = ${formatYen(bs.totals.check)} (${formatYen(bs.totals.prior_check)} at the earlier date) — tell Claude.`}
      </p>
    </div>
  );
}

export function CashFlowTable({ cf, ja = true }: { cf: CashFlow; ja?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm statement-table">
        <tbody>
          {CF_SECTIONS.map((sec) => {
            const { lines, total } = cfSectionLines(cf, sec);
            if (lines.length === 0) return null;
            return [
              <tr key={`h-${sec}`} className="border-t bg-muted/40"><td colSpan={2} className="py-1 font-medium">{ja ? `${CF_SECTION_LABEL[sec].ja} · ` : ""}{CF_SECTION_LABEL[sec].en}</td></tr>,
              ...lines.map((l) => (
                <tr key={l.key} className="border-t"><td className="py-1 pl-3">{ja ? <span className="mr-2">{l.label_ja}</span> : null}<span className={ja ? "text-muted-foreground" : ""}>{l.label}</span></td><td className="py-1 text-right">{yen(l.amount)}</td></tr>
              )),
              <tr key={`t-${sec}`} className="border-t font-semibold"><td className="py-1">{ja ? "小計 · " : ""}Net cash from {CF_SECTION_LABEL[sec].en.toLowerCase()}</td><td className="py-1 text-right">{yen(total)}</td></tr>,
            ];
          })}
          <tr className="border-t font-semibold bg-muted/20"><td className="py-1">{ja ? "現金及び預金の増減額 · " : ""}Net change in cash and deposits</td><td className="py-1 text-right">{yen(cf.net_change)}</td></tr>
          <tr className="border-t"><td className="py-1">{ja ? "期首残高 · " : ""}Cash and deposits at the start</td><td className="py-1 text-right">{yen(cf.cash_open)}</td></tr>
          <tr className="border-t"><td className="py-1">{ja ? "期末残高 · " : ""}Cash and deposits at the end</td><td className="py-1 text-right">{yen(cf.cash_close)}</td></tr>
          <tr className="border-t"><td className="py-1">{ja ? "実際の増減額 · " : ""}Actual change (end − start)</td><td className="py-1 text-right">{yen(cf.actual_change)}</td></tr>
          <tr className={`border-t ${cf.difference === 0 ? "text-muted-foreground" : "text-destructive font-semibold"}`}><td className="py-1">{ja ? "差異 · " : ""}Difference (statement − actual)</td><td className="py-1 text-right tabular-nums">{formatYen(cf.difference)}</td></tr>
        </tbody>
      </table>
      <p className="text-xs text-muted-foreground mt-2">
        Indirect method: profit, then every change in a non-cash account. Of the actual change, {formatYen(cf.unrealised_fx_on_cash)} is the month-end peso revaluation of cash (no money moved).
      </p>
    </div>
  );
}

export function AgeingTables({ a, ja = true }: { a: Ageing; ja?: boolean }) {
  const php = (n: number) => `₱${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="overflow-x-auto">
        <div className="font-medium text-sm mb-1">{ja ? "売掛金年齢表（分割払い） · " : ""}Layaway receivables by days past due</div>
        <table className="w-full text-sm statement-table">
          <thead className="text-xs text-muted-foreground"><tr><th className="text-left py-1">Bucket</th><th className="text-right py-1">Plans</th><th className="text-right py-1">₱</th><th className="text-right py-1">¥</th><th className="text-right py-1">Total ¥</th></tr></thead>
          <tbody>
            {LAYAWAY_BUCKETS.map((b) => { const x = a.layaway[b.key]; return (
              <tr key={b.key} className={`border-t ${b.key === "d90p" && x.total_jpy > 0 ? "text-destructive" : ""}`}>
                <td className="py-1">{ja ? <span className="mr-2">{b.ja}</span> : null}{b.label}</td><td className="py-1 text-right tabular-nums">{x.plans ?? 0}</td>
                <td className="py-1 text-right tabular-nums">{x.php ? php(x.php) : ""}</td><td className="py-1 text-right tabular-nums">{x.jpy ? formatYen(x.jpy) : ""}</td><td className="py-1 text-right">{yen(x.total_jpy)}</td>
              </tr>); })}
            <tr className="border-t font-semibold"><td className="py-1">Open on the schedule</td><td></td><td></td><td></td><td className="py-1 text-right">{yen(LAYAWAY_BUCKETS.reduce((s, b) => s + a.layaway[b.key].total_jpy, 0))}</td></tr>
            <tr className="border-t text-muted-foreground"><td className="py-1" colSpan={4}>Ledger balance 1200 Layaway receivable</td><td className="py-1 text-right">{yen(a.ledger.layaway_jpy)}</td></tr>
          </tbody>
        </table>
      </div>
      <div className="space-y-4">
        <div className="overflow-x-auto">
          <div className="font-medium text-sm mb-1">{ja ? "売掛金（一括注文） · " : ""}Unpaid cash orders by order age</div>
          <table className="w-full text-sm statement-table">
            <thead className="text-xs text-muted-foreground"><tr><th className="text-left py-1">Bucket</th><th className="text-right py-1">Orders</th><th className="text-right py-1">Total ¥</th></tr></thead>
            <tbody>
              {ORDER_BUCKETS.map((b) => { const x = a.cash_orders[b.key]; return (
                <tr key={b.key} className="border-t"><td className="py-1">{ja ? <span className="mr-2">{b.ja}</span> : null}{b.label}</td><td className="py-1 text-right tabular-nums">{x.orders ?? 0}</td><td className="py-1 text-right">{yen(x.total_jpy)}</td></tr>); })}
              <tr className="border-t text-muted-foreground"><td className="py-1" colSpan={2}>Ledger balance 1210 Cash order receivable</td><td className="py-1 text-right">{yen(a.ledger.orders_jpy)}</td></tr>
            </tbody>
          </table>
        </div>
        <div className="overflow-x-auto">
          <div className="font-medium text-sm mb-1">{ja ? "入金予定（90日） · " : ""}Scheduled collections, next 90 days</div>
          <table className="w-full text-sm statement-table">
            <thead className="text-xs text-muted-foreground"><tr><th className="text-left py-1">Window</th><th className="text-right py-1">Lines</th><th className="text-right py-1">₱</th><th className="text-right py-1">¥</th><th className="text-right py-1">Total ¥</th></tr></thead>
            <tbody>
              {FORECAST_BUCKETS.map((b) => { const x = a.forecast[b.key]; return (
                <tr key={b.key} className="border-t"><td className="py-1">{ja ? <span className="mr-2">{b.ja}</span> : null}{b.label}</td><td className="py-1 text-right tabular-nums">{x.lines ?? 0}</td>
                  <td className="py-1 text-right tabular-nums">{x.php ? php(x.php) : ""}</td><td className="py-1 text-right tabular-nums">{x.jpy ? formatYen(x.jpy) : ""}</td><td className="py-1 text-right">{yen(x.total_jpy)}</td></tr>); })}
            </tbody>
          </table>
        </div>
      </div>
      <p className="text-xs text-muted-foreground md:col-span-2">
        As of {dayLabel(a.as_of)}{a.requested_as_of && a.requested_as_of > a.as_of ? ` (the period ends ${dayLabel(a.requested_as_of)}, in the future — aged as of today)` : ""}; peso lines at the Hub rate{a.rate ? ` (₱1 = ¥${(1 / a.rate).toFixed(2)})` : ""}.
        {a.basis === "current_open_lines_aged_at_date" ? " The schedule keeps no history, so today's open instalments are aged as they stood on that date; instalments paid since then are not shown." : ""}
        {" "}Only pending, partly paid and overdue instalments of live plans count; the ledger balance beside each table is the receivable the books carry.
      </p>
    </div>
  );
}
