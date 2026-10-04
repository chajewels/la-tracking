/**
 * Durable, resumable walks over Square's time-windowed lists (close-out QC06 /
 * QC07, 2026-10-05). Used by square-reconcile for the Events API and refund
 * discovery. The checkpoint lives in square_sync_state (service role only).
 */
type Rec = Record<string, unknown>;
// deno-lint-ignore no-explicit-any
type Db = any;

/** Reads a checkpoint (null when never written). */
export async function getState(db: Db, key: string): Promise<Rec | null> {
  const { data, error } = await db.from("square_sync_state").select("value").eq("key", key).maybeSingle();
  if (error) throw new Error(`square_sync_state read ${key}: ${error.message}`);
  return (data?.value as Rec | undefined) ?? null;
}
/** Writes a checkpoint; a failed write throws (the stream then stops without advancing). */
export async function putState(db: Db, key: string, value: Rec): Promise<void> {
  const { error } = await db.from("square_sync_state").upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw new Error(`square_sync_state write ${key}: ${error.message}`);
}

export interface StreamResult { pages: number; items: number; through: string | null; truncated: boolean; history_gap: string | null }

/**
 * Walks a time-windowed, paginated Square list from a durable checkpoint:
 * { through } = everything before it is ingested; while a window is half read,
 * { window_begin, window_end, cursor } resume it exactly. Each page's items are
 * handled (durably) BEFORE the checkpoint moves, so a crash re-reads a page
 * (duplicates are ignored downstream) and never skips one. Windows overlap a
 * little; older than retentionMs is unavailable and reported (history_gap).
 */
export async function walkStream(db: Db, key: string, o: {
  firstLookbackMs: number; overlapMs: number; windowMs: number; retentionMs?: number; maxPages: number;
  fetch: (begin: string, end: string, cursor: string | null) => Promise<{ items: Rec[]; cursor: string | null }>;
  handle: (item: Rec) => Promise<void>;
}): Promise<StreamResult> {
  const state = (await getState(db, key)) ?? {};
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  let historyGap: string | null = null;
  let begin: number, end: number, cursor: string | null;
  if (typeof state.cursor === "string" && typeof state.window_begin === "string" && typeof state.window_end === "string") {
    begin = Date.parse(state.window_begin); end = Date.parse(state.window_end); cursor = state.cursor;
  } else {
    const through = typeof state.through === "string" ? Date.parse(state.through) : now - o.firstLookbackMs;
    begin = through - o.overlapMs;
    if (o.retentionMs && begin < now - o.retentionMs) { historyGap = iso(begin); begin = now - o.retentionMs; }
    end = Math.min(now, begin + o.windowMs);
    cursor = null;
  }
  let through = typeof state.through === "string" ? state.through : null;
  let pages = 0, items = 0;
  while (pages < o.maxPages) {
    const page = await o.fetch(iso(begin), iso(end), cursor);
    for (const it of page.items) { await o.handle(it); items++; }
    pages++;
    if (page.cursor) {
      cursor = page.cursor;
      await putState(db, key, { through, window_begin: iso(begin), window_end: iso(end), cursor, history_gap: historyGap });
      continue;
    }
    through = iso(end);
    cursor = null;
    await putState(db, key, { through, cursor: null, history_gap: historyGap });
    if (end >= Date.now() - 1000) return { pages, items, through, truncated: false, history_gap: historyGap };
    begin = end - o.overlapMs;
    end = Math.min(Date.now(), begin + o.windowMs);
  }
  return { pages, items, through, truncated: true, history_gap: historyGap };
}

