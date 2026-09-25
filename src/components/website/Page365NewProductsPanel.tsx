import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader2, PackagePlus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { InventoryItem, InventoryRun } from "@/lib/page365-inventory";
import {
  CREATE_REFUSAL, NEEDS_LABEL, NO_CATEGORY, categoryOptions, countNewRows, defaultNewFilters, draftable, filterNewRows,
  isDrafted, parseYen, pruneTicks, reasonText, selectAllShown, type CreateDraftsResult, type NewFilters, type NewRow,
} from "@/lib/page365-drafts";
import { createDrafts, listCategories } from "@/lib/page365-drafts-api";
import { copyPhotos } from "@/lib/page365-inventory-api";

/**
 * "New in Page365" — codes Page365 has and the Hub does not. Staff filter the
 * list, tick rows and press "Create drafts". Every product created is a DRAFT:
 * nothing appears on the website until someone publishes it in Catalog, and
 * Catalog refuses to publish a draft without origin and category.
 *
 * The rules are in page365_inventory_create_drafts (SQL); this panel filters,
 * ticks and reports. Photos go through the PR 1 copier, in Page365's order.
 */

const yen = (n: number | null | undefined) => (n == null ? "—" : `¥${Math.round(n).toLocaleString("en-US")}`);
const nameOf = (it: InventoryItem) => it.variant_name ? `${it.page365_name} — ${it.variant_name}` : (it.page365_name ?? "");
const productLink = (id: string) => `/website?tab=catalog&product=${id}`;
export const DRAFTS_VIEW_LINK = "/website?tab=catalog&view=page365-drafts";

interface PhotoTally { copied: number; failed: number }

export function Page365NewProductsPanel({ run, items, canCreate, onChanged }: {
  run: InventoryRun;
  items: InventoryItem[];
  canCreate: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const [filters, setFilters] = useState<NewFilters>(defaultNewFilters);
  const [minText, setMinText] = useState("");
  const [maxText, setMaxText] = useState("");
  const [ticks, setTicks] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState<null | "creating" | "photos">(null);
  const [result, setResult] = useState<CreateDraftsResult | null>(null);
  const [photos, setPhotos] = useState<PhotoTally | null>(null);

  const cats = useQuery({
    queryKey: ["page365-inventory-list-categories", run.id],
    queryFn: () => listCategories(run.id),
    staleTime: 5 * 60_000,
  });

  const rows: NewRow[] = useMemo(() => items.map(it => {
    const pid = (it as NewRow).inventory_product_id ?? null;
    return { ...it, page365_category: pid ? cats.data?.get(pid) ?? null : null };
  }), [items, cats.data]);
  const shown = useMemo(() => filterNewRows(rows, filters), [rows, filters]);
  const counts = useMemo(() => countNewRows(rows), [rows]);
  const options = useMemo(() => categoryOptions(rows), [rows]);

  // A filter change never leaves a hidden row ticked.
  useEffect(() => { setTicks(t => pruneTicks(t, shown)); }, [shown]);

  const patch = (p: Partial<NewFilters>) => setFilters(f => ({ ...f, ...p }));
  const toggle = (id: string, on: boolean) => setTicks(t => {
    const n = new Set(t);
    if (on) n.add(id); else n.delete(id);
    return n;
  });
  const shownDraftable = shown.filter(draftable).length;
  const tickedSold = rows.filter(r => ticks.has(r.id) && !((r.page365_available ?? 0) > 0)).length;

  const doCreate = async () => {
    setConfirmOpen(false);
    setBusy("creating");
    setResult(null);
    setPhotos(null);
    try {
      const r = await createDrafts(run.id, [...ticks]);
      if (!r.ok) throw new Error(CREATE_REFUSAL[r.reason ?? ""] ?? `Could not create drafts (${r.reason}).`);
      setResult(r);
      setTicks(new Set());
      const withPhotos = (r.created_items ?? []).filter(c => (c.photos ?? 0) > 0).map(c => c.item_id);
      if (withPhotos.length) {
        setBusy("photos");
        const tally: PhotoTally = { copied: 0, failed: 0 };
        const failedKeys: string[] = [];
        for (let guard = 0; guard < 400; guard++) {
          const p = await copyPhotos(run.id, withPhotos, failedKeys);
          tally.copied += p.copied + p.replaced;
          tally.failed += p.failed.length;
          failedKeys.push(...p.failed.map(f => `${f.item_id}:${f.photo_id}`));
          setPhotos({ ...tally });
          if (p.remaining === 0 || p.copied + p.replaced + p.already + p.failed.length === 0) break;
        }
      }
      toast.success(`${r.created ?? 0} draft(s) created. None is on the website until you publish it.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
      await onChanged();
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground" data-testid="new-counts">
        <b className="text-card-foreground">{counts.total}</b> new · <b className="text-card-foreground">{counts.inStock}</b> in stock ·{" "}
        <b className="text-card-foreground">{counts.soldOut}</b> sold out
        {counts.drafted > 0 && <> · <b className="text-card-foreground">{counts.drafted}</b> drafted</>}
      </p>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[auto_1fr_14rem_auto]">
        <div className="flex items-center gap-2">
          <Switch id="p365-in-stock" checked={filters.inStockOnly} onCheckedChange={v => patch({ inStockOnly: v })} />
          <Label htmlFor="p365-in-stock" className="text-xs">In stock only</Label>
        </div>
        <Input
          aria-label="Search code or name"
          placeholder="Search code or name"
          value={filters.search}
          onChange={e => patch({ search: e.target.value })}
          className="h-8 text-xs"
        />
        <Select value={filters.category || "__all__"} onValueChange={v => patch({ category: v === "__all__" ? "" : v })}>
          <SelectTrigger className="h-8 text-xs" aria-label="Page365 category"><SelectValue placeholder="All categories" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All categories</SelectItem>
            {options.map(o => <SelectItem key={o.name} value={o.name}>{o.name} ({o.count})</SelectItem>)}
            <SelectItem value={NO_CATEGORY}>(no category)</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1">
          <Input
            aria-label="Minimum price (yen)" inputMode="numeric" placeholder="¥ min" value={minText}
            onChange={e => { setMinText(e.target.value); patch({ priceMin: parseYen(e.target.value) }); }}
            className="h-8 w-24 text-xs"
          />
          <span className="text-xs text-muted-foreground">–</span>
          <Input
            aria-label="Maximum price (yen)" inputMode="numeric" placeholder="¥ max" value={maxText}
            onChange={e => { setMaxText(e.target.value); patch({ priceMax: parseYen(e.target.value) }); }}
            className="h-8 w-24 text-xs"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={!canCreate || busy !== null || shownDraftable === 0}
          onClick={() => setTicks(selectAllShown(shown))}>
          Select all shown ({shownDraftable})
        </Button>
        {ticks.size > 0 && (
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setTicks(new Set())}>Clear</Button>
        )}
        <span className="text-xs text-muted-foreground">Showing {shown.length} of {counts.total}</span>
        <Button
          size="sm"
          className="gold-gradient ml-auto text-primary-foreground"
          disabled={!canCreate || ticks.size === 0 || busy !== null}
          onClick={() => setConfirmOpen(true)}
        >
          {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <PackagePlus className="mr-1.5 h-4 w-4" />}
          Create drafts ({ticks.size})
        </Button>
      </div>

      <div className="max-h-96 overflow-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Code</TableHead>
              <TableHead className="min-w-[14rem]">Page365 name</TableHead>
              <TableHead className="hidden md:table-cell">Page365 category</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-6 text-center text-xs text-muted-foreground">
                  Nothing matches these filters{filters.inStockOnly && counts.soldOut > 0 ? " — sold pieces are hidden while “In stock only” is on" : ""}.
                </TableCell>
              </TableRow>
            ) : shown.map(it => (
              <TableRow key={it.id}>
                <TableCell className="w-8">
                  <Checkbox
                    aria-label={`Select ${it.code ?? ""}`}
                    checked={ticks.has(it.id)}
                    disabled={!canCreate || !draftable(it) || busy !== null}
                    onCheckedChange={v => toggle(it.id, v === true)}
                  />
                </TableCell>
                <TableCell className="font-medium">{it.code ?? "—"}</TableCell>
                <TableCell className="max-w-[22rem] truncate text-xs" title={nameOf(it)}>{nameOf(it)}</TableCell>
                <TableCell className="hidden text-xs text-muted-foreground md:table-cell">{it.page365_category ?? "—"}</TableCell>
                <TableCell className={`text-right tabular-nums ${(it.page365_available ?? 0) > 0 ? "" : "text-muted-foreground"}`}>
                  {it.page365_available ?? "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">{yen(it.page365_price_jpy)}</TableCell>
                <TableCell>
                  {isDrafted(it) && it.website_product_id ? (
                    <Link to={productLink(it.website_product_id)} className="text-[11px] text-primary underline-offset-2 hover:underline">
                      Draft created
                    </Link>
                  ) : it.result_note ? (
                    <span className="text-[11px] text-muted-foreground">{reasonText(it.result_note)}</span>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {result && (
        <div className="space-y-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs" role="status">
          <p>
            <b>{result.created ?? 0}</b> draft(s) created · <b>{result.skipped ?? 0}</b> skipped
            {(result.skipped_items ?? []).some(s => s.reason === "code_exists") && " (code already in the Hub)"} ·{" "}
            <b>{result.failed ?? 0}</b> failed.{" "}
            {photos && <>Photos: <b>{photos.copied}</b> copied{photos.failed ? <>, <b>{photos.failed}</b> failed</> : null}{busy === "photos" ? "…" : "."} </>}
            Drafts are not on the website. Set origin and category, then publish them in Catalog.{" "}
            <Link to={DRAFTS_VIEW_LINK} className="text-primary underline-offset-2 hover:underline">Open the Page365 drafts</Link>
          </p>
          {(result.created_items ?? []).length > 0 && (
            <ul className="flex flex-wrap gap-x-3 gap-y-1">
              {(result.created_items ?? []).slice(0, 60).map(c => (
                <li key={c.item_id}>
                  <Link to={productLink(c.product_id!)} className="font-medium text-primary underline-offset-2 hover:underline">{c.code}</Link>
                  {(c.needs ?? []).map(n => (
                    <Badge key={n} variant="outline" className="ml-1 text-[10px] text-warning">{NEEDS_LABEL[n] ?? n}</Badge>
                  ))}
                </li>
              ))}
              {(result.created_items ?? []).length > 60 && <li>… and {(result.created_items ?? []).length - 60} more</li>}
            </ul>
          )}
          {[...(result.skipped_items ?? []), ...(result.failed_items ?? [])].length > 0 && (
            <ul className="space-y-0.5 text-muted-foreground">
              {(result.skipped_items ?? []).map(s => (
                <li key={s.item_id}>
                  Skipped {s.code ?? ""}: {reasonText(s.reason)}
                  {s.product_id && <> — <Link to={productLink(s.product_id)} className="text-primary underline-offset-2 hover:underline">open it</Link></>}
                </li>
              ))}
              {(result.failed_items ?? []).map(f => (
                <li key={f.item_id} className="text-destructive">Failed {f.code ?? ""}: {reasonText(f.reason)}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Create {ticks.size} draft product(s)?</AlertDialogTitle>
            <AlertDialogDescription>
              Each becomes a Hub website product with status DRAFT: code, name, yen price, stock and every photo from
              Page365. Origin is left for you to set; category only where Page365's category clearly matches one.
              Nothing appears on the website until you publish it in Catalog. A code already in the Hub is skipped.
              {tickedSold > 0 && ` ${tickedSold} of them are sold out on Page365 and will be created with 0 stock.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={doCreate}>Create drafts</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
