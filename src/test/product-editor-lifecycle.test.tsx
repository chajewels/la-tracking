import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

/**
 * The REAL ProductDialog mounted inside the REAL ProductsCard (nothing in the
 * editor is stubbed): Save, translation and editor-session interactions,
 * including closing, reopening and switching products inside ONE mounted
 * component. Supabase is an in-memory model that evaluates the filters the Hub
 * sends; translation is a deterministic mock. No network, no AI, no real
 * database.
 */

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  writes: [] as Array<{ table: string; op: string; values: Row; filters: string[]; matched: number }>,
  hold: null as null | Promise<void>,                 // pauses the product update (a Save "in flight")
  beforeGuardedWrite: null as null | ((values: Row) => void),
  translate: vi.fn(),
  upload: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", async () => {
  const { parseOr } = await import("@/test/helpers/ja-table");
  const builder = (table: string) => {
    let op: "select" | "update" | "insert" | "delete" = "select";
    let values: Row = {};
    const preds: Array<(r: Row) => boolean> = [];
    const filters: string[] = [];
    const b: Record<string, unknown> = {};
    const exec = () => {
      const all = h.db[table] ?? (h.db[table] = []);
      if (table === "website_products" && op === "update" && filters.length > 1) h.beforeGuardedWrite?.(values);
      const hit = all.filter((r) => preds.every((p) => p(r)));
      if (op === "update") { for (const r of hit) Object.assign(r, values); h.writes.push({ table, op, values, filters, matched: hit.length }); }
      if (op === "insert") { const r = { id: `new-${table}-${all.length + 1}`, ...values }; all.push(r); h.writes.push({ table, op, values, filters, matched: 1 }); return [r]; }
      if (op === "delete") { h.writes.push({ table, op, values: {}, filters, matched: hit.length }); return []; }
      return hit.map((r) => ({ ...r }));
    };
    b.select = () => b;
    b.update = (v: Row) => { op = "update"; values = v; return b; };
    b.insert = (v: Row | Row[]) => { op = "insert"; values = (Array.isArray(v) ? v[0] : v) as Row; return b; };
    b.delete = () => { op = "delete"; return b; };
    b.eq = (c: string, v: unknown) => { filters.push(`${c}=eq.${String(v)}`); preds.push((r) => r[c] !== null && r[c] !== undefined && r[c] === v); return b; };
    b.is = (c: string, v: null) => { filters.push(`${c}=is.${v}`); preds.push((r) => (r[c] ?? null) === v); return b; };
    b.or = (s: string) => { filters.push(`or(${s})`); const t = parseOr(s); preds.push((r) => t.some((p) => p(r as never))); return b; };
    for (const m of ["order", "limit", "range", "in", "neq"]) b[m] = () => b;
    b.maybeSingle = async () => ({ data: exec()[0] ?? null, error: null });
    b.single = async () => ({ data: exec()[0] ?? null, error: null });
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => (async () => {
      if (table === "website_products" && op === "update" && h.hold) await h.hold;
      return { data: exec(), error: null };
    })().then(res, rej);
    return b;
  };
  return { supabase: { from: (t: string) => builder(t), storage: { from: () => ({}) }, functions: { invoke: vi.fn() } } };
});
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ roles: ["admin"] }) }));
vi.mock("@/contexts/PermissionsContext", () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock("@/hooks/use-toast", () => ({ toast: h.toast }));
vi.mock("@/components/website/translate", () => ({ translateJa: h.translate }));
vi.mock("@/components/website/HeroImageField", () => ({ uploadWebsiteImage: h.upload, default: () => null }));
vi.mock("@/components/website/ProductImportDialog", () => ({ default: () => null }));
vi.mock("@/components/website/CategoriesCard", () => ({ CATEGORIES_QUERY_KEY: ["website-categories"], fetchCategories: async () => [] }));
vi.mock("@/lib/page365-inventory-api", () => ({ fetchHiddenByPage365: async () => new Map() }));

import ProductsCard from "@/components/website/ProductsCard";

const product = (id: string, name: string, name_ja: string | null, description_ja: string | null): Row => ({
  id, name, sku: id.toUpperCase(), slug: id, status: "active", name_ja, metals: ["K18"], karat: null, condition: "New", origin: "JAPAN",
  item_kind: "jewelry", brand: null, weight_g: null, description_en: "Nice", description_ja, page365_sync_disabled: false,
  website_product_variants: [{ id: `v-${id}`, size: null, stone: null, price_jpy: 1000, sale_price_jpy: null, cost_basis: null, stock_qty: 1, sort: 0, website_product_media: [] }],
  website_collection_products: [{ collection_id: "rings" }], website_category_products: [],
});
const rowOf = (id: string) => h.db.website_products.find((r) => r.id === id)!;
const productUpdates = () => h.writes.filter((w) => w.table === "website_products" && w.op === "update");
const toastTitles = () => h.toast.mock.calls.map((c) => (c[0] as { title: string }).title);
const lastToast = (title: string) => h.toast.mock.calls.map((c) => c[0] as { title: string; description?: string }).filter((t) => t.title === title).at(-1);

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={["/website?open=rings"]}>
      <QueryClientProvider client={qc}><ProductsCard /></QueryClientProvider>
    </MemoryRouter>,
  );
}
const openProduct = async (name: string) => {
  fireEvent.click(await screen.findByText(name));
  await screen.findByText("Edit product");
};
const nameInput = () => screen.getByLabelText("Name") as HTMLInputElement;
const descJa = () => screen.getByLabelText("Description (Japanese)") as HTMLTextAreaElement;
const jaNameField = () => screen.getByLabelText("Name (Japanese, generated)") as HTMLInputElement;
const clickSave = () => fireEvent.click(screen.getByRole("button", { name: /Save product/ }));
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

beforeEach(() => {
  h.writes.length = 0; h.hold = null; h.beforeGuardedWrite = null;
  h.translate.mockReset(); h.toast.mockReset(); h.upload.mockReset();
  h.translate.mockImplementation(async (a: { name?: string; description?: string }) => ({
    name_ja: a.name ? `JA(${a.name})` : "", description_ja: a.description ? `JA(${a.description})` : "",
  }));
  vi.stubGlobal("confirm", vi.fn(() => true));
  h.db = {
    website_collections: [{ id: "rings", name: "Rings", name_ja: null, slug: "rings", sort: 0 }],
    website_products: [
      product("a", "Ring A", null, "素敵A"),
      product("b", "Ring B", "既存のB", null),
      product("d", "Ring D", "既存のD", "既存の説明D"),
    ],
  };
});

describe("Save locks the editor and belongs to its own session", () => {
  it("every field is disabled while a Save is in flight, so nothing typed can be dropped", async () => {
    const gate = deferred<void>(); h.hold = gate.promise;
    renderCard();
    await openProduct("Ring D");
    clickSave();
    await waitFor(() => expect(screen.getByTestId("product-form-fields")).toBeDisabled());
    expect(nameInput()).toBeDisabled();
    expect(descJa()).toBeDisabled();
    expect(screen.getByRole("button", { name: /Regenerate Japanese name/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Translate from English/ })).toBeDisabled();
    await act(async () => { gate.resolve(); });
    await waitFor(() => expect(screen.queryByText("Edit product")).not.toBeInTheDocument());
    expect(toastTitles()).toContain("Saved");
  });

  it("closing and opening ANOTHER product while a Save is pending: the old Save cannot close or change the new editor", async () => {
    const gate = deferred<void>(); h.hold = gate.promise;
    renderCard();
    await openProduct("Ring D");
    fireEvent.change(descJa(), { target: { value: "Dの新しい説明" } });
    clickSave();
    await waitFor(() => expect(screen.getByTestId("product-form-fields")).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Edit product")).not.toBeInTheDocument());
    await openProduct("Ring B");
    expect(nameInput().value).toBe("Ring B");
    fireEvent.change(descJa(), { target: { value: "Bの未保存の説明" } });
    await act(async () => { gate.resolve(); });
    await waitFor(() => expect(toastTitles()).toContain("Saved"));
    // the newer editor is still open, still on Ring B, with its unsaved text intact
    expect(screen.getByText("Edit product")).toBeInTheDocument();
    expect(nameInput().value).toBe("Ring B");
    expect(descJa().value).toBe("Bの未保存の説明");
    expect(rowOf("d").description_ja).toBe("Dの新しい説明");
    expect(rowOf("b").description_ja).toBeNull();
  });

  it("switching straight to another product (editor never closed) is also safe", async () => {
    const gate = deferred<void>(); h.hold = gate.promise;
    renderCard();
    await openProduct("Ring D");
    clickSave();
    await waitFor(() => expect(screen.getByTestId("product-form-fields")).toBeDisabled());
    fireEvent.click(screen.getAllByText("Ring B")[0]);
    await waitFor(() => expect(nameInput().value).toBe("Ring B"));
    await act(async () => { gate.resolve(); });
    await waitFor(() => expect(toastTitles()).toContain("Saved"));
    expect(screen.getByText("Edit product")).toBeInTheDocument();
    expect(nameInput().value).toBe("Ring B");
  });

  it("a translation started in an old editor never lands in, or sticks a spinner on, the next one", async () => {
    const d = deferred<{ name_ja: string; description_ja: string }>();
    h.translate.mockImplementation(() => d.promise);
    renderCard();
    await openProduct("Ring A");
    fireEvent.click(screen.getByRole("button", { name: /Regenerate Japanese name/ }));
    await waitFor(() => expect(h.translate).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Edit product")).not.toBeInTheDocument());
    await openProduct("Ring B");
    await act(async () => { d.resolve({ name_ja: "遅れて届いた名前", description_ja: "" }); });
    expect(jaNameField().value).toBe("既存のB");
    expect(screen.getByRole("button", { name: /Regenerate Japanese name/ })).toBeEnabled();
    expect(toastTitles()).not.toContain("Japanese name updated");
    expect(productUpdates()).toHaveLength(0);
  });

  it("Save is refused while a photo is still uploading", async () => {
    const up = deferred<string>(); h.upload.mockImplementation(() => up.promise);
    renderCard();
    await openProduct("Ring D");
    const input = document.querySelector('input[type="file"][accept="image/*"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "a.jpg", { type: "image/jpeg" })] } });
    await waitFor(() => expect(h.upload).toHaveBeenCalled());
    clickSave();
    expect(toastTitles()).toContain("Photo still uploading");
    expect(productUpdates()).toHaveLength(0);
    await act(async () => { up.resolve("https://example.test/a.jpg"); });
  });
});

describe("a newer Japanese value is never silently overwritten", () => {
  it("name: a replaced name is refused when the stored one changed; the form is kept and no retry happens", async () => {
    renderCard();
    await openProduct("Ring D");
    fireEvent.click(screen.getByRole("button", { name: /Regenerate Japanese name/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace name" }));
    await waitFor(() => expect(jaNameField().value).toBe("JA(Ring D)"));
    fireEvent.change(descJa(), { target: { value: "未保存の説明" } });
    rowOf("d").name_ja = "同僚が書いた名前";                 // written elsewhere after this editor opened
    clickSave();
    await waitFor(() => expect(toastTitles()).toContain("Not saved — changed elsewhere"));
    expect(lastToast("Not saved — changed elsewhere")!.description).toContain("Japanese name was changed by someone else");
    expect(rowOf("d").name_ja).toBe("同僚が書いた名前");
    expect(rowOf("d").description_ja).toBe("既存の説明D");   // nothing at all was written
    expect(productUpdates()).toHaveLength(1);
    expect(productUpdates()[0].matched).toBe(0);
    // the editor is still open and keeps everything the user had
    expect(screen.getByText("Edit product")).toBeInTheDocument();
    expect(jaNameField().value).toBe("JA(Ring D)");
    expect(descJa().value).toBe("未保存の説明");
    await new Promise((r) => setTimeout(r, 30));
    expect(productUpdates()).toHaveLength(1);                // never retried by itself
  });

  it("description: refused when the stored text changed; the typed text stays in the box", async () => {
    renderCard();
    await openProduct("Ring D");
    fireEvent.change(descJa(), { target: { value: "私の新しい説明" } });
    rowOf("d").description_ja = "同僚の説明";
    clickSave();
    await waitFor(() => expect(toastTitles()).toContain("Not saved — changed elsewhere"));
    expect(lastToast("Not saved — changed elsewhere")!.description).toContain("Japanese description was changed by someone else");
    expect(rowOf("d").description_ja).toBe("同僚の説明");
    expect(descJa().value).toBe("私の新しい説明");
    expect(screen.getByText("Edit product")).toBeInTheDocument();
  });

  it("a product deleted meanwhile is reported as gone, not as a conflict over text", async () => {
    renderCard();
    await openProduct("Ring D");
    fireEvent.change(descJa(), { target: { value: "新しい説明" } });
    h.db.website_products = h.db.website_products.filter((r) => r.id !== "d");
    clickSave();
    await waitFor(() => expect(toastTitles()).toContain("Not saved — changed elsewhere"));
    expect(lastToast("Not saved — changed elsewhere")!.description).toContain("no longer exists");
  });

  it("unchanged database: the edit saves, conditional on the value the editor opened with", async () => {
    renderCard();
    await openProduct("Ring D");
    fireEvent.change(descJa(), { target: { value: "  新しい説明D  " } });
    clickSave();
    await waitFor(() => expect(toastTitles()).toContain("Saved"));
    const [u] = productUpdates();
    expect(u.filters).toContain("description_ja=eq.既存の説明D");
    expect(u.values).toMatchObject({ description_ja: "新しい説明D" });      // trimmed: established behaviour, kept
    expect(u.values).not.toHaveProperty("name_ja");
    expect(u.matched).toBe(1);
  });

  it("a Japanese description that was NULL is guarded by IS NULL", async () => {
    renderCard();
    await openProduct("Ring B");
    fireEvent.change(descJa(), { target: { value: "初めての説明" } });
    clickSave();
    await waitFor(() => expect(toastTitles()).toContain("Saved"));
    expect(productUpdates()[0].filters).toContain("description_ja=is.null");
    expect(rowOf("b").description_ja).toBe("初めての説明");
  });

  it("a Save that changes no Japanese column adds no Japanese condition", async () => {
    renderCard();
    await openProduct("Ring D");
    fireEvent.change(nameInput(), { target: { value: "Ring D 18K" } });
    clickSave();
    await waitFor(() => expect(toastTitles()).toContain("Saved"));
    expect(productUpdates()[0].filters).toEqual(["id=eq.d"]);
    expect(rowOf("d").name_ja).toBe("既存のD");
  });
});

describe("a new product's generated description", () => {
  async function newProduct() {
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: /Add product/ }));
    await screen.findByText("New product");
    fireEvent.change(screen.getByLabelText("SKU"), { target: { value: "N1" } });
    fireEvent.change(nameInput(), { target: { value: "Brand new ring" } });
    fireEvent.change(document.querySelectorAll("textarea")[0], { target: { value: "A brand new description" } });
  }
  const created = () => h.db.website_products.find((r) => r.sku === "N1")!;

  it("is written when nothing changed meanwhile", async () => {
    await newProduct();
    clickSave();
    await waitFor(() => expect(toastTitles()).toContain("Saved"));
    expect(created()).toMatchObject({ name_ja: "JA(Brand new ring)", description_ja: "JA(A brand new description)" });
  });

  it("is NOT written over a Japanese description filled meanwhile; it says so", async () => {
    await newProduct();
    h.beforeGuardedWrite = (v) => { if ("description_ja" in v && !created().description_ja) created().description_ja = "別の人が書いた説明"; };
    clickSave();
    await waitFor(() => expect(toastTitles()).toContain("Saved"));
    expect(created().description_ja).toBe("別の人が書いた説明");
    expect(toastTitles()).toContain("Japanese description not generated");
  });

  it("is NOT written when the English description changed meanwhile; it says so", async () => {
    await newProduct();
    h.beforeGuardedWrite = (v) => { if ("description_ja" in v) created().description_en = "Edited elsewhere"; };
    clickSave();
    await waitFor(() => expect(toastTitles()).toContain("Saved"));
    expect(created().description_ja ?? null).toBeNull();
    expect(lastToast("Japanese description not generated")!.description).toContain("English text changed");
  });
});
