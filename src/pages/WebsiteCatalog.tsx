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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Globe, Loader2, Plus, RefreshCw, Trash2, Upload } from "lucide-react";

/** Public website catalog manager. Feeds the `website` API used by chajewelsjp.com. */

const MEDIA_BUCKET = "promotions";
const MEDIA_PREFIX = "website";

type Karat = "K18" | "K14" | "K10" | "PT1000" | "PT950" | "PT900" | "SILVER925";
type Status = "draft" | "active" | "archived";

/**
 * The only metal values the catalog stores. K18 covers Au750 / 18K — those are
 * never separate options, so the label carries them instead.
 */
const METAL_OPTIONS: { value: Karat; label: string }[] = [
  { value: "K18", label: "K18 (Au750 / 18K)" },
  { value: "K14", label: "K14" },
  { value: "K10", label: "K10" },
  { value: "PT1000", label: "PT1000" },
  { value: "PT950", label: "PT950" },
  { value: "PT900", label: "PT900" },
  { value: "SILVER925", label: "SILVER925" },
];
const metalLabel = (k: string | null | undefined) =>
  METAL_OPTIONS.find((m) => m.value === k)?.label ?? "—";

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
  karat: Karat | null;
  weight_g: number | null;
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
  sku: "", slug: "", name: "", karat: "K18", weight_g: null,
  description_en: "", description_ja: "", savedEn: "",
  status: "draft", collectionIds: [], variants: [emptyVariant(0)],
});

const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const yen = (n: number) => `¥ ${Math.round(n).toLocaleString("en-US")}`;

/** Formal-retail Japanese from Lovable AI. Server-side — the key never ships. */
async function translateToJa(text: string, name: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke("translate-product-description", {
    body: { text, name },
  });
  if (error) {
    // invoke() reports a bare "non-2xx status" — the useful message (rate limit,
    // credits exhausted, banned terminology) is in the response body.
    const res = (error as any)?.context as Response | undefined;
    const detail = res ? await res.json().catch(() => null) : null;
    throw new Error(detail?.error ?? error.message);
  }
  const ja = String((data as any)?.description_ja ?? "").trim();
  if (!ja) throw new Error((data as any)?.error ?? "Translation came back empty.");
  return ja;
}

export default function WebsiteCatalog() {
  const { roles } = useAuth();
  const isAdmin = roles?.includes("admin");
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ProductForm>(emptyProduct());
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);

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
          "id, sku, slug, name, karat, weight_g, description_en, description_ja, status, created_at, " +
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
      karat: p.karat ?? null,
      weight_g: p.weight_g === null ? null : Number(p.weight_g),
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
    const en = form.description_en.trim();
    if (!en) {
      toast({ title: "Nothing to translate", description: "Write the English description first." });
      return;
    }
    setTranslating(true);
    try {
      const ja = await translateToJa(en, form.name);
      setForm((f) => ({ ...f, description_ja: ja }));
      toast({ title: "Japanese updated" });
    } catch (e: any) {
      toast({ title: "Could not translate", description: e.message, variant: "destructive" });
    } finally {
      setTranslating(false);
    }
  }

  const save = useMutation({
    mutationFn: async (f: ProductForm) => {
      if (!f.name.trim() || !f.sku.trim()) throw new Error("Name and SKU are required.");
      if (!f.variants.length) throw new Error("Add at least one variant.");
      const slug = (f.slug.trim() || slugify(f.name));

      // Japanese is derived from the English text: refresh it when the English
      // changed, or when it has never been generated. Never on an unchanged product.
      const en = f.description_en.trim();
      let ja = f.description_ja.trim();
      if (!en) {
        ja = "";
      } else if (en !== f.savedEn.trim() || !ja) {
        setTranslating(true);
        try {
          ja = await translateToJa(en, f.name);
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
        name: f.name.trim(),
        karat: f.karat,
        weight_g: f.weight_g,
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
        <Button onClick={openNew}>
          <Plus className="mr-2 h-4 w-4" /> New product
        </Button>
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
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell className="text-muted-foreground">{p.sku}</TableCell>
                    <TableCell>{metalLabel(p.karat)}</TableCell>
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

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{form.id ? "Edit product" : "New product"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
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
              </div>
              <div className="space-y-1.5">
                <Label>SKU</Label>
                <Input value={form.sku} onChange={(e) => setForm((f) => ({ ...f, sku: e.target.value }))} placeholder="CJ-K18-0001" />
              </div>
              <div className="space-y-1.5">
                <Label>Web address (slug)</Label>
                <Input value={form.slug} onChange={(e) => setForm((f) => ({ ...f, slug: slugify(e.target.value) }))} />
              </div>
              <div className="space-y-1.5">
                <Label>Metal</Label>
                <Select
                  value={form.karat ?? "none"}
                  onValueChange={(v) => setForm((f) => ({ ...f, karat: v === "none" ? null : (v as Karat) }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not specified</SelectItem>
                    {METAL_OPTIONS.map((m) => (
                      <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Weight (grams)</Label>
                <Input
                  type="number" step="0.01" value={form.weight_g ?? ""}
                  onChange={(e) => setForm((f) => ({ ...f, weight_g: e.target.value === "" ? null : Number(e.target.value) }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Status</Label>
                <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v as Status }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="draft">Draft (hidden)</SelectItem>
                    <SelectItem value="active">Active (published)</SelectItem>
                    <SelectItem value="archived">Archived</SelectItem>
                  </SelectContent>
                </Select>
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

            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Description (English)</Label>
                <Textarea
                  rows={5}
                  value={form.description_en}
                  onChange={(e) => setForm((f) => ({ ...f, description_en: e.target.value }))}
                  placeholder="K18 gold, Made in Japan. 40cm, 2.0g."
                />
              </div>

              <div className="space-y-1.5 rounded-lg border border-border bg-muted/30 p-3">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-xs text-muted-foreground">
                    Japanese (translated automatically — read-only)
                  </Label>
                  <Button
                    type="button" variant="outline" size="sm"
                    onClick={regenerateJapanese}
                    disabled={translating || !form.description_en.trim()}
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
 */
function JewelryTypes({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const types = useQuery({
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

  const invalidate = () => qc.invalidateQueries({ queryKey: ["website-collections"] });

  const add = useMutation({
    mutationFn: async () => {
      const name = newName.trim();
      if (!name) throw new Error("Give the type a name.");
      const { error } = await supabase.from("website_collections" as any).insert({
        name, slug: slugify(name), description: newDescription.trim() || null,
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
    mutationFn: async ({ id, description }: { id: string; description: string }) => {
      const { error } = await supabase.from("website_collections" as any)
        .update({ description: description.trim() || null }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_d, v) => {
      toast({ title: "Description saved" });
      setDrafts((d) => { const next = { ...d }; delete next[v.id]; return next; });
      invalidate();
    },
    onError: (e: any) => toast({ title: "Could not save", description: e.message, variant: "destructive" }),
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
          These are the categories the website browses by. The English description shows on the type's page.
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
                <TableHead className="w-40">Type</TableHead>
                <TableHead className="w-40">Slug</TableHead>
                <TableHead>Description (English)</TableHead>
                <TableHead className="w-28" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(types.data ?? []).map((t: any) => {
                const value = drafts[t.id] ?? t.description ?? "";
                const dirty = drafts[t.id] !== undefined && drafts[t.id] !== (t.description ?? "");
                return (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium">{t.name}</TableCell>
                    <TableCell className="text-muted-foreground">{t.slug}</TableCell>
                    <TableCell>
                      <Input
                        value={value}
                        onChange={(e) => setDrafts((d) => ({ ...d, [t.id]: e.target.value }))}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="outline" size="sm" disabled={!dirty || saveDescription.isPending}
                          onClick={() => saveDescription.mutate({ id: t.id, description: value })}
                        >
                          Save
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
