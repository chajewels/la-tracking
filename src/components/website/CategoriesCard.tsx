import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { translateJa } from "@/components/website/translate";
import { HeroImageField } from "@/components/website/HeroImageField";

/**
 * Website categories (website_categories): a layer above jewelry types.
 * A product has one or more types AND one or more categories — Preloved,
 * Bridal, Gifts — and the site browses by either. Ordered by sort_order.
 *
 * Rows are edited in a dialog because a category carries ten fields. English
 * and Japanese are both typed; Save writes what was typed, Regenerate
 * overwrites the Japanese name and description from the translator (the CTA
 * label is short enough to type). Published is toggled inline. Delete is
 * refused while any product is assigned — the count is taken first.
 */
export interface WebsiteCategory {
  id: string;
  slug: string;
  name: string;
  name_ja: string | null;
  description: string | null;
  description_ja: string | null;
  hero_media: string | null;
  cta_label: string | null;
  cta_label_ja: string | null;
  sort_order: number;
  published: boolean;
}

export const CATEGORY_FIELDS = "id, slug, name, name_ja, description, description_ja, hero_media, cta_label, cta_label_ja, sort_order, published";
export const CATEGORIES_QUERY_KEY = ["website-categories"] as const;

export async function fetchCategories(): Promise<WebsiteCategory[]> {
  const { data, error } = await supabase
    .from("website_categories" as any)
    .select(CATEGORY_FIELDS)
    .order("sort_order")
    .order("name");
  if (error) throw error;
  return ((data ?? []) as unknown) as WebsiteCategory[];
}

interface CategoryForm {
  id?: string;
  slug: string;
  name: string;
  name_ja: string;
  description: string;
  description_ja: string;
  hero_media: string | null;
  cta_label: string;
  cta_label_ja: string;
  sort_order: string;
  published: boolean;
}

const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const emptyForm = (nextSort: number): CategoryForm => ({
  slug: "", name: "", name_ja: "", description: "", description_ja: "",
  hero_media: null, cta_label: "", cta_label_ja: "", sort_order: String(nextSort), published: false,
});

const toForm = (c: WebsiteCategory): CategoryForm => ({
  id: c.id,
  slug: c.slug,
  name: c.name,
  name_ja: c.name_ja ?? "",
  description: c.description ?? "",
  description_ja: c.description_ja ?? "",
  hero_media: c.hero_media,
  cta_label: c.cta_label ?? "",
  cta_label_ja: c.cta_label_ja ?? "",
  sort_order: String(c.sort_order ?? 0),
  published: !!c.published,
});

export function CategoriesEditor() {
  // The delete guard. Was `isAdmin`, which meant a staff member trusted with
  // this screen still could not finish a job on it. It is the permission that
  // decides, and admin keeps passing because can() returns true for admin.
  const { roles } = useAuth();
  const { can } = usePermissions();
  const canManage = can("manage_website_catalog") || !!roles?.includes("admin");

  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<CategoryForm>(emptyForm(0));
  const [translating, setTranslating] = useState(false);

  const categories = useQuery({ queryKey: CATEGORIES_QUERY_KEY, queryFn: fetchCategories });
  const invalidate = () => qc.invalidateQueries({ queryKey: CATEGORIES_QUERY_KEY });
  const nextSort = useMemo(
    () => (categories.data ?? []).reduce((m, c) => Math.max(m, Number(c.sort_order ?? 0)), -1) + 1,
    [categories.data],
  );
  const patch = (p: Partial<CategoryForm>) => setForm((f) => ({ ...f, ...p }));

  function openNew() { setForm(emptyForm(nextSort)); setOpen(true); }
  function openEdit(c: WebsiteCategory) { setForm(toForm(c)); setOpen(true); }

  /** Overwrites the Japanese name and description from the translator. */
  async function regenerate() {
    const name = form.name.trim();
    const description = form.description.trim();
    if (!name && !description) {
      toast({ title: "Nothing to translate", description: "Write the English name or description first." });
      return;
    }
    setTranslating(true);
    try {
      const out = await translateJa({ name: name || undefined, description: description || undefined });
      patch({ name_ja: name ? out.name_ja : form.name_ja, description_ja: description ? out.description_ja : "" });
      toast({ title: "Japanese updated" });
    } catch (e) {
      toast({ title: "Could not translate", description: (e as Error).message, variant: "destructive" });
    } finally {
      setTranslating(false);
    }
  }

  const save = useMutation({
    mutationFn: async (f: CategoryForm) => {
      const name = f.name.trim();
      if (!name) throw new Error("Give the category a name.");
      const sort = Number(f.sort_order);
      if (!Number.isInteger(sort) || sort < 0) throw new Error("Sort order must be a whole number, 0 or more.");
      const payload = {
        slug: f.id ? f.slug : slugify(f.slug.trim() || name),
        name,
        name_ja: f.name_ja.trim() || null,
        description: f.description.trim() || null,
        description_ja: f.description_ja.trim() || null,
        hero_media: f.hero_media,
        cta_label: f.cta_label.trim() || null,
        cta_label_ja: f.cta_label_ja.trim() || null,
        sort_order: sort,
        published: f.published,
      };
      if (f.id) {
        const { error } = await supabase.from("website_categories" as any).update(payload).eq("id", f.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("website_categories" as any).insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => { toast({ title: "Category saved" }); invalidate(); setOpen(false); },
    onError: (e: Error) => toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });

  const togglePublished = useMutation({
    mutationFn: async ({ id, published }: { id: string; published: boolean }) => {
      const { error } = await supabase.from("website_categories" as any).update({ published }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_d, v) => { toast({ title: v.published ? "Category published" : "Category unpublished" }); invalidate(); },
    onError: (e: Error) => toast({ title: "Could not update", description: e.message, variant: "destructive" }),
  });

  /** Refused while products are assigned: the count is taken before anything is deleted. */
  const remove = useMutation({
    mutationFn: async (c: WebsiteCategory) => {
      const { count, error: countErr } = await supabase
        .from("website_category_products" as any)
        .select("product_id", { count: "exact", head: true })
        .eq("category_id", c.id);
      if (countErr) throw countErr;
      if ((count ?? 0) > 0) {
        throw new Error(`${count} product${count === 1 ? " is" : "s are"} assigned to ${c.name}. Remove it from those products first.`);
      }
      const { error } = await supabase.from("website_categories" as any).delete().eq("id", c.id);
      if (error) throw error;
    },
    onSuccess: () => { toast({ title: "Category removed" }); invalidate(); },
    onError: (e: Error) => toast({ title: "Could not remove", description: e.message, variant: "destructive" }),
  });

  const list = categories.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-[70ch] text-xs text-muted-foreground">
          Categories sit above jewelry types — Preloved, Bridal, Gifts — and a product can carry several.
          Only published categories appear on the site, in this order.
        </p>
        <Button size="sm" onClick={openNew}><Plus className="mr-1 h-3.5 w-3.5" /> Add category</Button>
      </div>

      {categories.isLoading ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>
      ) : categories.isError ? (
        <p className="text-sm text-destructive">Could not load categories: {(categories.error as Error).message}</p>
      ) : list.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">No categories yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-14 text-right">Order</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="w-32">Slug</TableHead>
              <TableHead>CTA</TableHead>
              <TableHead className="w-24">Hero</TableHead>
              <TableHead className="w-28">Published</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="text-right tabular-nums text-muted-foreground">{c.sort_order}</TableCell>
                <TableCell className="font-medium">
                  {c.name}
                  <div className="text-xs font-normal text-muted-foreground" lang="ja">
                    {c.name_ja || <span className="italic">no Japanese yet</span>}
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">{c.slug}</TableCell>
                <TableCell className="text-xs">
                  {c.cta_label || <span className="text-muted-foreground">—</span>}
                  {c.cta_label_ja && <div className="text-muted-foreground" lang="ja">{c.cta_label_ja}</div>}
                </TableCell>
                <TableCell>
                  {c.hero_media
                    ? <img src={c.hero_media} alt="" className="h-10 w-14 rounded object-cover" loading="lazy" />
                    : <Badge variant="outline" className="text-[10px]">none</Badge>}
                </TableCell>
                <TableCell>
                  <Switch
                    checked={!!c.published}
                    aria-label={`${c.name} published`}
                    disabled={togglePublished.isPending}
                    onCheckedChange={(v) => togglePublished.mutate({ id: c.id, published: v })}
                  />
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <Button variant="ghost" size="icon" aria-label={`Edit ${c.name}`} onClick={() => openEdit(c)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    {canManage && (
                      <Button
                        variant="ghost" size="icon" aria-label={`Remove ${c.name}`} disabled={remove.isPending}
                        onClick={() => { if (confirm(`Remove the ${c.name} category?`)) remove.mutate(c); }}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{form.id ? "Edit category" : "New category"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Name (English)</Label>
                <Input
                  value={form.name}
                  onChange={(e) => patch({ name: e.target.value, slug: form.id ? form.slug : slugify(e.target.value) })}
                  placeholder="Preloved"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Name (Japanese)</Label>
                <Input lang="ja" value={form.name_ja} onChange={(e) => patch({ name_ja: e.target.value })} placeholder="プレラブド" />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label>Web address (slug)</Label>
                <Input value={form.slug} disabled={!!form.id} onChange={(e) => patch({ slug: slugify(e.target.value) })} />
                {form.id && <p className="text-[11px] text-muted-foreground">Fixed after creation — the site links to it.</p>}
              </div>
              <div className="space-y-1.5">
                <Label>Description (English)</Label>
                <Textarea rows={3} value={form.description} onChange={(e) => patch({ description: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>Description (Japanese)</Label>
                <Textarea lang="ja" rows={3} value={form.description_ja} onChange={(e) => patch({ description_ja: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>CTA label (English)</Label>
                <Input value={form.cta_label} onChange={(e) => patch({ cta_label: e.target.value })} placeholder="Shop preloved" />
              </div>
              <div className="space-y-1.5">
                <Label>CTA label (Japanese)</Label>
                <Input lang="ja" value={form.cta_label_ja} onChange={(e) => patch({ cta_label_ja: e.target.value })} placeholder="プレラブドを見る" />
              </div>
              <div className="space-y-1.5">
                <Label>Sort order</Label>
                <Input type="number" min={0} step={1} value={form.sort_order} onChange={(e) => patch({ sort_order: e.target.value })} className="sm:max-w-[8rem]" />
              </div>
              <div className="space-y-1.5">
                <Label>Published</Label>
                <div className="flex min-h-10 items-center gap-2">
                  <Switch checked={form.published} onCheckedChange={(v) => patch({ published: v })} aria-label="Published" />
                  <span className="text-sm text-muted-foreground">{form.published ? "Shown on the site" : "Hidden"}</span>
                </div>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Hero image</Label>
              <HeroImageField url={form.hero_media} folder="categories" onChange={(url) => patch({ hero_media: url })} />
            </div>
            <div className="flex justify-end">
              <Button type="button" variant="outline" size="sm" onClick={regenerate} disabled={translating || (!form.name.trim() && !form.description.trim())}>
                {translating ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
                Regenerate Japanese
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => save.mutate(form)} disabled={save.isPending}>
              {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save category
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * CategoriesEditor in its own card, so the Website workspace's catalog tab can
 * stand it beside Products and Jewelry types. The editor itself is untouched —
 * this adds the header and nothing else.
 */
export function CategoriesCard() {
  const categories = useQuery({ queryKey: CATEGORIES_QUERY_KEY, queryFn: fetchCategories });
  return (
    <Card>
      <CardHeader className="hairline-b">
        <CardTitle className="text-base">
          Categories {categories.data ? `(${categories.data.length})` : ""}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Categories sit above the jewelry types — a product can carry several of each, and both are
          shown on the site.
        </p>
      </CardHeader>
      <CardContent className="pt-4">
        <CategoriesEditor />
      </CardContent>
    </Card>
  );
}
