import type { FillClient } from "@/components/website/name-ja";

/**
 * An in-memory `website_products` that evaluates the PostgREST filters the Hub
 * sends (`eq`, and `or=(col.is.null,col.eq.,col.eq."x")`) with PostgreSQL
 * semantics (NULL never equals anything, '' equals ''), so a guarded write is
 * exercised for real instead of by reading its source. `beforeWrite` runs
 * between the app's read and its write, which is how a concurrent edit is
 * simulated. This is a model of PostgREST, not PostgREST itself.
 */
export type Row = Record<string, string | null>;

export function parseOr(f: string): Array<(r: Row) => boolean> {
  const parts: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < f.length; i++) {
    const c = f[i];
    if (c === "\\" && q) { cur += f[++i]; continue; }
    if (c === '"') { q = !q; cur += c; continue; }
    if (c === "," && !q) { parts.push(cur); cur = ""; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => {
    const m = /^([a-z_]+)\.(is|eq)\.([\s\S]*)$/.exec(p);
    if (!m) throw new Error(`unsupported or-term ${p}`);
    const [, col, op, rawVal] = m;
    const val = rawVal.startsWith('"') ? rawVal.slice(1, -1) : rawVal;
    return op === "is"
      ? (r: Row) => (val === "null" ? r[col] === null || r[col] === undefined : false)
      : (r: Row) => r[col] !== null && r[col] !== undefined && r[col] === val;
  });
}

export function makeTable(initial: Row[]) {
  const rows = initial.map((r) => ({ ...r }));
  const log: Array<{ op: string; values?: Record<string, unknown>; matched?: number }> = [];
  const hooks: { beforeWrite?: (rows: Row[]) => void; failWrite?: string } = {};

  function filter(kind: "update" | "select", values?: Record<string, unknown>) {
    const preds: Array<(r: Row) => boolean> = [];
    const f: Record<string, unknown> = {};
    f.eq = (c: string, v: string) => { preds.push((r) => r[c] !== null && r[c] === v); return f; };
    f.or = (s: string) => { const t = parseOr(s); preds.push((r) => t.some((p) => p(r))); return f; };
    f.select = () => {
      const run = async () => {
        hooks.beforeWrite?.(rows);
        if (hooks.failWrite) { log.push({ op: kind, values, matched: 0 }); return { data: null, error: { message: hooks.failWrite } }; }
        const hit = rows.filter((r) => preds.every((p) => p(r)));
        for (const r of hit) Object.assign(r, values);
        log.push({ op: kind, values, matched: hit.length });
        return { data: hit.map((r) => ({ id: r.id as string })), error: null };
      };
      const p = run();
      return Object.assign(f, { then: p.then.bind(p) });
    };
    f.maybeSingle = async () => {
      const hit = rows.find((r) => preds.every((p) => p(r)));
      return { data: hit ? { ...hit } : null, error: null };
    };
    return f;
  }

  const client = {
    from: () => ({
      update: (values: Record<string, unknown>) => filter("update", values),
      select: () => filter("select"),
    }),
  } as unknown as FillClient;
  return { rows, log, hooks, client, byId: (id: string) => rows.find((r) => r.id === id)! };
}
