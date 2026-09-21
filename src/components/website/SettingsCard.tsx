import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Loader2, Megaphone, Plus, RefreshCw, Trash2 } from "lucide-react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { translateJa } from "@/components/website/translate";
import {
  type Bilingual, type SectionId, type SettingKey, type SettingsDraft, type SocialKey, type SocialRow,
  EMPTY_DRAFT, SECTIONS, SETTING_KEYS, SETTING_KIND, SOCIAL_KEYS, SOCIAL_LABEL,
  announcementExpired, parseSetting, serializeSetting, validateSection,
} from "@/components/website/website-settings";

/**
 * Website → Settings. The storefront's own copy: who to write to, which social
 * links the footer shows, the tagline under them, and the announcement bar.
 *
 * Saved PER SECTION, and only the keys that actually changed are written —
 * pressing Save on Contact must not stamp updated_by on the announcement.
 * Every written key gets its own audit_logs row with the old and new value,
 * because a key/value table shows only what a setting IS and never what it was
 * or who changed it.
 *
 * Writes are gated on manage_website_content, matching the table's own RLS
 * ("Content managers can manage website settings"). Without it the whole card
 * is read-only rather than hidden: knowing what the site currently says is
 * useful to anyone who can see this tab.
 *
 * website_settings is absent from src/integrations/supabase/types.ts, so it is
 * reached through the `as any` table cast every website_* table uses.
 */

interface SettingRow {
  key: string;
  value: unknown;
  kind: string | null;
  public: boolean | null;
  updated_at: string | null;
}

const KNOWN = new Set<string>(SETTING_KEYS);

export function SettingsCard() {
  const qc = useQueryClient();
  const { user, roles } = useAuth();
  const { can } = usePermissions();
  const canManage = can("manage_website_content") || !!roles?.includes("admin");

  const settings = useQuery<SettingRow[]>({
    queryKey: ["website-settings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("website_settings" as any)
        .select("key, value, kind, public, updated_at")
        .order("key");
      if (error) throw error;
      return (data ?? []) as unknown as SettingRow[];
    },
  });

  const rows = useMemo(() => settings.data ?? [], [settings.data]);

  /** The saved state, as a typed draft. Missing keys read as their default. */
  const loaded = useMemo<SettingsDraft>(() => {
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const out = { ...EMPTY_DRAFT };
    for (const k of SETTING_KEYS) {
      (out[k] as unknown) = parseSetting(k, byKey.get(k));
    }
    return out;
  }, [rows]);

  const [draft, setDraft] = useState<SettingsDraft>(EMPTY_DRAFT);
  // Re-seed from the server whenever the saved state changes — on first load,
  // and after a save invalidates the query.
  useEffect(() => { setDraft(loaded); }, [loaded]);

  const [translating, setTranslating] = useState<SettingKey | null>(null);

  const patch = <K extends SettingKey>(key: K, value: SettingsDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const changedKeys = (id: SectionId): SettingKey[] => {
    const section = SECTIONS.find((s) => s.id === id)!;
    return section.keys.filter(
      (k) => JSON.stringify(serializeSetting(k, draft[k])) !== JSON.stringify(serializeSetting(k, loaded[k])),
    );
  };

  const save = useMutation({
    mutationFn: async (id: SectionId) => {
      const keys = changedKeys(id);
      if (!keys.length) return 0;

      const payload = keys.map((k) => ({
        key: k,
        value: serializeSetting(k, draft[k]),
        kind: SETTING_KIND[k],
        // `public` and `updated_at` are deliberately NOT sent: public keeps its
        // column default on insert and its existing value on conflict, and
        // updated_at is the table's own trigger's job.
        updated_by: user?.id ?? null,
      }));

      const { error } = await supabase
        .from("website_settings" as any)
        .upsert(payload as never, { onConflict: "key" });
      if (error) throw error;

      // One audit row per key, not one per Save: "Announcement" changing tells
      // nobody which of its four keys moved.
      await supabase.from("audit_logs").insert(
        keys.map((k) => ({
          entity_type: "website_setting",
          entity_id: k,
          action: "update_website_setting",
          old_value_json: { value: serializeSetting(k, loaded[k]) } as never,
          new_value_json: { value: serializeSetting(k, draft[k]) } as never,
          performed_by_user_id: user?.id ?? null,
        })),
      );
      return keys.length;
    },
    onSuccess: (n) => {
      if (!n) return;
      toast({ title: `Saved — ${n} setting${n === 1 ? "" : "s"} updated`, description: "The website refreshes within a minute." });
      qc.invalidateQueries({ queryKey: ["website-settings"] });
    },
    onError: (e: Error) => toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });

  /** Regenerate the Japanese half of a bilingual key from its English. */
  async function regenerate(key: "footer.tagline" | "announcement.text") {
    const en = draft[key].en.trim();
    if (!en) {
      toast({ title: "Nothing to translate", description: "Write the English text first." });
      return;
    }
    setTranslating(key);
    try {
      const out = await translateJa({ description: en });
      patch(key, { ...draft[key], ja: out.description_ja });
      toast({ title: "Japanese updated" });
    } catch (e) {
      toast({ title: "Could not translate", description: (e as Error).message, variant: "destructive" });
    } finally {
      setTranslating(null);
    }
  }

  const unknown = useMemo(() => rows.filter((r) => !KNOWN.has(r.key)), [rows]);

  const SectionSave = ({ id }: { id: SectionId }) => {
    const changed = changedKeys(id);
    const errors = validateSection(id, draft);
    const busy = save.isPending && save.variables === id;
    return (
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Button
          type="button" size="sm"
          disabled={!canManage || !changed.length || errors.length > 0 || save.isPending}
          onClick={() => save.mutate(id)}
        >
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save {SECTIONS.find((s) => s.id === id)!.label.toLowerCase()}
        </Button>
        {changed.length > 0 && errors.length === 0 && (
          <span className="text-xs text-muted-foreground">
            {changed.length} unsaved change{changed.length === 1 ? "" : "s"}
          </span>
        )}
        {errors.length > 0 && (
          <ul className="space-y-0.5 text-xs text-destructive">
            {errors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        )}
      </div>
    );
  };

  const BilingualField = ({ id, label, rows: textRows }: {
    id: "footer.tagline" | "announcement.text"; label: string; rows: number;
  }) => (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-en`}>{label} (English)</Label>
        <Textarea
          id={`${id}-en`} rows={textRows} disabled={!canManage}
          value={draft[id].en}
          onChange={(e) => patch(id, { ...draft[id], en: e.target.value } as Bilingual)}
        />
      </div>
      <div className="space-y-1.5 rounded-lg border border-border bg-muted/30 p-3">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={`${id}-ja`} className="text-xs text-muted-foreground">Japanese</Label>
          <Button
            type="button" variant="outline" size="sm"
            disabled={!canManage || translating === id || !draft[id].en.trim()}
            onClick={() => regenerate(id)}
          >
            {translating === id
              ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
            Regenerate
          </Button>
        </div>
        <Textarea
          id={`${id}-ja`} rows={textRows} lang="ja" disabled={!canManage}
          className="bg-transparent"
          value={draft[id].ja}
          onChange={(e) => patch(id, { ...draft[id], ja: e.target.value } as Bilingual)}
          placeholder="日本語"
        />
        <p className="text-[11px] text-muted-foreground">
          Typed Japanese is saved as written. Regenerate overwrites it from the English.
        </p>
      </div>
    </div>
  );

  const SocialList = ({ id, label, hint }: {
    id: "social.follow" | "social.loyalty_groups"; label: string; hint: string;
  }) => {
    const list = draft[id];
    const setList = (next: SocialRow[]) => patch(id, next);
    const move = (i: number, by: number) => {
      const next = [...list];
      const j = i + by;
      if (j < 0 || j >= next.length) return;
      [next[i], next[j]] = [next[j], next[i]];
      setList(next);
    };
    const unused = SOCIAL_KEYS.filter((k) => !list.some((r) => r.key === k));
    return (
      <div className="space-y-2">
        <div>
          <Label>{label}</Label>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
        {list.length === 0 && (
          <p className="rounded-md border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
            No links yet — the site shows nothing for this list.
          </p>
        )}
        {list.map((row, i) => (
          <div key={`${row.key}-${i}`} className="flex flex-wrap items-center gap-2">
            <Select
              value={row.key}
              disabled={!canManage}
              onValueChange={(v) => {
                const next = [...list];
                next[i] = { ...next[i], key: v as SocialKey };
                setList(next);
              }}
            >
              <SelectTrigger className="w-[9.5rem]" aria-label={`${label} row ${i + 1} channel`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {/* The row's own key stays selectable; the rest are the unused ones. */}
                {[row.key, ...unused].map((k) => (
                  <SelectItem key={k} value={k}>{SOCIAL_LABEL[k]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              className="min-w-[14rem] flex-1"
              disabled={!canManage}
              value={row.href}
              aria-label={`${label} row ${i + 1} link`}
              placeholder={row.key === "email" ? "mailto:sales@chajewelsjp.com" : "https://…"}
              onChange={(e) => {
                const next = [...list];
                next[i] = { ...next[i], href: e.target.value };
                setList(next);
              }}
            />
            <div className="flex items-center gap-1">
              <Button type="button" variant="ghost" size="icon" disabled={!canManage || i === 0}
                aria-label={`Move ${SOCIAL_LABEL[row.key]} up`} onClick={() => move(i, -1)}>
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button type="button" variant="ghost" size="icon" disabled={!canManage || i === list.length - 1}
                aria-label={`Move ${SOCIAL_LABEL[row.key]} down`} onClick={() => move(i, 1)}>
                <ArrowDown className="h-4 w-4" />
              </Button>
              <Button type="button" variant="ghost" size="icon" disabled={!canManage}
                aria-label={`Remove ${SOCIAL_LABEL[row.key]}`}
                onClick={() => setList(list.filter((_, x) => x !== i))}>
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          </div>
        ))}
        {canManage && unused.length > 0 && (
          <Button type="button" variant="outline" size="sm"
            onClick={() => setList([...list, { key: unused[0], href: "" }])}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add link
          </Button>
        )}
      </div>
    );
  };

  const expired = announcementExpired(draft["announcement.until"]);
  const live = draft["announcement.active"] && !expired && !!draft["announcement.text"].en.trim();

  return (
    <Card>
      <CardHeader className="hairline-b">
        <CardTitle className="text-base">Site settings</CardTitle>
        <p className="text-xs text-muted-foreground">
          The storefront's own copy — the address people write to, the links in the footer, and the
          announcement bar. Each section saves on its own.
        </p>
      </CardHeader>
      <CardContent className="space-y-8 pt-5">
        {settings.isLoading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : settings.isError ? (
          <p className="py-8 text-sm text-muted-foreground">Couldn't load settings.</p>
        ) : (
          <>
            {!canManage && (
              <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                You can read these settings but not change them — that needs Manage Website Content.
              </p>
            )}

            {/* ── Contact ─────────────────────────────────────────────── */}
            <section className="space-y-3">
              <h3 className="text-sm font-semibold">Contact</h3>
              <div className="space-y-1.5 sm:max-w-md">
                <Label htmlFor="contact-email">Contact email</Label>
                <Input
                  id="contact-email" type="email" disabled={!canManage}
                  value={draft["contact.email"]}
                  onChange={(e) => patch("contact.email", e.target.value)}
                  placeholder="sales@chajewelsjp.com"
                />
                <p className="text-[11px] text-muted-foreground">
                  Shown on the contact page and used as the reply-to on the site's forms.
                </p>
              </div>
              <SectionSave id="contact" />
            </section>

            {/* ── Social ──────────────────────────────────────────────── */}
            <section className="space-y-4 border-t border-border pt-6">
              <h3 className="text-sm font-semibold">Social</h3>
              <SocialList
                id="social.follow" label="Follow us"
                hint="The footer's social row, in this order."
              />
              <SocialList
                id="social.loyalty_groups" label="Loyalty groups"
                hint="The group-chat invites offered to loyalty members."
              />
              <SectionSave id="social" />
            </section>

            {/* ── Footer ──────────────────────────────────────────────── */}
            <section className="space-y-3 border-t border-border pt-6">
              <h3 className="text-sm font-semibold">Footer</h3>
              <BilingualField id="footer.tagline" label="Tagline" rows={2} />
              <SectionSave id="footer" />
            </section>

            {/* ── Announcement ────────────────────────────────────────── */}
            <section className="space-y-3 border-t border-border pt-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-sm font-semibold">Announcement</h3>
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={draft["announcement.active"]}
                    disabled={!canManage}
                    onCheckedChange={(v) => patch("announcement.active", v)}
                    aria-label="Announcement active"
                  />
                  Active
                </label>
              </div>

              {/* The bar as the site will read it. Shown always, because the
                  point of a preview is to see it BEFORE turning it on. */}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Preview</Label>
                <div
                  className={`flex flex-wrap items-center gap-2 rounded-md px-4 py-2.5 text-sm ${
                    live ? "bg-primary text-primary-foreground" : "border border-dashed border-border bg-muted/30 text-muted-foreground"
                  }`}
                >
                  <Megaphone className="h-4 w-4 shrink-0" />
                  <span className="min-w-0">
                    {draft["announcement.text"].en.trim() || "No announcement text yet."}
                  </span>
                  {draft["announcement.href"].trim() && (
                    <span className={live ? "underline" : "underline opacity-70"}>Learn more</span>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {!draft["announcement.active"]
                    ? "Off — the site shows no bar."
                    : expired
                      ? `Ended ${draft["announcement.until"]} — the site shows no bar.`
                      : !draft["announcement.text"].en.trim()
                        ? "On, but there is no text to show."
                        : draft["announcement.until"]
                          ? `Live on the site until ${draft["announcement.until"]}.`
                          : "Live on the site, with no end date."}
                </p>
              </div>

              <BilingualField id="announcement.text" label="Announcement" rows={2} />

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="announcement-href">Link (optional)</Label>
                  <Input
                    id="announcement-href" disabled={!canManage}
                    value={draft["announcement.href"]}
                    onChange={(e) => patch("announcement.href", e.target.value)}
                    placeholder="https://chajewelsjp.com/…"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="announcement-until">Ends (optional)</Label>
                  <Input
                    id="announcement-until" type="date" disabled={!canManage}
                    value={draft["announcement.until"]}
                    onChange={(e) => patch("announcement.until", e.target.value)}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Blank means it runs until someone turns it off.
                  </p>
                </div>
              </div>
              <SectionSave id="announcement" />
            </section>

            {/* ── Anything this card does not know about ──────────────── */}
            {unknown.length > 0 && (
              <section className="space-y-2 border-t border-border pt-6">
                <h3 className="text-sm font-semibold">Other keys</h3>
                <p className="text-xs text-muted-foreground">
                  Rows in <code>website_settings</code> this screen does not manage. Shown so nothing in
                  the table is invisible; edit them in SQL, or add them to the schema in
                  <code> website-settings.ts</code>.
                </p>
                <div className="space-y-1.5">
                  {unknown.map((r) => (
                    <div key={r.key} className="rounded-md border border-border px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="text-xs text-card-foreground">{r.key}</code>
                        <Badge variant="outline" className="text-[10px]">{r.kind ?? "—"}</Badge>
                        {r.public === false && <Badge variant="secondary" className="text-[10px]">private</Badge>}
                      </div>
                      <pre className="mt-1 overflow-x-auto text-[11px] text-muted-foreground">
                        {JSON.stringify(r.value, null, 2)}
                      </pre>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
