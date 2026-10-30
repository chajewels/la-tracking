import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

/**
 * Editor safety, through the REAL ProductDialog inside the REAL ProductsCard (nothing in the
 * editor is stubbed; the status control and the pickers are the real Radix / cmdk ones, driven
 * with real events): variant preservation, upload ownership, conflict-read failures, Save
 * locking with a picker already open, partial-create recovery, and publication ordering.
 * Supabase is an in-memory model that evaluates the filters the Hub sends and can be made to
 * fail on demand; translation and uploads are deterministic mocks. No network, no AI, no real DB.
 */

type Row = Record<string, unknown>;
type W = { table: string; op: string; values: Row; filters: string[]; matched: number };
const h = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  writes: [] as Array<{ table: string; op: string; values: Row; filters: string[]; matched: number }>,
  hold: null as null | Promise<void>,
  fail: null as null | ((table: string, op: string, values: Row) => string | null),
  failRead: null as null | string,
  translate: vi.fn(),
  upload: vi.fn(),
  video: vi.fn(),
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
      const why = h.fail?.(table, op, values);
      if (why) throw new Error(why);
      if (op === "select" && h.failRead && table === "website_products" && single) throw new Error(h.failRead);
      const hit = all.filter((r) => preds.every((p) => p(r)));
      if (op === "update") { for (const r of hit) Object.assign(r, values); h.writes.push({ table, op, values, filters, matched: hit.length }); }
      if (op === "insert") { const r = { id: `new-${table}-${all.length + 1}`, ...values }; all.push(r); h.writes.push({ table, op, values, filters, matched: 1 }); return [r]; }
      if (op === "delete") { h.writes.push({ table, op, values: {}, filters, matched: hit.length }); h.db[table] = all.filter((r) => !hit.includes(r)); return []; }
      return hit.map((r) => ({ ...r }));
    };
    let single = false;
    b.select = () => b;
    b.update = (v: Row) => { op = "update"; values = v; return b; };
    b.insert = (v: Row | Row[]) => { op = "insert"; values = (Array.isArray(v) ? v[0] : v) as Row; return b; };
    b.delete = () => { op = "delete"; return b; };
    b.eq = (c: string, v: unknown) => { filters.push(`${c}=eq.${String(v)}`); preds.push((r) => r[c] !== null && r[c] !== undefined && r[c] === v); return b; };
    b.is = (c: string, v: null) => { filters.push(`${c}=is.${v}`); preds.push((r) => (r[c] ?? null) === v); return b; };
    b.in = (c: string, v: unknown[]) => { filters.push(`${c}=in.(${v.join(",")})`); preds.push((r) => v.includes(r[c])); return b; };
    b.or = (s: string) => { filters.push(`or(${s})`); const t = parseOr(s); preds.push((r) => t.some((p) => p(r as never))); return b; };
    for (const m of ["order", "limit", "range", "neq"]) b[m] = () => b;
    const one = async () => {
      single = true;
      try { return { data: exec()[0] ?? null, error: null }; } catch (e) { return { data: null, error: { message: (e as Error).message } }; }
    };
    b.maybeSingle = one;
    b.single = one;
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => (async () => {
      if (table === "website_products" && op === "update" && h.hold) await h.hold;
      try { return { data: exec(), error: null }; } catch (e) { return { data: null, error: { message: (e as Error).message } }; }
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
vi.mock("@/lib/product-video", async (orig) => ({ ...(await orig<typeof import("@/lib/product-video")>()), uploadProductVideo: h.video }));
vi.mock("@/components/website/ProductImportDialog", () => ({ default: () => null }));
vi.mock("@/components/website/CategoriesCard", () => ({
  CATEGORIES_QUERY_KEY: ["website-categories"],
  fetchCategories: async () => [{ id: "cat1", name: "Gifts", name_ja: null, slug: "gifts", published: true }],
}));
vi.mock("@/lib/page365-inventory-api", () => ({ fetchHiddenByPage365: async () => new Map() }));

import ProductsCard from "@/components/website/ProductsCard";

// Radix (Select, Popover) needs these in jsdom.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;
Element.prototype.scrollIntoView ??= () => undefined;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;

const variant = (id: string) => ({ id, size: null, stone: null, price_jpy: 1000, sale_price_jpy: null, cost_basis: null, stock_qty: 1, sort: Number(id.slice(-1)) || 0, website_product_media: [] });
const product = (id: string, name: string, over: Row = {}, variantIds: string[] = [`v-${id}0`]): Row => ({
  id, name, sku: id.toUpperCase(), slug: id, status: "active", name_ja: "既存", metals: ["K18"], karat: null, condition: "New", origin: "JAPAN",
  item_kind: "jewelry", brand: null, weight_g: null, description_en: "Nice", description_ja: "素敵", page365_sync_disabled: false,
  website_product_variants: variantIds.map(variant),
  website_collection_products: [{ collection_id: "rings" }], website_category_products: [], ...over,
});
const wr = (): W[] => h.writes;
const productUpdates = () => wr().filter((w) => w.table === "website_products" && w.op === "update");
const toastTitles = () => h.toast.mock.calls.map((c) => (c[0] as { title: string }).title);
const lastToast = (title: string) => h.toast.mock.calls.map((c) => c[0] as { title: string; description?: string }).filter((t) => t.title === title).at(-1);
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

function renderCard(extra = "") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[`/website?open=rings${extra}`]}>
      <QueryClientProvider client={qc}><ProductsCard /></QueryClientProvider>
    </MemoryRouter>,
  );
}
const openProduct = async (name: string) => { fireEvent.click(await screen.findByText(name)); await screen.findByText("Edit product"); };
const cancel = async () => { fireEvent.click(screen.getByRole("button", { name: "Cancel" })); await waitFor(() => expect(screen.queryByText("Edit product")).not.toBeInTheDocument()); };
const nameInput = () => screen.getByLabelText("Name") as HTMLInputElement;
const descJa = () => screen.getByLabelText("Description (Japanese)") as HTMLTextAreaElement;
const clickSave = () => fireEvent.click(screen.getByRole("button", { name: /Save product/ }));
const photoInputs = () => Array.from(document.querySelectorAll('input[type="file"][accept="image/*"]')) as HTMLInputElement[];
const jpg = (n: string) => new File(["x"], n, { type: "image/jpeg" });
const attached = (url: string) => document.querySelectorAll(`[role="dialog"] img[src="${url}"]`).length;

async function chooseStatusActive() {
  const trigger = screen.getAllByRole("combobox").find((c) => /Draft/.test(c.textContent ?? ""))!;
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
  const option = await screen.findByRole("option", { name: /Active/ });
  fireEvent.keyDown(option, { key: "Enter" });
  await waitFor(() => expect(screen.getAllByRole("combobox").some((c) => /Active/.test(c.textContent ?? ""))).toBe(true));
}
async function pickCategoryGifts() {
  fireEvent.click(screen.getByRole("combobox", { name: "Categories" }));
  fireEvent.click(await screen.findByText("Gifts"));
  await waitFor(() => expect(screen.getByRole("list", { name: "Categories" })).toBeInTheDocument());
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
}

beforeEach(() => {
  h.writes.length = 0; h.hold = null; h.fail = null; h.failRead = null;
  h.translate.mockReset(); h.toast.mockReset(); h.upload.mockReset(); h.video.mockReset();
  h.translate.mockImplementation(async (a: { name?: string; description?: string }) => ({
    name_ja: a.name ? `JA(${a.name})` : "", description_ja: a.description ? `JA(${a.description})` : "",
  }));
  vi.stubGlobal("confirm", vi.fn(() => true));
  h.db = {
    website_collections: [
      { id: "rings", name: "Rings", name_ja: null, slug: "rings", sort: 0 },
      { id: "pendants", name: "Pendants", name_ja: null, slug: "pendants", sort: 1 },
    ],
    website_products: [product("p", "Ring P"), product("q", "Ring Q", {}, ["v-q0"])],
    website_product_variants: [],
  };
});

// ---------------------------------------------------------------- R1
describe("R1 variant preservation", () => {
  it("a variant added elsewhere after the editor opened survives a description Save", async () => {
    h.db.website_product_variants = [{ id: "v-p0", product_id: "p" }];
    renderCard();
    await openProduct("Ring P");
    h.db.website_product_variants.push({ id: "v-ADDED", product_id: "p" });   // added in another tab
    fireEvent.change(descJa(), { target: { value: "新しい説明" } });
    clickSave();
    await waitFor(() => expect(toastTitles()).toContain("Saved"));
    expect(wr().filter((w) => w.table === "website_product_variants" && w.op === "delete")).toHaveLength(0);
    expect(h.db.website_product_variants.map((r) => r.id)).toEqual(["v-p0", "v-ADDED"]);
  });

  it("a variant the user removed in the editor IS deleted, scoped to this product and listing only its id", async () => {
    h.db.website_products = [product("p", "Ring P", {}, ["v-p0", "v-p1"]), product("q", "Ring Q")];
    h.db.website_product_variants = [{ id: "v-p0", product_id: "p" }, { id: "v-p1", product_id: "p" }, { id: "v-q0", product_id: "q" }];
    renderCard();
    await openProduct("Ring P");
    fireEvent.click(screen.getAllByRole("button", { name: "Remove variant" })[1]);
    clickSave();
    await waitFor(() => expect(toastTitles()).toContain("Saved"));
    const del = wr().filter((w) => w.table === "website_product_variants" && w.op === "delete");
    expect(del).toHaveLength(1);
    expect(del[0].filters).toEqual(["product_id=eq.p", "id=in.(v-p1)"]);
    expect(h.db.website_product_variants.map((r) => r.id)).toEqual(["v-p0", "v-q0"]);
  });
});

// ---------------------------------------------------------------- R2
describe("R2 upload ownership", () => {
  it("photos finishing after close/reopen are discarded and do NOT clear a newer upload's busy state", async () => {
    const u1 = deferred<string>(); const u2 = deferred<string>();
    h.upload.mockImplementationOnce(() => u1.promise).mockImplementationOnce(() => u2.promise);
    renderCard();
    await openProduct("Ring P");
    fireEvent.change(photoInputs()[0], { target: { files: [jpg("a.jpg")] } });
    await waitFor(() => expect(h.upload).toHaveBeenCalledTimes(1));
    await cancel();
    await openProduct("Ring Q");
    fireEvent.change(photoInputs()[0], { target: { files: [jpg("b.jpg")] } });
    await waitFor(() => expect(h.upload).toHaveBeenCalledTimes(2));
    await act(async () => { u1.resolve("https://example.test/old.jpg"); });
    await waitFor(() => expect(toastTitles()).toContain("Photos not attached"));
    expect(attached("https://example.test/old.jpg")).toBe(0);
    clickSave();                                                    // still busy: the old completion did not clear it
    expect(toastTitles()).toContain("Photo still uploading");
    await act(async () => { u2.resolve("https://example.test/new.jpg"); });
    await waitFor(() => expect(attached("https://example.test/new.jpg")).toBe(1));
  });

  it("photos for a variant that was removed are discarded, never attached to whichever row moved into its index", async () => {
    h.db.website_products = [product("p", "Ring P", {}, ["v-p0", "v-p1"]), product("q", "Ring Q")];
    const u = deferred<string>(); h.upload.mockImplementationOnce(() => u.promise);
    renderCard();
    await openProduct("Ring P");
    fireEvent.change(photoInputs()[0], { target: { files: [jpg("a.jpg")] } });   // for the FIRST variant
    await waitFor(() => expect(h.upload).toHaveBeenCalled());
    fireEvent.click(screen.getAllByRole("button", { name: "Remove variant" })[0]);   // the second row slides into index 0
    await act(async () => { u.resolve("https://example.test/u.jpg"); });
    await waitFor(() => expect(toastTitles()).toContain("Photos not attached"));
    expect(lastToast("Photos not attached")!.description).toContain("variant was removed");
    expect(attached("https://example.test/u.jpg")).toBe(0);
  });

  it("photos land on the right variant when another row was removed meanwhile", async () => {
    h.db.website_products = [product("p", "Ring P", {}, ["v-p0", "v-p1"]), product("q", "Ring Q")];
    const u = deferred<string>(); h.upload.mockImplementationOnce(() => u.promise);
    renderCard();
    await openProduct("Ring P");
    fireEvent.change(photoInputs()[1], { target: { files: [jpg("a.jpg")] } });   // for the SECOND variant
    await waitFor(() => expect(h.upload).toHaveBeenCalled());
    fireEvent.click(screen.getAllByRole("button", { name: "Remove variant" })[0]);   // remove the first; the second is now index 0
    await act(async () => { u.resolve("https://example.test/u.jpg"); });
    await waitFor(() => expect(attached("https://example.test/u.jpg")).toBe(1));
  });

  it("a video finishing after the editor was closed and another product opened is not attached", async () => {
    const v = deferred<{ video_url: string; video_poster_url: string | null }>(); h.video.mockImplementationOnce(() => v.promise);
    renderCard();
    await openProduct("Ring P");
    const vin = document.querySelector('input[type="file"][accept="video/mp4"]') as HTMLInputElement;
    fireEvent.change(vin, { target: { files: [new File(["x"], "c.mp4", { type: "video/mp4" })] } });
    await waitFor(() => expect(h.video).toHaveBeenCalled());
    await cancel();
    await openProduct("Ring Q");
    await act(async () => { v.resolve({ video_url: "https://example.test/c.mp4", video_poster_url: null }); });
    await waitFor(() => expect(toastTitles()).toContain("Video not attached"));
    expect(toastTitles()).not.toContain("Video added");
    clickSave();                                                    // not busy any more and carries no video
    await waitFor(() => expect(toastTitles()).toContain("Saved"));
    expect(productUpdates().every((w) => !("video_url" in w.values))).toBe(true);
  });
});

// ---------------------------------------------------------------- R3
describe("R3 a failed conflict read is not a deletion", () => {
  it("reports the verification failure, keeps the edits, and does not say the product is gone", async () => {
    renderCard();
    await openProduct("Ring P");
    fireEvent.change(descJa(), { target: { value: "私の説明" } });
    h.db.website_products.find((r) => r.id === "p")!.description_ja = "同僚の説明";   // stored value moved: the update matches 0 rows
    h.failRead = "network down";                                                    // …and the re-read fails
    clickSave();
    await waitFor(() => expect(toastTitles()).toContain("Not saved — could not verify"));
    const t = lastToast("Not saved — could not verify")!;
    expect(t.description).toContain("could not be re-checked");
    expect(t.description).toContain("network down");
    expect(t.description).not.toContain("no longer exists");
    expect(toastTitles()).not.toContain("Not saved — changed elsewhere");
    expect(descJa().value).toBe("私の説明");
    expect(screen.getByText("Edit product")).toBeInTheDocument();
    expect(h.db.website_products.find((r) => r.id === "p")!.description_ja).toBe("同僚の説明");
  });
});

// ---------------------------------------------------------------- R4
describe("R4 Save locks portaled controls too", () => {
  it("an already-open picker is closed when Save starts, and nothing can change the submitted form", async () => {
    const gate = deferred<void>(); h.hold = gate.promise;
    renderCard();
    await openProduct("Ring P");
    fireEvent.click(screen.getByRole("combobox", { name: "Product types" }));       // a real, portaled, open picker
    const pendants = await screen.findByText("Pendants");
    expect(pendants).toBeInTheDocument();
    clickSave();
    await waitFor(() => expect(screen.getByTestId("product-form-fields")).toBeDisabled());
    await waitFor(() => expect(screen.queryByText("Pendants")).not.toBeInTheDocument());   // closed, not merely disabled
    fireEvent.click(pendants);                                                      // the stale option cannot act
    expect(within(screen.getByTestId("product-form-fields")).queryByRole("list", { name: "Product types" })!.textContent).not.toContain("Pendants");
    await act(async () => { gate.resolve(); });
    await waitFor(() => expect(toastTitles()).toContain("Saved"));
    expect(wr().filter((w) => w.table === "website_collection_products")).toHaveLength(0);
  });

  it("an open status list is closed when Save starts", async () => {
    h.db.website_products = [product("p", "Ring P", { status: "draft" }), product("q", "Ring Q")];
    const gate = deferred<void>(); h.hold = gate.promise;
    renderCard("&product=p");                                        // a draft: opened by its deep link
    await screen.findByText("Edit product");
    const trigger = screen.getAllByRole("combobox").find((c) => /Draft/.test(c.textContent ?? ""))!;
    trigger.focus(); fireEvent.keyDown(trigger, { key: "Enter" });
    await screen.findByRole("option", { name: /Active/ });
    fireEvent.click(screen.getByText("Save product"));            // the open list hides the rest from the a11y tree; click by text
    await waitFor(() => expect(screen.queryByRole("option", { name: /Active/ })).not.toBeInTheDocument());
    await act(async () => { gate.resolve(); });
    await waitFor(() => expect(toastTitles()).toContain("Saved"));
    expect(productUpdates().every((w) => w.values.status !== "active")).toBe(true);
  });

  it("a change event reaching a locked control during Save is ignored", async () => {
    const gate = deferred<void>(); h.hold = gate.promise;
    renderCard();
    await openProduct("Ring P");
    clickSave();
    await waitFor(() => expect(screen.getByTestId("product-form-fields")).toBeDisabled());
    fireEvent.change(nameInput(), { target: { value: "Changed during save" } });
    expect(nameInput().value).toBe("Ring P");
    await act(async () => { gate.resolve(); });
    await waitFor(() => expect(toastTitles()).toContain("Saved"));
    expect(h.db.website_products.find((r) => r.id === "p")!.name).toBe("Ring P");
  });
});

// ---------------------------------------------------------------- R5
describe("R5 partial create", () => {
  async function newProduct() {
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: /Add product/ }));
    await screen.findByText("New product");
    fireEvent.change(screen.getByLabelText("SKU"), { target: { value: "N1" } });
    fireEvent.change(nameInput(), { target: { value: "Brand new ring" } });
    fireEvent.change(document.querySelectorAll("textarea")[0], { target: { value: "My typed English" } });
  }
  const inserts = (t: string) => wr().filter((w) => w.table === t && w.op === "insert");

  it("a failure after the insert switches Save off, refuses a retry, keeps the text, and offers the saved product", async () => {
    h.fail = (t, op) => (t === "website_product_variants" && op === "insert" ? "variants exploded" : null);
    await newProduct();
    clickSave();
    await waitFor(() => expect(toastTitles()).toContain("Product created, but saving did not finish"));
    expect(inserts("website_products")).toHaveLength(1);
    expect(screen.getByTestId("product-recovery")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save product/ })).toBeDisabled();
    expect(document.querySelectorAll("textarea")[0].value).toBe("My typed English");   // text retained
    clickSave();                                                                       // a second try cannot create another product
    expect(inserts("website_products")).toHaveLength(1);
    h.fail = null;
    fireEvent.click(screen.getByRole("button", { name: "Open the saved product" }));
    await waitFor(() => expect(screen.queryByTestId("product-recovery")).not.toBeInTheDocument());
    expect(screen.getByText("Edit product")).toBeInTheDocument();
    expect(nameInput().value).toBe("Brand new ring");
    expect(inserts("website_products")).toHaveLength(1);
  });

  it("a failure BEFORE the insert is an ordinary failure: Save stays available and a retry may insert", async () => {
    h.fail = (t, op) => (t === "website_products" && op === "insert" ? "denied" : null);
    await newProduct();
    clickSave();
    await waitFor(() => expect(toastTitles()).toContain("Could not save"));
    expect(screen.queryByTestId("product-recovery")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save product/ })).toBeEnabled();
  });
});

// ---------------------------------------------------------------- R6
describe("R6 publication order (real status control, real mutation)", () => {
  const draft = () => { h.db.website_products = [product("p", "Ring P", { status: "draft", name_ja: null }), product("q", "Ring Q")]; };
  const idx = (pred: (w: W) => boolean) => wr().findIndex(pred);

  it("categories and the generated Japanese are written BEFORE activation; the first update never activates", async () => {
    draft();
    renderCard("&product=p");                                        // a draft: opened by its deep link
    await screen.findByText("Edit product");
    await pickCategoryGifts();
    await chooseStatusActive();
    clickSave();
    await waitFor(() => expect(toastTitles()).toContain("Saved"));
    const main = idx((w) => w.table === "website_products" && w.op === "update" && "metals" in w.values);
    const cat = idx((w) => w.table === "website_category_products" && w.op === "insert");
    const ja = idx((w) => w.table === "website_products" && "name_ja" in w.values && w.values.name_ja === "JA(Ring P)");
    const live = idx((w) => w.table === "website_products" && w.values.status === "active");
    expect(wr()[main].values.status).toBe("draft");
    expect([main, cat, ja, live].every((i) => i >= 0)).toBe(true);
    expect(main).toBeLessThan(cat);
    expect(cat).toBeLessThan(live);
    expect(ja).toBeLessThan(live);
    expect(h.db.website_products.find((r) => r.id === "p")).toMatchObject({ status: "active", name_ja: "JA(Ring P)" });
  });

  it("a failed category write prevents activation: the product stays a draft", async () => {
    draft();
    h.fail = (t, op) => (t === "website_category_products" && op === "insert" ? "category write failed" : null);
    renderCard("&product=p");                                        // a draft: opened by its deep link
    await screen.findByText("Edit product");
    await pickCategoryGifts();
    await chooseStatusActive();
    clickSave();
    await waitFor(() => expect(toastTitles()).toContain("Could not save"));
    expect(wr().some((w) => w.table === "website_products" && w.values.status === "active")).toBe(false);
    expect(h.db.website_products.find((r) => r.id === "p")!.status).toBe("draft");
  });

  it("a failed Japanese write prevents activation and says the product stayed a draft", async () => {
    draft();
    h.fail = (t, op, v) => (t === "website_products" && op === "update" && v.name_ja === "JA(Ring P)" ? "ja write failed" : null);
    renderCard("&product=p");                                        // a draft: opened by its deep link
    await screen.findByText("Edit product");
    await chooseStatusActive();
    clickSave();
    await waitFor(() => expect(toastTitles()).toContain("Could not save"));
    expect(lastToast("Could not save")!.description).toContain("Saved as a draft, not published");
    expect(wr().some((w) => w.table === "website_products" && w.values.status === "active")).toBe(false);
    expect(h.db.website_products.find((r) => r.id === "p")!.status).toBe("draft");
  });
});
