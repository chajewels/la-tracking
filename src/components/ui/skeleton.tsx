import { cn } from "@/lib/utils";

/**
 * Deco Ledger shimmer skeleton — warm gradient sweep on surface-2.
 * Falls back to a static tinted block under prefers-reduced-motion
 * (see .skeleton-shimmer in index.css).
 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("skeleton-shimmer rounded-md", className)} {...props} />;
}

export { Skeleton };
