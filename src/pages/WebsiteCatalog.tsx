import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "@/hooks/use-toast";
import PageMeta from "@/components/seo/PageMeta";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Download, Globe, Loader2, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import ProductImportDialog from "@/components/website/ProductImportDialog";
import type { TranslateFn } from "@/lib/website-catalog-import";
import {
  CONDITION_VALUES, ConditionValue, METAL_VALUES, MetalValue, ORIGIN_LABELS, ORIGIN_VALUES, OriginValue,
} from "@/lib/website-catalog-import";

/** Public website catalog manager. Feeds the `website` API used by chajewelsjp.com. */

const MEDIA_BUCKET = "promotions";
const MEDIA_PREFIX = "website";
/** Served from public/ — the Page365 upload sheet with the hub_* columns. */
const TEMPLATE_PATH = "/templates/cha-jewels-product-upload-template.xlsx";

type Status = "draft" | "active" | "archived";

/**
 * Metals are shown exactly as stamped (METAL_VALUES is the single source of
 * truth, shared with the importer). A piece can carry several — PT900/K18 —
 * in the order staff pick them. Nothing is merged: 750 is 750, not K18.
 */
const metalsLabel = (metals: unknown, karat?: string | null) => {
  const list = Array.isArray(metals) && metals.length ? (metals as string[]) : karat ? [karat] : [];
  return list.length ? list.join(" / ") : "—";
};

interface MediaRow { id?: string; url: string; alt: string | null; sort: number }
interface VariantRow {
  id?: string;
  size: string | null;
  stone: string | null;
  price_jpy: number;
  cost_basis: number | null;
  stock_qty: number;
  sort: number;
  media: MediaRow[];
}
interface ProductForm {
  id?: string;
  sku: string;
  slug: string;
  name: string;
  /** Generated from `name` on save — never typed by staff. */
  name_ja: string;
  /** English name as last saved — the Japanese name only refreshes when it changes. */
  savedName: string;
  /** Stamps in the order picked; at least one to save. */
  metals: MetalValue[];
  weight_g: number | null;
  condition: ConditionValue;
  /** The only source of any origin claim on the site — see OriginBadge there. */
  origin: OriginValue;
  brand: string;
  description_en: string;
  description_ja: string;
  /** English text as last saved — the translation only refreshes when it changes. */
  savedEn: string;
  status: Status;
  collectionIds: string[];
  variants: VariantRow[];
}

const emptyVariant = (sort: number): VariantRow => ({
  size: "", stone: "", price_jpy: 0, cost_basis: null, stock_qty: 0, sort, media: [],
});

const emptyProduct = (): ProductForm => ({
  sku: "", slug: "", name: "", name_ja: "", savedName: "", metals: ["K18"], weight_g: null, condition: "New",
  origin: "UNKNOWN", brand: "",
  description_en: "", description_ja: "", savedEn: "",
  status: "draft", collectionIds: [], variants: [emptyVariant(0)],
});

const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const yen = (n: number) => `¥ ${Math.round(n).toLocaleString("en-US")}`;

/**
 * Formal-retail Japanese from Lovable AI. Server-side — the key never ships.
 * Name and description are translated independently by the edge function;
 * pass only the fields that need refreshing. A field left out comes back "".
 */
const translateJa: TranslateFn = async (fields) => {
  const name = fields.name?.trim() ?? "";
  const description = fields.description?.trim() ?? "";
  if (!name && !description) return { name_ja: "", description_ja: "" };
  const { data, error } = await supabase.functions.invoke("translate-product-description", {
    body: { name: name || undefined, description: description || undefined },
  });
  if (error) {
    // invoke() reports a bare "non-2xx status" — the useful message (rate limit,
    // credits exhausted, banned terminology) is in the response body.
    const res = (error as any)?.context as Response | undefined;
    const detail = res ? await res.json().catch(() => null) : null;
    throw new Error(detail?.error ?? error.message);
  }
  const out = {
    name_ja: String((data as any)?.name_ja ?? "").trim(),
    description_ja: String((data as any)?.description_ja ?? "").trim(),
  };
  if ((name && !out.name_ja) || (description && !out.description_ja)) {
    throw new Error((data as any)?.error ?? "Translation came back empty.");
  }
  return out;
};

export default function WebsiteCatalog() {
  const { roles } = useAuth();
  const isAdmin = roles?.includes("admin");
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ProductForm>(emptyProduct());
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);

  const collections = useQuery({
    queryKey: ["website-collections"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("website_collections" as any)
        .select("id, slug, name, description")
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
          "id, sku, slug, name, name_ja, karat, metals, weight_g, condition, origin, brand, description_en, description_ja, status, created_at, " +
          "website_product_variants(id, size, stone, price_jpy, cost_basis, stock_qty, sort, website_product_media(id, url, alt, sort)), " +
          "website_collection_products(collection_id)"
        )
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

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
          .map((m) => ({ id: m.id, url: m.url, alt: m.alt, sort: Number(m.sort ?? 0) })),
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
      collectionIds: ((p.website_collection_products ?? []) as any[]).map((c) => c.collection_id),
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
        status: f.status,
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
        const ext = file.name.split(".").pop() ?? "jpg";
        const path = `${MEDIA_PREFIX}/${crypto.randomUUID()}.${ext}`;
        const { error } = await supabase.storage.from(MEDIA_BUCKET).upload(path, file, { upsert: false });
        if (error) throw error;
        const { data } = supabase.storage.from(MEDIA_BUCKET).getPublicUrl(path);
        uploaded.push({ url: data.publicUrl, alt: form.name || null, sort: 0 });
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
    <div className="space-y-6">
      <PageMeta
        title="Website Catalog | Cha Jewels Hub"
        description="Manage the products, jewelry types and imagery published on the Cha Jewels public website."
        path="/website-catalog"
      />


      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-foreground">
            <Globe className="h-5 w-5 text-primary" />
            Website Catalog
          </h1>
          <p className="text-sm text-muted-foreground">
            Everything shown on chajewelsjp.com. Only <span className="text-foreground">Active</span> products are published.
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

      <Card>
        <CardHeader className="hairline-b">
          <CardTitle className="text-base">
            Products {products.data ? `(${products.data.length})` : ""}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            {jpyPhp
              ? `Peso prices are calculated on the website from the daily rate — ¥1 = ₱${jpyPhp} as of ${(fx.data as any).date}. Nothing peso-denominated is stored here.`
              : "No exchange rate on file yet — the website will show yen only until the daily rate lands."}
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {products.isLoading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : rows.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              No products yet. Add your first piece to publish it on the website.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
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
                {rows.map((p: any) => (
                  <TableRow key={p.id} className="cursor-pointer" onClick={() => openEdit(p)}>
                    <TableCell className="font-medium">
                      {p.name}
                      {p.name_ja && <div className="text-xs font-normal text-muted-foreground" lang="ja">{p.name_ja}</div>}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{p.sku}</TableCell>
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
                    </TableCell>
                    <TableCell className="text-right">
                      {isAdmin && (
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

      <JewelryTypes isAdmin={!!isAdmin} />

      <WholesaleInquiries />


      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{form.id ? "Edit product" : "New product"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>SKU</Label>
                <Input value={form.sku} onChange={(e) => setForm((f) => ({ ...f, sku: e.target.value }))} placeholder="R3341" />
              </div>
              <div className="space-y-1.5">
                <Label>Name</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({
                    ...f, name: e.target.value,
                    slug: f.id ? f.slug : slugify(e.target.value),
                  }))}
                  placeholder="K18 Rope Chain 45cm"
                />
                <Input
                  readOnly lang="ja" value={form.name_ja}
                  className="cursor-default bg-muted/30 text-muted-foreground"
                  placeholder="Japanese name — generated on save"
                  aria-label="Name (Japanese, generated)"
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label>Web address (slug)</Label>
                <Input value={form.slug} onChange={(e) => setForm((f) => ({ ...f, slug: slugify(e.target.value) }))} />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Jewelry type</Label>
              <div className="flex flex-wrap gap-4">
                {(collections.data ?? []).map((c: any) => (
                  <label key={c.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={form.collectionIds.includes(c.id)}
                      onCheckedChange={(checked) => setForm((f) => ({
                        ...f,
                        collectionIds: checked
                          ? [...f.collectionIds, c.id]
                          : f.collectionIds.filter((id) => id !== c.id),
                      }))}
                    />
                    {c.name}
                  </label>
                ))}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Metal stamps</Label>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Metal stamps">
                  {METAL_VALUES.map((m) => {
                    const idx = form.metals.indexOf(m);
                    const on = idx >= 0;
                    return (
                      <button
                        key={m} type="button" aria-pressed={on}
                        onClick={() => setForm((f) => ({
                          ...f,
                          metals: on ? f.metals.filter((x) => x !== m) : [...f.metals, m],
                        }))}
                        className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                          on
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-background text-muted-foreground hover:border-primary/60 hover:text-foreground"
                        }`}
                      >
                        {on && form.metals.length > 1 ? `${idx + 1}. ` : ""}{m}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {form.metals.length
                    ? <>Shown as <span className="text-foreground">{form.metals.join(" / ")}</span> — the order you pick is the order shown.</>
                    : "Pick at least one. Exactly as stamped: 750 stays 750, it is not K18."}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label>Weight (grams)</Label>
                <Input
                  type="number" step="0.01" value={form.weight_g ?? ""}
                  onChange={(e) => setForm((f) => ({ ...f, weight_g: e.target.value === "" ? null : Number(e.target.value) }))}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Condition</Label>
              <RadioGroup
                value={form.condition}
                onValueChange={(v) => setForm((f) => ({ ...f, condition: v as ConditionValue }))}
                className="flex gap-6"
              >
                {CONDITION_VALUES.map((c) => (
                  <label key={c} className="flex items-center gap-2 text-sm">
                    <RadioGroupItem value={c} id={`condition-${c}`} />
                    {c}
                  </label>
                ))}
              </RadioGroup>
            </div>

            {/* Origin is the ONLY thing that lets the site say where a piece is
                from. Unknown is the honest default — the site then says nothing,
                which beats claiming an origin nobody checked. */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Origin</Label>
                <RadioGroup
                  value={form.origin}
                  onValueChange={(v) => setForm((f) => ({ ...f, origin: v as OriginValue }))}
                  className="flex flex-wrap gap-x-6 gap-y-2"
                >
                  {ORIGIN_VALUES.map((o) => (
                    <label key={o} className="flex items-center gap-2 text-sm">
                      <RadioGroupItem value={o} id={`origin-${o}`} />
                      {ORIGIN_LABELS[o]}
                    </label>
                  ))}
                </RadioGroup>
                <p className="text-xs text-muted-foreground">
                  Made in Japan shows 日本製 on the site. Branded shows the brand name and makes no
                  origin claim. Other and Unknown show nothing.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label>Brand{form.origin === "BRAND" ? "" : " (optional)"}</Label>
                <Input
                  value={form.brand}
                  onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))}
                  placeholder="Tiffany & Co."
                />
                <p className="text-xs text-muted-foreground">
                  Shown on the site only when Origin is Branded. Name only — never a logo.
                </p>
              </div>
            </div>

            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Description (English)</Label>
                <Textarea
                  rows={5}
                  value={form.description_en}
                  onChange={(e) => setForm((f) => ({ ...f, description_en: e.target.value }))}
                  placeholder="K18 gold, 40cm, 2.0g."
                />
              </div>

              <div className="space-y-1.5 rounded-lg border border-border bg-muted/30 p-3">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-xs text-muted-foreground">
                    Japanese (name and description translated automatically — read-only)
                  </Label>
                  <Button
                    type="button" variant="outline" size="sm"
                    onClick={regenerateJapanese}
                    disabled={translating || (!form.description_en.trim() && !form.name.trim())}
                  >
                    {translating
                      ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                      : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
                    Regenerate
                  </Button>
                </div>
                <Textarea
                  rows={5} readOnly value={form.description_ja}
                  className="cursor-default bg-transparent"
                  placeholder="Generated on save when the English text changes."
                />
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Variants &amp; photos</Label>
                <Button
                  type="button" variant="outline" size="sm"
                  onClick={() => setForm((f) => ({ ...f, variants: [...f.variants, emptyVariant(f.variants.length)] }))}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" /> Add variant
                </Button>
              </div>

              {form.variants.map((v, i) => (
                <div key={v.id ?? `new-${i}`} className="space-y-3 rounded-lg border border-border p-3">
                  <div className="grid gap-3 sm:grid-cols-4">
                    <div className="space-y-1">
                      <Label className="text-xs">Size</Label>
                      <Input value={v.size ?? ""} onChange={(e) => patchVariant(i, { size: e.target.value })} />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Stone</Label>
                      <Input value={v.stone ?? ""} onChange={(e) => patchVariant(i, { stone: e.target.value })} />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Price (¥)</Label>
                      <Input type="number" value={v.price_jpy} onChange={(e) => patchVariant(i, { price_jpy: Number(e.target.value) })} />
                      <p className="text-[11px] text-muted-foreground">
                        {v.price_jpy > 0 ? `≈ ${peso(v.price_jpy)} on the website` : " "}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Stock</Label>
                      <Input type="number" value={v.stock_qty} onChange={(e) => patchVariant(i, { stock_qty: Number(e.target.value) })} />
                    </div>
                  </div>

                  {isAdmin && (
                    <div className="grid gap-3 sm:grid-cols-4">
                      <div className="space-y-1">
                        <Label className="text-xs">Cost basis (¥, internal)</Label>
                        <Input
                          type="number" value={v.cost_basis ?? ""}
                          onChange={(e) => patchVariant(i, { cost_basis: e.target.value === "" ? null : Number(e.target.value) })}
                        />
                      </div>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-3">
                    {v.media.map((m, mi) => (
                      <div key={m.id ?? `${i}-${mi}`} className="relative">
                        <img src={m.url} alt={m.alt ?? ""} className="h-16 w-16 rounded object-cover" loading="lazy" />
                        <button
                          type="button"
                          className="absolute -right-2 -top-2 rounded-full bg-destructive p-1 text-destructive-foreground"
                          onClick={() => patchVariant(i, { media: v.media.filter((_, x) => x !== mi) })}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                    <label className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground hover:text-foreground">
                      {uploadingKey === `v${i}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                      Add photos
                      <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => uploadMedia(i, e.target.files)} />
                    </label>
                    {form.variants.length > 1 && (
                      <Button
                        type="button" variant="ghost" size="sm" className="ml-auto text-destructive"
                        onClick={() => setForm((f) => ({ ...f, variants: f.variants.filter((_, x) => x !== i) }))}
                      >
                        Remove variant
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v as Status }))}>
                <SelectTrigger className="sm:max-w-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">Draft (hidden)</SelectItem>
                  <SelectItem value="active">Active (published)</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>


          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => save.mutate(form)} disabled={save.isPending}>
              {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save product
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Jewelry types (website_collections). Necklaces, Pendants, Earrings, Bracelets,
 * Rings, Anklets, Sets ship as the starting set — staff add more here.
 *
 * Staff write English only. The Japanese name and description are generated on
 * save (and by Regenerate) through the same translator the products use; the
 * site shows Japanese by default and English on toggle.
 */
function JewelryTypes({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const types = useQuery({
    queryKey: ["website-collections"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("website_collections" as any)
        .select("id, slug, name, name_ja, description, description_ja")
        .order("name");
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["website-collections"] });

  /** Translation failures never block the English save — the row still lands; Regenerate retries. */
  async function japaneseFor(fields: { name?: string; description?: string }): Promise<Partial<{ name_ja: string | null; description_ja: string | null }>> {
    try {
      const out = await translateJa(fields);
      const patch: Partial<{ name_ja: string | null; description_ja: string | null }> = {};
      if (fields.name !== undefined) patch.name_ja = out.name_ja || null;
      if (fields.description !== undefined) patch.description_ja = out.description_ja || null;
      return patch;
    } catch (e: any) {
      toast({
        title: "Japanese not regenerated",
        description: `${e.message} The English still saved — use Regenerate to retry.`,
        variant: "destructive",
      });
      return {};
    }
  }

  const add = useMutation({
    mutationFn: async () => {
      const name = newName.trim();
      if (!name) throw new Error("Give the type a name.");
      const description = newDescription.trim();
      const ja = await japaneseFor({ name, description: description || undefined });
      const { error } = await supabase.from("website_collections" as any).insert({
        name, slug: slugify(name), description: description || null, ...ja,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Type added" });
      setNewName(""); setNewDescription(""); invalidate();
    },
    onError: (e: any) => toast({ title: "Could not add type", description: e.message, variant: "destructive" }),
  });

  const saveDescription = useMutation({
    mutationFn: async ({ id, description, name, hasNameJa }: { id: string; description: string; name: string; hasNameJa: boolean }) => {
      setBusyId(id);
      const en = description.trim();
      const ja = await japaneseFor({
        description: en || undefined,
        // Backfill a missing Japanese name while we are here — one call, not two.
        name: hasNameJa ? undefined : name,
      });
      const { error } = await supabase.from("website_collections" as any)
        .update({ description: en || null, description_ja: en ? (ja.description_ja ?? null) : null, ...(ja.name_ja ? { name_ja: ja.name_ja } : {}) })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_d, v) => {
      toast({ title: "Description saved" });
      setDrafts((d) => { const next = { ...d }; delete next[v.id]; return next; });
      invalidate();
    },
    onError: (e: any) => toast({ title: "Could not save", description: e.message, variant: "destructive" }),
    onSettled: () => setBusyId(null),
  });

  const regenerate = useMutation({
    mutationFn: async ({ id, name, description }: { id: string; name: string; description: string }) => {
      setBusyId(id);
      const out = await translateJa({ name, description: description.trim() || undefined });
      const { error } = await supabase.from("website_collections" as any)
        .update({ name_ja: out.name_ja || null, description_ja: description.trim() ? out.description_ja || null : null })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { toast({ title: "Japanese updated" }); invalidate(); },
    onError: (e: any) => toast({ title: "Could not translate", description: e.message, variant: "destructive" }),
    onSettled: () => setBusyId(null),
  });

  const removeType = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("website_collections" as any).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { toast({ title: "Type removed" }); invalidate(); },
    onError: (e: any) => toast({ title: "Could not remove", description: e.message, variant: "destructive" }),
  });

  return (
    <Card>
      <CardHeader className="hairline-b">
        <CardTitle className="text-base">
          Jewelry types {types.data ? `(${types.data.length})` : ""}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          These are the categories the website browses by. Write the English; the Japanese name and
          description are generated on save and shown on the site by default.
        </p>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        {types.isLoading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-44">Type</TableHead>
                <TableHead className="w-32">Slug</TableHead>
                <TableHead>Description (English)</TableHead>
                <TableHead className="w-[26%]">Japanese (generated)</TableHead>
                <TableHead className="w-36" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(types.data ?? []).map((t: any) => {
                const value = drafts[t.id] ?? t.description ?? "";
                const dirty = drafts[t.id] !== undefined && drafts[t.id] !== (t.description ?? "");
                const busy = busyId === t.id;
                return (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium">
                      {t.name}
                      <div className="text-xs font-normal text-muted-foreground" lang="ja">
                        {t.name_ja || <span className="italic">no Japanese yet</span>}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{t.slug}</TableCell>
                    <TableCell>
                      <Input
                        value={value}
                        onChange={(e) => setDrafts((d) => ({ ...d, [t.id]: e.target.value }))}
                      />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground" lang="ja">
                      {t.description_ja || <span className="italic">—</span>}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="outline" size="sm" disabled={!dirty || busy}
                          onClick={() => saveDescription.mutate({ id: t.id, description: value, name: t.name, hasNameJa: !!t.name_ja })}
                        >
                          Save
                        </Button>
                        <Button
                          variant="ghost" size="icon" title="Regenerate Japanese" aria-label="Regenerate Japanese"
                          disabled={busy}
                          onClick={() => regenerate.mutate({ id: t.id, name: t.name, description: t.description ?? "" })}
                        >
                          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                        </Button>
                        {isAdmin && (
                          <Button
                            variant="ghost" size="icon"
                            onClick={() => {
                              if (confirm(`Remove the ${t.name} type? Products stay, they just lose this type.`)) {
                                removeType.mutate(t.id);
                              }
                            }}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        <div className="grid gap-3 rounded-lg border border-dashed border-border p-3 sm:grid-cols-[minmax(0,12rem)_1fr_auto]">
          <div className="space-y-1">
            <Label className="text-xs">New type</Label>
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Brooches" />
            {newName.trim() && (
              <p className="text-[11px] text-muted-foreground">slug: {slugify(newName)}</p>
            )}
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Description (English)</Label>
            <Input
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              placeholder="One line shown on the type's page."
            />
          </div>
          <div className="flex items-end">
            <Button onClick={() => add.mutate()} disabled={!newName.trim() || add.isPending}>
              {add.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Add type
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Read-only feed of wholesale enquiries submitted on the public website.
 * Rows are written by the `website` edge function; nobody edits them here.
 */
const MARKET_LABELS: Record<string, string> = {
  JP: "Japan", PH: "Philippines", BOTH: "Japan & Philippines", OTHER: "Other",
};
const VOLUME_LABELS: Record<string, string> = {
  TEST: "Test order", "20_50": "20–50 pieces", "50_200": "50–200 pieces", "200_PLUS": "200+ pieces",
};

function WholesaleInquiries() {
  const inquiries = useQuery({
    queryKey: ["wholesale-inquiries"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wholesale_inquiries" as any)
        .select("id, name, business, email, phone, market, volume, notes, lang, created_at")
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

  return (
    <Card>
      <CardHeader className="hairline-b">
        <CardTitle className="text-base">
          Wholesale inquiries {inquiries.data ? `(${inquiries.data.length})` : ""}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Submitted through the wholesale form on chajewelsjp.com. View only.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        {inquiries.isLoading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (inquiries.data ?? []).length === 0 ? (
          <p className="px-6 py-10 text-sm text-muted-foreground">No inquiries yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Received</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Business</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Market</TableHead>
                <TableHead>Volume</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(inquiries.data ?? []).map((r: any) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {new Date(r.created_at).toLocaleDateString("en-CA", { timeZone: "Asia/Manila" })}
                  </TableCell>
                  <TableCell className="font-medium text-foreground">{r.name}</TableCell>
                  <TableCell>{r.business}</TableCell>
                  <TableCell className="text-xs">
                    <div>{r.email}</div>
                    {r.phone && <div className="text-muted-foreground">{r.phone}</div>}
                  </TableCell>
                  <TableCell>{MARKET_LABELS[r.market] ?? r.market}</TableCell>
                  <TableCell>{VOLUME_LABELS[r.volume] ?? r.volume}</TableCell>
                  <TableCell className="max-w-[22rem] text-xs text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="uppercase">{r.lang}</Badge>
                      <span className="truncate">{r.notes ?? "—"}</span>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
