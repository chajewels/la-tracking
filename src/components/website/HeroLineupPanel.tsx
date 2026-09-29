import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatPHTDisplay } from "@/lib/date-utils";
import {
  getHeroLineup, HERO_LINEUP_KEY, HERO_SLIDE_LIMIT, type HeroLineupCategory, type HeroLineupPiece,
  heroPickRefusalText, lineupReasonText,
} from "@/lib/hero-picks";
import { publicUrl } from "@/lib/media-cutouts";

/**
 * Website → Photos → Hero: what each category slide shows (migration
 * 20261016100000, docs/HERO-PICKS.md "Running order"). Per published category,
 * in the Hub's order: the ticked pieces ON the website hero now (at most 3, in
 * the order they were ticked), the ones WAITING their turn, and ticked pieces
 * NOT SHOWING with the reason. Read-only; the order is decided in the database
 * (hero_lineup_rows) — the same rule the storefront applies. Hidden until the
 * migration has run (the RPC does not exist yet).
 */
export function HeroLineupPanel({ usingTicks }: { usingTicks: boolean }) {
  const q = useQuery({ queryKey: HERO_LINEUP_KEY, queryFn: getHeroLineup, staleTime: 15_000, retry: false });

  if (q.isLoading) {
    return <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading the hero order…</p>;
  }
  const data = q.data;
  // A failed refresh keeps the last answer on screen; an error shows only when there is nothing to show.
  if (!data) {
    if (!q.isError) return null;
    // Before 20261016100000 the function is missing: say nothing rather than an error.
    const msg = heroPickRefusalText(q.error);
    return /get_hero_lineup|does not exist|Could not find the function/i.test(msg) ? null
      : <p className="text-xs text-muted-foreground">Could not load what each category slide shows: {msg}</p>;
  }
  const limit = data.slide_limit || HERO_SLIDE_LIMIT;

  return (
    <section className="space-y-3" aria-labelledby="hero-lineup-title" data-testid="hero-lineup">
      <div className="space-y-1">
        <h4 id="hero-lineup-title" className="text-sm font-medium">What each category slide shows</h4>
        <p className="text-xs text-muted-foreground">
          {usingTicks
            ? `The website hero shows these now: up to ${limit} ticked pieces per category, oldest tick first. Publishing a product does not change it.`
            : `The website still uses the hero record. This is what it will show once you switch to ticked product cut-outs.`}
        </p>
      </div>
      <ul className="space-y-2">
        {data.categories.map(c => <CategoryLineup key={c.id} c={c} limit={limit} usingTicks={usingTicks} />)}
      </ul>
      {data.no_category.length > 0 && (
        <div className="rounded border border-border p-2" data-testid="hero-lineup-no-category">
          <p className="text-xs font-medium">Ticked, but in no published category ({data.no_category.length})</p>
          <p className="text-[11px] text-muted-foreground">The hero has one slide per category, so these cannot show.</p>
          <PieceList pieces={data.no_category} />
        </div>
      )}
    </section>
  );
}

function CategoryLineup({ c, limit, usingTicks }: { c: HeroLineupCategory; limit: number; usingTicks: boolean }) {
  const on = c.on_hero.length;
  return (
    <li className="rounded border border-border p-2" data-testid={`hero-lineup-${c.slug}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{c.name}</span>
        <Badge variant={on > 0 ? "default" : "secondary"} className="tabular-nums">
          {usingTicks ? "On the website" : "Would show"} {on}/{limit}
        </Badge>
      </div>
      {on === 0 && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          No ticked piece can show here now — the slide {usingTicks ? "shows" : "would show"} no piece (it never falls back to untagged pieces).
        </p>
      )}
      <PieceList pieces={c.on_hero} />
      {c.waiting.length > 0 && (
        <Group label={`Waiting their turn (${c.waiting.length})`} hint="In tick order. The first one moves up when a piece on the slide sells or is unpublished.">
          <PieceList pieces={c.waiting} />
        </Group>
      )}
      {c.not_showing.length > 0 && (
        <Group label={`Ticked, not showing (${c.not_showing.length})`}>
          <PieceList pieces={c.not_showing} />
        </Group>
      )}
    </li>
  );
}

function Group({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <Collapsible defaultOpen className="mt-2">
      <CollapsibleTrigger className="group flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
        <ChevronDown className="h-3.5 w-3.5 transition-transform group-data-[state=closed]:-rotate-90" aria-hidden />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

function PieceList({ pieces }: { pieces: HeroLineupPiece[] }) {
  if (pieces.length === 0) return null;
  return (
    <ol className="mt-1 space-y-1">
      {pieces.map(p => {
        const thumb = publicUrl(p.photo?.thumb_path);
        return (
          <li key={p.product_id} className="flex items-center gap-2 text-xs" data-testid="hero-lineup-piece">
            <span className="w-6 shrink-0 text-right tabular-nums text-muted-foreground">{p.place ?? "–"}</span>
            <span className="h-9 w-9 shrink-0 overflow-hidden rounded bg-muted">
              {thumb && <img src={thumb} alt="" loading="lazy" className="h-full w-full object-contain" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate" title={`${p.sku} · ${p.name}`}><span className="font-medium">{p.sku}</span> · {p.name}</span>
              <span className="block text-[11px] text-muted-foreground">
                {p.state === "not_showing" ? lineupReasonText(p.reason) : `Ticked ${formatPHTDisplay(p.first_picked_at)}`}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
