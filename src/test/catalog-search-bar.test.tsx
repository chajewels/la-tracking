import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { CatalogSearchBar } from "@/components/website/CatalogSearchBar";
import { EMPTY_FILTERS, NO_PRODUCT_TYPE } from "@/lib/catalog-search";

const TYPES = [{ id: "necklaces", name: "Necklaces" }, { id: "rings", name: "Rings" }];
const counts = { all: 5, none: 1, byType: new Map([["necklaces", 0], ["rings", 4]]) };
const bar = (over: Partial<Parameters<typeof CatalogSearchBar>[0]> = {}) => {
  const onJump = vi.fn();
  render(
    <CatalogSearchBar query="" onQueryChange={vi.fn()} filters={EMPTY_FILTERS} onFiltersChange={vi.fn()} onClear={vi.fn()}
      types={TYPES} categories={[]} statuses={[]} counts={counts} shown={5} total={5} noun="published products"
      onJump={onJump} {...over} />,
  );
  return onJump;
};

describe("Catalog search bar (grouped list)", () => {
  it("chips pick a type; an empty type gets no chip; there is no 'All' chip", () => {
    const onJump = bar();
    const nav = screen.getByTestId("catalog-type-jump");
    expect(within(nav).queryByRole("button", { name: /^All/ })).toBeNull();
    expect(within(nav).queryByRole("button", { name: /^Necklaces/ })).toBeNull();
    fireEvent.click(within(nav).getByRole("button", { name: "Rings (4)" }));
    fireEvent.click(within(nav).getByRole("button", { name: "No product type (1)" }));
    expect(onJump.mock.calls).toEqual([["rings"], [NO_PRODUCT_TYPE]]);
  });

  it("an open type's chip is pressed and clicking it closes that type", () => {
    const onClose = vi.fn();
    const onJump = bar({ openIds: new Set(["rings"]), onClose });
    const nav = screen.getByTestId("catalog-type-jump");
    expect(within(nav).getByRole("button", { name: "Rings (4)" })).toHaveAttribute("aria-pressed", "true");
    expect(within(nav).getByRole("button", { name: "No product type (1)" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(within(nav).getByRole("button", { name: "Rings (4)" }));
    expect(onClose).toHaveBeenCalledWith("rings");
    expect(onJump).not.toHaveBeenCalled();
  });

  it("counts are said for the open tab", () => {
    bar();
    expect(screen.getByTestId("catalog-result-count")).toHaveTextContent("5 published products.");
  });

  it("no Status filter on Published (it holds one status); shown on Unpublished", () => {
    bar();
    expect(screen.queryByRole("combobox", { name: "Status" })).toBeNull();
  });

  it("Status filter present when the tab has several statuses", () => {
    bar({ statuses: ["draft", "archived"], noun: "unpublished products" });
    expect(screen.getByRole("combobox", { name: "Status" })).toBeInTheDocument();
  });

  it("with a type filter only that type's chip is left", () => {
    bar({ filters: { ...EMPTY_FILTERS, type: "rings" } });
    const nav = screen.getByTestId("catalog-type-jump");
    expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual(["Rings (4)"]);
  });
});
