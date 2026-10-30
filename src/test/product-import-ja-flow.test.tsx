import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as XLSX from "xlsx";

/**
 * The actual spreadsheet import flow: a real .xlsx is built in memory, uploaded
 * through the dialog's file input, previewed and imported. Supabase is an
 * in-memory model (it evaluates the filters the Hub sends) and translation is a
 * deterministic mock: no network, no live AI, no real database.
 */

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  writes: [] as Array<{ table: string; op: string; values: Row; matched: number }>,
  beforeFill: null as null | (() => void),
  failFill: null as null | string,
  toast: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", async () => {
  const { parseOr } = await import("@/test/helpers/ja-table");
  const builder = (table: string) => {
    let op: "select" | "update" | "insert" | "delete" = "select";
    let values: Row = {};
    const preds: Array<(r: Row) => boolean> = [];
    const b: Record<string, unknown> = {};
    const exec = () => {
      const all = h.db[table] ?? (h.db[table] = []);
      const guardedFill = table === "website_products" && op === "update" && preds.length > 1;
      if (guardedFill) {
        h.beforeFill?.();
        if (h.failFill) throw new Error(h.failFill);
      }
      const hit = all.filter((r) => preds.every((p) => p(r)));
      if (op === "update") { for (const r of hit) Object.assign(r, values); h.writes.push({ table, op, values, matched: hit.length }); }
      if (op === "insert") { const r = { id: `new-${table}-${all.length + 1}`, ...values }; all.push(r); h.writes.push({ table, op, values, matched: 1 }); return [r]; }
      if (op === "delete") { h.writes.push({ table, op, values: {}, matched: hit.length }); return []; }
      return hit.map((r) => ({ ...r }));
    };
    b.select = () => b;
    b.update = (v: Row) => { op = "update"; values = v; return b; };
    b.insert = (v: Row | Row[]) => { op = "insert"; values = (Array.isArray(v) ? v[0] : v) as Row; return b; };
    b.delete = () => { op = "delete"; return b; };
    b.eq = (c: string, v: unknown) => { preds.push((r) => r[c] !== null && r[c] !== undefined && r[c] === v); return b; };
    b.or = (s: string) => { const t = parseOr(s); preds.push((r) => t.some((p) => p(r as never))); return b; };
    for (const m of ["order", "limit", "in"]) b[m] = () => b;
    b.maybeSingle = async () => ({ data: exec()[0] ?? null, error: null });
    b.single = async () => ({ data: exec()[0] ?? null, error: null });
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
      let out: { data: unknown; error: { message: string } | null };
      try { out = { data: exec(), error: null }; } catch (e) { out = { data: null, error: { message: (e as Error).message } }; }
      return Promise.resolve(out).then(res, rej);
    };
    return b;
  };
  return { supabase: { from: (t: string) => builder(t), auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) } } };
});
vi.mock("@/hooks/use-toast", () => ({ toast: h.toast }));

import ProductImportDialog from "@/components/website/ProductImportDialog";
import { DATA_START_ROW, SHEET_NAME } from "@/lib/website-catalog-import";

const HEADER = [
  "buy_code", "product_name", "product_description", "price", "cost", "stock_amount", "hub_jewelry_type", "hub_metal",
  "hub_weight_g", "hub_stone", "hub_size", "hub_condition", "hub_status", "hub_origin", "hub_brand",
  "collection_slugs", "category_slugs", "hub_sale_price",
];
const sheetRow = (sku: string, name: string, desc: string) =>
  [sku, name, desc, "10000", "", "1", "rings", "K18", "3.2", "", "", "New", "Draft", "Japan", "", "", "", ""];

function workbookFile(rows: string[][]) {
  const grid: string[][] = [HEADER, ["guide"], ["guide"], ["guide"], ...rows];
  expect(grid.length - rows.length + 1).toBe(DATA_START_ROW);
  const ws = XLSX.utils.aoa_to_sheet(grid);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, SHEET_NAME);
  const bytes = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return new File([bytes], "products.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

const product = (id: string, sku: string, name: string, name_ja: string | null, description_ja: string | null): Row => ({
  id, sku, slug: id, name, name_ja, description_en: "Old English", description_ja,
});
const rowOf = (id: string) => h.db.website_products.find((r) => r.id === id)!;
const translate = vi.fn(async (a: { name?: string; description?: string }) => ({
  name_ja: a.name ? `JA(${a.name})` : "", description_ja: a.description ? `JA(${a.description})` : "",
}));

async function runImport(rows: string[][]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={qc}>
      <ProductImportDialog
        collections={[{ id: "col-rings", name: "Rings", slug: "rings" }]} categories={[]} isAdmin
        translate={translate as never}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /Upload spreadsheet/ }));
  const input = await waitFor(() => {
    const el = document.querySelector('input[type="file"]');
    if (!el) throw new Error("no file input");
    return el as HTMLInputElement;
  });
  fireEvent.change(input, { target: { files: [workbookFile(rows)] } });
  const go = await screen.findByRole("button", { name: /^Import \d+ rows?$/ });
  fireEvent.click(go);
  await waitFor(() => expect(h.toast.mock.calls.some((c) => /Import complete|failed to save/.test((c[0] as { title: string }).title))).toBe(true));
  void container;
}
const productUpdates = () => h.writes.filter((w) => w.table === "website_products" && w.op === "update");
const lastToast = () => h.toast.mock.calls.map((c) => c[0] as { title: string; description?: string }).find((t) => t.title === "Import complete" || /failed to save/.test(t.title))!;

beforeEach(() => {
  h.writes.length = 0; h.beforeFill = null; h.failFill = null; h.toast.mockClear(); translate.mockClear();
  h.db = {
    website_products: [
      product("p1", "SKU1", "Old name 1", "既存の名前", "既存の説明"),   // fully Japanese: must stay untouched
      product("p2", "SKU2", "Old name 2", null, "   "),                 // missing name, whitespace description
      product("p3", "SKU3", "Old name 3", "", null),                   // used for concurrency / failure cases
    ],
    website_product_variants: [], website_product_media: [], website_collection_products: [], website_category_products: [],
    website_import_batches: [],
  };
});

describe("spreadsheet import → Japanese fields", () => {
  it("an existing product's update omits every Japanese field and keeps its Japanese; the sheet's English wins", async () => {
    await runImport([sheetRow("SKU1", "Changed English name", "Changed English description")]);
    const [main] = productUpdates();
    expect(main.values).not.toHaveProperty("name_ja");
    expect(main.values).not.toHaveProperty("description_ja");
    expect(main.values).toMatchObject({ name: "Changed English name", description_en: "Changed English description" });
    expect(translate).not.toHaveBeenCalled();
    expect(productUpdates()).toHaveLength(1);
    expect(rowOf("p1")).toMatchObject({ name_ja: "既存の名前", description_ja: "既存の説明" });
    expect(lastToast().title).toBe("Import complete");
  });

  it("missing Japanese (null / whitespace-only) is filled afterwards by guarded writes, not in the main update", async () => {
    await runImport([sheetRow("SKU2", "New name 2", "New description 2")]);
    const updates = productUpdates();
    expect(updates[0].values).not.toHaveProperty("name_ja");
    expect(updates[0].values).not.toHaveProperty("description_ja");
    expect(updates.slice(1).map((u) => Object.keys(u.values))).toEqual([["name_ja"], ["description_ja"]]);
    expect(rowOf("p2")).toMatchObject({ name_ja: "JA(New name 2)", description_ja: "JA(New description 2)" });
    expect(lastToast().description).not.toMatch(/Japanese not filled/);
  });

  it("a new product receives the generated Japanese in its insert", async () => {
    await runImport([sheetRow("SKU9", "Brand new", "Brand new description")]);
    const ins = h.writes.find((w) => w.table === "website_products" && w.op === "insert")!;
    expect(ins.values).toMatchObject({ name_ja: "JA(Brand new)", description_ja: "JA(Brand new description)" });
  });

  it("a Japanese name filled meanwhile is kept, and the toast says which column was not filled and why", async () => {
    h.beforeFill = () => { if (!rowOf("p3").name_ja) rowOf("p3").name_ja = "別の人の入力"; };
    await runImport([sheetRow("SKU3", "Name 3", "Description 3")]);
    expect(rowOf("p3").name_ja).toBe("別の人の入力");
    expect(rowOf("p3").description_ja).toBe("JA(Description 3)");
    const t = lastToast();
    expect(t.title).toBe("Import complete");
    expect(t.description).toContain("Japanese not filled (kept as it was): SKU3 name_ja (has_value)");
    expect(t.description).not.toContain("description_ja");
  });

  it("a guarded-fill database failure is reported per column; the row still counts as updated", async () => {
    h.failFill = "permission denied";
    await runImport([sheetRow("SKU3", "Name 3", "Description 3")]);
    const t = lastToast();
    expect(t.title).toBe("Import complete");
    expect(t.description).toContain("1 updated");
    expect(t.description).toContain("SKU3 name_ja (database_error), SKU3 description_ja (database_error)");
    expect(rowOf("p3")).toMatchObject({ name_ja: "", description_ja: null, name: "Name 3" });
  });

  it("an English change while it translated is reported as such and writes no Japanese", async () => {
    translate.mockImplementationOnce(async (a) => {
      rowOf("p3").name = "Renamed elsewhere";            // before the import's own update runs…
      return { name_ja: `JA(${a.name})`, description_ja: `JA(${a.description})` };
    });
    h.beforeFill = () => { rowOf("p3").name = "Renamed elsewhere again"; }; // …and again just before the guarded fill
    await runImport([sheetRow("SKU3", "Name 3", "Description 3")]);
    expect(rowOf("p3").name_ja).toBe("");
    expect(lastToast().description).toContain("SKU3 name_ja (source_changed)");
  });

  it("a failed translation fails only that row and writes nothing for it", async () => {
    translate.mockRejectedValueOnce(new Error("rate limit"));
    await runImport([sheetRow("SKU3", "Name 3", "Description 3"), sheetRow("SKU1", "Other", "Other description")]);
    const t = lastToast();
    expect(t.title).toBe("1 row failed to save");
    expect(t.description).toContain("Japanese translation failed: rate limit");
    expect(rowOf("p3")).toMatchObject({ name: "Old name 3", name_ja: "" });
    expect(rowOf("p1").name).toBe("Other");
  });
});
