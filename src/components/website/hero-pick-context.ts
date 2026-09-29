import { createContext } from "react";
import type { CutoutRow } from "@/lib/media-cutouts";

/**
 * "Use on hero" (migration 20261013100000). MediaCutoutReviewCard provides the
 * handler; CutoutActionButtons (row and zoom viewer) shows the tick. Without a
 * provider, or before the migration (no hero_pick on the row), the tick is not
 * shown. ADMIN only (the database checks the role again); other roles see it
 * read-only. pendingUrl = the photo whose tick is being saved.
 */
export interface HeroPickControl {
  onPick: (row: CutoutRow, pick: boolean) => void;
  pendingUrl: string | null;
  isAdmin: boolean;
}
export const HeroPickContext = createContext<HeroPickControl | null>(null);
