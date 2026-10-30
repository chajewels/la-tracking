import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ProductDialog from "@/components/website/ProductDialog";
import {
  NAME_JA_EMPTY, applyRegeneratedName, bulkNameSummary, missingNameTargets, nameRegenerationNeedsConfirm, needsNameTranslation,
} from "@/components/website/name-ja";
import { descriptionWrites, needsDescriptionTranslation } from "@/components/website/description-ja";
import { type ProductForm, emptyProduct, identityWrites } from "@/components/website/product-form";

/**
 * Japanese product NAME rules (owner 2026-10-30): a missing Japanese name is
 * generated on Save; an existing one is never replaced automatically; one
 * product's name is regenerated only by an explicit, confirmed button; the bulk
 * pass fills missing names only. English names, SKUs and slugs are never
 * rewritten, and a name operation never touches a description. Mock
 * translations and fixtures only — no live AI call, no live product.
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
const JA = "K18ゴールドのチェーン、40cm、2.0g。";
const NAME_JA = "ロープチェーン 45cm";

/** An existing product as the editor opens it. */
function opened(over: Partial<ProductForm> = {}): ProductForm {
  return {
    ...emptyProduct(),
    id: "p1", sku: "AL112", slug: "al112-rope-chain", name: "Rope Chain 45cm", name_ja: NAME_JA,
    description_en: EN, description_ja: JA, jaSourceEn: EN,
    loaded: {
      description_en: EN, description_ja: JA,
      sku: "AL112", slug: "al112-rope-chain", name: "Rope Chain 45cm", name_ja: NAME_JA,
      storedJa: { name_ja: NAME_JA, description_ja: JA },
      variants: [], collectionIds: [], categoryIds: [],
    },
    ...over,
  };
}
const asked = (f: ProductForm, session = 1) => ({ session, id: f.id, name: f.name.trim(), nameJa: f.name_ja });

describe("Save: a missing Japanese name is generated, an existing one never replaced", () => {
  it("an EXISTING product with an English name and no Japanese name is translated", () => {
    expect(needsNameTranslation(opened({ name_ja: "" }))).toBe(true);
  });
  it("a NEW product with a name and no Japanese name is translated", () => {
    expect(needsNameTranslation({ ...emptyProduct(), name: "Ring" })).toBe(true);
  });
  it("an existing Japanese name is not translated", () => {
    expect(needsNameTranslation(opened())).toBe(false);
  });
  it("changing the English name does NOT replace an existing Japanese name", () => {
    expect(needsNameTranslation(opened({ name: "Rope Chain 50cm" }))).toBe(false);
  });
  it("changing the English description does not translate the name or the description", () => {
    const f = opened({ description_en: "Changed English." });
    expect(needsNameTranslation(f)).toBe(false);
    expect(needsDescriptionTranslation(f)).toBe(false);
  });
  it("nothing to translate without an English name", () => {
    expect(needsNameTranslation({ ...emptyProduct(), name: "  " })).toBe(false);
  });
  it("a whitespace-only Japanese name counts as missing", () => {
    expect(needsNameTranslation(opened({ name_ja: "  " }))).toBe(true);
  });
  it("an unrelated edit sends no Japanese name, name, SKU or slug", () => {
    const f = opened({ weight_g: 3.1, description_en: "New English." });
    expect(identityWrites(f, f.slug.trim())).toEqual({});
  });
  it("the existing Japanese name is not sent when only the English name changes", () => {
    const f = opened({ name: "Rope Chain 50cm" });
    expect(identityWrites(f, f.slug.trim())).toEqual({ name: "Rope Chain 50cm" });
  });
});

describe("empty-slug edge case", () => {
  it("an existing product with a saved EMPTY slug does not get one invented by an unrelated save", () => {
    const f = opened({ slug: "", loaded: { ...opened().loaded!, slug: "" }, weight_g: 2 });
    // ProductsCard passes slugify(name) as the fallback; it must not be written.
    expect(identityWrites(f, "rope-chain-45cm")).toEqual({});
  });
  it("clearing a saved slug still falls back to the name (policy unchanged)", () => {
    const f = opened({ slug: "" });
    expect(identityWrites(f, "rope-chain-45cm")).toEqual({ slug: "rope-chain-45cm" });
  });
  it("a slug staff typed is written", () => {
    const f = opened({ slug: "new-slug" });
    expect(identityWrites(f, "new-slug")).toEqual({ slug: "new-slug" });
  });
  it("a NEW product still sends all identity fields", () => {
    const f = { ...emptyProduct(), sku: "X1", name: "Ring" };
    expect(Object.keys(identityWrites(f, "ring")).sort()).toEqual(["name", "name_ja", "sku", "slug"]);
  });
});

describe("explicit Regenerate Japanese name: result handling", () => {
  it("fills only the Japanese name and returns every other field, saved or unsaved, as it was", () => {
    const f = opened({ description_ja: "未保存の説明。", weight_g: 4.2, sku: "AL112" });
    const next = applyRegeneratedName(f, asked(f), 1, "新しい名前")!;
    expect(next.name_ja).toBe("新しい名前");
    expect({ ...next, name_ja: f.name_ja }).toEqual(f);
  });
  it("never touches the English name, the descriptions or what is saved", () => {
    const f = opened();
    const next = applyRegeneratedName(f, asked(f), 1, "新しい名前")!;
    expect(next.name).toBe(f.name);
    expect(next.description_en).toBe(EN);
    expect(next.description_ja).toBe(JA);
    expect(next.loaded).toBe(f.loaded);
    expect(descriptionWrites(next)).toEqual({});
  });
  it("is discarded when the English name was edited meanwhile", () => {
    const f = opened();
    expect(applyRegeneratedName({ ...f, name: "Rope Chain 50cm" }, asked(f), 1, "x")).toBeNull();
  });
  it("is discarded when the Japanese name changed meanwhile", () => {
    const f = opened();
    expect(applyRegeneratedName({ ...f, name_ja: "別の名前" }, asked(f), 1, "x")).toBeNull();
  });
  it("is discarded after switching to another product", () => {
    const f = opened();
    expect(applyRegeneratedName({ ...f, id: "p2" }, asked(f), 1, "x")).toBeNull();
  });
  it("is discarded after the editor was reopened (a new session)", () => {
    const f = opened();
    expect(applyRegeneratedName(f, asked(f, 1), 2, "x")).toBeNull();
  });
  it("an empty translation changes nothing", () => {
    const f = opened();
    expect(applyRegeneratedName(f, asked(f), 1, "   ")).toBeNull();
  });
  it("asks before replacing an existing Japanese name only", () => {
    expect(nameRegenerationNeedsConfirm(opened())).toBe(true);
    expect(nameRegenerationNeedsConfirm(opened({ name_ja: "" }))).toBe(false);
  });
  it("a regenerated name is an explicit staff change, so Save writes it", () => {
    const f = opened();
    const next = applyRegeneratedName(f, asked(f), 1, "新しい名前")!;
    expect(identityWrites(next, next.slug.trim())).toEqual({ name_ja: "新しい名前" });
  });
});

describe("bulk: Generate missing Japanese names", () => {
  const rows = [
    { id: "1", sku: "A", name: "Ring", name_ja: null },
    { id: "2", sku: "B", name: "Chain", name_ja: "" },
    { id: "3", sku: "C", name: "Bangle", name_ja: "バングル" },
    { id: "4", sku: "D", name: "  ", name_ja: null },
    { id: "5", sku: "E", name: "Watch", name_ja: "  " },
  ];
  it("targets only products with an English name and no Japanese name", () => {
    expect(missingNameTargets(rows).map((r) => r.id)).toEqual(["1", "2", "5"]);
  });
  it("skips every product that already has a Japanese name", () => {
    expect(missingNameTargets(rows).some((r) => r.id === "3")).toBe(false);
  });
  it("reports filled, skipped and failed", () => {
    const s = bulkNameSummary(3, { filled: 1, hadJapanese: 1, noEnglish: 0, englishChanged: 0, gone: 0, notEligible: 0, translationFailed: ["B: rate limit"], databaseFailed: [] });
    expect(s.title).toContain("Japanese names filled: 1 of 3 products. Already had one: 1.");
    expect(s.title).toContain("Translation failed: 1. Database failed: 0.");
    expect(s.description).toBe("B: rate limit");
    expect(s.failed).toBe(true);
  });
  it("a clean run is not an error", () => {
    expect(bulkNameSummary(2, { filled: 2, hadJapanese: 0, noEnglish: 0, englishChanged: 0, gone: 0, notEligible: 0, translationFailed: [], databaseFailed: [] }).failed).toBe(false);
  });
  it("the write guard matches a null or empty Japanese name only", () => {
    expect(NAME_JA_EMPTY).toBe("name_ja.is.null,name_ja.eq.");
  });
});

describe("ProductDialog: Regenerate Japanese name", () => {
  function Harness(p: {
    onName?: () => void; onDesc?: () => void; canRegenerateName?: boolean; translatingName?: boolean; start?: ProductForm;
  }) {
    const [form, setForm] = useState(p.start ?? opened());
    return (
      <ProductDialog
        open onOpenChange={() => {}} form={form} setForm={setForm}
        collections={[]} categories={[]} isAdmin translating={false} uploadingKey={null}
        peso={String} saving={false} onSave={() => {}} onTranslateDescription={p.onDesc ?? (() => {})}
        canRegenerateName={p.canRegenerateName ?? true} translatingName={p.translatingName ?? false}
        onRegenerateJapaneseName={p.onName ?? (() => {})}
        onUploadMedia={() => {}} onPatchVariant={() => {}}
      />
    );
  }
  const nameBtn = () => screen.getByRole("button", { name: /Regenerate Japanese name/ });

  it("is hidden from staff without catalog permission", () => {
    render(<Harness canRegenerateName={false} />);
    expect(screen.queryByRole("button", { name: /Regenerate Japanese name/ })).toBeNull();
  });
  it("replacing an existing name asks first, and Keep current name changes nothing", () => {
    const onName = vi.fn();
    render(<Harness onName={onName} />);
    fireEvent.click(nameBtn());
    expect(onName).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep current name" }));
    expect(onName).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Name (Japanese, generated)") as HTMLInputElement).value).toBe(NAME_JA);
  });
  it("confirming regenerates exactly once", () => {
    const onName = vi.fn();
    render(<Harness onName={onName} />);
    fireEvent.click(nameBtn());
    fireEvent.click(screen.getByRole("button", { name: "Replace name" }));
    expect(onName).toHaveBeenCalledTimes(1);
  });
  it("with no Japanese name yet, no confirmation is needed", () => {
    const onName = vi.fn();
    render(<Harness onName={onName} start={opened({ name_ja: "" })} />);
    fireEvent.click(nameBtn());
    expect(onName).toHaveBeenCalledTimes(1);
  });
  it("is separate from Translate from English (the description)", () => {
    const onName = vi.fn();
    const onDesc = vi.fn();
    render(<Harness onName={onName} onDesc={onDesc} start={opened({ name_ja: "", description_ja: "" })} />);
    fireEvent.click(nameBtn());
    expect(onName).toHaveBeenCalledTimes(1);
    expect(onDesc).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Translate from English/ }));
    expect(onDesc).toHaveBeenCalledTimes(1);
    expect(onName).toHaveBeenCalledTimes(1);
  });
  it("is disabled with no English name, and while a translation is running", () => {
    const { unmount } = render(<Harness start={opened({ name: "" })} />);
    expect((nameBtn() as HTMLButtonElement).disabled).toBe(true);
    unmount();
    render(<Harness translatingName />);
    expect((nameBtn() as HTMLButtonElement).disabled).toBe(true);
  });
  it("the Japanese name field stays read-only", () => {
    render(<Harness />);
    expect((screen.getByLabelText("Name (Japanese, generated)") as HTMLInputElement).readOnly).toBe(true);
  });
});

describe("wiring (source-anchored)", () => {
  const card = code(src("src/components/website/ProductsCard.tsx"));
  const saveFn = between(card, "const save = useMutation({", "const remove = useMutation({");
  const regen = between(card, "async function regenerateJapaneseName()", "function submitForm()");
  const bulk = between(card, "async function fillMissingJapaneseNames()", "async function refreshProduct(");

  it("Save translates the name only when it is missing", () => {
    expect(saveFn).toContain("const needName = needsNameTranslation(f);");
    expect(saveFn).not.toContain("jaSourceName");
  });
  it("Save writes the generated name in its own guarded update, never in the payload or description patch", () => {
    expect(saveFn).toContain("fillMissingJapanese(supabase as unknown as FillClient");
    expect(saveFn).toContain('column: "name_ja", source: storedName, observed: f.name_ja, text: nameJa');
    expect(between(saveFn, "const productPayload = {", "let productId = f.id;")).not.toMatch(/name_ja:/);
  });
  it("a failed translation writes nothing and says how to retry", () => {
    expect(saveFn).toContain("if (out instanceof Error) {");
    expect(saveFn).toContain("Use Regenerate Japanese name or Translate from English to retry.");
    expect(saveFn).toContain("if (nameJa) {");
  });
  it("Regenerate Japanese name needs permission, translates the name only and never saves", () => {
    expect(regen).toContain("if (!canManage || save.isPending) return;");
    expect(regen).toContain("translateJa({ name })");
    expect(regen).not.toMatch(/description_(en|ja)|translateJa\(\{[^}]*description/);
    expect(regen).not.toMatch(/supabase|\.update\(|\.insert\(|onSave|save\.mutate/);
  });
  it("Regenerate Japanese name rejects stale responses and keeps unrelated edits", () => {
    expect(regen).toContain("applyRegeneratedName(formRef.current, ask, editSession.current, out.name_ja)");
    expect(regen).toContain("setForm((f) => applyRegeneratedName(f, ask, editSession.current, out.name_ja) ?? f);");
    expect(regen).not.toMatch(/setForm\(\{/);
  });
  it("the bulk pass fills missing names only, name only, with a guarded write", () => {
    expect(bulk).toContain("if (!canManage) return;");
    expect(bulk).toContain("const targets = missingNames;");
    expect(bulk).toContain("translateJa({ name: String(p.name).trim() })");
    expect(bulk).toContain('column: "name_ja"');
    expect(bulk).not.toMatch(/description_(en|ja)|translateJa\(\{[^}]*description|\bsku:|\bslug:/);
    expect(bulk).not.toMatch(/\.update\(|\.insert\(/);   // the only write is the guarded helper
  });
  it("the old overwrite-everything bulk action is gone", () => {
    expect(card).not.toContain("regenerateAllJapanese");
    expect(card).not.toContain("Regenerate all Japanese");
    expect(card).toContain("Generate missing Japanese names (${missingNames.length})".replace("${missingNames.length}", "{missingNames.length}"));
  });
  it("the importer fills a Japanese name only when missing", () => {
    const imp = code(src("src/components/website/ProductImportDialog.tsx"));
    const rules = code(src("src/components/website/import-ja.ts"));
    expect(rules).toContain("const needName = isMissingJa(existing?.name_ja);");
    expect(imp).toContain("...importJapanesePayload(existingProduct, plan),");
    expect(imp).not.toContain("v.name !== prevName");
  });
  it("none of this touches Gemini, the AI panel or the Gemini function", () => {
    for (const f of ["ProductsCard.tsx", "ProductDialog.tsx", "name-ja.ts", "ProductImportDialog.tsx"]) {
      expect(code(src(`src/components/website/${f}`))).not.toMatch(/gemini/i);
    }
  });
});
