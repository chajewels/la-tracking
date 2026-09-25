import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  APPLY_REFUSAL, MATCH_REASON, SKIP_REASON, defaultSelection, groupItems, runStatusText, splitStockSelection,
  stockTickable, type InventoryItem, type InventoryRun,
} from "@/lib/page365-inventory";
import {
  applyInventory, continueFetch, copyPhotos, itemsTable, runsTable, startFetch, type ApplyResult,
} from "@/lib/page365-inventory-api";

/**
 * Website → Page365 stock → Page365 inventory. Staff read the whole Page365
 * catalogue, review what it means for website stock and photos, and apply the
 * rows they tick. See docs/PAGE365-IMPORT.md "INVENTORY".
 *
 * Nothing here decides stock: page365_inventory_finish proposed every row, and
 * page365_inventory_apply writes each ticked row only if its stock is unchanged
 * since the fetch. Decreases start ticked; increases never do.
 */

const yen = (n: number | null | undefined) => (n == null ? "—" : `¥${Math.round(n).toLocaleString("en-US")}`);
const phtTime = (iso: string | null) =>
  iso ? `${new Date(iso).toLocaleString("en-CA", {
    timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  })} PHT` : "—";
const label = (it: InventoryItem) => it.code ?? it.hub_sku ?? "—";
const nameOf = (it: InventoryItem) => it.variant_name ? `${it.page365_name} — ${it.variant_name}` : (it.page365_name ?? "");

interface Outcome {
  stock: ApplyResult | null;
  photos: { copied: number; replaced: number; already: number; failed: { item_id: string; photo_id: number; reason: string }[] } | null;
}

function Section({ title, hint, count, tone = "default", children }: {
  title: string; hint: string; count: number; tone?: "default" | "warn" | "muted"; children: ReactNode;
}) {
  if (count === 0) return null;
  const toneClass = tone === "warn" ? "border-warning/40 text-warning" : tone === "muted" ? "text-muted-foreground" : "";
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="font-display text-sm text-card-foreground">{title}</h3>
        <Badge variant="outline" className={`text-[10px] ${toneClass}`}>{count}</Badge>
        <p className="w-full text-xs text-muted-foreground sm:w-auto">{hint}</p>
      </div>
      <div className="max-h-80 overflow-auto rounded-md border border-border">{children}</div>
    </section>
  );
}

function RowStatus({ it }: { it: InventoryItem }) {
  if (it.status === "applied") return <Badge className="bg-success/15 text-success text-[10px]">Applied</Badge>;
  if (it.status === "changed_since_fetch") return <Badge variant="outline" className="text-[10px] text-warning">Changed since fetch</Badge>;
  if (it.status === "failed") return <Badge variant="outline" className="text-[10px] text-destructive" title={it.result_note ?? ""}>Failed</Badge>;
  if (it.result_note) return <span className="text-[11px] text-muted-foreground">{SKIP_REASON[it.result_note] ?? it.result_note}</span>;
  return null;
}

export function Page365InventoryCard() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<null | "fetching" | "applying">(null);
  const [fetchProgress, setFetchProgress] = useState<{ done: number; total: number } | null>(null);
  const [stockTicks, setStockTicks] = useState<Set<string>>(new Set());
  const [photoTicks, setPhotoTicks] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const seededFor = useRef<string | null>(null);

  const latestRun = useQuery({
    queryKey: ["page365-inventory-run"],
    queryFn: async () => {
      const { data, error } = await runsTable().select("*").order("created_at", { ascending: false }).limit(1);
      if (error) throw error;
      return ((data ?? [])[0] ?? null) as InventoryRun | null;
    },
  });
  const run = latestRun.data ?? null;

  const items = useQuery({
    queryKey: ["page365-inventory-items", run?.id],
    enabled: !!run && run.status !== "fetching",
    queryFn: async () => {
      const out: InventoryItem[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await itemsTable().select("*").eq("run_id", run!.id).range(from, from + 999);
        if (error) throw error;
        out.push(...((data ?? []) as InventoryItem[]));
        if (!data || data.length < 1000) break;
      }
      return out;
    },
  });
  const rows = useMemo(() => items.data ?? [], [items.data]);
  const groups = useMemo(() => groupItems(rows), [rows]);
  const canApply = run?.status === "ready";

  // Pre-tick once per run (decreases + photos), never re-tick after staff untick.
  useEffect(() => {
    if (!run || !items.data || seededFor.current === run.id) return;
    seededFor.current = run.id;
    const d = defaultSelection(items.data);
    setStockTicks(d.stock);
    setPhotoTicks(d.photos);
  }, [run, items.data]);

  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ["page365-inventory-run"] });
    await qc.invalidateQueries({ queryKey: ["page365-inventory-items"] });
  }, [qc]);

  const runFetch = async (resume: boolean) => {
    setBusy("fetching");
    setOutcome(null);
    try {
      let p = resume && run ? await continueFetch(run.id) : await startFetch();
      const runId = p.run_id;
      let idle = 0;
      while (p.run?.status === "fetching") {
        const total = p.run.products_total || p.fetched + p.error + p.open;
        setFetchProgress({ done: p.fetched + p.error, total });
        const before = p.fetched + p.error;
        p = await continueFetch(runId);
        idle = p.fetched + p.error === before ? idle + 1 : 0;
        if (idle > 20) throw new Error("The fetch stopped making progress. Press Resume to try again.");
        if (idle > 0) await new Promise(r => setTimeout(r, 1500));
      }
      if (p.run?.status === "ready") toast.success("Page365 inventory read. Review below.");
      else toast.error(runStatusText({ status: (p.run?.status ?? "failed") as InventoryRun["status"], error: p.run?.error ?? null }));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
      setFetchProgress(null);
      seededFor.current = null;
      await refresh();
    }
  };

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, id: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(id); else next.delete(id);
    setter(next);
  };

  const { decreaseIds, increaseIds } = splitStockSelection(rows, stockTicks);
  const photoIds = groups.photos.filter(it => photoTicks.has(it.id)).map(it => it.id);
  const selectedCount = decreaseIds.length + increaseIds.length + photoIds.length;

  const doApply = async () => {
    if (!run) return;
    setConfirmOpen(false);
    setBusy("applying");
    const result: Outcome = { stock: null, photos: null };
    try {
      if (decreaseIds.length + increaseIds.length > 0) {
        const r = await applyInventory(run.id, decreaseIds, increaseIds);
        if (!r.ok) throw new Error(APPLY_REFUSAL[r.reason ?? ""] ?? `Could not apply (${r.reason}).`);
        result.stock = r;
      }
      if (photoIds.length > 0) {
        const acc = { copied: 0, replaced: 0, already: 0, failed: [] as { item_id: string; photo_id: number; reason: string }[] };
        for (let guard = 0; guard < 200; guard++) {
          const r = await copyPhotos(run.id, photoIds, acc.failed.map(f => `${f.item_id}:${f.photo_id}`));
          acc.copied += r.copied; acc.replaced += r.replaced; acc.already += r.already; acc.failed.push(...r.failed);
          setOutcome({ ...result, photos: { ...acc } });
          if (r.remaining === 0 || r.copied + r.replaced + r.already + r.failed.length === 0) break;
        }
        result.photos = acc;
      }
      setOutcome(result);
      toast.success("Applied. See the results below.");
    } catch (e) {
      setOutcome(result);
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
      await qc.invalidateQueries({ queryKey: ["page365-inventory-items"] });
    }
  };

  const tickCell = (it: InventoryItem, set: Set<string>, setter: (s: Set<string>) => void, enabled: boolean) => (
    <TableCell className="w-8">
      <Checkbox
        aria-label={`Select ${label(it)}`}
        checked={set.has(it.id)}
        disabled={!enabled || !canApply || busy !== null}
        onCheckedChange={v => toggle(set, setter, it.id, v === true)}
      />
    </TableCell>
  );

  const stockTable = (list: InventoryItem[]) => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8" />
          <TableHead>Code</TableHead>
          <TableHead className="min-w-[14rem]">Page365 name</TableHead>
          <TableHead className="text-right">Page365</TableHead>
          <TableHead className="text-right">Web holds</TableHead>
          <TableHead className="text-right whitespace-nowrap">Hub now → proposed</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {list.map(it => (
          <TableRow key={it.id}>
            {tickCell(it, stockTicks, setStockTicks, stockTickable(it))}
            <TableCell className="font-medium">{label(it)}</TableCell>
            <TableCell className="max-w-[22rem] truncate text-xs" title={nameOf(it)}>{nameOf(it)}</TableCell>
            <TableCell className="text-right tabular-nums">{it.page365_available ?? "—"}</TableCell>
            <TableCell className="text-right tabular-nums">{it.web_holds || "—"}</TableCell>
            <TableCell className="text-right tabular-nums whitespace-nowrap">
              {it.seen_stock ?? "—"} → <span className="font-semibold">{it.proposed_stock ?? "—"}</span>
            </TableCell>
            <TableCell><RowStatus it={it} /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );

  const fetching = busy === "fetching" || run?.status === "fetching";

  return (
    <Card>
      <CardHeader className="hairline-b">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base">Page365 inventory</CardTitle>
            <p className="text-xs text-muted-foreground">
              Reads every Page365 product and proposes website stock = Page365 quantity minus website holds Page365
              does not know about yet. Nothing changes until you apply ticked rows.
            </p>
            {run && (
              <p className="mt-1 text-xs text-muted-foreground">
                Last fetch {phtTime(run.created_at)} · {run.page365_count ?? "?"} products ·{" "}
                <span className={run.status === "ready" ? "text-success" : run.status === "fetching" ? "" : "text-warning"}>
                  {runStatusText(run)}
                </span>
              </p>
            )}
          </div>
          <div className="flex gap-2">
            {run?.status === "fetching" && busy === null && (
              <Button size="sm" variant="outline" onClick={() => runFetch(true)}>Resume fetch</Button>
            )}
            <Button
              size="sm"
              className="gold-gradient text-primary-foreground"
              disabled={busy !== null}
              onClick={() => runFetch(false)}
            >
              {busy === "fetching" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}
              Fetch Page365 inventory
            </Button>
          </div>
        </div>
        {fetching && fetchProgress && (
          <div className="mt-3 space-y-1">
            <Progress value={fetchProgress.total ? (100 * fetchProgress.done) / fetchProgress.total : 0} />
            <p className="text-xs text-muted-foreground">
              {fetchProgress.done} / {fetchProgress.total} products read
            </p>
          </div>
        )}
      </CardHeader>

      <CardContent className="space-y-6 pt-5">
        {latestRun.isError ? (
          <p className="text-sm text-muted-foreground">
            Page365 inventory is not available yet. It appears once the inventory migration has been run.
          </p>
        ) : !run ? (
          <p className="text-sm text-muted-foreground">No fetch yet. Press “Fetch Page365 inventory”.</p>
        ) : run.status === "fetching" ? (
          <p className="text-sm text-muted-foreground">
            {busy ? "Reading Page365…" : "A fetch was interrupted. Press “Resume fetch” to finish reading it."}
          </p>
        ) : items.isLoading ? (
          <div className="flex justify-center py-8 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : run.status === "failed" ? (
          <p className="text-sm text-muted-foreground">{runStatusText(run)}</p>
        ) : (
          <>
            {!canApply && (
              <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                {runStatusText(run)}. Shown for information; fetch again to apply.
              </p>
            )}

            <Section title="Decreases" hint="Pre-ticked. Page365 has fewer than the website." count={groups.decreases.length}>
              {stockTable(groups.decreases)}
            </Section>
            <Section title="Increases" hint="Tick to apply. A rise can mean a website sale not yet entered in Page365." count={groups.increases.length} tone="warn">
              {stockTable(groups.increases)}
            </Section>
            <Section title="Excluded — Page365 invoice hold" hint="An imported Page365 invoice holds this piece. Not changed until invoice import switches to the inventory (PR 2)." count={groups.excluded.length} tone="muted">
              <Table>
                <TableHeader><TableRow><TableHead>Code</TableHead><TableHead>Page365 name</TableHead><TableHead className="text-right">Page365</TableHead><TableHead className="text-right">Hub now</TableHead></TableRow></TableHeader>
                <TableBody>
                  {groups.excluded.map(it => (
                    <TableRow key={it.id}>
                      <TableCell className="font-medium">{label(it)}</TableCell>
                      <TableCell className="max-w-[22rem] truncate text-xs">{nameOf(it)}</TableCell>
                      <TableCell className="text-right tabular-nums">{it.page365_available}</TableCell>
                      <TableCell className="text-right tabular-nums">{it.seen_stock}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Section>
            <Section title="Flagged" hint="Ambiguous or missing. Never changed; fix the code on Page365 or in Catalog." count={groups.flagged.length} tone="warn">
              <Table>
                <TableHeader><TableRow><TableHead>Code</TableHead><TableHead>Name</TableHead><TableHead>Why</TableHead></TableRow></TableHeader>
                <TableBody>
                  {groups.flagged.map(it => (
                    <TableRow key={it.id}>
                      <TableCell className="font-medium">{label(it)}</TableCell>
                      <TableCell className="max-w-[22rem] truncate text-xs">{it.kind === "hub_only" ? "(Hub product)" : nameOf(it)}</TableCell>
                      <TableCell className="text-xs">
                        {MATCH_REASON[it.match_result] ?? it.match_result}
                        {it.kind === "hub_only" && it.missing_runs ? ` · missing in ${it.missing_runs} fetch${it.missing_runs > 1 ? "es" : ""} in a row` : ""}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Section>
            <Section title="New in Page365" hint="Codes the Hub does not have. Listed only; nothing is created." count={groups.newInPage365.length} tone="muted">
              <Table>
                <TableHeader><TableRow><TableHead>Code</TableHead><TableHead>Page365 name</TableHead><TableHead className="text-right">Qty</TableHead><TableHead className="text-right">Price</TableHead></TableRow></TableHeader>
                <TableBody>
                  {groups.newInPage365.map(it => (
                    <TableRow key={it.id}>
                      <TableCell className="font-medium">{label(it)}</TableCell>
                      <TableCell className="max-w-[22rem] truncate text-xs">{nameOf(it)}</TableCell>
                      <TableCell className="text-right tabular-nums">{it.page365_available}</TableCell>
                      <TableCell className="text-right tabular-nums">{yen(it.page365_price_jpy)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Section>
            <Section title="Price differences" hint="Reported only. The website price changes by hand in Catalog." count={groups.priceDiffs.length} tone="muted">
              <Table>
                <TableHeader><TableRow><TableHead>Code</TableHead><TableHead className="text-right">Page365</TableHead><TableHead className="text-right">Hub</TableHead></TableRow></TableHeader>
                <TableBody>
                  {groups.priceDiffs.map(it => (
                    <TableRow key={it.id}>
                      <TableCell className="font-medium">{label(it)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {yen(it.page365_price_jpy)}
                        {it.page365_full_price_jpy ? <span className="ml-1 text-[11px] text-muted-foreground">(on sale, was {yen(it.page365_full_price_jpy)})</span> : null}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{yen(it.hub_price_jpy)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Section>
            <Section title="Photos to copy" hint="Every Page365 photo, in Page365's order. Staff photos stay first and untouched." count={groups.photos.length} tone="muted">
              <Table>
                <TableHeader><TableRow><TableHead className="w-8" /><TableHead>Code</TableHead><TableHead className="text-right">To copy</TableHead><TableHead>Note</TableHead></TableRow></TableHeader>
                <TableBody>
                  {groups.photos.map(it => (
                    <TableRow key={it.id}>
                      {tickCell(it, photoTicks, setPhotoTicks, true)}
                      <TableCell className="font-medium">{label(it)}</TableCell>
                      <TableCell className="text-right tabular-nums">{it.photos_to_copy} of {it.photos_total}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {it.photos_removed > 0 ? `${it.photos_removed} copied photo(s) no longer on Page365 — remove by hand if wanted` : ""}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Section>
            {groups.noChange > 0 && (
              <p className="text-xs text-muted-foreground">{groups.noChange} matched piece(s) already agree with Page365.</p>
            )}

            {canApply && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
                <p className="text-xs text-muted-foreground">
                  {decreaseIds.length} decrease(s), {increaseIds.length} increase(s), photos for {photoIds.length} product(s) selected.
                </p>
                <Button
                  className="gold-gradient text-primary-foreground"
                  disabled={selectedCount === 0 || busy !== null}
                  onClick={() => setConfirmOpen(true)}
                >
                  {busy === "applying" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                  Apply selected
                </Button>
              </div>
            )}

            {outcome && (
              <div className="space-y-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs" role="status">
                {outcome.stock && (
                  <p>
                    Stock: <b>{outcome.stock.applied ?? 0}</b> applied · <b>{outcome.stock.changed_since_fetch ?? 0}</b> skipped
                    because stock changed since the fetch · <b>{outcome.stock.skipped ?? 0}</b> skipped · <b>{outcome.stock.failed ?? 0}</b> failed.
                    Each applied row is in the audit log.
                  </p>
                )}
                {outcome.photos && (
                  <p>
                    Photos: <b>{outcome.photos.copied}</b> copied · <b>{outcome.photos.replaced}</b> replaced ·{" "}
                    <b>{outcome.photos.already}</b> already there · <b>{outcome.photos.failed.length}</b> failed
                    {outcome.photos.failed.length > 0 && ` (${outcome.photos.failed.slice(0, 3).map(f => f.reason).join("; ")})`}.
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply to the website?</AlertDialogTitle>
            <AlertDialogDescription>
              {decreaseIds.length} decrease(s) and {increaseIds.length} increase(s) to website stock, and photos for{" "}
              {photoIds.length} product(s). A row whose stock changed since the fetch is skipped, not overwritten.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={doApply}>Apply</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
