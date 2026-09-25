import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { CatalogBulkBar } from "@/components/website/CatalogBulkBar";
import { missingText, publishMissing } from "@/lib/page365-drafts";
import { Download, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import ProductImportDialog from "@/components/website/ProductImportDialog";
import ProductDialog from "@/components/website/ProductDialog";
import { translateJa } from "@/components/website/translate";
import { uploadWebsiteImage } from "@/components/website/HeroImageField";
import { CATEGORIES_QUERY_KEY, fetchCategories } from "@/components/website/CategoriesCard";
import {
  ConditionValue, METAL_VALUES, MetalValue, ORIGIN_VALUES, OriginValue,
} from "@/lib/website-catalog-import";
import {
  type MediaRow, type ProductForm, type VariantRow, TEMPLATE_PATH,
  emptyProduct, emptyVariant, metalsLabel, slugify, yen,
} from "@/components/website/product-form";

/**
 * The website product list and everything that writes to it: the queries, the
 * save and remove mutations, the bulk Japanese pass, the import trigger and
 * the template download.
 *
 * Lifted out of WebsiteCatalog.tsx with its logic untouched. The one thing
 * that moved on screen is the action row — it used to sit beside the page
 * title and now sits in this card's header, because the card is no longer the
 * only thing on the page.
 */
export default function ProductsCard() {
  const { roles } = useAuth();
  const isAdmin = roles?.includes("admin");
  // The delete guard. isAdmin still gates the two ADMIN-ONLY things here — the
  // cost-basis field and the importer's admin mode — because those are about
  // money, not about who maintains the catalog. Removing a product is the
  // latter, so it follows the permission.
  const { can } = usePermissions();
  const canManage = can("manage_website_catalog") || !!isAdmin;
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ProductForm>(emptyProduct());
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [searchParams, setSearchParams] = useSearchParams();
  const draftsView = searchParams.get("view") === "page365-drafts";

  const collections = useQuery({
    queryKey: ["website-collections"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("website_collections" as any)
        .select("id, slug, name, name_ja, description, description_ja, hero_media")
        .order("name");
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

  const products = useQuery({
    queryKey: ["website-products"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("website_products" as any)
        .select(
          // "*" rather than a column list: page365_product_id (PR 4) is read when
          // the migration has run and simply absent before it.
          "*, " +
          "website_product_variants(id, size, stone, price_jpy, cost_basis, stock_qty, sort, website_product_media(id, url, alt, sort, page365_photo_id, page365_photo_version)), " +
          "website_collection_products(collection_id), website_category_products(category_id)"
        )
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

  const categories = useQuery({ queryKey: CATEGORIES_QUERY_KEY, queryFn: fetchCategories });

  const fx = useQuery({
    queryKey: ["website-fx-rate"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fx_rates" as any)
        .select("date, jpy_php")
        .order("date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as any;
    },
  });

  const rows = useMemo(() => (products.data ?? []).map((p: any) => {
    const variants = (p.website_product_variants ?? []) as any[];
    const prices = variants.map((v) => Number(v.price_jpy ?? 0)).filter((n) => n > 0);
    return {
      ...p,
      variantCount: variants.length,
      stock: variants.reduce((s, v) => s + Number(v.stock_qty ?? 0), 0),
      fromPrice: prices.length ? Math.min(...prices) : 0,
    };
  }), [products.data]);

  // ?view=page365-drafts (from "Create drafts"): only the Page365 drafts.
  const visible = useMemo(
    () => (draftsView ? rows.filter((p) => p.page365_product_id != null && p.status === "draft") : rows),
    [rows, draftsView],
  );
  const selectedRows = useMemo(() => visible.filter((p) => picked.has(p.id)), [visible, picked]);
  const clearParam = (key: string) => setSearchParams(prev => {
    const n = new URLSearchParams(prev);
    n.delete(key);
    return n;
  }, { replace: true });

  // ?product=<id> (links from "Create drafts"): open that product once loaded.
  const deepLinked = searchParams.get("product");
  useEffect(() => {
    if (!deepLinked || !products.data) return;
    const p = rows.find((r) => r.id === deepLinked);
    clearParam("product");
    if (p) openEdit(p);
    else toast({ title: "Product not found", description: "It may have been removed.", variant: "destructive" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinked, products.data]);

  function openNew() {
    setForm(emptyProduct());
    setOpen(true);
  }

  function openEdit(p: any) {
    const variants = ((p.website_product_variants ?? []) as any[])
      .sort((a, b) => Number(a.sort) - Number(b.sort))
      .map((v) => ({
        id: v.id,
        size: v.size ?? "",
        stone: v.stone ?? "",
        price_jpy: Number(v.price_jpy ?? 0),
        cost_basis: v.cost_basis === null ? null : Number(v.cost_basis),
        stock_qty: Number(v.stock_qty ?? 0),
        sort: Number(v.sort ?? 0),
        media: ((v.website_product_media ?? []) as any[])
          .sort((a, b) => Number(a.sort) - Number(b.sort))
          .map((m) => ({
            id: m.id, url: m.url, alt: m.alt, sort: Number(m.sort ?? 0),
            page365_photo_id: m.page365_photo_id ?? null, page365_photo_version: m.page365_photo_version ?? null,
          })),
      }));
    setForm({
      id: p.id,
      sku: p.sku ?? "",
      slug: p.slug ?? "",
      name: p.name ?? "",
      name_ja: p.name_ja ?? "",
      savedName: p.name ?? "",
      metals: (Array.isArray(p.metals) && p.metals.length ? p.metals : p.karat ? [p.karat] : [])
        .filter((m: string): m is MetalValue => (METAL_VALUES as readonly string[]).includes(m)),
      weight_g: p.weight_g === null ? null : Number(p.weight_g),
      condition: (p.condition === "Preloved" ? "Preloved" : "New") as ConditionValue,
      origin: (ORIGIN_VALUES as readonly string[]).includes(p.origin) ? (p.origin as OriginValue) : "UNKNOWN",
      brand: p.brand ?? "",
      description_en: p.description_en ?? "",
      description_ja: p.description_ja ?? "",
      savedEn: p.description_en ?? "",
      status: p.status ?? "draft",
      page365SyncDisabled: p.page365_sync_disabled === true,
      collectionIds: ((p.website_collection_products ?? []) as any[]).map((c) => c.collection_id),
      categoryIds: ((p.website_category_products ?? []) as any[]).map((c) => c.category_id),
      variants: variants.length ? variants : [emptyVariant(0)],
    });
    setOpen(true);
  }

  async function regenerateJapanese() {
    const name = form.name.trim();
    const en = form.description_en.trim();
    if (!name && !en) {
      toast({ title: "Nothing to translate", description: "Write the English name or description first." });
      return;
    }
    setTranslating(true);
    try {
      const ja = await translateJa({ name, description: en });
      setForm((f) => ({
        ...f,
        name_ja: name ? ja.name_ja : "",
        description_ja: en ? ja.description_ja : "",
      }));
      toast({ title: "Japanese updated" });
    } catch (e: any) {
      toast({ title: "Could not translate", description: e.message, variant: "destructive" });
    } finally {
      setTranslating(false);
    }
  }

  /**
   * Re-translate EVERY product's Japanese name and description in one pass,
   * sequentially so the AI rate limit is never hit. Name and description go in
   * one call per product, so a design term ("Open Teardrop") comes back the
   * same in both. English is never touched; a product whose translation fails
   * is skipped and named in the summary.
   */
  async function regenerateAllJapanese() {
    const rows = (products.data ?? []) as any[];
    const targets = rows.filter((p) => String(p.name ?? "").trim());
    if (!targets.length) { toast({ title: "Nothing to translate" }); return; }
    if (!confirm(`Regenerate the Japanese name and description for ${targets.length} product${targets.length === 1 ? "" : "s"}? English text is not changed.`)) return;
    setBulk({ done: 0, total: targets.length });
    const failed: string[] = [];
    for (const [i, p] of targets.entries()) {
      try {
        const en = String(p.description_en ?? "").trim();
        const out = await translateJa({ name: String(p.name).trim(), description: en || undefined });
        const { error } = await supabase.from("website_products" as any)
          .update({ name_ja: out.name_ja || null, description_ja: en ? out.description_ja || null : null })
          .eq("id", p.id);
        if (error) throw error;
      } catch (e: any) {
        failed.push(`${p.sku ?? p.name}: ${e.message}`);
      } finally {
        setBulk({ done: i + 1, total: targets.length });
      }
    }
    setBulk(null);
    qc.invalidateQueries({ queryKey: ["website-products"] });
    if (failed.length) {
      toast({ title: `Japanese regenerated for ${targets.length - failed.length} of ${targets.length}`, description: failed.join(" · "), variant: "destructive" });
    } else {
      toast({ title: `Japanese regenerated for ${targets.length} product${targets.length === 1 ? "" : "s"}` });
    }
  }

  const save = useMutation({
    mutationFn: async (f: ProductForm) => {
      if (!f.name.trim() || !f.sku.trim()) throw new Error("Name and SKU are required.");
      if (!f.metals.length) throw new Error("Pick at least one metal stamp.");
      if (!f.variants.length) throw new Error("Add at least one variant.");
      if (f.origin === "BRAND" && !f.brand.trim()) throw new Error("Enter the brand name for a Branded piece.");
      const slug = (f.slug.trim() || slugify(f.name));
      const wasActive = (products.data ?? []).some((p) => p.id === f.id && p.status === "active");
      const goingLive = f.status === "active" && !wasActive;

      // Japanese is derived from the English text: refresh it when the English
      // changed, or when it has never been generated. Never on an unchanged product.
      const name = f.name.trim();
      const en = f.description_en.trim();
      let nameJa = f.name_ja.trim();
      let ja = f.description_ja.trim();
      if (!en) ja = "";
      const needName = name !== f.savedName.trim() || !nameJa;
      const needDesc = !!en && (en !== f.savedEn.trim() || !ja);
      if (needName || needDesc) {
        setTranslating(true);
        try {
          const out = await translateJa({
            name: needName ? name : undefined,
            description: needDesc ? en : undefined,
          });
          if (needName) nameJa = out.name_ja;
          if (needDesc) ja = out.description_ja;
        } catch (e: any) {
          toast({
            title: "Japanese not regenerated",
            description: `${e.message} The product still saved — use Regenerate to retry.`,
            variant: "destructive",
          });
        } finally {
          setTranslating(false);
        }
      }

      const productPayload = {
        sku: f.sku.trim(),
        slug,
        name,
        name_ja: nameJa || null,
        metals: f.metals,
        weight_g: f.weight_g,
        condition: f.condition,
        origin: f.origin,
        brand: f.brand.trim() || null,
        description_en: en || null,
        description_ja: ja || null,
        // Going live is written LAST, after categories: a Page365 draft is
        // refused publication without a category (trg_page365_draft_publish_guard).
        status: goingLive ? "draft" : f.status,
        page365_sync_disabled: f.page365SyncDisabled,
      };

      let productId = f.id;
      if (productId) {
        const { error } = await supabase.from("website_products" as any)
          .update(productPayload).eq("id", productId);
        if (error) throw error;
      } else {
        const { data, error } = await supabase.from("website_products" as any)
          .insert(productPayload).select("id").single();
        if (error) throw error;
        productId = (data as any).id;
      }

      // Variants: upsert, then remove ones deleted in the form.
      const keptVariantIds: string[] = [];
      for (const [i, v] of f.variants.entries()) {
        const payload = {
          product_id: productId,
          size: v.size?.trim() || null,
          stone: v.stone?.trim() || null,
          price_jpy: Math.round(Number(v.price_jpy) || 0),
          cost_basis: v.cost_basis === null || v.cost_basis === undefined ? null : Math.round(Number(v.cost_basis)),
          stock_qty: Math.round(Number(v.stock_qty) || 0),
          sort: i,
        };
        let variantId = v.id;
        if (variantId) {
          const { error } = await supabase.from("website_product_variants" as any)
            .update(payload).eq("id", variantId);
          if (error) throw error;
        } else {
          const { data, error } = await supabase.from("website_product_variants" as any)
            .insert(payload).select("id").single();
          if (error) throw error;
          variantId = (data as any).id;
        }
        keptVariantIds.push(variantId!);

        // Media rows for this variant (replace-all — media list is small).
        const { error: delMediaErr } = await supabase.from("website_product_media" as any)
          .delete().eq("variant_id", variantId);
        if (delMediaErr) throw delMediaErr;
        if (v.media.length) {
          const { error: insMediaErr } = await supabase.from("website_product_media" as any)
            .insert(v.media.map((m, idx) => ({
              variant_id: variantId, url: m.url, alt: m.alt?.trim() || null, sort: idx,
              // Keep a copied Page365 photo's identity, or the next fetch
              // would copy it again (duplicate photo).
              page365_photo_id: m.page365_photo_id ?? null,
              page365_photo_version: m.page365_photo_version ?? null,
            })));
          if (insMediaErr) throw insMediaErr;
        }
      }
      const { data: existing } = await supabase.from("website_product_variants" as any)
        .select("id").eq("product_id", productId);
      const stale = ((existing ?? []) as any[]).map((r) => r.id).filter((id) => !keptVariantIds.includes(id));
      if (stale.length) {
        const { error } = await supabase.from("website_product_variants" as any).delete().in("id", stale);
        if (error) throw error;
      }

      // Collection membership
      const { error: delColErr } = await supabase.from("website_collection_products" as any)
        .delete().eq("product_id", productId);
      if (delColErr) throw delColErr;
      if (f.collectionIds.length) {
        const { error } = await supabase.from("website_collection_products" as any)
          .insert(f.collectionIds.map((cid, idx) => ({
            collection_id: cid, product_id: productId, sort: idx,
          })));
        if (error) throw error;
      }

      // Category membership — its own join table with its own column name
      // (sort_order, not sort). Never the collection payload.
      const { error: delCatErr } = await supabase.from("website_category_products" as any)
        .delete().eq("product_id", productId);
      if (delCatErr) throw delCatErr;
      if (f.categoryIds.length) {
        const { error } = await supabase.from("website_category_products" as any)
          .insert(f.categoryIds.map((cid, idx) => ({
            category_id: cid, product_id: productId, sort_order: idx,
          })));
        if (error) throw error;
      }
      if (goingLive) {
        const { error } = await supabase.from("website_products" as never)
          .update({ status: "active" } as never).eq("id", productId!);
        if (error) throw new Error(`Saved as a draft, not published: ${error.message}`);
      }
      return productId;
    },
    onSuccess: () => {
      toast({ title: "Saved", description: "The website will refresh within a minute." });
      qc.invalidateQueries({ queryKey: ["website-products"] });
      setOpen(false);
    },
    onError: (e: any) => toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("website_products" as any).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Product removed" });
      qc.invalidateQueries({ queryKey: ["website-products"] });
    },
    onError: (e: any) => toast({ title: "Could not remove", description: e.message, variant: "destructive" }),
  });

  async function uploadMedia(variantIndex: number, files: FileList | null) {
    if (!files?.length) return;
    setUploadingKey(`v${variantIndex}`);
    try {
      const uploaded: MediaRow[] = [];
      for (const file of Array.from(files)) {
        const url = await uploadWebsiteImage("", file);
        uploaded.push({ url, alt: form.name || null, sort: 0 });
      }
      setForm((f) => {
        const variants = [...f.variants];
        variants[variantIndex] = {
          ...variants[variantIndex],
          media: [...variants[variantIndex].media, ...uploaded],
        };
        return { ...f, variants };
      });
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setUploadingKey(null);
    }
  }

  function patchVariant(i: number, patch: Partial<VariantRow>) {
    setForm((f) => {
      const variants = [...f.variants];
      variants[i] = { ...variants[i], ...patch };
      return { ...f, variants };
    });
  }

  const jpyPhp = fx.data ? Number((fx.data as any).jpy_php) : null;
  const peso = (n: number) =>
    jpyPhp ? `₱ ${Math.round(n * jpyPhp).toLocaleString("en-US")}` : "—";

  return (
    <>
      <Card>
        <CardHeader className="hairline-b">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
            <CardTitle className="text-base">
              Products {products.data ? `(${products.data.length})` : ""}
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              {jpyPhp
                ? `Peso prices are calculated on the website from the daily rate — ¥1 = ₱${jpyPhp} as of ${(fx.data as any).date}. Nothing peso-denominated is stored here.`
                : "No exchange rate on file yet — the website will show yen only until the daily rate lands."}
            </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" asChild>
            <a href={TEMPLATE_PATH} download>
              <Download className="mr-2 h-4 w-4" /> Download template
            </a>
          </Button>
          <ProductImportDialog
            collections={(collections.data ?? []) as any[]}
            categories={(categories.data ?? []).map((c) => ({ id: c.id, name: c.name, slug: c.slug }))}
            isAdmin={!!isAdmin}
            translate={translateJa}
          />
          <Button variant="outline" onClick={regenerateAllJapanese} disabled={!!bulk || !(products.data ?? []).length}>
            {bulk
              ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Translating {bulk.done}/{bulk.total}</>
              : <><RefreshCw className="mr-2 h-4 w-4" /> Regenerate all Japanese</>}
          </Button>
          <Button onClick={openNew}>
            <Plus className="mr-2 h-4 w-4" /> Add product
          </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {draftsView && (
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs">
              <Badge variant="outline">Page365 drafts only ({visible.length})</Badge>
              <span className="text-muted-foreground">Not on the website. Set origin and category, then select and Publish.</span>
              <Button size="sm" variant="ghost" onClick={() => clearParam("view")}>Show all products</Button>
            </div>
          )}
          {canManage && (
            <CatalogBulkBar
              selected={selectedRows}
              categories={(categories.data ?? []).map((c) => ({ id: c.id, name: c.name }))}
              onDone={() => qc.invalidateQueries({ queryKey: ["website-products"] })}
              onClear={() => setPicked(new Set())}
            />
          )}
          {products.isLoading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : visible.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              No products yet. Add your first piece to publish it on the website.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {canManage && (
                    <TableHead className="w-8">
                      <Checkbox
                        aria-label="Select all"
                        checked={visible.length > 0 && selectedRows.length === visible.length}
                        onCheckedChange={(v) => setPicked(v === true ? new Set(visible.map((p) => p.id as string)) : new Set())}
                      />
                    </TableHead>
                  )}
                  <TableHead>Name</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Metal</TableHead>
                  <TableHead>Condition</TableHead>
                  <TableHead>Origin</TableHead>
                  <TableHead className="text-right">From</TableHead>
                  <TableHead className="text-right">Approx.</TableHead>
                  <TableHead className="text-right">Variants</TableHead>
                  <TableHead className="text-right">Stock</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((p: any) => (
                  <TableRow key={p.id} className="cursor-pointer" onClick={() => openEdit(p)}>
                    {canManage && (
                      <TableCell className="w-8" onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          aria-label={`Select ${p.sku}`}
                          checked={picked.has(p.id)}
                          onCheckedChange={(v) => setPicked((prev) => {
                            const n = new Set(prev);
                            if (v === true) n.add(p.id); else n.delete(p.id);
                            return n;
                          })}
                        />
                      </TableCell>
                    )}
                    <TableCell className="font-medium">
                      {p.name}
                      {p.name_ja && <div className="text-xs font-normal text-muted-foreground" lang="ja">{p.name_ja}</div>}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {p.sku}
                      {p.page365_sync_disabled && (
                        <Badge variant="outline" className="ml-1.5 text-[10px] text-muted-foreground" title="Don't sync with Page365">
                          Not synced
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>{metalsLabel(p.metals, p.karat)}</TableCell>
                    <TableCell>
                      {p.condition === "Preloved"
                        ? <Badge variant="secondary">Preloved</Badge>
                        : <span className="text-muted-foreground">New</span>}
                    </TableCell>
                    <TableCell>
                      {p.origin === "JAPAN" ? "Made in Japan"
                        : p.origin === "BRAND" ? (p.brand || <span className="text-warning">Branded — no brand name</span>)
                        : p.origin === "OTHER" ? <span className="text-muted-foreground">Other</span>
                        : <span className="text-muted-foreground">Unknown</span>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{p.fromPrice ? yen(p.fromPrice) : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {p.fromPrice ? peso(p.fromPrice) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{p.variantCount}</TableCell>
                    <TableCell className="text-right tabular-nums">{p.stock}</TableCell>
                    <TableCell>
                      <Badge variant={p.status === "active" ? "default" : "secondary"}>{p.status}</Badge>
                      {p.status === "draft" && publishMissing(p).length > 0 && (
                        <div className="mt-0.5 text-[10px] text-warning">{missingText(publishMissing(p))}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {canManage && (
                        <Button
                          variant="ghost" size="icon"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm(`Remove ${p.name} from the website catalog?`)) remove.mutate(p.id);
                          }}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ProductDialog
        open={open}
        onOpenChange={setOpen}
        form={form}
        setForm={setForm}
        collections={(collections.data ?? []) as any[]}
        categories={categories.data ?? []}
        isAdmin={!!isAdmin}
        translating={translating}
        uploadingKey={uploadingKey}
        peso={peso}
        saving={save.isPending}
        onSave={() => save.mutate(form)}
        onRegenerateJapanese={regenerateJapanese}
        onUploadMedia={uploadMedia}
        onPatchVariant={patchVariant}
      />
    </>
  );
}
