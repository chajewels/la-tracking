import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Loader2, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import { MultiPick } from "@/components/website/MultiPick";
import {
  CONDITION_VALUES, ConditionValue, METAL_VALUES, ORIGIN_LABELS, ORIGIN_VALUES, OriginValue,
} from "@/lib/website-catalog-import";
import {
  type ProductForm, type Status, type VariantRow, emptyVariant, slugify,
} from "@/components/website/product-form";

/**
 * The product editor. Moved out of WebsiteCatalog.tsx unchanged — every field,
 * every hint and every disabled rule is the same markup it was.
 *
 * It owns no state and no query. ProductsCard holds the form and the save
 * mutation and hands them down, because the same form has to survive the card
 * closing and reopening the dialog.
 */
export default function ProductDialog({
  open, onOpenChange, form, setForm, collections, categories, isAdmin,
  translating, uploadingKey, peso, saving, onSave, onRegenerateJapanese,
  onUploadMedia, onPatchVariant,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  form: ProductForm;
  setForm: React.Dispatch<React.SetStateAction<ProductForm>>;
  collections: any[];
  categories: { id: string; name: string; name_ja?: string | null; published?: boolean }[];
  isAdmin: boolean;
  translating: boolean;
  uploadingKey: string | null;
  peso: (n: number) => string;
  saving: boolean;
  onSave: () => void;
  onRegenerateJapanese: () => void;
  onUploadMedia: (variantIndex: number, files: FileList | null) => void;
  onPatchVariant: (i: number, patch: Partial<VariantRow>) => void;
}) {
  return (
      <Dialog open={open} onOpenChange={onOpenChange}>
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

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Jewelry types</Label>
                <MultiPick
                  ariaLabel="Jewelry types"
                  buttonLabel="Add jewelry type"
                  placeholder="Search jewelry types…"
                  emptyText="No jewelry type matches."
                  options={collections.map((c: any) => ({ id: c.id, label: c.name, hint: c.name_ja }))}
                  value={form.collectionIds}
                  onChange={(collectionIds) => setForm((f) => ({ ...f, collectionIds }))}
                />
              </div>
              <div className="space-y-2">
                <Label>Categories</Label>
                <MultiPick
                  ariaLabel="Categories"
                  buttonLabel="Add category"
                  placeholder="Search categories…"
                  emptyText="No category matches."
                  options={categories.map((c) => ({ id: c.id, label: c.published ? c.name : `${c.name} (unpublished)`, hint: c.name_ja }))}
                  value={form.categoryIds}
                  onChange={(categoryIds) => setForm((f) => ({ ...f, categoryIds }))}
                />
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
                    onClick={onRegenerateJapanese}
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
                      <Input value={v.size ?? ""} onChange={(e) => onPatchVariant(i, { size: e.target.value })} />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Stone</Label>
                      <Input value={v.stone ?? ""} onChange={(e) => onPatchVariant(i, { stone: e.target.value })} />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Price (¥)</Label>
                      <Input type="number" value={v.price_jpy} onChange={(e) => onPatchVariant(i, { price_jpy: Number(e.target.value) })} />
                      <p className="text-[11px] text-muted-foreground">
                        {v.price_jpy > 0 ? `≈ ${peso(v.price_jpy)} on the website` : " "}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Stock</Label>
                      <Input type="number" value={v.stock_qty} onChange={(e) => onPatchVariant(i, { stock_qty: Number(e.target.value) })} />
                    </div>
                  </div>

                  {isAdmin && (
                    <div className="grid gap-3 sm:grid-cols-4">
                      <div className="space-y-1">
                        <Label className="text-xs">Cost basis (¥, internal)</Label>
                        <Input
                          type="number" value={v.cost_basis ?? ""}
                          onChange={(e) => onPatchVariant(i, { cost_basis: e.target.value === "" ? null : Number(e.target.value) })}
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
                          onClick={() => onPatchVariant(i, { media: v.media.filter((_, x) => x !== mi) })}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                    <label className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground hover:text-foreground">
                      {uploadingKey === `v${i}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                      Add photos
                      <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => onUploadMedia(i, e.target.files)} />
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
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={onSave} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save product
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
  );
}
