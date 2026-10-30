import { describe, expect, it, vi } from "vitest";
import { fillMissingJapanese, jaMissingFilter, bulkNameSummary, bulkNameAccounted, classifyNameRows, fillSkipReason } from "@/components/website/name-ja";
import {
  fillImportedJapanese, importJapanesePayload, planImportJapanese, type ImportTranslate,
} from "@/components/website/import-ja";
import { makeTable, parseOr } from "@/test/helpers/ja-table";

const NAME = { id: "p1", column: "name_ja", source: "Diamond ring", text: "ダイヤモンドリング" } as const;
const mk = (name_ja: string | null, extra: Record<string, string | null> = {}) =>
  makeTable([{ id: "p1", name: "Diamond ring", name_ja, description_en: "Nice", description_ja: null, ...extra }]);

describe("missing-name predicate agrees between the app and the database filter", () => {
  it.each([[null], [""]])("fills %j", async (v) => {
    const t = mk(v);
    expect(await fillMissingJapanese(t.client, { ...NAME, observed: v })).toBe("filled");
    expect(t.byId("p1").name_ja).toBe(NAME.text);
  });
  it.each([["  "], ["\t"], [" \n "]])("fills a whitespace-only name %j that the app SAW", async (v) => {
    const t = mk(v);
    expect(await fillMissingJapanese(t.client, { ...NAME, observed: v })).toBe("filled");
    expect(t.byId("p1").name_ja).toBe(NAME.text);
  });
  it("does not match a whitespace value it did not see (someone typed one meanwhile)", async () => {
    const t = mk("   ");
    expect(await fillMissingJapanese(t.client, { ...NAME, observed: "" })).toBe("not_eligible");
    expect(t.byId("p1").name_ja).toBe("   ");
  });
  it("never fills a protected, existing name", async () => {
    const t = mk("既存のリング");
    expect(await fillMissingJapanese(t.client, { ...NAME, observed: "" })).toBe("has_value");
    expect(t.byId("p1").name_ja).toBe("既存のリング");
  });
  it("jaMissingFilter text", () => {
    expect(jaMissingFilter("name_ja")).toBe("name_ja.is.null,name_ja.eq.");
    expect(jaMissingFilter("name_ja", "")).toBe("name_ja.is.null,name_ja.eq.");
    expect(jaMissingFilter("name_ja", "ほんもの")).toBe("name_ja.is.null,name_ja.eq.");
    expect(jaMissingFilter("name_ja", "  ")).toBe('name_ja.is.null,name_ja.eq.,name_ja.eq."  "');
    expect(parseOr(jaMissingFilter("name_ja", "  ")).length).toBe(3);
  });
});

describe("concurrent edits", () => {
  it("English name changed while translating: nothing written, reported as source_changed", async () => {
    const t = mk(null);
    t.hooks.beforeWrite = (rows) => { rows[0].name = "Diamond ring 18K"; };
    expect(await fillMissingJapanese(t.client, { ...NAME, observed: null })).toBe("source_changed");
    expect(t.byId("p1").name_ja).toBeNull();
    expect(t.log.at(-1)).toMatchObject({ op: "update", matched: 0 });
  });
  it("Japanese name typed/filled meanwhile: kept, reported as has_value", async () => {
    const t = mk(null);
    t.hooks.beforeWrite = (rows) => { rows[0].name_ja = "手入力の名前"; };
    expect(await fillMissingJapanese(t.client, { ...NAME, observed: null })).toBe("has_value");
    expect(t.byId("p1").name_ja).toBe("手入力の名前");
  });
  it("both changed: the existing value wins the report and nothing is replaced", async () => {
    const t = mk(null);
    t.hooks.beforeWrite = (rows) => { rows[0].name = "Other"; rows[0].name_ja = "既存"; };
    expect(await fillMissingJapanese(t.client, { ...NAME, observed: null })).toBe("has_value");
    expect(t.byId("p1").name_ja).toBe("既存");
  });
  it("zero rows is never success", async () => {
    const t = mk("既存");
    const o = await fillMissingJapanese(t.client, { ...NAME, observed: null });
    expect(o).not.toBe("filled");
    expect(t.log.at(-1)?.matched).toBe(0);
  });
  it("product deleted meanwhile: gone", async () => {
    const t = mk(null);
    t.hooks.beforeWrite = (rows) => { rows.length = 0; };
    expect(await fillMissingJapanese(t.client, { ...NAME, observed: null })).toBe("gone");
  });
  it("a database error throws (failed, not skipped)", async () => {
    const t = mk(null);
    t.hooks.failWrite = "permission denied";
    await expect(fillMissingJapanese(t.client, { ...NAME, observed: null })).rejects.toThrow("permission denied");
    expect(t.byId("p1").name_ja).toBeNull();
  });
  it("description fill is guarded on the English description", async () => {
    const t = mk(null);
    t.hooks.beforeWrite = (rows) => { rows[0].description_en = "Changed"; };
    const o = await fillMissingJapanese(t.client, { id: "p1", column: "description_ja", source: "Nice", observed: null, text: "素敵" });
    expect(o).toBe("source_changed");
    expect(t.byId("p1").description_ja).toBeNull();
  });
  it("skip reasons are distinct", () => {
    const m = (["has_value", "source_changed", "gone"] as const).map((o) => fillSkipReason(o, "A Japanese name"));
    expect(new Set(m).size).toBe(3);
  });
});

describe("bulk summary distinguishes every outcome", () => {
  it("counts filled, both skips and both failures", () => {
    const o = {
      filled: 2, hadJapanese: 3, noEnglish: 1, englishChanged: 1, gone: 1, notEligible: 1,
      translationFailed: ["A: rate limit"], databaseFailed: ["B: denied"],
    };
    const s = bulkNameSummary(11, o);
    expect(bulkNameAccounted(o)).toBe(11);
    expect(s.title).toBe(
      "Japanese names filled: 2 of 11 products. Already had one: 3. No English name: 1. English changed meanwhile: 1. "
      + "Product removed: 1. Not eligible: 1. Translation failed: 1. Database failed: 1.");
    expect(s.description).toBe("A: rate limit · B: denied");
    expect(s.failed).toBe(true);
  });
});

describe("bulk classification", () => {
  it("never calls a product with no English name, or a removed one, 'already had a Japanese name'", () => {
    const c = classifyNameRows([
      { id: "1", name: "A", name_ja: null }, { id: "2", name: "B", name_ja: "  " },
      { id: "3", name: "C", name_ja: "既存" }, { id: "4", name: "", name_ja: null },
      { id: "5", name: "  ", name_ja: "" }, { id: "6", name: "", name_ja: "既存" },
    ]);
    expect(c.targets.map((r) => r.id)).toEqual(["1", "2"]);
    expect(c.hadJapanese).toBe(2);   // 3 and 6
    expect(c.noEnglish).toBe(2);     // 4 and 5
    expect(c.targets.length + c.hadJapanese + c.noEnglish).toBe(6);
  });
});

describe("importer Japanese rules", () => {
  const v = { name: "Diamond ring", description_en: "Nice" };
  const tr = (): ImportTranslate & ReturnType<typeof vi.fn> =>
    vi.fn(async () => ({ name_ja: " ダイヤ ", description_ja: " 素敵 " })) as never;

  it("an existing product's update payload carries NO Japanese field", async () => {
    const plan = await planImportJapanese({ name_ja: "既存", description_ja: "既存文" }, v, tr());
    expect(importJapanesePayload({ name_ja: "既存", description_ja: "既存文" }, plan)).toEqual({});
  });
  it("existing names and descriptions are not translated at all", async () => {
    const t = tr();
    const plan = await planImportJapanese({ name_ja: "既存", description_ja: "既存文" }, { name: "Changed English", description_en: "Changed" }, t);
    expect(t).not.toHaveBeenCalled();
    expect(plan).toEqual({ genName: "", genDesc: "" });
  });
  it("whitespace-only counts as missing and is filled by a guarded write", async () => {
    const existing = { name_ja: "  ", description_ja: "\t" };
    const t = mk("  ", { description_ja: "\t" });
    const plan = await planImportJapanese(existing, v, tr());
    expect(plan).toEqual({ genName: "ダイヤ", genDesc: "素敵" });
    expect(await fillImportedJapanese(t.client, "p1", existing, v, plan)).toEqual([]);
    expect(t.byId("p1")).toMatchObject({ name_ja: "ダイヤ", description_ja: "素敵" });
  });
  it("a concurrent staff edit is not overwritten and is reported", async () => {
    const existing = { name_ja: null, description_ja: null };
    const t = mk(null);
    const plan = await planImportJapanese(existing, v, tr());
    t.hooks.beforeWrite = (rows) => { rows[0].name_ja = "スタッフ入力"; rows[0].description_en = "Edited"; };
    const res = await fillImportedJapanese(t.client, "p1", existing, v, plan);
    expect(t.byId("p1").name_ja).toBe("スタッフ入力");
    expect(t.byId("p1").description_ja).toBeNull();
    expect(res).toEqual([{ column: "name_ja", outcome: "has_value" }, { column: "description_ja", outcome: "source_changed" }]);
  });
  it("a database failure on a fill is reported, never thrown", async () => {
    const existing = { name_ja: null, description_ja: null };
    const t = mk(null);
    t.hooks.failWrite = "boom";
    const plan = await planImportJapanese(existing, v, tr());
    const res = await fillImportedJapanese(t.client, "p1", existing, v, plan);
    expect(res.map((r) => r.outcome)).toEqual(["database_error", "database_error"]);
  });
  it("a failed translation rejects before any write", async () => {
    await expect(planImportJapanese({ name_ja: null }, v, vi.fn(async () => { throw new Error("429"); }) as never)).rejects.toThrow("429");
  });
  it("checkbox off: nothing translated, a new product gets nulls", async () => {
    const plan = await planImportJapanese(null, v, null);
    expect(importJapanesePayload(null, plan)).toEqual({ name_ja: null, description_ja: null });
  });
  it("a new product receives the generated Japanese", async () => {
    const plan = await planImportJapanese(null, v, tr());
    expect(importJapanesePayload(null, plan)).toEqual({ name_ja: "ダイヤ", description_ja: "素敵" });
  });
});
