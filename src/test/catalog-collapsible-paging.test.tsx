import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import {
  GROUP_PAGE_SIZE, openFromParams, pageSlice, pagesFromParams, placementFor, withOpen, withPage,
  type ScopedProduct,
} from "@/lib/catalog-search";

/**
 * Website → Catalog: product types as collapsible sections, 25 a page (owner
 * request 2026-09-28: "it will be too long to scroll … atleast make it as page
 * and not long list"). Closed by default; Jump to opens one and closes the
 * rest; a search or filter opens only the types with matches; the tab, open
 * sections and pages live in the URL; Select all takes only the rows shown.
 */

const TYPES = [
  { id: "earrings", name: "Earrings" },
  { id: "pendants", name: "Pendants" },
  { id: "rings", name: "Rings" },
];
const product = (id: string, name: string, status: string, types: string[]) => ({
  id, name, sku: name.split(" ")[0], status, name_ja: null, metals: [], karat: null, condition: "New", origin: "JAPAN",
  item_kind: "jewelry", website_product_variants: [{ id: `v${id}`, price_jpy: 10000, stock_qty: 1, sort: 0, website_product_media: [] }],
  website_collection_products: types.map((collection_id) => ({ collection_id })), website_category_products: [],
});
// 40 published rings (paging), 3 published + 2 draft pendants, 1 published with no type, no earrings.
const PRODUCTS = [
  ...Array.from({ length: 40 }, (_, i) => product(`r${i + 1}`, `R${String(i + 1).padStart(3, "0")} Diamond ring`, "active", ["rings"])),
  product("p1", "P001 Pearl pendant", "active", ["pendants"]),
  product("p2", "P002 Heart pendant", "active", ["pendants"]),
  product("p3", "P003 Cross pendant", "active", ["pendants"]),
  product("d1", "D001 Draft pendant", "draft", ["pendants"]),
  product("d2", "D002 Draft pendant", "draft", ["pendants"]),
  product("w1", "W001 Wallet", "active", []),
];

vi.mock("@/integrations/supabase/client", () => {
  const data: Record<string, unknown> = {};
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "order", "eq", "limit", "range", "in"]) b[m] = () => b;
    b.maybeSingle = async () => ({ data: null, error: null });
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve({ data: (globalThis as Record<string, unknown>).__catalogData?.[table as never] ?? [], error: null }).then(res, rej);
    return b;
  };
  return { supabase: { from: (t: string) => builder(t), storage: { from: () => ({}) }, functions: { invoke: vi.fn() } }, __data: data };
});
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ roles: ["admin"] }) }));
vi.mock("@/contexts/PermissionsContext", () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock("@/hooks/use-toast", () => ({ toast: vi.fn() }));
vi.mock("@/components/website/ProductDialog", () => ({ default: () => null }));
vi.mock("@/components/website/ProductImportDialog", () => ({ default: () => null }));
vi.mock("@/components/website/CategoriesCard", () => ({ CATEGORIES_QUERY_KEY: ["website-categories"], fetchCategories: async () => [] }));
vi.mock("@/lib/page365-inventory-api", () => ({ fetchHiddenByPage365: async () => new Map() }));

import ProductsCard from "@/components/website/ProductsCard";

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{loc.search}</output>;
}
const params = () => new URLSearchParams(screen.getByTestId("where").textContent ?? "");

function renderAt(search = "") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[`/website${search}`]}>
      <QueryClientProvider client={qc}>
        <ProductsCard />
        <Where />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const header = (name: string) => {
  const btn = screen.getAllByTestId("catalog-group-toggle").find((b) => within(b).getByTestId("catalog-group-name").textContent === name);
  if (!btn) throw new Error(`no section ${name}`);
  return btn;
};
const productRows = () => screen.queryAllByRole("checkbox", { name: /^Select [A-Z]\d{3}$/ });
const loaded = () => screen.findAllByTestId("catalog-group-toggle");

beforeEach(() => {
  (globalThis as Record<string, unknown>).__catalogData = { website_products: PRODUCTS, website_collections: TYPES, fx_rates: [] };
});

describe("helpers", () => {
  it("pageSlice: 25 a page, ranges, and a page past the end shows the last", () => {
    const rows = Array.from({ length: 40 }, (_, i) => i);
    expect(GROUP_PAGE_SIZE).toBe(25);
    expect(pageSlice(rows, 1)).toMatchObject({ page: 1, pages: 2, from: 1, to: 25, total: 40 });
    expect(pageSlice(rows, 2)).toMatchObject({ page: 2, from: 26, to: 40 });
    expect(pageSlice(rows, 2).rows).toHaveLength(15);
    expect(pageSlice(rows, 9)).toMatchObject({ page: 2, from: 26 });
    expect(pageSlice([], 1)).toMatchObject({ page: 1, pages: 1, from: 0, to: 0, total: 0 });
  });

  it("URL: ?open= and ?pg= read and write; closing a section drops its page; page 1 is not written", () => {
    let sp = withOpen(new URLSearchParams("view=published&q=x"), ["rings", "pendants"]);
    expect([...openFromParams(sp)]).toEqual(["rings", "pendants"]);
    sp = withPage(sp, "rings", 2);
    expect(pagesFromParams(sp).get("rings")).toBe(2);
    expect(sp.get("q")).toBe("x");
    expect(withPage(sp, "rings", 1).get("pg")).toBeNull();
    const closed = withOpen(sp, ["pendants"]);
    expect(closed.get("pg")).toBeNull();
    expect(withOpen(closed, []).get("open")).toBeNull();
    expect(pagesFromParams(new URLSearchParams("pg=rings:0,bad,:3,x:y"))).toEqual(new Map());
  });

  it("placementFor: a search opens only the types with matches, clearing closes all, pages go back to 1", () => {
    const rows = PRODUCTS as unknown as ScopedProduct[];
    const searched = placementFor(new URLSearchParams("q=pendant&open=rings&pg=rings:2"), rows, TYPES);
    expect([...openFromParams(searched)]).toEqual(["pendants"]);
    expect(searched.get("pg")).toBeNull();
    const cleared = placementFor(new URLSearchParams("open=pendants"), rows, TYPES);
    expect(cleared.get("open")).toBeNull();
  });
});

describe("Catalog: collapsible product types with paging", () => {
  it("every type is collapsed by default, its count shown, no product rows listed", async () => {
    renderAt();
    const toggles = await loaded();
    expect(toggles.map((t) => within(t).getByTestId("catalog-group-name").textContent))
      .toEqual(["Earrings", "Pendants", "Rings", "No product type"]);
    for (const t of toggles) expect(t).toHaveAttribute("aria-expanded", "false");
    expect(within(header("Rings")).getByTestId("catalog-group-count")).toHaveTextContent("40 products");
    expect(within(header("Pendants")).getByTestId("catalog-group-count")).toHaveTextContent("3 products");
    expect(productRows()).toHaveLength(0);
    // Counts on the tabs and the result line keep their meaning.
    expect(screen.getByRole("tab", { name: "Published (44)" })).toBeInTheDocument();
    expect(screen.getByTestId("catalog-result-count")).toHaveTextContent("44 published products.");
  });

  it("a header toggles its section (a button with aria-expanded); an open type shows 25 with the range", async () => {
    renderAt();
    await loaded();
    fireEvent.click(header("Rings"));
    await waitFor(() => expect(header("Rings")).toHaveAttribute("aria-expanded", "true"));
    expect(header("Rings").tagName).toBe("BUTTON");
    expect(header("Rings")).toHaveAttribute("aria-controls", "catalog-group-body-rings");
    expect(productRows()).toHaveLength(25);
    expect(screen.getByTestId("catalog-group-range")).toHaveTextContent("1–25 of 40");
    expect(params().get("open")).toBe("rings");
    fireEvent.click(header("Rings"));
    await waitFor(() => expect(productRows()).toHaveLength(0));
    expect(params().get("open")).toBeNull();
  });

  it("Next / Previous page through a type: 26–40 of 40, kept in ?pg=", async () => {
    renderAt();
    await loaded();
    fireEvent.click(header("Rings"));
    const prev = await screen.findByRole("button", { name: "Previous page of Rings" });
    expect(prev).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next page of Rings" }));
    await waitFor(() => expect(screen.getByTestId("catalog-group-range")).toHaveTextContent("26–40 of 40"));
    expect(productRows()).toHaveLength(15);
    expect(screen.getByRole("button", { name: "Next page of Rings" })).toBeDisabled();
    expect(params().get("pg")).toBe("rings:2");
    fireEvent.click(screen.getByRole("button", { name: "Previous page of Rings" }));
    await waitFor(() => expect(screen.getByTestId("catalog-group-range")).toHaveTextContent("1–25 of 40"));
  });

  it("a type of 25 or fewer has no pager", async () => {
    renderAt();
    await loaded();
    fireEvent.click(header("Pendants"));
    await waitFor(() => expect(productRows()).toHaveLength(3));
    expect(screen.queryByTestId("catalog-group-pager")).toBeNull();
  });

  it("Jump to opens that type and closes the others; a (0) chip stays disabled", async () => {
    renderAt();
    await loaded();
    fireEvent.click(header("Pendants"));
    await waitFor(() => expect(header("Pendants")).toHaveAttribute("aria-expanded", "true"));
    const jump = screen.getByTestId("catalog-type-jump");
    expect(within(jump).getByRole("button", { name: "Earrings (0)" })).toBeDisabled();
    fireEvent.click(within(jump).getByRole("button", { name: "Rings (40)" }));
    await waitFor(() => expect(header("Rings")).toHaveAttribute("aria-expanded", "true"));
    expect(header("Pendants")).toHaveAttribute("aria-expanded", "false");
    expect(params().get("open")).toBe("rings");
  });

  it("Open all / Close all", async () => {
    renderAt();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Open all" }));
    await waitFor(() => { for (const t of screen.getAllByTestId("catalog-group-toggle")) expect(t).toHaveAttribute("aria-expanded", "true"); });
    expect(screen.getByRole("button", { name: "Open all" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Close all" }));
    await waitFor(() => expect(productRows()).toHaveLength(0));
    expect(screen.getByRole("button", { name: "Close all" })).toBeDisabled();
  });

  it("a search opens only the types with matches and goes back to page 1; clearing it closes everything", async () => {
    renderAt("?open=rings&pg=rings:2");
    await waitFor(() => expect(screen.getByTestId("catalog-group-range")).toHaveTextContent("26–40 of 40"));
    fireEvent.change(screen.getByTestId("catalog-search-input"), { target: { value: "pendant" } });
    await waitFor(() => expect(params().get("q")).toBe("pendant"));
    const toggles = screen.getAllByTestId("catalog-group-toggle");
    expect(toggles.map((t) => within(t).getByTestId("catalog-group-name").textContent)).toEqual(["Pendants"]);
    expect(header("Pendants")).toHaveAttribute("aria-expanded", "true");
    expect(params().get("pg")).toBeNull();
    expect(productRows()).toHaveLength(3);
    expect(screen.getByTestId("catalog-result-count")).toHaveTextContent("3 of 44 published products match.");

    fireEvent.change(screen.getByTestId("catalog-search-input"), { target: { value: "R0" } });
    await waitFor(() => expect(params().get("q")).toBe("R0"));
    expect(header("Rings")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("catalog-group-range")).toHaveTextContent("1–25 of 40");

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await waitFor(() => expect(params().get("q")).toBeNull());
    expect(params().get("open")).toBeNull();
    for (const t of screen.getAllByTestId("catalog-group-toggle")) expect(t).toHaveAttribute("aria-expanded", "false");
  });

  it("the URL restores the place: tab, open types and page", async () => {
    renderAt("?view=published&open=rings,pendants&pg=rings:2");
    await waitFor(() => expect(screen.getByTestId("catalog-group-range")).toHaveTextContent("26–40 of 40"));
    expect(header("Pendants")).toHaveAttribute("aria-expanded", "true");
    expect(header("Earrings")).toHaveAttribute("aria-expanded", "false");
    expect(productRows()).toHaveLength(15 + 3);
  });

  it("switching tab closes the sections and resets the pages", async () => {
    renderAt("?open=rings&pg=rings:2");
    await waitFor(() => expect(productRows()).toHaveLength(15));
    fireEvent.click(screen.getByRole("tab", { name: "Unpublished (2)" }));
    await waitFor(() => expect(params().get("view")).toBe("unpublished"));
    expect(params().get("open")).toBeNull();
    expect(params().get("pg")).toBeNull();
    expect(within(header("Pendants")).getByTestId("catalog-group-count")).toHaveTextContent("2 products");
    expect(productRows()).toHaveLength(0);
  });

  it("Select all takes only the rows shown: the current page of the open sections", async () => {
    renderAt("?open=rings");
    await waitFor(() => expect(productRows()).toHaveLength(25));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all shown" }));
    expect(await screen.findByText("25 selected")).toBeInTheDocument();
    for (const cb of productRows()) expect(cb).toHaveAttribute("data-state", "checked");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all shown" }));
    await waitFor(() => expect(screen.queryByText(/selected$/)).toBeNull());
  });

  it("with every section closed, Select all has nothing to select", async () => {
    renderAt();
    await loaded();
    expect(screen.getByRole("checkbox", { name: "Select all shown" })).toBeDisabled();
  });
});
