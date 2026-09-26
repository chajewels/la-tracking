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
  APPLY_REFUSAL, FETCH_BUSY_MAX_WAITS, FETCH_BUSY_WAIT_MS, MATCH_REASON, NIGHTLY_FULL_TEXT, SKIP_REASON, autoApplyText,
  defaultSelection, groupItems, hideTickable, hubOnlyReason, republishProductIds, runDuration, runKindLabel,
  runSourceLabel, runStatusText, splitStockSelection, stockTickable, type InventoryItem, type InventoryRun,
} from "@/lib/page365-inventory";
import {
  applyInventory, continueFetch, copyPhotos, hideOnWebsite, itemsTable, productsTable, runsTable, startFetch,
  type ApplyResult, type FetchKind, type HideResult,
} from "@/lib/page365-inventory-api";
import { publishProducts } from "@/lib/page365-drafts-api";
import { PUBLISH_REFUSAL, missingText, type PublishResult } from "@/lib/page365-drafts";
import { Page365NewProductsPanel } from "@/components/website/Page365NewProductsPanel";

/**
 * Website → Page365 stock → Page365 inventory. Staff read the whole Page365
 * catalogue, review what it means for website stock and photos, and apply the
 * rows they tick. See docs/PAGE365-IMPORT.md "INVENTORY".
 *
 * Nothing here decides stock: page365_inventory_finish proposed every row, and
 * page365_inventory_apply writes each ticked row only if its stock is unchanged
 * since the fetch. Decreases start ticked; increases never do. Products
 * switched to "Don't sync with Page365" sit in their own group and are never
 * proposed, applied or given photos (checked again on the server).
 *
 * PR 3: the latest run may be a SCHEDULED one (every 5-30 minutes, PR 3d). While it
 * reads, this card polls instead of offering Resume as if it were stuck; a
 * staff "Fetch" joins it and takes turns with the schedule (a { busy } answer
 * waits). Its decreases may already be applied automatically (row badge
 * "Auto-applied"); increases, drafts, prices and photos still wait here.
 *
 * PR 3c: "Fetch Page365 inventory" is a QUICK read (the catalogue list plus
 * the pages of Hub products — seconds); "Full fetch" opens every page
 * (minutes). The schedule does the same: quick at the chosen interval (PR 3d), full nightly.
 * Increases start ticked like decreases (owner decision 2026-09-26). "New in
 * Page365" comes from the latest FULL read, labelled "as of" it; codes gone
 * from the latest list are greyed out there.
 *
 * PR 3b: "Hide on website" — a synced product missing from 2 complete reads
 * in a row (and seen on Page365 before) — starts ticked; Apply sets its stock
 * to 0 and unpublishes it (page365_inventory_hide, compare-and-set). "Back in
 * Page365 — re-publish?" is never ticked for you: re-publishing goes through
 * the Catalog publish (website_publish_products) with its usual checks.
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
  hides: HideResult | null;
  republish: PublishResult | null;
  photos: {
    copied: number; replaced: number; already: number; notSynced: number;
    failed: { item_id: string; photo_id: number; reason: string }[];
  } | null;
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
  if (it.status === "applied" && it.result_note === "auto_applied") {
    return <Badge className="bg-success/15 text-success text-[10px]" title={SKIP_REASON.auto_applied}>Auto-applied</Badge>;
  }
  if (it.status === "applied" && it.result_note === "auto_hidden") {
    return <Badge className="bg-success/15 text-success text-[10px]" title={SKIP_REASON.auto_hidden}>Auto-hidden</Badge>;
  }
  if (it.status === "applied" && it.result_note === "hidden") {
    return <Badge className="bg-success/15 text-success text-[10px]">Hidden</Badge>;
  }
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
  const [hideTicks, setHideTicks] = useState<Set<string>>(new Set());
  const [republishTicks, setRepublishTicks] = useState<Set<string>>(new Set());
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
    // A scheduled read finishes on its own: poll while it does (PR 3).
    refetchInterval: q => ((q.state.data as InventoryRun | null)?.status === "fetching" ? 15_000 : false),
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

  // PR 3c: "New in Page365" comes from the latest FULL, complete read. Before
  // the PR 3c migration there is no kind column: every run is full, so the
  // latest ready run is used as before.
  const fullRun = useQuery({
    queryKey: ["page365-inventory-full-run"],
    queryFn: async () => {
      const { data, error } = await runsTable().select("*").eq("kind", "full").eq("status", "ready")
        .order("created_at", { ascending: false }).limit(1);
      if (error) {
        if (/\bkind\b/.test(error.message)) return null;
        throw error;
      }
      return ((data ?? [])[0] ?? null) as InventoryRun | null;
    },
  });
  const newRun: InventoryRun | null = fullRun.data
    ?? (run && !run.kind && run.status === "ready" ? run : null);
  const newItems = useQuery({
    queryKey: ["page365-inventory-new-items", newRun?.id],
    enabled: !!newRun,
    queryFn: async () => {
      const out: InventoryItem[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await itemsTable().select("*").eq("run_id", newRun!.id).eq("category", "new")
          .range(from, from + 999);
        if (error) throw error;
        out.push(...((data ?? []) as InventoryItem[]));
        if (!data || data.length < 1000) break;
      }
      return out;
    },
  });
  // Which listings the latest list still has (any kind of read whose list was
  // complete). null = the latest read IS the full read: nothing to compare.
  const listRun = run && run.status !== "fetching" && run.status !== "failed" && run.id !== newRun?.id ? run : null;
  const listed = useQuery({
    queryKey: ["page365-inventory-listed", listRun?.id],
    enabled: !!listRun,
    queryFn: async () => {
      const ids = new Set<number>();
      for (let from = 0; ; from += 1000) {
        const { data, error } = await productsTable().select("page365_product_id")
          .eq("run_id", listRun!.id).range(from, from + 999);
        if (error) throw error;
        for (const r of (data ?? []) as { page365_product_id: number }[]) ids.add(Number(r.page365_product_id));
        if (!data || data.length < 1000) break;
      }
      return ids;
    },
  });
  const canCreateDrafts = newRun?.status === "ready" && !!newRun.finished_at
    && Date.now() - new Date(newRun.finished_at).getTime() < 48 * 3600_000;

  // Pre-tick once per run (decreases + photos), never re-tick after staff untick.
  useEffect(() => {
    if (!run || !items.data || seededFor.current === run.id) return;
    seededFor.current = run.id;
    const d = defaultSelection(items.data);
    setStockTicks(d.stock);
    setPhotoTicks(d.photos);
    setHideTicks(d.hides);
    setRepublishTicks(new Set());
  }, [run, items.data]);

  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ["page365-inventory-run"] });
    await qc.invalidateQueries({ queryKey: ["page365-inventory-items"] });
    await qc.invalidateQueries({ queryKey: ["page365-inventory-full-run"] });
    await qc.invalidateQueries({ queryKey: ["page365-inventory-new-items"] });
    await qc.invalidateQueries({ queryKey: ["page365-inventory-listed"] });
    await qc.invalidateQueries({ queryKey: ["page365-inventory-run-history"] });
  }, [qc]);

  const runFetch = async (resume: boolean, kind: FetchKind = "quick") => {
    setBusy("fetching");
    setOutcome(null);
    try {
      let p = resume && run ? await continueFetch(run.id) : await startFetch(kind);
      const runId = p.run_id;
      let idle = 0;
      let waits = 0;
      while (p.run?.status === "fetching") {
        const total = p.run.products_total || p.fetched + p.error + p.open;
        setFetchProgress({ done: p.fetched + p.error, total });
        const before = p.fetched + p.error;
        p = await continueFetch(runId);
        if (p.busy) {
          // The scheduled fetch is reading this run right now: take turns.
          if (++waits > FETCH_BUSY_MAX_WAITS) {
            throw new Error("The scheduled fetch is still reading Page365. It finishes on its own — this page updates when it does.");
          }
          await new Promise(r => setTimeout(r, FETCH_BUSY_WAIT_MS));
          continue;
        }
        idle = p.fetched + p.error === before ? idle + 1 : 0;
        if (idle > 20) throw new Error("The fetch stopped making progress. Press Resume to try again.");
        if (idle > 0) await new Promise(r => setTimeout(r, 1500));
      }
      if (p.run?.status === "ready") {
        toast.success(`Page365 inventory read (${p.run.kind === "quick" ? "quick" : "full"}). Review below.`);
      }
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
  const hideIds = groups.hides.filter(it => hideTicks.has(it.id) && hideTickable(it)).map(it => it.id);
  const republishIds = republishProductIds(groups.backIn, republishTicks);
  const selectedCount = decreaseIds.length + increaseIds.length + photoIds.length + hideIds.length + republishIds.length;

  const doApply = async () => {
    if (!run) return;
    setConfirmOpen(false);
    setBusy("applying");
    const result: Outcome = { stock: null, hides: null, republish: null, photos: null };
    try {
      if (decreaseIds.length + increaseIds.length > 0) {
        const r = await applyInventory(run.id, decreaseIds, increaseIds);
        if (!r.ok) throw new Error(APPLY_REFUSAL[r.reason ?? ""] ?? `Could not apply (${r.reason}).`);
        result.stock = r;
      }
      if (hideIds.length > 0) {
        const r = await hideOnWebsite(run.id, hideIds);
        if (!r.ok) throw new Error(APPLY_REFUSAL[r.reason ?? ""] ?? `Could not hide (${r.reason}).`);
        result.hides = r;
      }
      // After the stock rows, so a ticked increase is in place before it goes live.
      if (republishIds.length > 0) {
        const r = await publishProducts(republishIds);
        if (!r.ok) throw new Error(PUBLISH_REFUSAL[r.reason ?? ""] ?? `Could not re-publish (${r.reason}).`);
        result.republish = r;
      }
      if (photoIds.length > 0) {
        const acc = { copied: 0, replaced: 0, already: 0, notSynced: 0, failed: [] as { item_id: string; photo_id: number; reason: string }[] };
        for (let guard = 0; guard < 200; guard++) {
          const r = await copyPhotos(run.id, photoIds, acc.failed.map(f => `${f.item_id}:${f.photo_id}`));
          acc.copied += r.copied; acc.replaced += r.replaced; acc.already += r.already; acc.failed.push(...r.failed);
          acc.notSynced = Math.max(acc.notSynced, r.not_synced ?? 0);
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
      if (result.hides || result.republish) await qc.invalidateQueries({ queryKey: ["website-products"] });
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
          <TableHead className="text-right whitespace-nowrap" title="Pieces on imported Page365 invoices whose Hub order is not paid yet">Invoice holds</TableHead>
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
            <TableCell className="text-right tabular-nums">{it.invoice_holds || "—"}</TableCell>
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
              Page365 is the stock master. Proposes website stock = Page365 quantity minus website holds and unpaid
              Page365 invoice holds Page365 may not count yet. Importing a Page365 invoice no longer changes website
              stock. Nothing changes until you apply ticked rows. “Fetch” is quick: Page365’s product list plus the
              pages of products the Hub has (seconds). “Full fetch” reads every Page365 page (minutes) — it runs by
              itself nightly at {NIGHTLY_FULL_TEXT} and feeds “New in Page365”.
            </p>
            {run && (
              <p className="mt-1 text-xs text-muted-foreground" data-testid="p365-inv-last-fetch">
                Last fetch {phtTime(run.created_at)} ({runSourceLabel(run).toLowerCase()}, {runKindLabel(run).toLowerCase()}
                {run.finished_at ? `, ${runDuration(run)}` : ""}) · {run.page365_count ?? "?"} products
                {run.kind === "quick" ? ` listed, ${run.products_total} page(s) read` : ""} ·{" "}
                <span className={run.status === "ready" ? "text-success" : run.status === "fetching" ? "" : "text-warning"}>
                  {runStatusText(run)}
                </span>
                {run.source === "schedule" && run.status !== "fetching" && <> · {autoApplyText(run)}</>}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {run?.status === "fetching" && busy === null && (
              <Button size="sm" variant="outline" onClick={() => runFetch(true)}>
                {run.source === "schedule" ? "Join scheduled fetch" : "Resume fetch"}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => runFetch(false, "full")}
              title="Reads every Page365 product page (minutes). Runs by itself nightly."
            >
              Full fetch
            </Button>
            <Button
              size="sm"
              className="gold-gradient text-primary-foreground"
              disabled={busy !== null}
              onClick={() => runFetch(false, "quick")}
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
              {fetchProgress.done} / {fetchProgress.total} product pages read
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
          <p className="text-sm text-muted-foreground" data-testid="p365-inv-fetching-note">
            {busy
              ? "Reading Page365…"
              : run.source === "schedule"
                ? "A scheduled fetch is reading Page365. It finishes on its own and this page updates when it does."
                : "A fetch was interrupted. Press “Resume fetch” to finish reading it."}
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
            <Section title="Increases" hint="Pre-ticked. Page365 has more than the website — staff enter every confirmed website sale in Page365, so Page365 is the truth." count={groups.increases.length}>
              {stockTable(groups.increases)}
            </Section>
            <Section
              title="Hide on website"
              hint="Pre-ticked. On Page365 before, now missing from 2 complete fetches in a row — Page365 hides sold pieces. Apply sets website stock to 0 and unpublishes it (Catalog → draft). Skipped if it changed since the fetch."
              count={groups.hides.length}
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" /><TableHead>Code</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Missing in</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Hub now → proposed</TableHead><TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groups.hides.map(it => (
                    <TableRow key={it.id} data-testid="p365-inv-hide-row">
                      {tickCell(it, hideTicks, setHideTicks, hideTickable(it))}
                      <TableCell className="font-medium">{label(it)}</TableCell>
                      <TableCell className="text-right tabular-nums whitespace-nowrap">{it.missing_runs ?? "—"} fetches</TableCell>
                      <TableCell className="text-right tabular-nums whitespace-nowrap">
                        {it.seen_stock ?? "—"} → <span className="font-semibold">0, unpublished</span>
                      </TableCell>
                      <TableCell><RowStatus it={it} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Section>
            <Section
              title="Back in Page365 — re-publish?"
              hint="The Hub hid these when Page365 stopped listing them; Page365 lists them again. Never re-published by itself. Tick to publish again — its stock follows Page365 through the increase above (applied automatically on a scheduled fetch when automatic updates are on)."
              count={groups.backIn.length}
              tone="warn"
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" /><TableHead>Code</TableHead><TableHead className="min-w-[14rem]">Page365 name</TableHead>
                    <TableHead className="text-right">Page365</TableHead><TableHead className="text-right whitespace-nowrap">Hub now → proposed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groups.backIn.map(it => (
                    <TableRow key={it.id} data-testid="p365-inv-back-row">
                      {tickCell(it, republishTicks, setRepublishTicks, true)}
                      <TableCell className="font-medium">{label(it)}</TableCell>
                      <TableCell className="max-w-[22rem] truncate text-xs" title={nameOf(it)}>{nameOf(it)}</TableCell>
                      <TableCell className="text-right tabular-nums">{it.page365_available ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums whitespace-nowrap">
                        {it.seen_stock ?? "—"} → <span className="font-semibold">{it.proposed_stock ?? "—"}</span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Section>
            <Section title="Not synced" hint="Switched to “Don’t sync with Page365” in Catalog. Always skipped: never proposed, never applied, photos never copied." count={groups.notSynced.length} tone="muted">
              <Table>
                <TableHeader><TableRow><TableHead>Code</TableHead><TableHead>Name</TableHead><TableHead className="text-right">Page365</TableHead><TableHead className="text-right">Hub now</TableHead></TableRow></TableHeader>
                <TableBody>
                  {groups.notSynced.map(it => (
                    <TableRow key={it.id} data-testid="p365-inv-not-synced-row">
                      <TableCell className="font-medium">{label(it)}</TableCell>
                      <TableCell className="max-w-[22rem] truncate text-xs">{it.kind === "hub_only" ? "(Hub product — not on Page365)" : nameOf(it)}</TableCell>
                      <TableCell className="text-right tabular-nums">{it.page365_available ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{it.seen_stock ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Section>
            <Section title="Excluded — Page365 invoice hold" hint="Invoice import is set back to taking stock (page365_stock_mode = invoice), and an imported invoice holds this piece." count={groups.excluded.length} tone="muted">
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
                        {it.kind === "hub_only" ? hubOnlyReason(it) : (MATCH_REASON[it.match_result] ?? it.match_result)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Section>
            {newRun && (newItems.data ?? []).length > 0 ? (
              <section className="space-y-2" data-testid="p365-inv-new-section">
                <div className="flex flex-wrap items-baseline gap-2">
                  <h3 className="font-display text-sm text-card-foreground">New in Page365</h3>
                  <p className="w-full text-xs text-muted-foreground sm:w-auto">
                    Codes the Hub does not have, from the latest full fetch. Tick and “Create drafts” — drafts never
                    appear on the website until published in Catalog.
                  </p>
                </div>
                <Page365NewProductsPanel
                  run={newRun}
                  items={newItems.data ?? []}
                  canCreate={canCreateDrafts}
                  onChanged={refresh}
                  listedIds={listRun ? listed.data ?? null : null}
                  listedAt={listRun ? phtTime(listRun.created_at) : null}
                />
              </section>
            ) : !fullRun.isLoading && !newRun ? (
              <p className="text-xs text-muted-foreground" data-testid="p365-inv-no-full">
                New in Page365 comes from a full fetch. None yet — press “Full fetch”, or wait for the nightly one
                ({NIGHTLY_FULL_TEXT}).
              </p>
            ) : null}
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
                  {decreaseIds.length} decrease(s), {increaseIds.length} increase(s),{" "}
                  {hideIds.length > 0 && <>{hideIds.length} to hide, </>}
                  {republishIds.length > 0 && <>{republishIds.length} to re-publish, </>}
                  photos for {photoIds.length} product(s) selected.
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
                {outcome.hides && (
                  <p>
                    Hidden on the website: <b>{outcome.hides.hidden ?? 0}</b> · <b>{outcome.hides.changed_since_fetch ?? 0}</b> skipped
                    because they changed since the fetch · <b>{outcome.hides.skipped ?? 0}</b> skipped
                    {(outcome.hides.skipped_items ?? []).length > 0 &&
                      ` (${(outcome.hides.skipped_items ?? []).slice(0, 3).map(x => SKIP_REASON[x.reason] ?? x.reason).join("; ")})`}
                    {" "}· <b>{outcome.hides.failed ?? 0}</b> failed. Each hidden product is in the audit log.
                  </p>
                )}
                {outcome.republish && (
                  <p>
                    Re-published: <b>{outcome.republish.published ?? 0}</b>
                    {(outcome.republish.blocked_items ?? []).length > 0 && (
                      <> · not published, still needs: {(outcome.republish.blocked_items ?? [])
                        .map(b => `${b.sku} (${missingText(b.missing)})`).join("; ")}</>
                    )}
                    {(outcome.republish.skipped ?? 0) > 0 && <> · <b>{outcome.republish.skipped}</b> skipped (not a draft any more)</>}.
                  </p>
                )}
                {outcome.photos && (
                  <p>
                    Photos: <b>{outcome.photos.copied}</b> copied · <b>{outcome.photos.replaced}</b> replaced ·{" "}
                    <b>{outcome.photos.already}</b> already there ·{" "}
                    {outcome.photos.notSynced > 0 && <><b>{outcome.photos.notSynced}</b> not synced (skipped) · </>}
                    <b>{outcome.photos.failed.length}</b> failed
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
              {decreaseIds.length} decrease(s) and {increaseIds.length} increase(s) to website stock,{" "}
              {hideIds.length > 0 && <>{hideIds.length} product(s) hidden (stock 0, unpublished), </>}
              {republishIds.length > 0 && <>{republishIds.length} product(s) re-published, </>}
              and photos for {photoIds.length} product(s). A row that changed since the fetch is skipped, not overwritten.
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
