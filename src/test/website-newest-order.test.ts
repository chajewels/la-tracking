import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { newestFirst } from "../../supabase/functions/_shared/catalog-order.ts";

/**
 * "Newest" means newest (owner 2026-10-27): GET /catalog/collections/:slug and
 * GET /catalog/categories/:slug list their products by
 * website_products.created_at descending, ties by id ascending (the Hub
 * catalog list's own order). The storefront builds "Oldest" by reversing the
 * list, so the order must be total. Contract: supabase/contracts/api.md.
 */

const src = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");
const INDEX = "supabase/functions/website/index.ts";

/** The source of one route block in website/index.ts, from its comment to the next route. */
function route(header: string): string {
  const text = src(INDEX);
  const start = text.indexOf(header);
  expect(start).toBeGreaterThan(-1);
  const end = text.indexOf("\n    // GET ", start + header.length);
  return text.slice(start, end === -1 ? undefined : end);
}

const p = (id: string, created_at: unknown, name = id) => ({ id, created_at, name });
const ids = (list: { id: unknown }[]) => list.map((x) => x.id);

describe("newestFirst", () => {
  it("puts the most recently added product first", () => {
    const list = [
      p("a", "2026-09-01T00:00:00+00:00"),
      p("b", "2026-10-20T08:00:00+00:00"),
      p("c", "2026-10-01T12:30:00.5+00:00"),
    ];
    expect(ids(newestFirst(list))).toEqual(["b", "c", "a"]);
  });

  it("breaks a created_at tie by id ascending, whatever order the rows arrive in", () => {
    const at = "2026-09-08T12:00:00+00:00";
    const forward = [p("3", at), p("1", at), p("2", at)];
    const backward = [...forward].reverse();
    expect(ids(newestFirst(forward))).toEqual(["1", "2", "3"]);
    expect(ids(newestFirst(backward))).toEqual(["1", "2", "3"]);
  });

  it("compares instants, not strings, across offsets", () => {
    const list = [p("utc", "2026-10-01T00:30:00+00:00"), p("pht", "2026-10-01T08:00:00+08:00")];
    // 08:00+08 is 00:00 UTC — thirty minutes BEFORE the other one.
    expect(ids(newestFirst(list))).toEqual(["utc", "pht"]);
  });

  it("ignores the name: the old sort_order-then-name order is gone", () => {
    const list = [p("x", "2026-10-02T00:00:00+00:00", "Aaa ring"), p("y", "2026-10-03T00:00:00+00:00", "Zzz ring")];
    expect(ids(newestFirst(list))).toEqual(["y", "x"]);
  });

  it("puts a product with no readable created_at last, still ordered by id", () => {
    const list = [p("n2", null), p("ok", "2026-10-01T00:00:00+00:00"), p("n1", "not a date")];
    expect(ids(newestFirst(list))).toEqual(["ok", "n1", "n2"]);
  });

  it("returns a new array and leaves the input untouched", () => {
    const list = [p("a", "2026-01-01T00:00:00+00:00"), p("b", "2026-02-01T00:00:00+00:00")];
    const out = newestFirst(list);
    expect(out).not.toBe(list);
    expect(ids(list)).toEqual(["a", "b"]);
  });

  it("is total: reversing the result is exactly oldest first", () => {
    const list = [
      p("d", "2026-10-01T00:00:00+00:00"), p("b", "2026-10-01T00:00:00+00:00"),
      p("a", "2026-11-01T00:00:00+00:00"), p("c", "2026-09-01T00:00:00+00:00"),
    ];
    const newest = ids(newestFirst(list));
    expect(newest).toEqual(["a", "b", "d", "c"]);
    expect([...newest].reverse()).toEqual(["c", "d", "b", "a"]);
  });
});

describe.each([
  ["GET /catalog/collections/:slug", "// GET /catalog/collections/:slug", "website_collection_products"],
  ["GET /catalog/categories/:slug", "// GET /catalog/categories/:slug", "website_category_products"],
])("%s (website/index.ts)", (_name, header, table) => {
  const block = route(header);

  it("reads created_at with each product and orders with newestFirst", () => {
    expect(block).toContain(`.from("${table}")`);
    expect(block).toMatch(/website_products\(\$\{PRODUCT_SELECT\}, created_at\)/);
    expect(block).toMatch(/newestFirst\(/);
  });

  it("no longer orders by the link table's sort column or by name", () => {
    expect(block).not.toMatch(/\.order\("sort(_order)?"/);
    expect(block).not.toMatch(/localeCompare/);
  });

  it("drops created_at before shaping, so the product payload is unchanged", () => {
    expect(block).toMatch(/delete \w+\.created_at/);
  });
});

describe("the hero order is untouched", () => {
  it("the category route still attaches hero_place from hero_lineup_rows", () => {
    expect(route("// GET /catalog/categories/:slug")).toContain("await attachHeroPlaces(supabase, shaped, (category as AnyRec).id);");
  });
});
