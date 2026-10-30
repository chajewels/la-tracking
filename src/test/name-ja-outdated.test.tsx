import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ProductDialog from "@/components/website/ProductDialog";
import { japaneseNameMayBeOutdated, needsNameTranslation } from "@/components/website/name-ja";
import { importJapanesePayload, importKeptOutdatedJapaneseName } from "@/components/website/import-ja";
import { type ProductForm, emptyProduct } from "@/components/website/product-form";

/**
 * Owner 2026-10-31: an existing Japanese name is never replaced automatically
 * (Save, bulk, import), but when the English name changes staff are TOLD the
 * Japanese name may be out of date — in the editor, and in the import summary.
 * Fixtures only; no translation call, no live product.
 */

const NAME = "Rope Chain 45cm";
const NAME_JA = "ロープチェーン 45cm";

function opened(over: Partial<ProductForm> = {}): ProductForm {
  return {
    ...emptyProduct(),
    id: "p1", sku: "AL112", slug: "al112-rope-chain", name: NAME, name_ja: NAME_JA,
    loaded: {
      description_en: "", description_ja: "",
      sku: "AL112", slug: "al112-rope-chain", name: NAME, name_ja: NAME_JA,
      storedJa: { name_ja: NAME_JA, description_ja: null },
      variants: [], collectionIds: [], categoryIds: [],
    },
    ...over,
  };
}

describe("japaneseNameMayBeOutdated", () => {
  const base = { name: NAME, nameJa: NAME_JA, wasName: NAME, wasJa: NAME_JA };
  it("false while the English name is unchanged", () => {
    expect(japaneseNameMayBeOutdated(base)).toBe(false);
  });
  it("false when only spaces at the ends changed", () => {
    expect(japaneseNameMayBeOutdated({ ...base, name: `  ${NAME} ` })).toBe(false);
  });
  it("true when the English name changed and the Japanese name stayed", () => {
    expect(japaneseNameMayBeOutdated({ ...base, name: "Rope Chain 50cm" })).toBe(true);
  });
  it("false after the Japanese name was regenerated", () => {
    expect(japaneseNameMayBeOutdated({ ...base, name: "Rope Chain 50cm", nameJa: "ロープチェーン 50cm" })).toBe(false);
  });
  it("false when there is no Japanese name (Save fills a missing one)", () => {
    expect(japaneseNameMayBeOutdated({ ...base, name: "Rope Chain 50cm", nameJa: " ", wasJa: null })).toBe(false);
  });
});

describe("Save rule is unchanged: the existing Japanese name is still never replaced", () => {
  it("an English name change does not trigger a translation", () => {
    expect(needsNameTranslation(opened({ name: "Rope Chain 50cm" }))).toBe(false);
  });
});

describe("editor warning", () => {
  function Harness({ start }: { start: ProductForm }) {
    const [form, setForm] = useState(start);
    return (
      <ProductDialog
        open onOpenChange={() => {}} form={form} setForm={setForm}
        collections={[]} categories={[]} isAdmin translating={false} uploadingKeys={[]}
        peso={String} saving={false} onSave={() => {}} onTranslateDescription={() => {}}
        canRegenerateName translatingName={false} onRegenerateJapaneseName={() => {}}
        onUploadMedia={() => {}} onPatchVariant={() => {}}
      />
    );
  }
  const nameInput = () => screen.getByPlaceholderText("K18 Rope Chain 45cm") as HTMLInputElement;

  it("is not shown when the editor opens", () => {
    render(<Harness start={opened()} />);
    expect(screen.queryByTestId("name-ja-stale")).toBeNull();
  });
  it("appears as soon as the English name is edited, and goes away when it is put back", () => {
    render(<Harness start={opened()} />);
    fireEvent.change(nameInput(), { target: { value: "Rope Chain 50cm" } });
    expect(screen.getByTestId("name-ja-stale").textContent).toMatch(/Regenerate Japanese name/);
    fireEvent.change(nameInput(), { target: { value: NAME } });
    expect(screen.queryByTestId("name-ja-stale")).toBeNull();
  });
  it("is not shown on a new product", () => {
    render(<Harness start={{ ...emptyProduct(), name: "Ring", name_ja: "リング" }} />);
    expect(screen.queryByTestId("name-ja-stale")).toBeNull();
  });
  it("is not shown when the product has no Japanese name yet", () => {
    render(<Harness start={opened({ name_ja: "", loaded: { ...opened().loaded!, name_ja: "", storedJa: { name_ja: null, description_ja: null } } })} />);
    fireEvent.change(nameInput(), { target: { value: "Rope Chain 50cm" } });
    expect(screen.queryByTestId("name-ja-stale")).toBeNull();
  });
});

describe("import: English name changed, Japanese name kept and listed", () => {
  const existing = { name: NAME, name_ja: NAME_JA, description_ja: null };
  it("an existing product whose English name changed is listed", () => {
    expect(importKeptOutdatedJapaneseName(existing, { name: "Rope Chain 50cm", description_en: "" })).toBe(true);
  });
  it("its Japanese name is still not sent in the update payload", () => {
    expect(importJapanesePayload(existing, { genName: "", genDesc: "" })).toEqual({});
  });
  it("not listed when the English name is the same", () => {
    expect(importKeptOutdatedJapaneseName(existing, { name: NAME, description_en: "" })).toBe(false);
  });
  it("not listed when there was no Japanese name (the import fills it)", () => {
    expect(importKeptOutdatedJapaneseName({ ...existing, name_ja: null }, { name: "Rope Chain 50cm", description_en: "" })).toBe(false);
  });
  it("a new product is never listed", () => {
    expect(importKeptOutdatedJapaneseName(null, { name: "Rope Chain 50cm", description_en: "" })).toBe(false);
  });
});
