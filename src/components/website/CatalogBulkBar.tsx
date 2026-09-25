import { useState } from "react";
import { Loader2, Send } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { japaneseFor } from "@/components/website/translate";
import { ORIGIN_LABELS, type OriginValue } from "@/lib/website-catalog-import";
import { PUBLISH_REFUSAL, missingText, publishMissing } from "@/lib/page365-drafts";
import { publishProducts } from "@/lib/page365-drafts-api";

/**
 * Catalog bulk actions on the selected products: set origin, add a category,
 * and PUBLISH. Publishing goes through website_publish_products, which refuses
 * any product still missing origin, category, a brand name (Branded), a metal
 * stamp (jewelry only — watches and other items need none) or a price and
 * names what is missing. Before publishing, a draft whose
 * Japanese was never generated is translated (English is the source; failures
 * never block — Regenerate retries).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Product = any;

export function CatalogBulkBar({ selected, categories, onDone, onClear }: {
  selected: Product[];
  categories: { id: string; name: string }[];
  onDone: () => Promise<void> | void;
  onClear: () => void;
}) {
  const [busy, setBusy] = useState<null | string>(null);
  const [origin, setOrigin] = useState<OriginValue | "">("");
  const [brand, setBrand] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const drafts = selected.filter(p => p.status === "draft");
  const ready = drafts.filter(p => publishMissing(p).length === 0);
  const notReady = drafts.filter(p => publishMissing(p).length > 0);
  const ids = selected.map(p => p.id as string);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      toast({ title: `Could not ${label}`, description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(null);
      await onDone();
    }
  };

  const applyOrigin = () => run("set origin", async () => {
    if (!origin) return;
    if (origin === "BRAND" && !brand.trim()) throw new Error("Enter the brand name for Branded pieces.");
    const { error } = await supabase.from("website_products" as never)
      .update({ origin, brand: origin === "BRAND" ? brand.trim() : null } as never).in("id", ids);
    if (error) throw error;
    toast({ title: `Origin set on ${ids.length} product(s)` });
  });

  const addCategory = () => run("add the category", async () => {
    if (!categoryId) return;
    // Insert only the missing memberships (the join table's keys are not ours to assume).
    const { data: have, error: readErr } = await supabase.from("website_category_products" as never)
      .select("product_id").eq("category_id", categoryId).in("product_id", ids);
    if (readErr) throw readErr;
    const already = new Set(((have ?? []) as { product_id: string }[]).map(r => r.product_id));
    const add = ids.filter(pid => !already.has(pid));
    if (add.length) {
      const { error } = await supabase.from("website_category_products" as never)
        .insert(add.map(pid => ({ category_id: categoryId, product_id: pid, sort_order: 0 })) as never);
      if (error) throw error;
    }
    toast({ title: `Category added to ${ids.length} product(s)` });
  });

  const publish = () => run("publish", async () => {
    setConfirmOpen(false);
    // Japanese first, for the drafts that will actually go live.
    for (const [i, p] of ready.entries()) {
      const needName = !p.name_ja;
      const needDesc = !!(p.description_en ?? "").trim() && !p.description_ja;
      if (!needName && !needDesc) continue;
      setBusy(`translate ${i + 1}/${ready.length}`);
      const patch = await japaneseFor({
        name: needName ? String(p.name) : undefined,
        description: needDesc ? String(p.description_en) : undefined,
      });
      if (Object.keys(patch).length) {
        await supabase.from("website_products" as never).update(patch as never).eq("id", p.id);
      }
    }
    setBusy("publish");
    const r = await publishProducts(drafts.map(p => p.id));
    if (!r.ok) throw new Error(PUBLISH_REFUSAL[r.reason ?? ""] ?? `Refused (${r.reason}).`);
    const blocked = r.blocked_items ?? [];
    toast({
      title: `${r.published ?? 0} published${blocked.length ? ` · ${blocked.length} not published` : ""}`,
      description: blocked.length
        ? blocked.slice(0, 8).map(b => `${b.sku}: ${missingText(b.missing)}`).join(" · ") + (blocked.length > 8 ? " …" : "")
        : "The website will refresh within a minute.",
      variant: blocked.length ? "destructive" : undefined,
    });
    onClear();
  });

  if (!selected.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-4 py-2 text-xs" role="toolbar" aria-label="Bulk actions">
      <span className="font-medium">{selected.length} selected</span>
      <Button size="sm" variant="ghost" onClick={onClear} disabled={!!busy}>Clear</Button>

      <div className="flex items-center gap-1">
        <Select value={origin} onValueChange={v => setOrigin(v as OriginValue)}>
          <SelectTrigger className="h-8 w-36 text-xs" aria-label="Origin"><SelectValue placeholder="Set origin…" /></SelectTrigger>
          <SelectContent>
            {(["JAPAN", "BRAND", "OTHER"] as const).map(o => <SelectItem key={o} value={o}>{ORIGIN_LABELS[o]}</SelectItem>)}
          </SelectContent>
        </Select>
        {origin === "BRAND" && (
          <Input aria-label="Brand name" placeholder="Brand name" value={brand} onChange={e => setBrand(e.target.value)} className="h-8 w-32 text-xs" />
        )}
        <Button size="sm" variant="outline" disabled={!origin || !!busy} onClick={applyOrigin}>Apply</Button>
      </div>

      <div className="flex items-center gap-1">
        <Select value={categoryId} onValueChange={setCategoryId}>
          <SelectTrigger className="h-8 w-40 text-xs" aria-label="Category"><SelectValue placeholder="Add category…" /></SelectTrigger>
          <SelectContent>
            {categories.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" disabled={!categoryId || !!busy} onClick={addCategory}>Add</Button>
      </div>

      <Button
        size="sm"
        className="gold-gradient ml-auto text-primary-foreground"
        disabled={drafts.length === 0 || !!busy}
        onClick={() => setConfirmOpen(true)}
      >
        {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Send className="mr-1.5 h-4 w-4" />}
        {busy && busy.startsWith("translate") ? `Japanese ${busy.slice(10)}` : `Publish (${drafts.length})`}
      </Button>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publish {ready.length} of {drafts.length} draft(s)?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>{ready.length} will appear on the website. Japanese is generated first where it is missing.</p>
                {notReady.length > 0 && (
                  <div className="text-warning">
                    <p>{notReady.length} cannot be published yet and stay drafts:</p>
                    <ul className="mt-1 max-h-40 list-disc overflow-auto pl-5 text-xs">
                      {notReady.slice(0, 50).map(p => <li key={p.id}>{p.sku}: {missingText(publishMissing(p))}</li>)}
                    </ul>
                  </div>
                )}
                {selected.length > drafts.length && (
                  <p className="text-muted-foreground">{selected.length - drafts.length} selected product(s) are not drafts and are left as they are.</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={publish} disabled={ready.length === 0}>Publish</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
