import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ProductDialog from "@/components/website/ProductDialog";
import {
  applyTranslatedDescription, descriptionWrites, needsDescriptionTranslation, translationNeedsConfirm,
} from "@/components/website/description-ja";
import { type ProductForm, emptyProduct, identityWrites } from "@/components/website/product-form";

/**
 * Bilingual product description editor (owner 2026-10-30). The Japanese
 * description is staff-owned: editable, saved exactly, never replaced unless
 * staff press Translate and confirm. Product NAMES, SKUs and slugs are
 * protected: a description edit sends none of them. Fixtures only — no live
 * product is read or written.
 */

const ROOT = resolve(__dirname, "../..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const code = (s: string) => s.split("\n").filter(l => !/^\s*(--|\/\/|\*|\/\*)/.test(l)).join("\n");
const between = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  expect(a, from).toBeGreaterThan(-1);
  const b = s.indexOf(to, a + from.length);
  expect(b, to).toBeGreaterThan(a);
  return s.slice(a, b);
};

const EN = "K18 gold chain, 40cm, 2.0g.";
const JA = "K18ゴールドのチェーン、40cm、2.0g。手作業で確認済み。";

/** An existing product as the editor opens it. */
function opened(over: Partial<ProductForm> = {}): ProductForm {
  return {
    ...emptyProduct(),
    id: "p1", sku: "AL112", slug: "al112-rope-chain", name: "Rope Chain 45cm", name_ja: "ロープチェーン 45cm",
    description_en: EN, description_ja: JA, jaSourceEn: EN,
    loaded: {
      description_en: EN, description_ja: JA,
      sku: "AL112", slug: "al112-rope-chain", name: "Rope Chain 45cm", name_ja: "ロープチェーン 45cm",
      variants: [], collectionIds: [], categoryIds: [],
    },
    ...over,
  };
}

describe("what Save writes (existing product)", () => {
  it("editing the English leaves the Japanese description out of the update", () => {
    const w = descriptionWrites(opened({ description_en: "K18 gold chain, 45cm, 2.4g." }));
    expect(w).toEqual({ description_en: "K18 gold chain, 45cm, 2.4g." });
    expect("description_ja" in w).toBe(false);
  });
  it("editing the Japanese saves the exact text and leaves the English out", () => {
    const manual = "  K18ゴールド　チェーン\n二行目。 ";
    const w = descriptionWrites(opened({ description_ja: manual }));
    expect(w).toEqual({ description_ja: manual.trim() });
  });
  it("an unrelated edit writes no description at all", () => {
    expect(descriptionWrites(opened({ weight_g: 3.1 }))).toEqual({});
  });
  it("clearing the English does not clear the Japanese", () => {
    const w = descriptionWrites(opened({ description_en: "" }));
    expect(w).toEqual({ description_en: null });
  });
  it("a description-only edit sends no name, SKU, slug or Japanese name", () => {
    const f = opened({ description_ja: "新しい説明。", description_en: "New English." });
    const sent = { ...identityWrites(f, f.slug.trim()), ...descriptionWrites(f) };
    expect(Object.keys(sent).sort()).toEqual(["description_en", "description_ja"]);
  });
  it("a protected value with stray whitespace is not trimmed by an unrelated save", () => {
    const f = opened({ name: "Rope Chain 45cm ", loaded: { ...opened().loaded!, name: "Rope Chain 45cm " } });
    expect(identityWrites(f, f.slug)).toEqual({});
  });
  it("a real name change still reaches the database (authorised workflow untouched)", () => {
    const f = opened({ name: "Rope Chain 50cm" });
    expect(identityWrites(f, f.slug)).toEqual({ name: "Rope Chain 50cm" });
  });
  it("reopening reads the saved Japanese back unchanged", () => {
    const f = opened();
    expect(f.description_ja).toBe(JA);
    expect(descriptionWrites(f)).toEqual({});
  });
});

describe("new product", () => {
  const fresh = (over: Partial<ProductForm>) => ({ ...emptyProduct(), sku: "X1", name: "Ring", ...over });
  it("writes both descriptions and all identity fields", () => {
    const f = fresh({ description_en: EN, description_ja: JA });
    expect(descriptionWrites(f)).toEqual({ description_en: EN, description_ja: JA });
    expect(Object.keys(identityWrites(f, "ring")).sort()).toEqual(["name", "name_ja", "sku", "slug"]);
  });
  it("is auto-translated only when English exists and Japanese is empty", () => {
    expect(needsDescriptionTranslation(fresh({ description_en: EN }))).toBe(true);
    expect(needsDescriptionTranslation(fresh({ description_en: EN, description_ja: JA }))).toBe(false);
    expect(needsDescriptionTranslation(fresh({ description_en: "" }))).toBe(false);
  });
  it("an existing product is never auto-translated on Save, empty Japanese or not", () => {
    expect(needsDescriptionTranslation(opened({ description_ja: "" }))).toBe(false);
    expect(needsDescriptionTranslation(opened({ description_en: "Changed English." }))).toBe(false);
  });
});

describe("translation result handling", () => {
  const ask = { session: 3, id: "p1", en: EN, ja: JA };
  it("applies to the form it was requested for", () => {
    const next = applyTranslatedDescription(opened(), ask, 3, " 翻訳結果。 ");
    expect(next?.description_ja).toBe("翻訳結果。");
    expect(next?.name_ja).toBe("ロープチェーン 45cm");
    expect(next?.name).toBe("Rope Chain 45cm");
  });
  it("is discarded when the Japanese was typed while it was in flight", () => {
    expect(applyTranslatedDescription(opened({ description_ja: JA + "追記" }), ask, 3, "翻訳結果。")).toBeNull();
  });
  it("is discarded when the English was edited meanwhile", () => {
    expect(applyTranslatedDescription(opened({ description_en: EN + " New." }), ask, 3, "翻訳結果。")).toBeNull();
  });
  it("is discarded when another product, or the same one reopened, is on screen", () => {
    expect(applyTranslatedDescription(opened({ id: "p2" }), ask, 3, "翻訳結果。")).toBeNull();
    expect(applyTranslatedDescription(opened(), ask, 4, "翻訳結果。")).toBeNull();
  });
  it("an empty translation changes nothing", () => {
    expect(applyTranslatedDescription(opened(), ask, 3, "   ")).toBeNull();
  });
  it("asks before replacing existing Japanese only", () => {
    expect(translationNeedsConfirm(opened())).toBe(true);
    expect(translationNeedsConfirm(opened({ description_ja: "  " }))).toBe(false);
  });
});

describe("ProductDialog", () => {
  function Harness({ onTranslate, start = opened() }: { onTranslate: () => void; start?: ProductForm }) {
    const [form, setForm] = useState(start);
    return (
      <ProductDialog
        open onOpenChange={() => {}} form={form} setForm={setForm}
        collections={[]} categories={[]} isAdmin translating={false} uploadingKey={null}
        peso={String} saving={false} onSave={() => {}} onTranslateDescription={onTranslate}
        onUploadMedia={() => {}} onPatchVariant={() => {}}
      />
    );
  }
  const jaBox = () => screen.getByLabelText("Description (Japanese)") as HTMLTextAreaElement;

  it("the Japanese description is editable, not read-only", () => {
    render(<Harness onTranslate={() => {}} />);
    expect(jaBox().readOnly).toBe(false);
    fireEvent.change(jaBox(), { target: { value: "手入力の説明。" } });
    expect(jaBox().value).toBe("手入力の説明。");
  });
  it("typing the English does not change the Japanese", () => {
    render(<Harness onTranslate={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("K18 gold, 40cm, 2.0g."), { target: { value: "Changed." } });
    expect(jaBox().value).toBe(JA);
    expect(screen.getByRole("status").textContent).toMatch(/Japanese was kept/);
  });
  it("Translate over existing Japanese asks first, and Cancel translates nothing", () => {
    const onTranslate = vi.fn();
    render(<Harness onTranslate={onTranslate} />);
    fireEvent.click(screen.getByRole("button", { name: /Translate from English/ }));
    expect(onTranslate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep my Japanese" }));
    expect(onTranslate).not.toHaveBeenCalled();
    expect(jaBox().value).toBe(JA);
  });
  it("confirming runs the translation once", () => {
    const onTranslate = vi.fn();
    render(<Harness onTranslate={onTranslate} />);
    fireEvent.click(screen.getByRole("button", { name: /Translate from English/ }));
    fireEvent.click(screen.getByRole("button", { name: "Replace with translation" }));
    expect(onTranslate).toHaveBeenCalledTimes(1);
  });
  it("with no Japanese yet, Translate needs no confirmation", () => {
    const onTranslate = vi.fn();
    render(<Harness onTranslate={onTranslate} start={opened({ description_ja: "" })} />);
    fireEvent.click(screen.getByRole("button", { name: /Translate from English/ }));
    expect(onTranslate).toHaveBeenCalledTimes(1);
  });
  it("the Japanese name stays read-only and generated", () => {
    render(<Harness onTranslate={() => {}} />);
    expect((screen.getByLabelText("Name (Japanese, generated)") as HTMLInputElement).readOnly).toBe(true);
  });
});

describe("wiring (source-anchored)", () => {
  const card = code(src("src/components/website/ProductsCard.tsx"));
  const saveFn = between(card, "const save = useMutation({", "const remove = useMutation({");

  it("Save builds its payload from the guarded helpers, with no inline description or identity write", () => {
    const payload = between(saveFn, "const productPayload = {", "let productId = f.id;");
    expect(saveFn).toContain("const identity = identityWrites(f, slug);");
    expect(payload).toContain("...identity,");
    expect(payload).toContain("...descriptionWrites(f),");
    expect(payload).not.toMatch(/\bsku:|\bslug:|\bname:|name_ja:|description_en:|description_ja:/);
  });
  it("Save only ever patches description_ja for a new product", () => {
    expect(saveFn).toContain("const needDesc = needsDescriptionTranslation(f);");
    expect(saveFn).toContain("if (needDesc) jaPatch.description_ja");
  });
  it("a failed or late translation touches nothing", () => {
    const fn = between(card, "async function translateDescription()", "async function regenerateJapaneseName()");
    expect(fn).toContain("applyTranslatedDescription(formRef.current");
    expect(fn).toContain("The Japanese description was not changed.");
    expect(fn).not.toMatch(/setForm\(\{/);
  });
  it("the editor is re-keyed on every open", () => {
    expect(between(card, "function openNew()", "function openEdit(")).toContain("editSession.current += 1;");
    expect(between(card, "function openEdit(", "async function translateDescription()")).toContain("editSession.current += 1;");
  });
  it("the bulk name pass never reads or writes a description", () => {
    const fn = between(card, "async function fillMissingJapaneseNames()", "async function refreshProduct(");
    expect(fn).not.toMatch(/description_(en|ja)|translateJa\(\{[^}]*description/);
  });
  it("the importer fills a Japanese description only when none exists", () => {
    const imp = code(src("src/components/website/ProductImportDialog.tsx"));
    const rules = code(src("src/components/website/import-ja.ts"));
    expect(rules).toContain("const needDesc = !!v.description_en && isMissingJa(existing?.description_ja);");
    expect(imp).toContain("planImportJapanese(existingProduct, v,");
    expect(imp).not.toContain("v.description_en !== prevEn");
  });
  it("nothing server-side writes description_ja behind the editor's back", () => {
    // The only edge function that names the column besides the read API is the translator, which writes nothing.
    const fn = code(src("supabase/functions/translate-product-description/index.ts"));
    expect(fn).not.toMatch(/\.from\(["']website_products["']\)/);
  });
});
