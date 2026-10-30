import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

/**
 * Behavioral tests for the Japanese NAME paths of the catalog (Save, the
 * bulk "Generate missing Japanese names", and the Save / explicit-translation
 * interlock) against a stateful in-memory database that evaluates the
 * PostgREST filters the Hub sends. Translation and database are mocked; nothing
 * leaves the process. The database is a model of PostgREST, not PostgREST.
 */

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  db: { website_products: [] as Row[] } as Record<string, Row[]>,
  writes: [] as Array<{ table: string; op: string; values: Row; matched: number }>,
  beforeWrite: null as null | ((table: string, op: string) => void),
  failUpdate: null as null | ((values: Record<string, unknown>) => string | null),
  translate: vi.fn(),
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
      h.beforeWrite?.(table, op);
      const all = h.db[table] ?? (h.db[table] = []);
      const hit = all.filter((r) => preds.every((p) => p(r)));
      if (op === "update") { const why = h.failUpdate?.(values); if (why) throw new Error(why); for (const r of hit) Object.assign(r, values); h.writes.push({ table, op, values, matched: hit.length }); }
      if (op === "insert") { const r = { id: `new-${all.length + 1}`, ...values }; all.push(r); h.writes.push({ table, op, values, matched: 1 }); return [r]; }
      if (op === "delete") { h.writes.push({ table, op, values: {}, matched: hit.length }); return []; }
      // Reads return copies: the app must not see later database changes through a shared reference.
      return table === "website_products" || op !== "select" ? hit.map((r) => (op === "select" ? { ...r } : r)) : [];
    };
    b.select = () => b;
    b.update = (v: Row) => { op = "update"; values = v; return b; };
    b.insert = (v: Row) => { op = "insert"; values = v; return b; };
    b.delete = () => { op = "delete"; return b; };
    b.eq = (c: string, v: unknown) => { preds.push((r) => r[c] !== null && r[c] !== undefined && r[c] === v); return b; };
    b.or = (s: string) => { const t = parseOr(s); preds.push((r) => t.some((p) => p(r as never))); return b; };
    for (const m of ["order", "limit", "range", "in", "neq"]) b[m] = () => b;
    b.maybeSingle = async () => ({ data: exec()[0] ?? null, error: null });
    b.single = async () => ({ data: exec()[0] ?? null, error: null });
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
        let out: { data: unknown; error: { message: string } | null };
      try { out = { data: exec(), error: null }; } catch (e) { out = { data: null, error: { message: (e as Error).message } }; }
      return Promise.resolve(out).then(res, rej);
    };
    return b;
  };
  return { supabase: { from: (t: string) => builder(t), storage: { from: () => ({}) }, functions: { invoke: vi.fn() } } };
});
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ roles: ["admin"] }) }));
vi.mock("@/contexts/PermissionsContext", () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock("@/hooks/use-toast", () => ({ toast: h.toast }));
vi.mock("@/components/website/translate", () => ({ translateJa: h.translate }));
vi.mock("@/components/website/ProductImportDialog", () => ({ default: () => null }));
vi.mock("@/components/website/CategoriesCard", () => ({ CATEGORIES_QUERY_KEY: ["website-categories"], fetchCategories: async () => [] }));
vi.mock("@/lib/page365-inventory-api", () => ({ fetchHiddenByPage365: async () => new Map() }));
// The dialog is replaced by a probe exposing exactly what ProductsCard hands it.
vi.mock("@/components/website/ProductDialog", () => ({
  default: (p: {
    open: boolean; form: { name: string; name_ja: string; description_ja: string }; saving: boolean; translating: boolean;
    translatingName?: boolean; onSave: () => void; onRegenerateJapaneseName?: () => void; onTranslateDescription: () => void;
    setForm: (f: (x: Record<string, unknown>) => Record<string, unknown>) => void;
  }) => p.open ? (
    <div data-testid="dlg" data-saving={String(p.saving)} data-translating={String(p.translating)} data-translating-name={String(!!p.translatingName)}>
      <output data-testid="f-name">{p.form.name}</output>
      <output data-testid="f-name-ja">{p.form.name_ja}</output>
      <output data-testid="f-desc-ja">{p.form.description_ja}</output>
      <button onClick={p.onSave}>save</button>
      <button onClick={() => p.onRegenerateJapaneseName?.()}>regen</button>
      <button onClick={p.onTranslateDescription}>regen-desc</button>
      <button onClick={() => p.setForm((f) => ({ ...f, description_ja: "手書き" }))}>type-desc</button>
    </div>
  ) : null,
}));

import ProductsCard from "@/components/website/ProductsCard";

const product = (id: string, name: string, name_ja: string | null, extra: Row = {}): Row => ({
  id, name, sku: id.toUpperCase(), slug: id, status: "draft", name_ja, metals: ["K18"], karat: null, condition: "New", origin: "JAPAN",
  item_kind: "jewelry", brand: null, weight_g: null, description_en: "Nice", description_ja: "素敵", page365_sync_disabled: false,
  website_product_variants: [{ id: `v-${id}`, size: null, stone: null, price_jpy: 1000, sale_price_jpy: null, cost_basis: null, stock_qty: 1, sort: 0, website_product_media: [] }],
  website_collection_products: [], website_category_products: [], ...extra,
});
const rowOf = (id: string) => h.db.website_products.find((r) => r.id === id)!;
const productWrites = () => h.writes.filter((w) => w.table === "website_products");

function renderCard(search = "") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[`/website${search}`]}>
      <QueryClientProvider client={qc}><ProductsCard /></QueryClientProvider>
    </MemoryRouter>,
  );
}
const toastTitles = () => h.toast.mock.calls.map((c) => (c[0] as { title: string }).title);
const lastToast = () => h.toast.mock.calls.at(-1)![0] as { title: string; description?: string };

beforeEach(() => {
  h.writes.length = 0; h.beforeWrite = null; h.failUpdate = null;
  h.translate.mockReset(); h.toast.mockReset();
  h.translate.mockImplementation(async (a: { name?: string }) => ({ name_ja: a.name ? `JA(${a.name})` : "", description_ja: "" }));
  vi.stubGlobal("confirm", vi.fn(() => true));
  h.db = { website_products: [
    product("a", "Ring A", null),
    product("b", "Ring B", ""),
    product("c", "Ring C", "   "),
    product("d", "Ring D", "既存のD"),
  ] };
});

describe("Save", () => {
  it("fills a MISSING Japanese name (null) on an existing product, and only that", async () => {
    renderCard("?product=a");
    fireEvent.click(await screen.findByText("save"));
    await waitFor(() => expect(toastTitles()).toContain("Saved"));
    expect(h.translate).toHaveBeenCalledWith({ name: "Ring A", description: undefined });
    expect(rowOf("a").name_ja).toBe("JA(Ring A)");
    expect(rowOf("a")).toMatchObject({ name: "Ring A", sku: "A", slug: "a", description_ja: "素敵" });
  });

  it.each([["b", "Ring B"], ["c", "Ring C"]])("fills an empty / whitespace-only name (%s)", async (id, name) => {
    renderCard(`?product=${id}`);
    fireEvent.click(await screen.findByText("save"));
    await waitFor(() => expect(toastTitles()).toContain("Saved"));
    expect(rowOf(id).name_ja).toBe(`JA(${name})`);
  });

  it("never translates or writes an existing Japanese name", async () => {
    renderCard("?product=d");
    fireEvent.click(await screen.findByText("save"));
    await waitFor(() => expect(toastTitles()).toContain("Saved"));
    expect(h.translate).not.toHaveBeenCalled();
    expect(rowOf("d").name_ja).toBe("既存のD");
    expect(productWrites().every((w) => !("name_ja" in w.values))).toBe(true);
  });

  it("a Japanese name filled meanwhile is kept and the skip is reported, not called success", async () => {
    renderCard("?product=a");
    const btn = await screen.findByText("save");
    h.beforeWrite = (() => { let n = 0; return (t: string, op: string) => { if (t === "website_products" && op === "update" && ++n === 2) rowOf("a").name_ja = "別タブの名前"; }; })();
    fireEvent.click(btn);
    await waitFor(() => expect(toastTitles()).toContain("Saved"));
    expect(rowOf("a").name_ja).toBe("別タブの名前");
    expect(toastTitles()).toContain("Japanese name not generated");
    expect(h.writes.at(-1)).toMatchObject({ matched: 0 });
  });

  it("an English rename while the name translates: the stale Japanese is NOT written", async () => {
    let release!: (v: { name_ja: string; description_ja: string }) => void;
    h.translate.mockImplementation(() => new Promise((r) => { release = r; }));
    renderCard("?product=a");
    fireEvent.click(await screen.findByText("save"));
    await waitFor(() => expect(h.translate).toHaveBeenCalled());
    rowOf("a").name = "Ring A 18K";           // someone renames it in another tab
    await act(async () => { release({ name_ja: "JA(Ring A)", description_ja: "" }); });
    await waitFor(() => expect(toastTitles()).toContain("Japanese name not generated"));
    expect(rowOf("a").name_ja).toBeNull();
    expect(rowOf("a").name).toBe("Ring A 18K");
  });

  it("a failed translation leaves the product saved and the Japanese untouched", async () => {
    h.translate.mockRejectedValue(new Error("rate limit"));
    renderCard("?product=a");
    fireEvent.click(await screen.findByText("save"));
    await waitFor(() => expect(toastTitles()).toContain("Saved"));
    expect(toastTitles()).toContain("Japanese not generated");
    expect(rowOf("a").name_ja).toBeNull();
  });
});

describe("Bulk: Generate missing Japanese names", () => {
  it("fills null, empty and whitespace-only names, skips existing, never touches English or descriptions", async () => {
    renderCard();
    const btn = await screen.findByRole("button", { name: /Generate missing Japanese names \(3\)/ });
    fireEvent.click(btn);
    await waitFor(() => expect(lastToast().title).toMatch(/^Japanese names filled: 3/));
    expect(rowOf("a").name_ja).toBe("JA(Ring A)");
    expect(rowOf("b").name_ja).toBe("JA(Ring B)");
    expect(rowOf("c").name_ja).toBe("JA(Ring C)");
    expect(rowOf("d").name_ja).toBe("既存のD");
    expect(h.translate).toHaveBeenCalledTimes(3);
    for (const w of productWrites()) expect(Object.keys(w.values)).toEqual(["name_ja"]);
    expect(lastToast().title).toContain("Already had one: 1");
  });

  it("reports every outcome in its own bucket and the buckets add up to the products seen", async () => {
    h.db.website_products.push(
      product("e", "Ring E", null), product("f", "Ring F", null),
      product("g", "", null),                 // no English name: nothing to translate
      product("h", "Ring H", null),           // removed while translating
      product("i", "Ring I", null),           // changed to a different whitespace value while translating
    );
    h.translate.mockImplementation(async (a: { name: string }) => {
      if (a.name === "Ring B") throw new Error("rate limit");
      if (a.name === "Ring A") rowOf("a").name_ja = "同時入力";                       // filled meanwhile
      if (a.name === "Ring C") rowOf("c").name = "Ring C renamed";                   // English changed
      if (a.name === "Ring H") h.db.website_products = h.db.website_products.filter((r) => r.id !== "h");
      if (a.name === "Ring I") rowOf("i").name_ja = "\t\t";                          // matches neither reason
      return { name_ja: `JA(${a.name})`, description_ja: "" };
    });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: /Generate missing Japanese names \(7\)/ }));
    await waitFor(() => expect(lastToast().title).toMatch(/^Japanese names filled/));
    expect(lastToast().title).toBe(
      "Japanese names filled: 2 of 9 products. Already had one: 2. No English name: 1. English changed meanwhile: 1. "
      + "Product removed: 1. Not eligible: 1. Translation failed: 1. Database failed: 0.",
    );
    // 2 + 2 + 1 + 1 + 1 + 1 + 1 + 0 = 9
    expect(rowOf("a").name_ja).toBe("同時入力");
    expect(rowOf("b").name_ja).toBe("");
    expect(rowOf("c").name_ja).toBe("   ");
    expect(rowOf("i").name_ja).toBe("\t\t");
    expect(rowOf("e").name_ja).toBe("JA(Ring E)");
    expect(rowOf("f").name_ja).toBe("JA(Ring F)");
    expect(rowOf("g").name_ja).toBeNull();
    expect(lastToast().description).toContain("B: rate limit");
  });

  it("a database failure is its own bucket and nothing is written for that product", async () => {
    h.failUpdate = (v) => ("name_ja" in v && v.name_ja === "JA(Ring B)" ? "permission denied" : null);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: /Generate missing Japanese names \(3\)/ }));
    await waitFor(() => expect(lastToast().title).toMatch(/^Japanese names filled/));
    expect(lastToast().title).toBe(
      "Japanese names filled: 2 of 4 products. Already had one: 1. No English name: 0. English changed meanwhile: 0. "
      + "Product removed: 0. Not eligible: 0. Translation failed: 0. Database failed: 1.",
    );
    expect(lastToast().description).toContain("permission denied");
    expect(rowOf("b").name_ja).toBe("");
  });

  it("declining the confirmation changes nothing and calls no translation", async () => {
    vi.stubGlobal("confirm", vi.fn(() => false));
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: /Generate missing Japanese names/ }));
    await Promise.resolve();
    expect(h.translate).not.toHaveBeenCalled();
    expect(productWrites()).toHaveLength(0);
  });
});

describe("Save and explicit translation never race", () => {
  it("Save while the Japanese name is translating is refused; the unsaved edit survives; the result then applies", async () => {
    let release!: (v: { name_ja: string; description_ja: string }) => void;
    h.translate.mockImplementation(() => new Promise((r) => { release = r; }));
    renderCard("?product=d");
    await screen.findByTestId("dlg");
    fireEvent.click(screen.getByText("type-desc"));
    fireEvent.click(screen.getByText("regen"));
    await waitFor(() => expect(screen.getByTestId("dlg").dataset.translatingName).toBe("true"));
    fireEvent.click(screen.getByText("save"));
    expect(toastTitles()).toContain("Translation in progress");
    expect(productWrites()).toHaveLength(0);
    expect(screen.getByTestId("f-desc-ja").textContent).toBe("手書き");
    await act(async () => { release({ name_ja: "新しい名前", description_ja: "" }); });
    await waitFor(() => expect(screen.getByTestId("f-name-ja").textContent).toBe("新しい名前"));
    expect(screen.getByTestId("f-desc-ja").textContent).toBe("手書き");
    expect(rowOf("d").name_ja).toBe("既存のD");        // nothing saved yet
    fireEvent.click(screen.getByText("save"));
    await waitFor(() => expect(toastTitles()).toContain("Saved"));
    expect(rowOf("d").name_ja).toBe("新しい名前");
  });

  it("Save while the description translates is refused too", async () => {
    let release!: (v: { name_ja: string; description_ja: string }) => void;
    h.translate.mockImplementation(() => new Promise((r) => { release = r; }));
    renderCard("?product=d");
    await screen.findByTestId("dlg");
    fireEvent.click(screen.getByText("regen-desc"));
    await waitFor(() => expect(screen.getByTestId("dlg").dataset.translating).toBe("true"));
    fireEvent.click(screen.getByText("save"));
    expect(toastTitles()).toContain("Translation in progress");
    expect(productWrites()).toHaveLength(0);
    await act(async () => { release({ name_ja: "", description_ja: "新訳" }); });
  });

  it("explicit translation is ignored while a Save is running", async () => {
    let release!: (v: { name_ja: string; description_ja: string }) => void;
    h.translate.mockImplementation(() => new Promise((r) => { release = r; }));
    renderCard("?product=a");
    fireEvent.click(await screen.findByText("save"));
    await waitFor(() => expect(screen.getByTestId("dlg").dataset.saving).toBe("true"));
    h.translate.mockClear();
    fireEvent.click(screen.getByText("regen"));
    fireEvent.click(screen.getByText("regen-desc"));
    expect(h.translate).not.toHaveBeenCalled();
    await act(async () => { release({ name_ja: "JA(Ring A)", description_ja: "" }); });
    await waitFor(() => expect(toastTitles()).toContain("Saved"));
  });

  it("a stale response after switching product is discarded", async () => {
    let release!: (v: { name_ja: string; description_ja: string }) => void;
    h.translate.mockImplementation(() => new Promise((r) => { release = r; }));
    const { unmount } = renderCard("?product=d");
    await screen.findByTestId("dlg");
    fireEvent.click(screen.getByText("regen"));
    await waitFor(() => expect(h.translate).toHaveBeenCalled());
    unmount();
    expect(rowOf("d").name_ja).toBe("既存のD");
    await act(async () => { release({ name_ja: "遅い結果", description_ja: "" }); });
    expect(rowOf("d").name_ja).toBe("既存のD");
    expect(productWrites()).toHaveLength(0);
  });
});
