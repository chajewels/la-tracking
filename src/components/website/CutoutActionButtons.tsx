import { ChevronDown, RefreshCw, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cutoutRowState, isLocked, type CutoutRow, type ReviewAction } from "@/lib/media-cutouts";

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
      {isAdmin && held && !isLocked(row.status) && (
        <Button size="sm" variant="outline" disabled={busy || inFlight} onClick={() => onAct(row, "override_cap")}>
          Allow one more paid call
        </Button>
      )}
    </div>
  );
}
