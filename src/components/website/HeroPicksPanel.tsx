import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Lock, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  blockerText, carryOver, type CarryOverResult, HERO_SOURCE_LABEL, HERO_SOURCE_TEXT, type HeroPhotoSource,
  heroPickRefusalText, type HeroTabTotals, setHeroPhotoSource,
} from "@/lib/hero-picks";

/**
 * Website → Photos → Hero tab (migration 20261013100000, docs/HERO-PICKS.md):
 * how many photos are ticked "Use on hero", how many products that puts on the
 * hero and how many published products are left out; the hero switch (what
 * the website hero reads — changing it asks first and says what the website
 * will show); and the one-time carry-over of the approved hero cut-outs
 * (preview, then apply; pressing it twice ticks nothing twice). The switch and
 * the carry-over are ADMIN only — the database checks the role again.
 */
export function HeroPicksPanel({ totals, source, isAdmin, onChanged }: {
  totals: HeroTabTotals;
  source: HeroPhotoSource;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [confirmSource, setConfirmSource] = useState<HeroPhotoSource | null>(null);
  const [preview, setPreview] = useState<CarryOverResult | null>(null);

  const switchSource = useMutation({
    mutationFn: (next: HeroPhotoSource) => setHeroPhotoSource(next, source),
    onSuccess: out => {
      toast.success(`The website hero now uses: ${HERO_SOURCE_LABEL[out.source]}. Saved to the audit log.`);
      setConfirmSource(null);
    },
    onError: e => toast.error(heroPickRefusalText(e)),
    onSettled: onChanged,
  });
  const loadPreview = useMutation({
    mutationFn: () => carryOver(false),
    onSuccess: out => setPreview(out),
    onError: e => toast.error(heroPickRefusalText(e)),
  });
  const apply = useMutation({
    mutationFn: () => carryOver(true),
    onSuccess: out => {
      const n = out.ticked ?? 0;
      toast.success(n > 0
        ? `Ticked ${n} photo${n === 1 ? "" : "s"} from the approved hero cut-outs. Saved to the audit log.`
        : "Nothing new to carry over — they are already ticked.");
      setPreview(null);
    },
    onError: e => toast.error(heroPickRefusalText(e)),
    onSettled: onChanged,
  });

  const after = preview?.products_after;
  const toTick = preview?.to_tick ?? 0;
  const leftOut = Object.entries(preview?.left_out ?? {}).filter(([, n]) => (n ?? 0) > 0);

  return (
    <section className="space-y-4 rounded-md border border-border p-3" aria-labelledby="hero-picks-title" data-testid="hero-picks-panel">
      <div className="space-y-1">
        <h3 id="hero-picks-title" className="flex items-center gap-2 text-sm font-medium">
          <Sparkles className="h-4 w-4 text-primary" aria-hidden /> Hero photos
        </h3>
        <p className="text-xs text-muted-foreground">
          Tick "Use on hero" on a finished product cut-out to put that photo on the website hero (up to 4 per piece, in
          the photos' order). Only an admin can tick.
        </p>
      </div>

      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3" data-testid="hero-picks-counts">
        <div className="rounded border border-border p-2">
          <dt className="text-xs text-muted-foreground">Ticked photos</dt>
          <dd className="text-lg font-medium tabular-nums">{totals.count.toLocaleString()}</dd>
          {totals.count > totals.usable && (
            <dd className="text-[11px] text-warning">{(totals.count - totals.usable).toLocaleString()} not usable now</dd>
          )}
        </div>
        <div className="rounded border border-border p-2">
          <dt className="text-xs text-muted-foreground">Products on the hero</dt>
          <dd className="text-lg font-medium tabular-nums">{totals.products_on_hero.toLocaleString()}</dd>
          <dd className="text-[11px] text-muted-foreground">of {totals.published_in_stock.toLocaleString()} published and in stock</dd>
        </div>
        <div className="rounded border border-border p-2">
          <dt className="text-xs text-muted-foreground">Published products left out</dt>
          <dd className="text-lg font-medium tabular-nums">{totals.published_left_out.toLocaleString()}</dd>
          <dd className="text-[11px] text-muted-foreground">no ticked photo yet</dd>
        </div>
      </dl>

      <div className="space-y-2" data-testid="hero-source">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">The website hero uses</span>
          <Badge variant={source === "product_ticks" ? "default" : "secondary"} data-testid="hero-source-badge">
            {HERO_SOURCE_LABEL[source]}
          </Badge>
        </div>
        <ToggleGroup
          type="single"
          value={source}
          disabled={!isAdmin || switchSource.isPending}
          onValueChange={v => { if (v && v !== source) setConfirmSource(v as HeroPhotoSource); }}
          className="flex-wrap justify-start"
          aria-label="What the website hero uses"
        >
          <ToggleGroupItem value="hero_record" variant="outline" size="sm">Hero record</ToggleGroupItem>
          <ToggleGroupItem value="product_ticks" variant="outline" size="sm">Ticked product cut-outs</ToggleGroupItem>
        </ToggleGroup>
        <p className="text-xs text-muted-foreground" data-testid="hero-source-text">{HERO_SOURCE_TEXT[source]}</p>
        {!isAdmin && (
          <p className="flex items-center gap-1 text-xs text-muted-foreground"><Lock className="h-3 w-3" /> Only an admin can change this.</p>
        )}
      </div>

      {isAdmin && (
        <div className="space-y-2" data-testid="hero-carry-over">
          <Button size="sm" variant="outline" onClick={() => loadPreview.mutate()} disabled={loadPreview.isPending || apply.isPending}>
            {loadPreview.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            Carry over approved hero cut-outs…
          </Button>
          <p className="text-xs text-muted-foreground">
            Ticks the same photo for every approved hero cut-out whose product cut-out is usable. Shows how many first;
            nothing is ticked twice.
          </p>
        </div>
      )}

      <AlertDialog open={confirmSource !== null} onOpenChange={o => { if (!o) setConfirmSource(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmSource === "product_ticks" ? "Switch the website hero to ticked product cut-outs?" : "Switch the website hero back to the hero record?"}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-left" data-testid="hero-source-confirm">
                {confirmSource && <p>{HERO_SOURCE_TEXT[confirmSource]}</p>}
                {confirmSource === "product_ticks" && (
                  <>
                    <p className="tabular-nums">
                      Right now that is {totals.products_on_hero.toLocaleString()} of {totals.published_in_stock.toLocaleString()} published
                      products in stock; {totals.published_left_out.toLocaleString()} would leave the hero until a photo is ticked.
                    </p>
                    <p className="font-medium text-foreground">
                      Switch only once the website update for ticked cut-outs is live (the Hub edge function and the
                      storefront). Before that, the hero cannot show them.
                    </p>
                  </>
                )}
                <p>The website refreshes within about a minute. Saved to the audit log; you can switch back at any time.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={switchSource.isPending} onClick={e => { e.preventDefault(); if (confirmSource) switchSource.mutate(confirmSource); }}>
              {switchSource.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              Switch
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={preview !== null} onOpenChange={o => { if (!o && !apply.isPending) setPreview(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Carry over the approved hero cut-outs?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-left tabular-nums" data-testid="hero-carry-over-preview">
                {preview && (
                  <>
                    <p>
                      {preview.approved_hero.toLocaleString()} approved hero cut-out{preview.approved_hero === 1 ? "" : "s"}:{" "}
                      <strong className="text-foreground">{toTick.toLocaleString()} will be ticked</strong>
                      {preview.already_ticked ? `, ${preview.already_ticked.toLocaleString()} already ticked` : ""}.
                    </p>
                    {leftOut.length > 0 && (
                      <div>
                        <p>Left out (not ticked):</p>
                        <ul className="list-disc pl-5">
                          {leftOut.map(([k, n]) => <li key={k}>{n} — {blockerText(k)}</li>)}
                        </ul>
                      </div>
                    )}
                    {after && (
                      <p>
                        Products on the hero: {preview.products_now.products_on_hero.toLocaleString()} → {after.products_on_hero.toLocaleString()} of{" "}
                        {after.published_in_stock.toLocaleString()} published in stock; {after.published_left_out.toLocaleString()} left out.
                      </p>
                    )}
                    <p>
                      {source === "hero_record"
                        ? "The website does not change: it keeps using the hero record until you switch."
                        : "The website hero updates within about a minute."}{" "}
                      Saved to the audit log.
                    </p>
                  </>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={apply.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={apply.isPending || toTick === 0} onClick={e => { e.preventDefault(); apply.mutate(); }}>
              {apply.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              {toTick === 0 ? "Nothing to carry over" : `Tick ${toTick.toLocaleString()} photo${toTick === 1 ? "" : "s"}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
