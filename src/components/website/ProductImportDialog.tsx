import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import * as XLSX from "xlsx";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertTriangle, FileSpreadsheet, Loader2, Upload } from "lucide-react";
import {
  CollectionOption, DATA_START_ROW, ImportRow, ImportRowInput, SHEET_NAME,
  isBlankRow, rowAction, validateRow,
} from "@/lib/website-catalog-import";
import type { TranslateFn } from "@/lib/website-catalog-import";

/**
 * Spreadsheet import for the Website Catalog.
 *
 * Parses the Page365 upload template client-side, shows a per-row preview, then
 * writes each row through the same Supabase calls the edit modal uses. One
 * variant per row — these are one-of-a-kind pieces.
 */

interface Props {
  collections: CollectionOption[];
  isAdmin: boolean;
  /** Same translate call the edit modal's Regenerate button uses. */
  translate: TranslateFn;
}

interface Summary { created: number; updated: number; skipped: number }

const HEADER_ROW_INDEX = 0;
const IMAGE_COLUMNS = Array.from({ length: 10 }, (_, i) => `image_${i + 1}`);

export default function ProductImportDialog({ collections, isAdmin, translate }: Props) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [existingSkus, setExistingSkus] = useState<Set<string>>(new Set());
  const [parsing, setParsing] = useState(false);
  const [skipErrors, setSkipErrors] = useState(false);
  const [translateJa, setTranslateJa] = useState(true);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);

  const errorCount = rows.filter((r) => r.errors.length).length;
  const okRows = useMemo(() => rows.filter((r) => !r.errors.length), [rows]);
  const createCount = okRows.filter((r) => rowAction(r, existingSkus) === "create").length;
  const updateCount = okRows.length - createCount;
  const canImport = okRows.length > 0 && (errorCount === 0 || skipErrors) && !progress;

  function reset() {
    setFileName(""); setRows([]); setSummary(null); setProgress(null);
    setSkipErrors(false); setExistingSkus(new Set());
    if (fileRef.current) fileRef.current.value = "";
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    setParsing(true);
    setSummary(null);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[SHEET_NAME] ?? wb.Sheets[wb.SheetNames[0]];
      if (!sheet) throw new Error("The file has no readable sheet.");

      const grid = XLSX.utils.sheet_to_json<string[]>(sheet, {
        header: 1, raw: false, defval: "", blankrows: true,
      });
      const header = (grid[HEADER_ROW_INDEX] ?? []).map((h) => String(h ?? "").trim());
      if (!header.includes("buy_code")) {
        throw new Error(
          "This does not look like the product upload template — no buy_code column in row 1.",
        );
      }
      const col = (name: string) => header.indexOf(name);
      const cell = (r: string[], name: string) => {
        const i = col(name);
        return i < 0 ? "" : String(r[i] ?? "").trim();
      };

      // Existing SKUs decide Create vs Update, and are matched case-insensitively.
      const { data: existing, error } = await supabase
        .from("website_products" as any)
        .select("sku");
      if (error) throw error;
      const skus = new Set(
        ((existing ?? []) as any[]).map((p) => String(p.sku ?? "").trim().toUpperCase()),
      );

      const parsed: ImportRow[] = [];
      for (let i = DATA_START_ROW - 1; i < grid.length; i++) {
        const r = grid[i] ?? [];
        const input: ImportRowInput = {
          sheetRow: i + 1,
          buy_code: cell(r, "buy_code"),
          product_name: cell(r, "product_name"),
          product_description: cell(r, "product_description"),
          price: cell(r, "price"),
          cost: cell(r, "cost"),
          stock_amount: cell(r, "stock_amount"),
          hub_jewelry_type: cell(r, "hub_jewelry_type"),
          hub_metal: cell(r, "hub_metal"),
          hub_weight_g: cell(r, "hub_weight_g"),
          hub_stone: cell(r, "hub_stone"),
          hub_size: cell(r, "hub_size"),
          hub_condition: cell(r, "hub_condition"),
          hub_status: cell(r, "hub_status"),
          // Both columns are new to the template; an older sheet without them
          // simply yields "" here, which validateRow reads as UNKNOWN / no brand.
          hub_origin: cell(r, "hub_origin"),
          hub_brand: cell(r, "hub_brand"),
          images: IMAGE_COLUMNS.map((c) => cell(r, c)),
        };
        if (isBlankRow(input)) continue;
        parsed.push(validateRow(input, { collections, isAdmin, existingSkus: skus }));
      }

      if (!parsed.length) {
        throw new Error(`No data rows found. Data starts at row ${DATA_START_ROW}.`);
      }
      setExistingSkus(skus);
      setRows(parsed);
      setFileName(file.name);
    } catch (e: any) {
      toast({ title: "Could not read the file", description: e.message, variant: "destructive" });
      reset();
    } finally {
      setParsing(false);
    }
  }

  /** Mirrors the edit modal's save sequence for a single one-variant product. */
  async function importRow(row: ImportRow): Promise<"create" | "update"> {
    const v = row.value!;

    const { data: found, error: findErr } = await supabase
      .from("website_products" as any)
      .select("id, slug, name, name_ja, description_en, description_ja")
      .eq("sku", v.sku)
      .maybeSingle();
    if (findErr) throw findErr;
    const existingProduct = found as any | null;
    const action: "create" | "update" = existingProduct ? "update" : "create";

    // Japanese only when the English changed or none exists yet — same rule as
    // the modal, so re-uploading an unchanged sheet costs no AI calls.
    let ja = String(existingProduct?.description_ja ?? "");
    let nameJa = String(existingProduct?.name_ja ?? "");
    const prevEn = String(existingProduct?.description_en ?? "").trim();
    const prevName = String(existingProduct?.name ?? "").trim();
    const needDesc = !!v.description_en && (v.description_en !== prevEn || !ja);
    const needName = v.name !== prevName || !nameJa;
    if (translateJa && (needDesc || needName)) {
      try {
        const out = await translate({
          name: needName ? v.name : undefined,
          description: needDesc ? v.description_en : undefined,
        });
        if (needName) nameJa = out.name_ja;
        if (needDesc) ja = out.description_ja;
      } catch (e: any) {
        throw new Error(`Japanese translation failed: ${e.message}`);
      }
    }

    const payload = {
      sku: v.sku,
      // Keep the existing web address on update — changing it breaks live links.
      slug: existingProduct?.slug ?? v.slug,
      name: v.name,
      name_ja: nameJa || null,
      karat: v.karat,
      weight_g: v.weight_g,
      description_en: v.description_en,
      description_ja: ja || null,
      condition: v.condition,
      origin: v.origin,
      brand: v.brand,
      status: v.status,
    };

    let productId: string;
    if (existingProduct) {
      productId = existingProduct.id;
      const { error } = await supabase.from("website_products" as any)
        .update(payload).eq("id", productId);
      if (error) throw error;
    } else {
      const { data, error } = await supabase.from("website_products" as any)
        .insert(payload).select("id").single();
      if (error) throw error;
      productId = (data as any).id;
    }

    // One variant per row. Reuse the first existing variant so its media and id
    // survive an update; drop any extras.
    const { data: variants, error: vErr } = await supabase
      .from("website_product_variants" as any)
      .select("id").eq("product_id", productId).order("sort");
    if (vErr) throw vErr;
    const variantIds = ((variants ?? []) as any[]).map((x) => x.id as string);

    const variantPayload = {
      product_id: productId,
      size: v.size,
      stone: v.stone,
      price_jpy: v.price_jpy,
      stock_qty: v.stock_qty,
      sort: 0,
      ...(v.cost_basis === null ? {} : { cost_basis: v.cost_basis }),
    };

    let variantId: string;
    if (variantIds.length) {
      variantId = variantIds[0];
      const { error } = await supabase.from("website_product_variants" as any)
        .update(variantPayload).eq("id", variantId);
      if (error) throw error;
      if (variantIds.length > 1) {
        const { error: delErr } = await supabase.from("website_product_variants" as any)
          .delete().in("id", variantIds.slice(1));
        if (delErr) throw delErr;
      }
    } else {
      const { data, error } = await supabase.from("website_product_variants" as any)
        .insert(variantPayload).select("id").single();
      if (error) throw error;
      variantId = (data as any).id;
    }

    // Photos are replaced only when the sheet supplies at least one URL.
    if (v.images.length) {
      const { error: delErr } = await supabase.from("website_product_media" as any)
        .delete().eq("variant_id", variantId);
      if (delErr) throw delErr;
      const { error: insErr } = await supabase.from("website_product_media" as any)
        .insert(v.images.map((url, idx) => ({
          variant_id: variantId, url, alt: v.name, sort: idx,
        })));
      if (insErr) throw insErr;
    }

    const { error: delColErr } = await supabase.from("website_collection_products" as any)
      .delete().eq("product_id", productId);
    if (delColErr) throw delColErr;
    const { error: colErr } = await supabase.from("website_collection_products" as any)
      .insert({ collection_id: v.collectionId, product_id: productId, sort: 0 });
    if (colErr) throw colErr;

    return action;
  }

  async function runImport() {
    const queue = okRows;
    setProgress({ done: 0, total: queue.length });
    let created = 0, updated = 0, skipped = errorCount;
    const failures: { row: number; sku: string; error: string }[] = [];

    for (const [i, row] of queue.entries()) {
      try {
        const action = await importRow(row);
        if (action === "create") created++; else updated++;
      } catch (e: any) {
        skipped++;
        failures.push({ row: row.sheetRow, sku: row.sku, error: e.message ?? String(e) });
      }
      setProgress({ done: i + 1, total: queue.length });
    }

    const errorLog = [
      ...rows.filter((r) => r.errors.length).map((r) => ({
        row: r.sheetRow, sku: r.sku, error: r.errors.join("; "),
      })),
      ...failures,
    ];

    // Traceability row. A failure here must not lose the import result.
    const { data: session } = await supabase.auth.getUser();
    const { error: batchErr } = await supabase.from("website_import_batches" as any).insert({
      file_name: fileName,
      uploaded_by: session?.user?.id ?? null,
      row_count: rows.length,
      created,
      updated,
      skipped,
      errors: errorLog.length ? errorLog : null,
    });
    if (batchErr) {
      toast({
        title: "Import finished, batch log not saved",
        description: batchErr.message,
        variant: "destructive",
      });
    }

    setProgress(null);
    setSummary({ created, updated, skipped });
    qc.invalidateQueries({ queryKey: ["website-products"] });

    if (failures.length) {
      toast({
        title: `${failures.length} row${failures.length === 1 ? "" : "s"} failed to save`,
        description: failures.slice(0, 3).map((f) => `Row ${f.row}: ${f.error}`).join(" · "),
        variant: "destructive",
      });
    } else {
      toast({
        title: "Import complete",
        description: `${created} created, ${updated} updated${skipped ? `, ${skipped} skipped` : ""}.`,
      });
    }
  }

  return (
    <>
      <Button variant="outline" onClick={() => { reset(); setOpen(true); }}>
        <Upload className="mr-2 h-4 w-4" /> Upload spreadsheet
      </Button>

      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Upload product spreadsheet</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="rounded-lg border border-dashed border-border p-4">
              <label className="flex cursor-pointer items-center gap-3 text-sm">
                {parsing
                  ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  : <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />}
                <span className="text-foreground">
                  {fileName || "Choose an .xlsx or .csv file"}
                </span>
                <input
                  ref={fileRef} type="file" accept=".xlsx,.csv" className="hidden"
                  onChange={(e) => onFile(e.target.files?.[0])}
                />
              </label>
              <p className="mt-2 text-xs text-muted-foreground">
                Uses the product upload template. Row 1 is the header, rows 2–4 are
                guidance, data starts at row {DATA_START_ROW}. One piece per row.
              </p>
            </div>

            {rows.length > 0 && (
              <>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant="default">{createCount} to create</Badge>
                  <Badge variant="secondary">{updateCount} to update</Badge>
                  {errorCount > 0 && (
                    <Badge variant="destructive">{errorCount} with errors</Badge>
                  )}
                  <span className="text-muted-foreground">· {rows.length} rows read</span>
                </div>

                <div className="max-h-[40vh] overflow-y-auto rounded-lg border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-16">Row</TableHead>
                        <TableHead className="w-28">SKU</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead className="w-24">Action</TableHead>
                        <TableHead>Errors</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((r) => (
                        <TableRow key={r.sheetRow} className={r.errors.length ? "bg-destructive/5" : ""}>
                          <TableCell className="tabular-nums text-muted-foreground">{r.sheetRow}</TableCell>
                          <TableCell className="font-medium">{r.sku || "—"}</TableCell>
                          <TableCell className="max-w-[18rem] truncate">{r.name || "—"}</TableCell>
                          <TableCell>
                            {r.errors.length ? (
                              <span className="text-destructive">Skip</span>
                            ) : rowAction(r, existingSkus) === "create" ? "Create" : "Update"}
                          </TableCell>
                          <TableCell className="text-xs text-destructive">
                            {r.errors.join("; ")}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                {errorCount > 0 && (
                  <label className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-sm">
                    <Checkbox
                      checked={skipErrors}
                      onCheckedChange={(c) => setSkipErrors(c === true)}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="flex items-center gap-1.5 font-medium text-foreground">
                        <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                        Skip rows with errors
                      </span>
                      <span className="text-muted-foreground">
                        Import the {okRows.length} clean row{okRows.length === 1 ? "" : "s"} and leave
                        the rest. Otherwise fix the sheet and upload it again.
                      </span>
                    </span>
                  </label>
                )}

                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={translateJa} onCheckedChange={(c) => setTranslateJa(c === true)} />
                  <span className="text-muted-foreground">
                    Generate Japanese descriptions (one AI call per changed row — turn off for a
                    large first import and use Regenerate later)
                  </span>
                </label>
              </>
            )}

            {progress && (
              <div className="space-y-1.5">
                <Progress value={(progress.done / Math.max(progress.total, 1)) * 100} />
                <p className="text-xs text-muted-foreground">
                  Importing {progress.done} of {progress.total}…
                </p>
              </div>
            )}

            {summary && (
              <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
                <p className="font-medium text-foreground">Import complete</p>
                <p className="text-muted-foreground">
                  {summary.created} created · {summary.updated} updated · {summary.skipped} skipped
                </p>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {summary ? "Close" : "Cancel"}
            </Button>
            <Button onClick={runImport} disabled={!canImport}>
              {progress && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Import {okRows.length > 0 ? `${okRows.length} row${okRows.length === 1 ? "" : "s"}` : ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
