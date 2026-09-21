import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { format, parseISO } from "date-fns";
import { translateJa } from "@/components/website/translate";

/**
 * Website testimonials (website_testimonials). The storefront homepage shows
 * the published ones in sort_order via the `website` edge function's
 * GET /testimonials; until one is published it renders placeholder cards.
 *
 * One editable block per row, drafts held locally until Save. Save writes what
 * was typed — English and Japanese alike — verbatim. Regenerate overwrites the
 * Japanese quote from the English one through the shared translator (the quote
 * travels as `description`; the function translates it as prose) and discards
 * any unsaved Japanese draft, the same contract as the jewelry-types editor.
 * Published is toggled inline and takes effect on the site's next revalidate.
 * Delete is admin-only; a testimonial has no dependants, so there is no guard.
 */
export interface WebsiteTestimonial {
  id: string;
  customer_name: string;
  location: string | null;
  quote_en: string | null;
  quote_ja: string | null;
  item: string | null;
  /** The month the customer said it, as a date. Nullable: older rows have none. */
  testimonial_date: string | null;
  rating: number | null;
  sort_order: number;
  published: boolean;
}

const TESTIMONIALS_QUERY_KEY = ["website-testimonials"] as const;
const FIELDS = "id, customer_name, location, quote_en, quote_ja, item, testimonial_date, rating, sort_order, published";
const RATINGS = ["1", "2", "3", "4", "5"] as const;
/** Select cannot hold an empty-string value; this token stands for "no rating". */
const NO_RATING = "none";

async function fetchTestimonials(): Promise<WebsiteTestimonial[]> {
  const { data, error } = await supabase
    .from("website_testimonials" as any)
    .select(FIELDS)
    .order("sort_order")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as unknown) as WebsiteTestimonial[];
}

interface Draft {
  customer_name: string;
  location: string;
  item: string;
  /** "" while empty — <input type="date"> has no null, and toRow maps it back. */
  testimonial_date: string;
  rating: string;
  quote_en: string;
  quote_ja: string;
  sort_order: string;
}

const toDraft = (t: WebsiteTestimonial): Draft => ({
  customer_name: t.customer_name ?? "",
  location: t.location ?? "",
  item: t.item ?? "",
  testimonial_date: t.testimonial_date ?? "",
  rating: t.rating == null ? NO_RATING : String(t.rating),
  quote_en: t.quote_en ?? "",
  quote_ja: t.quote_ja ?? "",
  sort_order: String(t.sort_order ?? 0),
});

/** The row as the table wants it. Throws on the two things a testimonial cannot do without. */
function toRow(d: Draft) {
  const customer_name = d.customer_name.trim();
  if (!customer_name) throw new Error("The customer's name is required.");
  const quote_en = d.quote_en.trim();
  const quote_ja = d.quote_ja.trim();
  if (!quote_en && !quote_ja) throw new Error("Type the quote in English or Japanese.");
  const sort_order = Number(d.sort_order);
  if (!Number.isInteger(sort_order)) throw new Error("Order must be a whole number.");
  return {
    customer_name,
    location: d.location.trim() || null,
    item: d.item.trim() || null,
    // Empty box means no date, not the epoch.
    testimonial_date: d.testimonial_date.trim() || null,
    rating: d.rating === NO_RATING ? null : Number(d.rating),
    quote_en: quote_en || null,
    quote_ja: quote_ja || null,
    sort_order,
  };
}

const newDraft = (nextSort: number): Draft => ({
  customer_name: "", location: "", item: "", testimonial_date: "", rating: "5", quote_en: "", quote_ja: "", sort_order: String(nextSort),
});

/**
 * The month a testimonial is from, for the row header: "Sep 2026", or an em
 * dash when there is none.
 *
 * parseISO, not new Date(): a date-only string goes through new Date() as UTC
 * midnight, which in any timezone behind UTC lands on the previous day. Here
 * that would only ever move the MONTH at a month boundary, but the repo's
 * timezone standard is explicit and this is the parse that honours it.
 */
function monthLabel(iso: string | null): string {
  if (!iso) return "—";
  const d = parseISO(iso);
  return Number.isNaN(d.getTime()) ? "—" : format(d, "MMM yyyy");
}

export function TestimonialsCard({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, Partial<Draft>>>({});
  const [adding, setAdding] = useState<Draft | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const list = useQuery({ queryKey: TESTIMONIALS_QUERY_KEY, queryFn: fetchTestimonials });
  const rows = list.data ?? [];
  const nextSort = rows.reduce((m, t) => Math.max(m, t.sort_order ?? 0), -1) + 1;

  const invalidate = () => qc.invalidateQueries({ queryKey: TESTIMONIALS_QUERY_KEY });
  const patchDraft = (id: string, patch: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));
  const clearDraft = (id: string) =>
    setDrafts((d) => { const next = { ...d }; delete next[id]; return next; });
  const fail = (title: string) => (e: Error) => toast({ title, description: e.message, variant: "destructive" });

  const add = useMutation({
    mutationFn: async (d: Draft) => {
      const { error } = await supabase.from("website_testimonials" as any).insert({ ...toRow(d), published: false });
      if (error) throw error;
    },
    onSuccess: () => { toast({ title: "Testimonial added", description: "It is unpublished until you switch it on." }); setAdding(null); invalidate(); },
    onError: fail("Could not add testimonial"),
  });

  /** Writes the typed text as it is — no translation on save. */
  const save = useMutation({
    mutationFn: async ({ id, draft }: { id: string; draft: Draft }) => {
      setBusyId(id);
      const { error } = await supabase.from("website_testimonials" as any).update(toRow(draft)).eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_d, v) => { toast({ title: "Testimonial saved" }); clearDraft(v.id); invalidate(); },
    onError: fail("Could not save"),
    onSettled: () => setBusyId(null),
  });

  const togglePublished = useMutation({
    mutationFn: async ({ id, published }: { id: string; published: boolean }) => {
      const { error } = await supabase.from("website_testimonials" as any).update({ published }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_d, v) => { toast({ title: v.published ? "Published" : "Unpublished" }); invalidate(); },
    onError: fail("Could not change publication"),
  });

  /** Overwrites the Japanese quote from the English one, discarding any unsaved Japanese draft. */
  const regenerate = useMutation({
    mutationFn: async ({ id, quote_en }: { id: string; quote_en: string }) => {
      const source = quote_en.trim();
      if (!source) throw new Error("Type the English quote first.");
      setBusyId(id);
      const out = await translateJa({ description: source });
      const { error } = await supabase.from("website_testimonials" as any)
        .update({ quote_ja: out.description_ja || null }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_d, v) => {
      toast({ title: "Japanese updated" });
      setDrafts((d) => {
        const cur = d[v.id];
        if (!cur) return d;
        const { quote_ja: _j, ...rest } = cur;
        return { ...d, [v.id]: rest };
      });
      invalidate();
    },
    onError: fail("Could not translate"),
    onSettled: () => setBusyId(null),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("website_testimonials" as any).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { toast({ title: "Testimonial removed" }); invalidate(); },
    onError: fail("Could not remove"),
  });

  return (
    <Card>
      <CardHeader className="hairline-b">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Testimonials{list.data ? ` (${rows.length})` : ""}</CardTitle>
            <p className="text-xs text-muted-foreground">
              Customer quotes shown on the website's home page, in order. Only published ones appear;
              Regenerate rewrites the Japanese quote from the English.
            </p>
          </div>
          <Button size="sm" variant="outline" disabled={!!adding} onClick={() => setAdding(newDraft(nextSort))}>
            <Plus className="mr-1 h-4 w-4" /> Add testimonial
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        {adding && (
          <TestimonialFields
            idPrefix="new" draft={adding} onChange={(p) => setAdding((d) => (d ? { ...d, ...p } : d))}
            header={<Badge variant="outline">New</Badge>}
            actions={
              <>
                <Button variant="ghost" size="sm" disabled={add.isPending} onClick={() => setAdding(null)}>Cancel</Button>
                <Button size="sm" disabled={add.isPending} onClick={() => add.mutate(adding)}>
                  {add.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}Add
                </Button>
              </>
            }
          />
        )}
        {list.isLoading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : rows.length === 0 && !adding ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No testimonials yet. The website shows placeholder cards until one is published.
          </p>
        ) : (
          rows.map((t) => {
            const saved = toDraft(t);
            const draft: Draft = { ...saved, ...(drafts[t.id] ?? {}) };
            const dirty = (Object.keys(saved) as (keyof Draft)[]).some((k) => draft[k] !== saved[k]);
            const busy = busyId === t.id;
            return (
              <TestimonialFields
                key={t.id} idPrefix={t.id} draft={draft} onChange={(p) => patchDraft(t.id, p)}
                header={
                  <div className="flex items-center gap-3">
                    <Badge variant={t.published ? "default" : "outline"}>{t.published ? "Published" : "Draft"}</Badge>
                    <span className="text-xs tabular-nums text-muted-foreground">{monthLabel(t.testimonial_date)}</span>
                    <Label htmlFor={`${t.id}-published`} className="flex items-center gap-2 text-xs font-normal text-muted-foreground">
                      <Switch
                        id={`${t.id}-published`} checked={t.published}
                        disabled={togglePublished.isPending}
                        onCheckedChange={(published) => togglePublished.mutate({ id: t.id, published })}
                        aria-label={`Publish ${t.customer_name}'s testimonial`}
                      />
                      Show on the website
                    </Label>
                  </div>
                }
                actions={
                  <>
                    <Button variant="outline" size="sm" disabled={!dirty || busy} onClick={() => save.mutate({ id: t.id, draft })}>
                      Save
                    </Button>
                    <Button
                      variant="ghost" size="icon" title="Regenerate Japanese" aria-label="Regenerate Japanese"
                      disabled={busy} onClick={() => regenerate.mutate({ id: t.id, quote_en: draft.quote_en })}
                    >
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    </Button>
                    {isAdmin && (
                      <Button
                        variant="ghost" size="icon" aria-label={`Remove ${t.customer_name}'s testimonial`}
                        disabled={remove.isPending}
                        onClick={() => {
                          if (confirm(`Remove ${t.customer_name}'s testimonial? This cannot be undone.`)) remove.mutate(t.id);
                        }}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                  </>
                }
              />
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

/** One testimonial's fields. Shared by the add block and every saved row. */
function TestimonialFields({ idPrefix, draft, onChange, header, actions }: {
  idPrefix: string;
  draft: Draft;
  onChange: (patch: Partial<Draft>) => void;
  header: React.ReactNode;
  actions: React.ReactNode;
}) {
  const id = (k: keyof Draft) => `${idPrefix}-${k}`;
  return (
    <div className="space-y-3 rounded-md border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {header}
        <div className="flex items-center gap-1">{actions}</div>
      </div>
      <div className="grid gap-3 md:grid-cols-4">
        <div className="space-y-1 md:col-span-2">
          <Label htmlFor={id("customer_name")}>Customer</Label>
          <Input id={id("customer_name")} value={draft.customer_name} onChange={(e) => onChange({ customer_name: e.target.value })} placeholder="Yuki S." />
        </div>
        <div className="space-y-1">
          <Label htmlFor={id("location")}>Location</Label>
          <Input id={id("location")} value={draft.location} onChange={(e) => onChange({ location: e.target.value })} placeholder="Tokyo" />
        </div>
        <div className="space-y-1">
          <Label htmlFor={id("item")}>Item</Label>
          <Input id={id("item")} value={draft.item} onChange={(e) => onChange({ item: e.target.value })} placeholder="K18 diamond ring" />
        </div>
        <div className="space-y-1">
          <Label htmlFor={id("testimonial_date")}>Date</Label>
          <Input id={id("testimonial_date")} type="date" value={draft.testimonial_date} onChange={(e) => onChange({ testimonial_date: e.target.value })} />
        </div>
        <div className="space-y-1 md:col-span-2">
          <Label htmlFor={id("quote_en")}>Quote (English)</Label>
          <Textarea id={id("quote_en")} rows={3} value={draft.quote_en} onChange={(e) => onChange({ quote_en: e.target.value })} />
        </div>
        <div className="space-y-1 md:col-span-2">
          <Label htmlFor={id("quote_ja")}>Quote (Japanese)</Label>
          <Textarea id={id("quote_ja")} lang="ja" rows={3} value={draft.quote_ja} onChange={(e) => onChange({ quote_ja: e.target.value })} placeholder="日本語の引用" />
        </div>
        <div className="space-y-1">
          <Label htmlFor={id("rating")}>Rating</Label>
          <Select value={draft.rating} onValueChange={(rating) => onChange({ rating })}>
            <SelectTrigger id={id("rating")} aria-label="Rating"><SelectValue /></SelectTrigger>
            <SelectContent>
              {RATINGS.map((r) => <SelectItem key={r} value={r}>{"★".repeat(Number(r))} {r}</SelectItem>)}
              <SelectItem value={NO_RATING}>No rating</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={id("sort_order")}>Order</Label>
          <Input id={id("sort_order")} type="number" step={1} value={draft.sort_order} onChange={(e) => onChange({ sort_order: e.target.value })} />
        </div>
      </div>
    </div>
  );
}
