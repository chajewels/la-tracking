import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { japaneseFor, translateJa } from "@/components/website/translate";
import { HeroImageField } from "@/components/website/HeroImageField";
import { slugify } from "@/components/website/product-form";

/**
 * Jewelry types (website_collections). Necklaces, Pendants, Earrings, Bracelets,
 * Rings, Anklets, Sets ship as the starting set — staff add more here.
 *
 * English and Japanese are both editable. Save writes what was typed, verbatim;
 * Regenerate overwrites the Japanese from the translator the products use. A
 * new type gets its Japanese generated once on add. The hero image is the
 * picture the site shows for the type (collection cards, hero slides) — the
 * site falls back to its own placeholder when there is none.
 */
type TypeDraft = { description: string; name_ja: string; description_ja: string };

export function JewelryTypesCard({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Partial<TypeDraft>>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const types = useQuery({
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

  const invalidate = () => qc.invalidateQueries({ queryKey: ["website-collections"] });
  const patchDraft = (id: string, patch: Partial<TypeDraft>) =>
    setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));
  const clearDraft = (id: string) =>
    setDrafts((d) => { const next = { ...d }; delete next[id]; return next; });

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

  /** Writes the typed text as it is — no translation on save. */
  const saveRow = useMutation({
    mutationFn: async ({ id, draft }: { id: string; draft: TypeDraft }) => {
      setBusyId(id);
      const { error } = await supabase.from("website_collections" as any)
        .update({
          description: draft.description.trim() || null,
          name_ja: draft.name_ja.trim() || null,
          description_ja: draft.description_ja.trim() || null,
        })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_d, v) => { toast({ title: "Type saved" }); clearDraft(v.id); invalidate(); },
    onError: (e: any) => toast({ title: "Could not save", description: e.message, variant: "destructive" }),
    onSettled: () => setBusyId(null),
  });

  const saveHero = useMutation({
    mutationFn: async ({ id, hero_media }: { id: string; hero_media: string | null }) => {
      const { error } = await supabase.from("website_collections" as any)
        .update({ hero_media }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_d, v) => { toast({ title: v.hero_media ? "Hero image saved" : "Hero image removed" }); invalidate(); },
    onError: (e: any) => toast({ title: "Could not save hero image", description: e.message, variant: "destructive" }),
  });

  /** Overwrites the Japanese from the translator, discarding any unsaved Japanese draft. */
  const regenerate = useMutation({
    mutationFn: async ({ id, name, description }: { id: string; name: string; description: string }) => {
      setBusyId(id);
      const out = await translateJa({ name, description: description.trim() || undefined });
      const { error } = await supabase.from("website_collections" as any)
        .update({ name_ja: out.name_ja || null, description_ja: description.trim() ? out.description_ja || null : null })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_d, v) => {
      toast({ title: "Japanese updated" });
      setDrafts((d) => {
        const cur = d[v.id];
        if (!cur) return d;
        const { name_ja: _n, description_ja: _j, ...rest } = cur;
        return { ...d, [v.id]: rest };
      });
      invalidate();
    },
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
          The jewelry types the website browses by. English and Japanese are both editable; Regenerate
          rewrites the Japanese from the English. The hero image is the picture shown for the type.
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
              <TableHead className="w-28">Slug</TableHead>
              <TableHead>Description (English)</TableHead>
              <TableHead className="w-[26%]">Description (Japanese)</TableHead>
              <TableHead className="w-44">Hero image</TableHead>
              <TableHead className="w-36" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(types.data ?? []).map((t: any) => {
              const saved: TypeDraft = {
                description: t.description ?? "", name_ja: t.name_ja ?? "", description_ja: t.description_ja ?? "",
              };
              const draft: TypeDraft = { ...saved, ...(drafts[t.id] ?? {}) };
              const dirty = (Object.keys(saved) as (keyof TypeDraft)[]).some((k) => draft[k] !== saved[k]);
              const busy = busyId === t.id;
              return (
                <TableRow key={t.id}>
                  <TableCell className="font-medium align-top">
                    {t.name}
                    <Input
                      lang="ja" value={draft.name_ja}
                      onChange={(e) => patchDraft(t.id, { name_ja: e.target.value })}
                      placeholder="日本語の名前"
                      aria-label={`${t.name} — Japanese name`}
                      className="mt-1 h-8 text-xs"
                    />
                  </TableCell>
                  <TableCell className="text-muted-foreground align-top">{t.slug}</TableCell>
                  <TableCell className="align-top">
                    <Input
                      value={draft.description}
                      onChange={(e) => patchDraft(t.id, { description: e.target.value })}
                      aria-label={`${t.name} — description (English)`}
                    />
                  </TableCell>
                  <TableCell className="align-top">
                    <Input
                      lang="ja" value={draft.description_ja}
                      onChange={(e) => patchDraft(t.id, { description_ja: e.target.value })}
                      placeholder="日本語の説明"
                      aria-label={`${t.name} — description (Japanese)`}
                    />
                  </TableCell>
                  <TableCell className="align-top">
                    <HeroImageField
                      url={t.hero_media ?? null} folder="collections" size="sm"
                      disabled={saveHero.isPending}
                      onChange={(url) => saveHero.mutate({ id: t.id, hero_media: url })}
                    />
                  </TableCell>
                  <TableCell className="text-right align-top">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="outline" size="sm" disabled={!dirty || busy}
                        onClick={() => saveRow.mutate({ id: t.id, draft })}
                      >
                        Save
                      </Button>
                      <Button
                        variant="ghost" size="icon" title="Regenerate Japanese" aria-label="Regenerate Japanese"
                        disabled={busy}
                        onClick={() => regenerate.mutate({ id: t.id, name: t.name, description: draft.description })}
                      >
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                      </Button>
                      {isAdmin && (
                        <Button
                          variant="ghost" size="icon" aria-label={`Remove ${t.name}`}
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
