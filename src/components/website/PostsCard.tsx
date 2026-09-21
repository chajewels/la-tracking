import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, FileText, Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import DataTable, { type DataTableColumn } from "@/components/data-table/DataTable";
import { HeroImageField } from "@/components/website/HeroImageField";
import { Markdown } from "@/components/website/markdown";
import { translateJa } from "@/components/website/translate";
import {
  type PostDraft, type PostRow, type PostType,
  POST_SELECT, POST_TYPES, POST_TYPE_LABEL,
  emptyPost, isUniqueViolation, postSlug, toDraft, toPayload, todayPHT, validatePost,
} from "@/components/website/website-posts";

/**
 * Articles and news for chajewelsjp.com.
 *
 * Bodies are markdown, edited as plain textareas with a preview toggle rather
 * than a rich-text editor: what the storefront renders is markdown, so a WYSIWYG
 * would be showing the writer something the site never promised to reproduce.
 *
 * Writes are gated on manage_website_content, matching the table's own RLS.
 * Without it the card is read-only — knowing what the site has published is
 * useful to anyone who can see this tab.
 *
 * website_posts is absent from src/integrations/supabase/types.ts, so it is
 * reached through the `as any` table cast every website_* table uses.
 */

type Filter = "all" | PostType;

export function PostsCard() {
  const qc = useQueryClient();
  const { user, roles } = useAuth();
  const { can } = usePermissions();
  const canManage = can("manage_website_content") || !!roles?.includes("admin");

  const posts = useQuery<PostRow[]>({
    queryKey: ["website-posts"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("website_posts" as any)
        .select(POST_SELECT)
        .order("published_at", { ascending: false, nullsFirst: false })
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as PostRow[];
    },
  });

  const allRows = useMemo(() => posts.data ?? [], [posts.data]);
  const [filter, setFilter] = useState<Filter>("all");
  const rows = useMemo(
    () => (filter === "all" ? allRows : allRows.filter((r) => (r.type ?? "article") === filter)),
    [allRows, filter],
  );
  /** Slug uniqueness is checked against every post, never the filtered view. */
  const slugIndex = useMemo(() => allRows.map((r) => ({ id: r.id, slug: r.slug })), [allRows]);

  const [draft, setDraft] = useState<PostDraft | null>(null);
  const [preview, setPreview] = useState<"en" | "ja" | null>(null);
  const [translating, setTranslating] = useState(false);
  const patch = (p: Partial<PostDraft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  /**
   * Opening or closing the editor always lands on the WRITE pane. Done here
   * rather than in an effect on draft.id: an effect would have to depend on
   * `draft`, and that re-runs on every keystroke — resetting the preview out
   * from under someone who had just turned it on.
   */
  const openDraft = (d: PostDraft | null) => { setDraft(d); setPreview(null); };

  const errors = draft ? validatePost(draft, slugIndex) : [];

  const save = useMutation({
    mutationFn: async (d: PostDraft) => {
      const { data, error } = await supabase
        .from("website_posts" as any)
        .upsert(toPayload(d, user?.id ?? null) as never, { onConflict: "id" })
        .select("id")
        .single();
      // The UNIQUE index is the authority on slugs; validatePost is only the
      // early warning, and two writers can clear it in the same moment.
      if (error) {
        throw isUniqueViolation(error)
          ? new Error(`The slug "${d.slug.trim()}" is already taken — someone saved it a moment ago.`)
          : error;
      }
      const id = (data as unknown as { id: string }).id;

      await supabase.from("audit_logs").insert([{
        entity_type: "website_post",
        entity_id: id,
        action: d.id ? "update_website_post" : "create_website_post",
        old_value_json: (d.id
          ? { slug: allRows.find((r) => r.id === d.id)?.slug ?? null,
              published: allRows.find((r) => r.id === d.id)?.published ?? null }
          : null) as never,
        new_value_json: { slug: d.slug.trim(), type: d.type, published: d.published,
                          published_at: d.published_at.trim() || null } as never,
        performed_by_user_id: user?.id ?? null,
      }]);
      return id;
    },
    onSuccess: () => {
      toast({ title: "Post saved", description: "The website refreshes within a minute." });
      qc.invalidateQueries({ queryKey: ["website-posts"] });
      openDraft(null);
    },
    onError: (e: Error) => toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async (row: PostRow) => {
      const { error } = await supabase.from("website_posts" as any).delete().eq("id", row.id);
      if (error) throw error;
      await supabase.from("audit_logs").insert([{
        entity_type: "website_post",
        entity_id: row.id,
        action: "delete_website_post",
        old_value_json: { slug: row.slug, title_en: row.title_en, published: row.published } as never,
        new_value_json: null,
        performed_by_user_id: user?.id ?? null,
      }]);
    },
    onSuccess: () => {
      toast({ title: "Post removed" });
      qc.invalidateQueries({ queryKey: ["website-posts"] });
      openDraft(null);
    },
    onError: (e: Error) => toast({ title: "Could not remove", description: e.message, variant: "destructive" }),
  });

  /** Regenerate the Japanese title, excerpt and body from the English. */
  async function regenerate() {
    if (!draft) return;
    const title = draft.title_en.trim();
    const body = draft.body_en.trim();
    const excerpt = draft.excerpt_en.trim();
    if (!title && !body && !excerpt) {
      toast({ title: "Nothing to translate", description: "Write the English first." });
      return;
    }
    setTranslating(true);
    try {
      // Two calls, because the helper carries one name and one description per
      // call — and the excerpt and the body must not be merged into one blob
      // and split back apart by guesswork.
      const main = await translateJa({ name: title || undefined, description: body || undefined });
      const patchNext: Partial<PostDraft> = {};
      if (title) patchNext.title_ja = main.name_ja;
      if (body) patchNext.body_ja = main.description_ja;
      if (excerpt) {
        const ex = await translateJa({ description: excerpt });
        patchNext.excerpt_ja = ex.description_ja;
      }
      patch(patchNext);
      toast({ title: "Japanese updated" });
    } catch (e) {
      toast({ title: "Could not translate", description: (e as Error).message, variant: "destructive" });
    } finally {
      setTranslating(false);
    }
  }

  /** Publishing for the first time dates the post today, visibly. */
  function setPublished(on: boolean) {
    if (!draft) return;
    patch(on && !draft.published_at.trim() ? { published: true, published_at: todayPHT() } : { published: on });
  }

  const columns = useMemo<DataTableColumn<PostRow>[]>(() => [
    {
      key: "type",
      header: "Type",
      cell: (r) => {
        const t = (r.type ?? "article") as PostType;
        return <Badge variant="outline" className="text-[10px]">{POST_TYPE_LABEL[t] ?? t}</Badge>;
      },
      sortValue: (r) => r.type ?? "",
      filterValue: (r) => POST_TYPE_LABEL[(r.type ?? "article") as PostType] ?? "",
      csvValue: (r) => r.type ?? "",
    },
    {
      key: "title",
      header: "Title",
      cell: (r) => (
        <div className="min-w-0">
          <div className="font-medium text-card-foreground">{r.title_en}</div>
          <div className="flex flex-wrap items-center gap-1.5">
            <code className="text-[11px] text-muted-foreground">/{r.slug}</code>
            {r.layaway_only && <Badge variant="secondary" className="text-[10px]">EN only</Badge>}
            {!r.title_ja && <Badge variant="outline" className="text-[10px] text-muted-foreground">no JA</Badge>}
          </div>
        </div>
      ),
      sortValue: (r) => r.title_en.toLowerCase(),
      filterValue: (r) => `${r.title_en} ${r.slug}`,
      csvValue: (r) => r.title_en,
    },
    {
      key: "published",
      header: "State",
      cell: (r) => (r.published
        ? <Badge variant="outline" className="border-success/20 bg-success/10 text-[10px] text-success">Published</Badge>
        : <Badge variant="outline" className="border-border bg-muted text-[10px] text-muted-foreground">Draft</Badge>),
      sortValue: (r) => (r.published ? 0 : 1),
      filterValue: (r) => (r.published ? "Published" : "Draft"),
      csvValue: (r) => (r.published ? "published" : "draft"),
    },
    {
      key: "published_at",
      header: "Date",
      cell: (r) => <span className="whitespace-nowrap tabular-nums text-xs text-muted-foreground">{r.published_at ?? "—"}</span>,
      sortValue: (r) => r.published_at ?? "",
      csvValue: (r) => r.published_at ?? "",
    },
    ...(canManage ? [{
      key: "actions",
      header: "",
      align: "right" as const,
      hideable: false,
      cell: (r: PostRow) => (
        <Button
          type="button" variant="ghost" size="icon"
          aria-label={`Edit ${r.title_en}`}
          onClick={(e) => { e.stopPropagation(); openDraft(toDraft(r)); }}
        >
          <Pencil className="h-4 w-4" />
        </Button>
      ),
    }] : []),
  ], [canManage]);

  const CHIPS: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "article", label: "Articles" },
    { key: "news", label: "News" },
  ];
  const countOf = (f: Filter) =>
    f === "all" ? allRows.length : allRows.filter((r) => (r.type ?? "article") === f).length;

  const editing = !!draft?.id;

  return (
    <>
      <Card>
        <CardHeader className="hairline-b">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <FileText className="h-4 w-4 text-primary" />
                Posts {posts.data ? `(${allRows.length})` : ""}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Articles and news on chajewelsjp.com. Bodies are markdown; only published posts appear.
              </p>
            </div>
            {canManage && (
              <Button type="button" size="sm" onClick={() => openDraft(emptyPost())}>
                <Plus className="mr-1.5 h-3.5 w-3.5" /> New post
              </Button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5 pt-2" role="group" aria-label="Filter posts by type">
            {CHIPS.map((c) => (
              <button
                key={c.key} type="button" aria-pressed={filter === c.key}
                onClick={() => setFilter(c.key)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  filter === c.key
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-muted-foreground hover:border-primary/60 hover:text-foreground"
                }`}
              >
                {c.label} ({countOf(c.key)})
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {posts.isLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : posts.isError ? (
            <p className="px-6 py-10 text-sm text-muted-foreground">Couldn't load posts.</p>
          ) : rows.length === 0 ? (
            <p className="px-6 py-10 text-sm text-muted-foreground">
              {allRows.length === 0 ? "No posts yet." : "No posts of that type."}
            </p>
          ) : (
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(r) => r.id}
              onRowClick={(r) => canManage && openDraft(toDraft(r))}
              searchText={(r) => [r.title_en, r.title_ja ?? "", r.slug, r.excerpt_en ?? ""]}
              csvName="website-posts"
              densityKey="cj-website-posts-density"
            />
          )}
        </CardContent>
      </Card>

      <Sheet open={!!draft} onOpenChange={(o) => !o && openDraft(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-3xl">
          {draft && (
            <>
              <SheetHeader className="text-left">
                <SheetTitle>{editing ? "Edit post" : "New post"}</SheetTitle>
              </SheetHeader>

              <div className="mt-4 space-y-5">
                <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
                  <div className="space-y-1.5">
                    <Label htmlFor="post-title-en">Title (English)</Label>
                    <Input
                      id="post-title-en" value={draft.title_en} disabled={!canManage}
                      onChange={(e) => patch({
                        title_en: e.target.value,
                        // The slug follows the title until the post has an id or
                        // the slug has been typed into — after that it is an
                        // address someone may already have linked to.
                        slug: editing || draft.slug !== postSlug(draft.title_en)
                          ? draft.slug
                          : postSlug(e.target.value),
                      })}
                      placeholder="How to care for pearl jewelry"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="post-type">Type</Label>
                    <Select value={draft.type} disabled={!canManage}
                      onValueChange={(v) => patch({ type: v as PostType })}>
                      <SelectTrigger id="post-type"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {POST_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>{POST_TYPE_LABEL[t]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="post-title-ja">Title (Japanese)</Label>
                  <Input
                    id="post-title-ja" lang="ja" value={draft.title_ja} disabled={!canManage}
                    onChange={(e) => patch({ title_ja: e.target.value })}
                    placeholder="日本語のタイトル"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="post-slug">Web address (slug)</Label>
                  <Input
                    id="post-slug" value={draft.slug} disabled={!canManage}
                    onChange={(e) => patch({ slug: postSlug(e.target.value) })}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    chajewelsjp.com/{draft.type === "news" ? "news" : "articles"}/{draft.slug || "…"}
                    {editing && " — changing this breaks any link already shared."}
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label>Cover image</Label>
                  <HeroImageField
                    url={draft.cover_media} folder="posts" disabled={!canManage}
                    onChange={(url) => patch({ cover_media: url })}
                  />
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="post-excerpt-en">Excerpt (English)</Label>
                    <Textarea id="post-excerpt-en" rows={3} value={draft.excerpt_en} disabled={!canManage}
                      onChange={(e) => patch({ excerpt_en: e.target.value })}
                      placeholder="One or two lines shown on the index page." />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="post-excerpt-ja">Excerpt (Japanese)</Label>
                    <Textarea id="post-excerpt-ja" rows={3} lang="ja" value={draft.excerpt_ja} disabled={!canManage}
                      onChange={(e) => patch({ excerpt_ja: e.target.value })} placeholder="日本語の抜粋" />
                  </div>
                </div>

                {/* ── Bodies ──────────────────────────────────────────── */}
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label>Body (markdown)</Label>
                    <div className="flex items-center gap-2">
                      <Button type="button" variant="outline" size="sm"
                        disabled={!canManage || translating}
                        onClick={regenerate}>
                        {translating
                          ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                          : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
                        Regenerate Japanese
                      </Button>
                    </div>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    <code># Heading</code> · <code>**bold**</code> · <code>- list item</code> ·
                    {" "}<code>[text](https://…)</code> · blank line between paragraphs.
                  </p>

                  {(["en", "ja"] as const).map((lang) => (
                    <div key={lang} className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <Label htmlFor={`post-body-${lang}`} className="text-xs text-muted-foreground">
                          {lang === "en" ? "English" : "Japanese"}
                        </Label>
                        <Button
                          type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs"
                          aria-pressed={preview === lang}
                          onClick={() => setPreview(preview === lang ? null : lang)}
                        >
                          <Eye className="mr-1 h-3.5 w-3.5" />
                          {preview === lang ? "Write" : "Preview"}
                        </Button>
                      </div>
                      {preview === lang ? (
                        <div className="max-h-80 overflow-y-auto rounded-md border border-border bg-muted/20 px-3 py-2">
                          <Markdown>{lang === "en" ? draft.body_en : draft.body_ja}</Markdown>
                        </div>
                      ) : (
                        <Textarea
                          id={`post-body-${lang}`} rows={10} disabled={!canManage}
                          lang={lang === "ja" ? "ja" : undefined}
                          className="font-mono text-xs"
                          value={lang === "en" ? draft.body_en : draft.body_ja}
                          onChange={(e) => patch(lang === "en" ? { body_en: e.target.value } : { body_ja: e.target.value })}
                        />
                      )}
                    </div>
                  ))}
                </div>

                {/* ── Publishing ──────────────────────────────────────── */}
                <div className="space-y-3 rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <label className="flex items-center gap-2 text-sm">
                      <Switch checked={draft.published} disabled={!canManage}
                        onCheckedChange={setPublished} aria-label="Published" />
                      Published
                    </label>
                    <div className="flex items-center gap-2">
                      <Label htmlFor="post-date" className="text-xs text-muted-foreground">Date</Label>
                      <Input
                        id="post-date" type="date" className="w-[10.5rem]" disabled={!canManage}
                        value={draft.published_at}
                        onChange={(e) => patch({ published_at: e.target.value })}
                      />
                    </div>
                  </div>
                  <label className="flex items-start gap-2 text-sm">
                    <Switch checked={draft.layaway_only} disabled={!canManage}
                      onCheckedChange={(v) => patch({ layaway_only: v })} aria-label="Layaway only" />
                    <span>
                      Layaway only
                      <span className="block text-xs text-muted-foreground">Shown on the English site only</span>
                    </span>
                  </label>
                </div>

                {errors.length > 0 && (
                  <ul className="space-y-0.5 text-xs text-destructive">
                    {errors.map((e) => <li key={e}>{e}</li>)}
                  </ul>
                )}

                <div className="flex flex-wrap items-center gap-2 pb-2">
                  <Button type="button" disabled={!canManage || errors.length > 0 || save.isPending}
                    onClick={() => save.mutate(draft)}>
                    {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Save post
                  </Button>
                  <Button type="button" variant="outline" onClick={() => openDraft(null)}>Cancel</Button>
                  {editing && canManage && (
                    <Button
                      type="button" variant="ghost" className="ml-auto text-destructive"
                      disabled={remove.isPending}
                      onClick={() => {
                        const row = allRows.find((r) => r.id === draft.id);
                        if (!row) return;
                        if (confirm(`Remove "${row.title_en}"? This cannot be undone, and any link to /${row.slug} will stop working.`)) {
                          remove.mutate(row);
                        }
                      }}
                    >
                      {remove.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Trash2 className="mr-1.5 h-4 w-4" />}
                      Delete
                    </Button>
                  )}
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
