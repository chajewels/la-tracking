import { useContext, useId } from "react";
import { ChevronDown, Loader2, RefreshCw, Sparkles, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cutoutRowState, isLocked, type CutoutRow, type ReviewAction } from "@/lib/media-cutouts";
import { blockerText } from "@/lib/hero-picks";
import { HeroPickContext, type HeroPickControl } from "@/components/website/hero-pick-context";

/** "Use on hero": unticking is always allowed; ticking only a usable cut-out; admin only. */
function HeroPickToggle({ row, hero }: { row: CutoutRow; hero: HeroPickControl }) {
  const id = useId();
  const picked = row.hero_pick === true;
  const reason = blockerText(row.hero_pick_blocker);
  const saving = hero.pendingUrl === row.source_url;
  // Unticking is always allowed; ticking only a usable cut-out.
  const disabled = !hero.isAdmin || saving || hero.pendingUrl !== null || (!picked && !!reason);
  const note = !hero.isAdmin
    ? "Only an admin can choose the hero photos."
    : picked && reason ? `Ticked, but not on the hero: ${reason}.`
    : !picked && reason ? `Can't be on the hero: ${reason}.`
    : null;
  return (
    <div className="flex basis-full flex-wrap items-center gap-x-2 gap-y-1" data-testid="hero-pick">
      <label
        htmlFor={id}
        className={"inline-flex h-9 items-center gap-2 rounded-md border border-border px-2.5 text-sm "
          + (disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer hover:border-primary/60")}
      >
        <Checkbox
          id={id}
          checked={picked}
          disabled={disabled}
          onCheckedChange={v => hero.onPick(row, v === true)}
          aria-describedby={note ? `${id}-note` : undefined}
        />
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden />}
        Use on hero
      </label>
      {note && <span id={`${id}-note`} className="text-xs text-muted-foreground" data-testid="hero-pick-note">{note}</span>}
    </div>
  );
}

/**
 * The review buttons for one photo on Website → Photos. Rendered by the row
 * AND by the zoom viewer, so both always offer the same actions for the same
 * state and call the card's one onAct. Completed is final: no Re-run, ever.
 */
export default function CutoutActionButtons({ row, onAct, busy, isAdmin, testId = "cutout-actions" }: {
  row: CutoutRow;
  onAct: (row: CutoutRow, action: ReviewAction) => void;
  busy: boolean;
  isAdmin: boolean;
  testId?: string;
}) {
  const { inFlight, completed, kept, rejected, keepFirst, held, capped } = cutoutRowState(row);
  const hero = useContext(HeroPickContext);
  return (
    <div className="flex flex-wrap gap-2" data-testid={testId}>
      {keepFirst && (
        <Button size="sm" disabled={busy} onClick={() => onAct(row, "keep_original")}>
          Keep original
        </Button>
      )}
      {!held && !rejected && !kept && (
        <Button size="sm" variant={keepFirst ? "outline" : "default"}
                disabled={busy || inFlight || !row.cutout_path || row.status === "approved"}
                onClick={() => onAct(row, "approve")}>
          Approve
        </Button>
      )}
      {!held && !isLocked(row.status) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" disabled={busy || inFlight || capped}
                    title={capped ? "This photo has used all its paid calls" : undefined}>
              <RefreshCw className="mr-1 h-3.5 w-3.5" /> Re-run <ChevronDown className="ml-1 h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => onAct(row, "rerun")}>Re-run</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAct(row, "rerun_high_detail")}>Re-run in high detail</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {!rejected && !kept && !held && (
        <Button size="sm" variant="outline" disabled={busy || inFlight} onClick={() => onAct(row, "reject")}>
          Reject
        </Button>
      )}
      {!completed && !keepFirst && (
        <Button size="sm" variant="outline" disabled={busy || inFlight} onClick={() => onAct(row, "keep_original")}>
          Keep original
        </Button>
      )}
      {(!completed || kept) && (
        <Button size="sm" variant="outline" disabled={busy || inFlight} onClick={() => onAct(row, "own_cutout")}>
          <Upload className="mr-1 h-3.5 w-3.5" /> Upload my own cut-out
        </Button>
      )}
      {row.last_rerun?.cutout_path && !rejected && (
        <Button size="sm" variant="outline" disabled={busy || inFlight} onClick={() => onAct(row, "use_rerun")}>
          Use the re-run
        </Button>
      )}
      {isAdmin && rejected && (
        <Button size="sm" variant="outline" disabled={busy || inFlight} onClick={() => onAct(row, "retry_once")}>
          Try once more
        </Button>
      )}
      {/* Also on a FAILED photo at its paid-call limit (NL366, 2026-09-29):
          review_media_cutout's override_cap already accepts that state, but
          the button only showed for Needs owner, leaving no way forward. */}
      {isAdmin && (held || (capped && row.status === "failed")) && !isLocked(row.status) && (
        <Button size="sm" variant="outline" disabled={busy || inFlight} onClick={() => onAct(row, "override_cap")}>
          Allow one more paid call
        </Button>
      )}
      {hero && row.hero_pick !== undefined && <HeroPickToggle row={row} hero={hero} />}
    </div>
  );
}
