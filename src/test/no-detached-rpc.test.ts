import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// supabase-js's rpc() is a METHOD that reads `this.rest`. Storing it anywhere
// (`const rpc = supabase.rpc`, `{ rpc } = supabase`, `rpc: supabase.rpc`)
// detaches it, and every call then throws "Cannot read properties of undefined
// (reading 'rest')" before a request goes out. It shipped twice: the sidebar
// status pills (6f0ba5d0) and Page365 Create drafts / Catalog Publish.
// Call it on the client, or use callUntypedRpc (src/lib/untyped-rpc.ts).
// See docs/FIXED-BUGS.md.

const RECEIVER = /\b(supabase\w*|\w*[cC]lient)\.rpc\b/g;
const DESTRUCTURE = /\{[^}]*\brpc\b[^}]*\}\s*=\s*(supabase\w*|\w*[cC]lient)\b/;

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

/** Line numbers where a client's rpc method is referenced without being called on the client. */
function findDetachedRpc(source: string): number[] {
  const src = stripComments(source);
  const lineOf = (i: number) => src.slice(0, i).split("\n").length;
  const hits: number[] = [];
  for (const m of src.matchAll(RECEIVER)) {
    const start = m.index!;
    const after = src.slice(start + m[0].length);
    if (/^\s*[(<]/.test(after)) continue; // supabase.rpc(...) / supabase.rpc<T>(...)
    if (/^\s+as\b/.test(after)) {
      // (supabase.rpc as X)(...) keeps `this`: the cast is erased to (supabase.rpc)(...).
      const before = src.slice(0, start).replace(/\s+$/, "");
      if (before.endsWith("(")) {
        let depth = 1;
        let j = start;
        while (j < src.length && depth > 0) {
          const ch = src[j++];
          if (ch === "(") depth++;
          else if (ch === ")") depth--;
        }
        if (depth === 0 && /^\s*\(/.test(src.slice(j))) continue;
      }
    }
    hits.push(lineOf(start));
  }
  for (const m of src.matchAll(new RegExp(DESTRUCTURE, "g"))) hits.push(lineOf(m.index!));
  return hits;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("no supabase.rpc is detached from its client", () => {
  it("the checker flags the detached forms", () => {
    expect(findDetachedRpc("const rpc = supabase.rpc;")).toEqual([1]);
    expect(findDetachedRpc("const rpc = supabase.rpc as unknown as <T>(\n  fn: string,\n) => Promise<T>;")).toEqual([1]);
    expect(findDetachedRpc("const rpc = (supabase.rpc as unknown as Fn);")).toEqual([1]);
    expect(findDetachedRpc("const r = client.rpc.bind(client);")).toEqual([1]);
    expect(findDetachedRpc("const o = { rpc: supabase.rpc };")).toEqual([1]);
    expect(findDetachedRpc("const { rpc } = supabase;")).toEqual([1]);
  });

  it("the checker accepts calls on the client", () => {
    expect(findDetachedRpc("await supabase.rpc('x', {});")).toEqual([]);
    expect(findDetachedRpc("await supabase.rpc<T>('x');")).toEqual([]);
    expect(findDetachedRpc("await client.rpc(fn, args);")).toEqual([]);
    expect(findDetachedRpc("await (supabase.rpc as unknown as (\n  fn: string,\n) => P)('x', {});")).toEqual([]);
    expect(findDetachedRpc("(supabase.rpc as any)('audit_all_accounts', undefined, { signal });")).toEqual([]);
    expect(findDetachedRpc("// const rpc = supabase.rpc;\n/* rpc = supabase.rpc */")).toEqual([]);
  });

  it("no file in src/ stores supabase.rpc instead of calling it", () => {
    const self = join("src", "test", "no-detached-rpc.test.ts");
    const offenders: string[] = [];
    for (const f of walk("src")) {
      if (relative(".", f) === self) continue;
      for (const line of findDetachedRpc(readFileSync(f, "utf8"))) offenders.push(`${f}:${line}`);
    }
    expect(offenders, "Call supabase.rpc on the client or use callUntypedRpc (src/lib/untyped-rpc.ts)").toEqual([]);
  });
});
