import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import DataTable, { type DataTableColumn } from "@/components/data-table/DataTable";
import { supabase } from "@/integrations/supabase/client";
import { ledgerTable } from "@/lib/page365-stock-table";
import {
  CHIP_CLASS, FLAG_ADVICE, flagReason, ledgerChip,
  type Page365StockFlag, type Page365StockLine,
} from "@/lib/page365-stock";

/**
 * Website → Page365 stock. Page365 invoice lines that need a look: lines that
 * did not match exactly one website product, plus (from before PR 2, or while
 * page365_stock_mode is 'invoice') lines that could not take website stock.
 * Since PR 2 an import never changes website stock — the Page365 inventory
 * fetch on the same tab does. See docs/PAGE365-IMPORT.md "STOCK".
 *
 * Resolving a flag only records that someone dealt with it, with a note. It
 * NEVER moves stock — the fix happens on Page365 or in Catalog. Same key as
 * the Catalog tab (manage_website_catalog), checked again in
 * resolve_page365_stock_flag.
 */
interface FlagRow extends Page365StockLine {
  cash_orders: { invoice_number: string } | null;
  layaway_accounts: { invoice_number: string } | null;
}

const RESOLVE_REFUSAL: Record<string, string> = {
  forbidden: "You need the Website catalog permission to resolve these.",
  note_required: "A note is required.",
  not_open: "Someone already resolved this line.",
};

const phtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });

export function Page365StockCard() {
  const qc = useQueryClient();
  const [showResolved, setShowResolved] = useState(false);
  const [resolving, setResolving] = useState<FlagRow | null>(null);
  const [note, setNote] = useState("");

  const flags = useQuery({
    queryKey: ["page365-stock-flags", showResolved],
    queryFn: async () => {
      let q = ledgerTable()
        .select("*, cash_orders(invoice_number), layaway_accounts(invoice_number)")
        .not("flag", "is", null)
        .order("created_at", { ascending: false })
        .limit(500);
      if (!showResolved) q = q.is("resolved_at", null);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as FlagRow[];
    },
  });

  const resolve = useMutation({
    mutationFn: async ({ id, text }: { id: string; text: string }) => {
      // Cast: resolve_page365_stock_flag ships in this PR's migration and is not
      // in the generated RPC union until Lovable regenerates types.ts.
      const { data, error } = await (supabase.rpc as unknown as (
        fn: string, args: Record<string, unknown>,
      ) => Promise<{ data: { ok: boolean; reason?: string } | null; error: { message: string } | null }>)(
        "resolve_page365_stock_flag", { p_line_id: id, p_note: text },
      );
      if (error) throw new Error(error.message);
      if (!data?.ok) throw new Error(RESOLVE_REFUSAL[data?.reason ?? ""] ?? "Could not resolve this line.");
    },
    onSuccess: () => {
      toast.success("Flag resolved");
      setResolving(null);
      setNote("");
      qc.invalidateQueries({ queryKey: ["page365-stock-flags"] });
      qc.invalidateQueries({ queryKey: ["page365-stock-lines"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = useMemo(() => flags.data ?? [], [flags.data]);
  const openCount = rows.filter(r => !r.resolved_at).length;

  const columns = useMemo<DataTableColumn<FlagRow>[]>(() => [
    {
      key: "created_at",
      header: "Flagged",
      cell: r => <span className="whitespace-nowrap text-xs text-muted-foreground">{phtDate(r.created_at)}</span>,
      sortValue: r => r.created_at,
      csvValue: r => phtDate(r.created_at),
    },
    {
      key: "invoice",
      header: "Invoice",
      cell: r => {
        const inv = r.cash_orders?.invoice_number ?? r.layaway_accounts?.invoice_number;
        const href = r.cash_order_id ? `/cash-orders/${r.cash_order_id}` : r.account_id ? `/accounts/${r.account_id}` : null;
        return (
          <div className="text-xs">
            {href ? (
              <Link to={href} className="font-medium text-primary hover:underline">#{inv ?? r.page365_no}</Link>
            ) : (
              <span className="text-muted-foreground">Order deleted</span>
            )}
            <div className="text-muted-foreground">Page365 {r.page365_no} · line {r.line_no}</div>
          </div>
        );
      },
      sortValue: r => r.page365_no,
      filterValue: r => [String(r.page365_no), r.cash_orders?.invoice_number ?? "", r.layaway_accounts?.invoice_number ?? ""].join(" "),
      csvValue: r => String(r.page365_no),
    },
    {
      key: "line",
      header: "Line",
      cellClassName: "max-w-[22rem]",
      cell: r => (
        <div className="text-xs">
          <div className="truncate text-card-foreground" title={r.line_name}>{r.line_name}</div>
          <div className="text-muted-foreground">
            Code {r.first_word ?? "—"} · qty {r.quantity}
            {r.stock_seen != null && <> · {r.stock_seen} in stock then</>}
          </div>
        </div>
      ),
      sortValue: r => r.line_name,
      filterValue: r => [r.line_name, r.first_word ?? ""].join(" "),
      csvValue: r => r.line_name,
    },
    {
      key: "reason",
      header: "Reason",
      cell: r => {
        const chip = ledgerChip(r);
        return (
          <div className="space-y-1">
            <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${CHIP_CLASS[chip.tone]}`}>
              {flagReason(r.flag)}
            </span>
            {r.resolved_at && (
              <div className="text-[11px] text-muted-foreground">Resolved: {r.resolution_note}</div>
            )}
          </div>
        );
      },
      sortValue: r => flagReason(r.flag),
      filterValue: r => flagReason(r.flag),
      csvValue: r => flagReason(r.flag),
    },
    {
      key: "action",
      header: "Action",
      hideable: false,
      cell: r => r.resolved_at ? null : (
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { setResolving(r); setNote(""); }}>
          Resolve
        </Button>
      ),
    },
  ], []);

  return (
    <Card>
      <CardHeader className="hairline-b">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">
              Page365 stock {flags.data ? `(${openCount} open)` : ""}
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Imported Page365 invoice lines that did not match one website product. Importing an invoice no longer
              changes website stock — the Page365 inventory fetch below does. Resolving records a note; it never moves stock.
            </p>
          </div>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setShowResolved(v => !v)}>
            {showResolved ? "Hide resolved" : "Show resolved"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {flags.isLoading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : flags.isError ? (
          <p className="px-6 py-10 text-sm text-muted-foreground">
            Page365 stock is not available yet. It appears once the stock migration has been run.
          </p>
        ) : rows.length === 0 ? (
          <p className="px-6 py-10 text-sm text-muted-foreground">Nothing to look at. Every imported line matched.</p>
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={r => r.id}
            searchText={r => [r.line_name, r.first_word ?? "", String(r.page365_no)]}
            csvName="page365-stock-flags"
            densityKey="cj-page365-stock-density"
          />
        )}
      </CardContent>

      <Dialog open={!!resolving} onOpenChange={o => { if (!o) setResolving(null); }}>
        <DialogContent className="max-w-md border-border bg-card">
          <DialogHeader>
            <DialogTitle className="font-display text-card-foreground">Resolve flag</DialogTitle>
            <DialogDescription>
              {resolving && (
                <>
                  Page365 {resolving.page365_no}, line {resolving.line_no}: {resolving.line_name}
                  <span className="mt-2 block">{FLAG_ADVICE[resolving.flag as Page365StockFlag]}</span>
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="p365-resolve-note" className="text-xs">What was done (required)</Label>
            <Textarea
              id="p365-resolve-note"
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="e.g. Reduced Page365 stock for R1155 by 1"
              className="bg-background"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setResolving(null)}>Cancel</Button>
            <Button
              className="gold-gradient text-primary-foreground"
              disabled={!note.trim() || resolve.isPending}
              onClick={() => resolving && resolve.mutate({ id: resolving.id, text: note.trim() })}
            >
              {resolve.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Resolve"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
