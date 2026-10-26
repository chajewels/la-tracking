import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Loader2, Upload } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { callRpc } from "@/components/finance/useBookedMonths";
import { shiftMonth } from "@/components/finance/expenses";
import { LEDGER_JOURNALS_KEY, LEDGER_STATUS_KEY, LEDGER_TB_KEY, dayLabel, formatNative, formatYen, longMonth } from "@/components/finance/ledger";
import {
  COGS_KEY, INVENTORY_KEY, type SaleCostRow, cleanYen, cogsRefusal, costCoverageLabel, costSourceLabel, importSummary, normaliseSalesCosts,
  normaliseValuation, parseCostCsv, saleCostProblem, saleDescription, sortForWork, stockAdjustment,
} from "@/components/finance/cogs";

/**
 * Finance → Ledger → "Cost of goods" (Expenses Phase 5, owner 2026-10-26). Every sale booked in the month with
 * its real cost — set here by finance (manage_expenses), copied from the product's cost basis, or MISSING.
 * No percentage anywhere. CSV import by invoice number; stock at cost vs the ledger's inventory; the
 * stock-count adjustment is a manual journal the owner confirms.
 */

function refusal(e: unknown, fallback: string) {
  const code = (e as { code?: string })?.code ?? "";
  toast({ title: cogsRefusal(code) || fallback, variant: "destructive" });
}

export default function CostOfGoodsSection({ thisMonth, today, canPost, onChanged }: { thisMonth: string; today: string; canPost: boolean; onChanged: () => void }) {
  const qc = useQueryClient();
  const [month, setMonth] = useState(thisMonth);
  const [editing, setEditing] = useState<SaleCostRow | null>(null);
  const q = useQuery({
    queryKey: [...COGS_KEY, month],
    staleTime: 15_000,
    queryFn: async () => normaliseSalesCosts(await callRpc("get_sales_costs", { p_month: `${month}-01` })),
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: COGS_KEY }); qc.invalidateQueries({ queryKey: INVENTORY_KEY });
    qc.invalidateQueries({ queryKey: LEDGER_STATUS_KEY }); qc.invalidateQueries({ queryKey: LEDGER_JOURNALS_KEY }); qc.invalidateQueries({ queryKey: LEDGER_TB_KEY });
    onChanged();
  };
  const rows = useMemo(() => sortForWork(q.data?.sales ?? []), [q.data]);
  const d = q.data;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-base">Cost of goods</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="icon" className="h-11 w-11" aria-label="Earlier month" onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft className="h-4 w-4" /></Button>
              <span className="min-w-[150px] text-center text-sm font-medium">{longMonth(month)}</span>
              <Button variant="outline" size="icon" className="h-11 w-11" aria-label="Later month" onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight className="h-4 w-4" /></Button>
              {d?.can_set && <ImportCostsDialog onDone={refresh} />}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            The cost of the pieces in each sale, in yen. Set it per sale here or import a CSV by invoice number; pieces listed on the website carry their cost basis automatically. A sale without a cost posts no cost of goods — nothing is estimated.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {q.isLoading && <div className="text-sm text-muted-foreground"><Loader2 className="inline h-4 w-4 animate-spin mr-2" />Loading…</div>}
          {q.isError && <div className="text-sm text-destructive">Could not load the sales.</div>}
          {d && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
                <Stat label="Sales booked" value={String(d.sales.length)} />
                <Stat label="Revenue (¥)" value={formatYen(d.revenue_jpy)} />
                <Stat label="Cost of goods known" value={formatYen(d.cost_jpy)} sub={costCoverageLabel(d.sales.length - d.missing_count, d.sales.length)} />
                <Stat label="Cost missing" value={String(d.missing_count)} warn={d.missing_count > 0} sub={d.older_missing_count > 0 ? `${d.older_missing_count} older sale${d.older_missing_count === 1 ? "" : "s"} since the ledger start also missing` : undefined} />
              </div>
              {!d.ledger_start && <p className="text-xs text-amber-700 dark:text-amber-400">The ledger has no start date yet — costs can be entered now and will post once the start is set.</p>}
              {rows.length === 0 && <p className="text-sm text-muted-foreground py-4 text-center">No sales were booked in {longMonth(month)}.</p>}
              {rows.length > 0 && (
                <ul className="divide-y" data-testid="cogs-sales">
                  {rows.map((r) => {
                    const missing = r.cost_jpy == null;
                    const link = r.sale_type === "layaway" ? `/accounts/${r.id}` : `/cash-orders/${r.id}`;
                    return (
                      <li key={`${r.sale_type}:${r.id}`} className="py-2 flex flex-wrap items-center justify-between gap-2" data-testid={`cogs-${r.invoice_number}`}>
                        <div className="min-w-0 text-sm space-y-0.5">
                          <p className="flex flex-wrap items-center gap-2">
                            <Link to={link} className="font-medium text-primary underline">{r.invoice_number}</Link>
                            <span className="text-muted-foreground">{dayLabel(r.sale_date)}</span>
                            <span>{saleDescription(r)}</span>
                            {r.is_trade && <Badge variant="outline">trade-in</Badge>}
                            {missing ? <Badge variant="destructive">cost missing</Badge> : <Badge variant="secondary">{costSourceLabel(r.cost_source)}</Badge>}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Revenue {formatNative(r.revenue, r.currency)}{r.currency === "PHP" ? ` (≈ ${formatYen(r.revenue_jpy)})` : ""}
                            {!missing ? ` · cost ${formatYen(r.cost_jpy ?? 0)} · gross ${formatYen(r.revenue_jpy - (r.cost_jpy ?? 0))}` : ""}
                            {r.note ? ` · ${r.note}` : ""}
                          </p>
                        </div>
                        {d.can_set && (
                          <Button size="sm" variant={missing ? "default" : "outline"} className="min-h-11" onClick={() => setEditing(r)}>
                            {missing ? "Set cost" : "Change cost"}
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <InventoryCard today={today} canPost={canPost} onChanged={refresh} />

      {editing && <SetCostDialog row={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); refresh(); }} />}
    </div>
  );
}

function Stat({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`tabular-nums font-medium ${warn ? "text-destructive" : ""}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function SetCostDialog({ row, onClose, onDone }: { row: SaleCostRow; onClose: () => void; onDone: () => void }) {
  const [cost, setCost] = useState(row.cost_source === "manual" && row.cost_jpy != null ? String(row.cost_jpy) : "");
  const [note, setNote] = useState(row.note ?? "");
  const problem = saleCostProblem(cost);
  const save = useMutation({
    mutationFn: (clear: boolean) => callRpc("set_sale_cost", { p_sale_type: row.sale_type, p_sale_id: row.id, p_cost_jpy: clear ? null : Number(cleanYen(cost)), p_note: note.trim() || null }),
    onSuccess: (_, clear) => { toast({ title: clear ? "Cost cleared" : `Cost set for ${row.invoice_number}` }); onDone(); },
    onError: (e) => refusal(e, "Could not save the cost"),
  });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cost of goods — {row.invoice_number}</DialogTitle>
          <DialogDescription>{saleDescription(row)} · revenue {formatNative(row.revenue, row.currency)}. Enter what the pieces cost the shop, in yen.</DialogDescription>
        </DialogHeader>
        {row.items.some((i) => i.cost_jpy != null) && (
          <p className="text-xs text-muted-foreground">
            From the product cost basis: {row.items.map((i) => `${i.title ?? "piece"} ${i.cost_jpy != null ? formatYen(i.cost_jpy) + (i.quantity && i.quantity > 1 ? ` × ${i.quantity}` : "") : "(no cost)"}`).join(", ")}. A cost set here replaces it.
          </p>
        )}
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="sale-cost">Cost (¥)</Label>
            <Input id="sale-cost" inputMode="numeric" className="min-h-11" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="e.g. 45000" autoFocus />
            {cost && problem && <p className="text-xs text-destructive">{problem}</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="sale-cost-note">Note (optional)</Label>
            <Textarea id="sale-cost-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Supplier, invoice, how the cost was worked out" maxLength={500} />
          </div>
        </div>
        <DialogFooter className="gap-2">
          {row.cost_source === "manual" && <Button variant="ghost" className="min-h-11" disabled={save.isPending} onClick={() => save.mutate(true)}>Clear cost</Button>}
          <Button variant="outline" className="min-h-11" onClick={onClose}>Cancel</Button>
          <Button className="min-h-11" disabled={!!problem || save.isPending} onClick={() => save.mutate(false)}>{save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save cost"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportCostsDialog({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const parsed = useMemo(() => parseCostCsv(text), [text]);
  const run = useMutation({
    mutationFn: () => callRpc("import_sale_costs", { p_rows: parsed.rows }),
    onSuccess: (out) => { setResult(out as Record<string, unknown>); toast({ title: "Costs imported", description: importSummary(out as { set?: number }) }); onDone(); },
    onError: (e) => refusal(e, "Could not import the costs"),
  });
  const onFile = async (f: File | undefined) => { if (f) setText(await f.text()); };
  return (
    <>
      <Button size="sm" variant="outline" className="min-h-11" onClick={() => setOpen(true)}><Upload className="h-4 w-4 mr-1" />Import costs (CSV)</Button>
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setText(""); setResult(null); } }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Import costs by invoice number</DialogTitle>
            <DialogDescription>One sale per line: <code>invoice_number, cost_jpy, note</code> (note optional, header optional). Up to 2,000 lines. An invoice that already has a cost is replaced.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input type="file" accept=".csv,text/csv,text/plain" className="min-h-11" onChange={(e) => onFile(e.target.files?.[0])} aria-label="CSV file" />
            <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} placeholder={"19794, 45000, supplier invoice 77\n19840, 32000"} className="font-mono text-xs" />
            <p className="text-xs text-muted-foreground">{parsed.rows.length} row{parsed.rows.length === 1 ? "" : "s"} ready{parsed.skipped ? ` · ${parsed.skipped} line${parsed.skipped === 1 ? "" : "s"} skipped (need an invoice and a cost)` : ""}</p>
            {result && (
              <div className="rounded-md border p-2 text-xs space-y-1">
                <p className="font-medium">{importSummary(result as { set?: number })}</p>
                {Array.isArray(result.not_found) && result.not_found.length > 0 && <p>Not found: {(result.not_found as string[]).join(", ")}</p>}
                {Array.isArray(result.ambiguous) && result.ambiguous.length > 0 && <p>Both a layaway and a cash order carry this number — set these on the sale itself: {(result.ambiguous as string[]).join(", ")}</p>}
                {Array.isArray(result.invalid) && result.invalid.length > 0 && <p>Invalid: {(result.invalid as string[]).join(", ")}</p>}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" className="min-h-11" onClick={() => setOpen(false)}>Close</Button>
            <Button className="min-h-11" disabled={parsed.rows.length === 0 || run.isPending} onClick={() => run.mutate()}>{run.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : `Import ${parsed.rows.length} row${parsed.rows.length === 1 ? "" : "s"}`}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function InventoryCard({ today, canPost, onChanged }: { today: string; canPost: boolean; onChanged: () => void }) {
  const q = useQuery({ queryKey: INVENTORY_KEY, staleTime: 30_000, queryFn: async () => normaliseValuation(await callRpc("get_inventory_valuation", {})) });
  const [adjusting, setAdjusting] = useState(false);
  const [reason, setReason] = useState("");
  const v = q.data;
  const adj = v ? stockAdjustment(v, today, reason.trim()) : null;
  const post = useMutation({
    mutationFn: () => callRpc("post_manual_journal", { p: adj!.payload }),
    onSuccess: (out) => { const j = (out.journal ?? {}) as Record<string, unknown>; toast({ title: `Stock-count adjustment posted (journal #${j.journal_no ?? ""})` }); setAdjusting(false); setReason(""); onChanged(); },
    onError: (e) => refusal(e, "Could not post the adjustment"),
  });
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Inventory</CardTitle>
        <p className="text-xs text-muted-foreground">Stock on hand at cost (website pieces with a cost basis, plus trade-ins at their buyback amount) against what the ledger carries in 1300 / 1310. The difference is yours to confirm as a stock-count adjustment — nothing posts by itself.</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {q.isLoading && <div className="text-sm text-muted-foreground"><Loader2 className="inline h-4 w-4 animate-spin mr-2" />Loading…</div>}
        {q.isError && <div className="text-sm text-destructive">Could not load the inventory figures.</div>}
        {v && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
              <Stat label="Website stock at cost" value={formatYen(v.stock_at_cost_jpy)} sub={`${v.stock_units_with_cost} of ${v.stock_units} units have a cost`} warn={v.variants_in_stock_without_cost > 0} />
              <Stat label="Trade-ins in stock" value={formatYen(v.trade_ins_in_stock_jpy)} sub={`${v.trade_ins_in_stock} piece${v.trade_ins_in_stock === 1 ? "" : "s"}`} />
              <Stat label="Ledger 1300 Inventory" value={formatYen(v.ledger_inventory_jpy)} sub={`1310 trade-ins ${formatYen(v.ledger_trade_in_jpy)}`} />
              <Stat label="Difference (stock − ledger)" value={formatYen(v.difference_jpy)} warn={v.difference_jpy !== 0} />
            </div>
            {v.variants_in_stock_without_cost > 0 && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                {v.variants_in_stock_without_cost} website variant{v.variants_in_stock_without_cost === 1 ? " has" : "s have"} stock but no cost basis — add it under <Link to="/website" className="underline">Website → Products</Link> (admin field "Cost basis") so new sales carry their cost automatically.
              </p>
            )}
            {canPost && v.ledger_start && v.difference_jpy !== 0 && !adjusting && (
              <Button size="sm" variant="outline" className="min-h-11" onClick={() => setAdjusting(true)}>Post stock-count adjustment…</Button>
            )}
            {adjusting && adj && (
              <div className="rounded-md border p-3 space-y-2 text-sm">
                <p>{adj.label}: <strong>{formatYen(adj.amount)}</strong> dated {dayLabel(today)} — {adj.direction === "down" ? "Dr 5900 Inventory write-down / Cr 1300 Inventory" : "Dr 1300 Inventory / Cr 5900 Inventory write-down"}.</p>
                <Input className="min-h-11" placeholder="Reason (e.g. stock count 26 Oct)" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
                <div className="flex gap-2">
                  <Button size="sm" className="min-h-11" disabled={reason.trim().length < 3 || post.isPending} onClick={() => post.mutate()}>Post adjustment</Button>
                  <Button size="sm" variant="ghost" className="min-h-11" onClick={() => setAdjusting(false)}>Cancel</Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
