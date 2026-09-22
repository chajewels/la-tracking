import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown, ArrowUp, Eye, HelpCircle, Loader2, Pencil, Plus, RefreshCw, Trash2,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { toast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Markdown } from "@/components/website/markdown";
import { translateJa } from "@/components/website/translate";
import {
  type FaqItemDraft, type FaqItemRow, type FaqSectionDraft, type FaqSectionRow, type ReorderWrite,
  FAQ_ITEM_SELECT, FAQ_SECTION_SELECT,
  emptyItem, emptySection, faqSlug, inOrder, itemPayload, itemToDraft, nextSortOrder,
  reorder, sectionDeleteBlocker, sectionPayload, sectionToDraft, validateItem, validateSection,
} from "@/components/website/website-faq";

/**
 * The storefront FAQ: sections, and the questions inside them.
 *
 * Answers are markdown, previewed through the same components/website/markdown.tsx
 * the posts editor uses — one renderer, so a list that previews correctly in a
 * post previews correctly here.
 *
 * THE AUDIT IS NOT OPTIONAL HERE. These answers carry binding layaway and
 * loyalty terms, so every write logs one — and an item's log carries the OLD
 * AND NEW ANSWER TEXT, not just its id. A log that records that an answer
 * changed without recording what it said cannot settle a dispute about what a
 * customer was told.
 *
 * Writes are gated on manage_website_content, matching both tables' RLS.
 *
 * Neither table is in src/integrations/supabase/types.ts, so both are reached
 * through the `as any` table cast every website_* table uses.
 */

type Editing =
  | { kind: "section"; draft: FaqSectionDraft }
  | { kind: "item"; draft: FaqItemDraft }
  | null;

export function FaqCard() {
  const qc = useQueryClient();
  const { user, roles } = useAuth();
  const { can } = usePermissions();
  const canManage = can("manage_website_content") || !!roles?.includes("admin");

  const sections = useQuery<FaqSectionRow[]>({
    queryKey: ["website-faq-sections"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("website_faq_sections" as any)
        .select(FAQ_SECTION_SELECT)
        .order("sort_order");
      if (error) throw error;
      return (data ?? []) as unknown as FaqSectionRow[];
    },
  });

  const items = useQuery<FaqItemRow[]>({
    queryKey: ["website-faq-items"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("website_faq_items" as any)
        .select(FAQ_ITEM_SELECT)
        .order("section_id")
        .order("sort_order");
      if (error) throw error;
      return (data ?? []) as unknown as FaqItemRow[];
    },
  });

  const allSections = useMemo(() => inOrder(sections.data ?? []), [sections.data]);
  const allItems = useMemo(() => items.data ?? [], [items.data]);
  const itemsOf = (sectionId: string) => inOrder(allItems.filter((i) => i.section_id === sectionId));
  const slugIndex = useMemo(() => allSections.map((s) => ({ id: s.id, slug: s.slug })), [allSections]);

  const [editing, setEditing] = useState<Editing>(null);
  const [preview, setPreview] = useState<"en" | "ja" | null>(null);
  const [translating, setTranslating] = useState(false);
  const open = (e: Editing) => { setEditing(e); setPreview(null); };

  const patchSection = (p: Partial<FaqSectionDraft>) =>
    setEditing((e) => (e?.kind === "section" ? { kind: "section", draft: { ...e.draft, ...p } } : e));
  const patchItem = (p: Partial<FaqItemDraft>) =>
    setEditing((e) => (e?.kind === "item" ? { kind: "item", draft: { ...e.draft, ...p } } : e));

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["website-faq-sections"] });
    qc.invalidateQueries({ queryKey: ["website-faq-items"] });
  };

  const audit = (entity_type: string, entity_id: string, action: string, oldV: unknown, newV: unknown) =>
    supabase.from("audit_logs").insert([{
      entity_type, entity_id, action,
      old_value_json: (oldV ?? null) as never,
      new_value_json: (newV ?? null) as never,
      performed_by_user_id: user?.id ?? null,
    }]);

  // ── Sections ──────────────────────────────────────────────────────────────
  const saveSection = useMutation({
    mutationFn: async (d: FaqSectionDraft) => {
      const before = d.id ? allSections.find((s) => s.id === d.id) : null;
      const sort = d.id ? undefined : nextSortOrder(allSections);
      const { data, error } = await supabase
        .from("website_faq_sections" as any)
        .upsert(sectionPayload(d, user?.id ?? null, sort) as never, { onConflict: "id" })
        .select("id")
        .single();
      if (error) {
        throw (error as { code?: string }).code === "23505"
          ? new Error(`The slug "${d.slug.trim()}" is already taken.`)
          : error;
      }
      const id = (data as unknown as { id: string }).id;
      await audit("website_faq_section", id, d.id ? "update_faq_section" : "create_faq_section",
        before && { slug: before.slug, title_en: before.title_en, published: before.published },
        { slug: d.slug.trim(), title_en: d.title_en.trim(), published: d.published });
    },
    onSuccess: () => { toast({ title: "Section saved" }); invalidate(); open(null); },
    onError: (e: Error) => toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });

  const removeSection = useMutation({
    mutationFn: async (s: FaqSectionRow) => {
      // Re-counted here, not trusted from the render: the button was enabled
      // against a list that may be a minute old, and the FK cascades.
      const { count, error: countErr } = await supabase
        .from("website_faq_items" as any)
        .select("id", { count: "exact", head: true })
        .eq("section_id", s.id);
      if (countErr) throw countErr;
      const blocker = sectionDeleteBlocker(count ?? 0);
      if (blocker) throw new Error(blocker);

      const { error } = await supabase.from("website_faq_sections" as any).delete().eq("id", s.id);
      if (error) throw error;
      await audit("website_faq_section", s.id, "delete_faq_section",
        { slug: s.slug, title_en: s.title_en }, null);
    },
    onSuccess: () => { toast({ title: "Section removed" }); invalidate(); open(null); },
    onError: (e: Error) => toast({ title: "Could not remove section", description: e.message, variant: "destructive" }),
  });

  // ── Items ─────────────────────────────────────────────────────────────────
  const saveItem = useMutation({
    mutationFn: async (d: FaqItemDraft) => {
      const before = d.id ? allItems.find((i) => i.id === d.id) : null;
      const sort = d.id ? undefined : nextSortOrder(itemsOf(d.section_id));
      const { data, error } = await supabase
        .from("website_faq_items" as any)
        .upsert(itemPayload(d, user?.id ?? null, sort) as never, { onConflict: "id" })
        .select("id")
        .single();
      if (error) throw error;
      const id = (data as unknown as { id: string }).id;
      // The ANSWER TEXT goes in the log, both sides. These are published terms.
      await audit("website_faq_item", id, d.id ? "update_faq_item" : "create_faq_item",
        before && {
          question_en: before.question_en, answer_en: before.answer_en,
          answer_ja: before.answer_ja, published: before.published, layaway_only: before.layaway_only,
        },
        {
          question_en: d.question_en.trim(), answer_en: d.answer_en.trim(),
          answer_ja: d.answer_ja.trim() || null, published: d.published, layaway_only: d.layaway_only,
        });
    },
    onSuccess: () => { toast({ title: "Question saved" }); invalidate(); open(null); },
    onError: (e: Error) => toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });

  const removeItem = useMutation({
    mutationFn: async (i: FaqItemRow) => {
      const { error } = await supabase.from("website_faq_items" as any).delete().eq("id", i.id);
      if (error) throw error;
      await audit("website_faq_item", i.id, "delete_faq_item",
        { question_en: i.question_en, answer_en: i.answer_en, answer_ja: i.answer_ja }, null);
    },
    onSuccess: () => { toast({ title: "Question removed" }); invalidate(); open(null); },
    onError: (e: Error) => toast({ title: "Could not remove", description: e.message, variant: "destructive" }),
  });

  // ── Reordering ────────────────────────────────────────────────────────────
  const move = useMutation({
    mutationFn: async ({ table, writes, entity, id }: {
      table: "website_faq_sections" | "website_faq_items";
      writes: ReorderWrite[]; entity: string; id: string;
    }) => {
      for (const w of writes) {
        const { error } = await supabase
          .from(table as any)
          .update({ sort_order: w.sort_order, updated_by: user?.id ?? null })
          .eq("id", w.id);
        if (error) throw error;
      }
      // One row for the move, not one per row written — the other row only
      // shifted to make space.
      const moved = writes.find((w) => w.id === id)!;
      await audit(entity, id, "reorder_" + entity.replace("website_", ""),
        null, { sort_order: moved.sort_order });
    },
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast({ title: "Could not reorder", description: e.message, variant: "destructive" }),
  });

  const moveSection = (id: string, dir: -1 | 1) => {
    const writes = reorder(allSections, id, dir);
    if (writes) move.mutate({ table: "website_faq_sections", writes, entity: "website_faq_section", id });
  };
  const moveItem = (sectionId: string, id: string, dir: -1 | 1) => {
    const writes = reorder(itemsOf(sectionId), id, dir);
    if (writes) move.mutate({ table: "website_faq_items", writes, entity: "website_faq_item", id });
  };

  /** Regenerate the Japanese side of whichever editor is open. */
  async function regenerate() {
    if (!editing) return;
    setTranslating(true);
    try {
      if (editing.kind === "section") {
        const title = editing.draft.title_en.trim();
        if (!title) { toast({ title: "Nothing to translate" }); return; }
        const out = await translateJa({ name: title });
        patchSection({ title_ja: out.name_ja });
      } else {
        const q = editing.draft.question_en.trim();
        const a = editing.draft.answer_en.trim();
        if (!q && !a) { toast({ title: "Nothing to translate" }); return; }
        const out = await translateJa({ name: q || undefined, description: a || undefined });
        patchItem({
          ...(q ? { question_ja: out.name_ja } : {}),
          ...(a ? { answer_ja: out.description_ja } : {}),
        });
      }
      toast({ title: "Japanese updated" });
    } catch (e) {
      toast({ title: "Could not translate", description: (e as Error).message, variant: "destructive" });
    } finally {
      setTranslating(false);
    }
  }

  const loading = sections.isLoading || items.isLoading;
  const failed = sections.isError || items.isError;
  const sectionErrors = editing?.kind === "section" ? validateSection(editing.draft, slugIndex) : [];
  const itemErrors = editing?.kind === "item" ? validateItem(editing.draft) : [];

  const OrderButtons = ({ up, down, label }: { up: () => void; down: () => void; label: string }) => (
    <>
      <Button type="button" variant="ghost" size="icon" disabled={!canManage || move.isPending}
        aria-label={`Move ${label} up`} onClick={up}>
        <ArrowUp className="h-4 w-4" />
      </Button>
      <Button type="button" variant="ghost" size="icon" disabled={!canManage || move.isPending}
        aria-label={`Move ${label} down`} onClick={down}>
        <ArrowDown className="h-4 w-4" />
      </Button>
    </>
  );

  return (
    <>
      <Card>
        <CardHeader className="hairline-b">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <HelpCircle className="h-4 w-4 text-primary" />
                FAQ {sections.data ? `(${allSections.length} section${allSections.length === 1 ? "" : "s"}, ${allItems.length} question${allItems.length === 1 ? "" : "s"})` : ""}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                The questions on chajewelsjp.com, in the order shown there. Answers are markdown, and
                every change is logged — these carry binding layaway and loyalty terms.
              </p>
            </div>
            {canManage && (
              <Button type="button" size="sm" onClick={() => open({ kind: "section", draft: emptySection() })}>
                <Plus className="mr-1.5 h-3.5 w-3.5" /> New section
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4 pt-5">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : failed ? (
            <p className="py-8 text-sm text-muted-foreground">Couldn't load the FAQ.</p>
          ) : allSections.length === 0 ? (
            <p className="py-8 text-sm text-muted-foreground">No sections yet.</p>
          ) : (
            allSections.map((s, si) => {
              const rows = itemsOf(s.id);
              return (
                <div key={s.id} className="rounded-lg border border-border">
                  <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-card-foreground">{s.title_en}</span>
                        <code className="text-[11px] text-muted-foreground">#{s.slug}</code>
                        {s.published === false && (
                          <Badge variant="outline" className="border-border bg-muted text-[10px] text-muted-foreground">Hidden</Badge>
                        )}
                        {!s.title_ja && <Badge variant="outline" className="text-[10px] text-muted-foreground">no JA</Badge>}
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {rows.length} question{rows.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <OrderButtons
                        label={s.title_en}
                        up={() => si > 0 && moveSection(s.id, -1)}
                        down={() => si < allSections.length - 1 && moveSection(s.id, 1)}
                      />
                      {canManage && (
                        <>
                          <Button type="button" variant="ghost" size="icon" aria-label={`Edit ${s.title_en}`}
                            onClick={() => open({ kind: "section", draft: sectionToDraft(s) })}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button" variant="ghost" size="icon" aria-label={`Remove ${s.title_en}`}
                            disabled={removeSection.isPending}
                            onClick={() => {
                              const blocker = sectionDeleteBlocker(rows.length);
                              if (blocker) { toast({ title: "Section not empty", description: blocker, variant: "destructive" }); return; }
                              if (confirm(`Remove the "${s.title_en}" section?`)) removeSection.mutate(s);
                            }}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="divide-y divide-border/50">
                    {rows.length === 0 ? (
                      <p className="px-3 py-4 text-xs text-muted-foreground">No questions in this section yet.</p>
                    ) : rows.map((it, ii) => (
                      <div key={it.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <div className="text-sm text-card-foreground">{it.question_en}</div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            {it.published === false && (
                              <Badge variant="outline" className="border-border bg-muted text-[10px] text-muted-foreground">Hidden</Badge>
                            )}
                            {it.layaway_only && <Badge variant="secondary" className="text-[10px]">EN only</Badge>}
                            {!it.answer_ja && <Badge variant="outline" className="text-[10px] text-muted-foreground">no JA</Badge>}
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <OrderButtons
                            label={it.question_en}
                            up={() => ii > 0 && moveItem(s.id, it.id, -1)}
                            down={() => ii < rows.length - 1 && moveItem(s.id, it.id, 1)}
                          />
                          {canManage && (
                            <>
                              <Button type="button" variant="ghost" size="icon" aria-label={`Edit ${it.question_en}`}
                                onClick={() => open({ kind: "item", draft: itemToDraft(it) })}>
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                type="button" variant="ghost" size="icon" aria-label={`Remove ${it.question_en}`}
                                disabled={removeItem.isPending}
                                onClick={() => { if (confirm(`Remove "${it.question_en}"?`)) removeItem.mutate(it); }}
                              >
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  {canManage && (
                    <div className="border-t border-border px-3 py-2">
                      <Button type="button" variant="outline" size="sm"
                        onClick={() => open({ kind: "item", draft: emptyItem(s.id) })}>
                        <Plus className="mr-1 h-3.5 w-3.5" /> Add question
                      </Button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <Sheet open={!!editing} onOpenChange={(o) => !o && open(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
          {editing?.kind === "section" && (
            <>
              <SheetHeader className="text-left">
                <SheetTitle>{editing.draft.id ? "Edit section" : "New section"}</SheetTitle>
              </SheetHeader>
              <div className="mt-4 space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="faq-section-title-en">Title (English)</Label>
                  <Input
                    id="faq-section-title-en" value={editing.draft.title_en} disabled={!canManage}
                    onChange={(e) => patchSection({
                      title_en: e.target.value,
                      slug: editing.draft.id || editing.draft.slug !== faqSlug(editing.draft.title_en)
                        ? editing.draft.slug
                        : faqSlug(e.target.value),
                    })}
                    placeholder="Layaway"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="faq-section-title-ja">Title (Japanese)</Label>
                  <Input id="faq-section-title-ja" lang="ja" value={editing.draft.title_ja} disabled={!canManage}
                    onChange={(e) => patchSection({ title_ja: e.target.value })} placeholder="日本語" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="faq-section-slug">Anchor (slug)</Label>
                  <Input id="faq-section-slug" value={editing.draft.slug} disabled={!canManage}
                    onChange={(e) => patchSection({ slug: faqSlug(e.target.value) })} />
                  <p className="text-[11px] text-muted-foreground">
                    chajewelsjp.com/faq#{editing.draft.slug || "…"}
                    {editing.draft.id && " — changing this breaks any link already shared."}
                  </p>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={editing.draft.published} disabled={!canManage}
                    onCheckedChange={(v) => patchSection({ published: v })} aria-label="Section published" />
                  Published
                </label>

                {sectionErrors.length > 0 && (
                  <ul className="space-y-0.5 text-xs text-destructive">
                    {sectionErrors.map((e) => <li key={e}>{e}</li>)}
                  </ul>
                )}

                <div className="flex flex-wrap items-center gap-2 pb-2">
                  <Button type="button" disabled={!canManage || sectionErrors.length > 0 || saveSection.isPending}
                    onClick={() => saveSection.mutate(editing.draft)}>
                    {saveSection.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Save section
                  </Button>
                  <Button type="button" variant="outline" size="sm" disabled={!canManage || translating}
                    onClick={regenerate}>
                    {translating ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
                    Regenerate Japanese
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => open(null)}>Cancel</Button>
                </div>
              </div>
            </>
          )}

          {editing?.kind === "item" && (
            <>
              <SheetHeader className="text-left">
                <SheetTitle>{editing.draft.id ? "Edit question" : "New question"}</SheetTitle>
              </SheetHeader>
              <div className="mt-4 space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="faq-q-en">Question (English)</Label>
                  <Input id="faq-q-en" value={editing.draft.question_en} disabled={!canManage}
                    onChange={(e) => patchItem({ question_en: e.target.value })}
                    placeholder="Can I pay off my layaway early?" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="faq-q-ja">Question (Japanese)</Label>
                  <Input id="faq-q-ja" lang="ja" value={editing.draft.question_ja} disabled={!canManage}
                    onChange={(e) => patchItem({ question_ja: e.target.value })} placeholder="日本語" />
                </div>

                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label>Answer (markdown)</Label>
                    <Button type="button" variant="outline" size="sm" disabled={!canManage || translating}
                      onClick={regenerate}>
                      {translating ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
                      Regenerate Japanese
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    <code>**bold**</code> · <code>- list item</code> · <code>[text](https://…)</code> ·
                    {" "}blank line between paragraphs.
                  </p>

                  {(["en", "ja"] as const).map((lang) => (
                    <div key={lang} className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <Label htmlFor={`faq-a-${lang}`} className="text-xs text-muted-foreground">
                          {lang === "en" ? "English" : "Japanese"}
                        </Label>
                        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs"
                          aria-pressed={preview === lang}
                          onClick={() => setPreview(preview === lang ? null : lang)}>
                          <Eye className="mr-1 h-3.5 w-3.5" />
                          {preview === lang ? "Write" : "Preview"}
                        </Button>
                      </div>
                      {preview === lang ? (
                        <div className="max-h-72 overflow-y-auto rounded-md border border-border bg-muted/20 px-3 py-2">
                          <Markdown>{lang === "en" ? editing.draft.answer_en : editing.draft.answer_ja}</Markdown>
                        </div>
                      ) : (
                        <Textarea
                          id={`faq-a-${lang}`} rows={8} disabled={!canManage}
                          lang={lang === "ja" ? "ja" : undefined}
                          className="font-mono text-xs"
                          value={lang === "en" ? editing.draft.answer_en : editing.draft.answer_ja}
                          onChange={(e) => patchItem(lang === "en" ? { answer_en: e.target.value } : { answer_ja: e.target.value })}
                        />
                      )}
                    </div>
                  ))}
                </div>

                <div className="space-y-2 rounded-lg border border-border p-3">
                  <label className="flex items-center gap-2 text-sm">
                    <Switch checked={editing.draft.published} disabled={!canManage}
                      onCheckedChange={(v) => patchItem({ published: v })} aria-label="Question published" />
                    Published
                  </label>
                  <label className="flex items-start gap-2 text-sm">
                    <Switch checked={editing.draft.layaway_only} disabled={!canManage}
                      onCheckedChange={(v) => patchItem({ layaway_only: v })} aria-label="Layaway only" />
                    <span>
                      Layaway only
                      <span className="block text-xs text-muted-foreground">English site only</span>
                    </span>
                  </label>
                </div>

                {itemErrors.length > 0 && (
                  <ul className="space-y-0.5 text-xs text-destructive">
                    {itemErrors.map((e) => <li key={e}>{e}</li>)}
                  </ul>
                )}

                <div className="flex flex-wrap items-center gap-2 pb-2">
                  <Button type="button" disabled={!canManage || itemErrors.length > 0 || saveItem.isPending}
                    onClick={() => saveItem.mutate(editing.draft)}>
                    {saveItem.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Save question
                  </Button>
                  <Button type="button" variant="outline" onClick={() => open(null)}>Cancel</Button>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
