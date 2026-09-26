// Rules shared by the cut-out worker and the Hub (docs/MEDIA-CUTOUTS.md).
// The SQL in 20261005100000_media_cutouts.sql is the authority; this is its
// TS mirror, pinned by src/test/media-cutouts.test.ts. No imports.

export type CutoutMode = "off" | "test" | "on";

/** Fail-closed: anything but the exact strings "test" / "on" is OFF. */
export function readCutoutMode(value: unknown): CutoutMode {
  return value === "test" || value === "on" ? value : "off";
}

/** Fail-closed: anything but a whole number 0–999999 is 0 (nothing submitted). */
export function readCutoutCap(value: unknown): number {
  const s = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
  return /^[0-9]{1,6}$/.test(s) ? Number(s) : 0;
}

/** Provider calls left this month. */
export function capLeft(cap: number, used: number): number {
  return Math.max(0, cap - used);
}

/** The single 80 % bell (SQL: used * 5 >= cap * 4). */
export function shouldRingCapBell(used: number, cap: number, alreadyRung: boolean): boolean {
  return !alreadyRung && cap > 0 && used * 5 >= cap * 4;
}

/** Only our own website photos are processed — never our derived files. */
export const SOURCE_URL_RE = /^https:\/\/[^/]+\/storage\/v1\/object\/public\/promotions\/website\//;
export const DERIVED_RE = /\/promotions\/website\/derived\//;
export function isCutoutSource(url: string | null | undefined): boolean {
  return !!url && SOURCE_URL_RE.test(url) && !DERIVED_RE.test(url);
}

/** Where staff upload their own cut-out (the review RPC accepts only this). */
export const OWN_CUTOUT_RE =
  /^https:\/\/[^/]+\/storage\/v1\/object\/public\/promotions\/website\/derived\/own\/[A-Za-z0-9_.-]+\.(png|webp)$/;

export const BUCKET = "promotions";

/**
 * Derived files for one run. Keyed by the ORIGINAL's bytes (sha-256) so the
 * same photo used twice is stored once, and by run so a re-run never
 * overwrites what a cache may be serving.
 */
export function derivedPaths(sha256: string, run: number) {
  const dir = `website/derived/${sha256.slice(0, 32)}/r${run}`;
  return {
    master: `${dir}/master.png`,
    cutout: `${dir}/cutout.webp`,
    catalog: `${dir}/catalog.webp`,
    catalogSmall: `${dir}/catalog-small.webp`,
  };
}

/** The storage path inside the bucket for one of our public URLs. */
export function storagePathOf(publicUrl: string): string | null {
  const m = publicUrl.match(/\/storage\/v1\/object\/public\/promotions\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** 1 try + 3 retries (SQL media_cutout_error): 5 min → 30 min → 3 h, then failed. */
export const MAX_RETRIES = 3;
export const RETRY_BACKOFF_MINUTES = [5, 30, 180] as const;

/** Per tick. Submissions are also capped by the monthly cap. */
export const TICK = {
  submit: 8,
  poll: 20,
  process: 6,
  housekeeping: 20,
  leaseSeconds: 110,
  /** Stop starting new work after this much wall time (cron fires every 2 min). */
  budgetMs: 90_000,
} as const;
