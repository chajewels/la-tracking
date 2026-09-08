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
import { Globe, Loader2, Plus, Trash2, Upload } from "lucide-react";

/** Public website catalog manager. Feeds the `website` API used by chajewelsjp.com. */

const MEDIA_BUCKET = "promotions";
const MEDIA_PREFIX = "website";

type Karat = "K18" | "PT900" | "PT950";
type Status = "draft" | "active" | "archived";

interface MediaRow { id?: string; url: string; alt: string | null; sort: number }
interface VariantRow {
  id?: string;
  size: string | null;
  stone: string | null;
  price_jpy: number;
  price_php: number | null;
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
  description_tl: string;
  status: Status;
  collectionIds: string[];
  variants: VariantRow[];
}

const emptyVariant = (sort: number): VariantRow => ({
  size: "", stone: "", price_jpy: 0, price_php: null, cost_basis: null, stock_qty: 0, sort, media: [],
});

const emptyProduct = (): ProductForm => ({
  sku: "", slug: "", name: "", karat: "K18", weight_g: null,
  description_en: "", description_ja: "", description_tl: "",
  status: "draft", collectionIds: [], variants: [emptyVariant(0)],
});

const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const yen = (n: number) => `¥ ${Math.round(n).toLocaleString("en-US")}`;

export default function WebsiteCatalog() {
  const { roles } = useAuth();
  const isAdmin = roles?.includes("admin");
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ProductForm>(emptyProduct());
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);

  const collections = useQuery({
    queryKey: ["website-collections"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("website_collections" as any)
        .select("id, slug, name")
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
          "id, sku, slug, name, karat, weight_g, description_en, description_ja, description_tl, status, created_at, " +
          "website_product_variants(id, size, stone, price_jpy, price_php, cost_basis, stock_qty, sort, website_product_media(id, url, alt, sort)), " +
          "website_collection_products(collection_id)"
        )
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as any[];
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
        price_php: v.price_php === null ? null : Number(v.price_php),
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
      description_tl: p.description_tl ?? "",
      status: p.status ?? "draft",
      collectionIds: ((p.website_collection_products ?? []) as any[]).map((c) => c.collection_id),
      variants: variants.length ? variants : [emptyVariant(0)],
    });
    setOpen(true);
  }

  const save = useMutation({
    mutationFn: async (f: ProductForm) => {
      if (!f.name.trim() || !f.sku.trim()) throw new Error("Name and SKU are required.");
      if (!f.variants.length) throw new Error("Add at least one variant.");
      const slug = (f.slug.trim() || slugify(f.name));

      const productPayload = {
        sku: f.sku.trim(),
        slug,
        name: f.name.trim(),
        karat: f.karat,
        weight_g: f.weight_g,
        description_en: f.description_en.trim() || null,
        description_ja: f.description_ja.trim() || null,
        description_tl: f.description_tl.trim() || null,
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
          price_php: v.price_php === null || v.price_php === undefined ? null : Math.round(Number(v.price_php)),
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

  return (
    <div className="space-y-6">
      <PageMeta
        title="Website Catalog | Cha Jewels Hub"
        description="Manage the products, variants and imagery published on the Cha Jewels public website."
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
                    <TableCell>{p.karat ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{p.fromPrice ? yen(p.fromPrice) : "—"}</TableCell>
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
                    <SelectItem value="K18">K18</SelectItem>
                    <SelectItem value="PT900">PT900</SelectItem>
                    <SelectItem value="PT950">PT950</SelectItem>
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
              <Label>Collections</Label>
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

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label>Description (English)</Label>
                <Textarea rows={4} value={form.description_en} onChange={(e) => setForm((f) => ({ ...f, description_en: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>Description (Japanese)</Label>
                <Textarea rows={4} value={form.description_ja} onChange={(e) => setForm((f) => ({ ...f, description_ja: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>Description (Tagalog)</Label>
                <Textarea rows={4} value={form.description_tl} onChange={(e) => setForm((f) => ({ ...f, description_tl: e.target.value }))} />
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
                  <div className="grid gap-3 sm:grid-cols-5">
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
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Price (₱)</Label>
                      <Input
                        type="number" value={v.price_php ?? ""}
                        onChange={(e) => patchVariant(i, { price_php: e.target.value === "" ? null : Number(e.target.value) })}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Stock</Label>
                      <Input type="number" value={v.stock_qty} onChange={(e) => patchVariant(i, { stock_qty: Number(e.target.value) })} />
                    </div>
                  </div>

                  {isAdmin && (
                    <div className="grid gap-3 sm:grid-cols-5">
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
