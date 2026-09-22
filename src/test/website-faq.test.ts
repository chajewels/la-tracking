import { describe, expect, it } from "vitest";
import {
  emptyItem, emptySection, inOrder, itemPayload, itemToDraft, nextSortOrder,
  reorder, sectionDeleteBlocker, sectionPayload, sectionToDraft, validateItem, validateSection,
  type FaqItemRow, type FaqSectionRow,
} from "@/components/website/website-faq";

/**
 * The FAQ's two silent failures.
 *
 * ORDERING: sort_order has no UNIQUE constraint, so two rows can legitimately
 * share a value. A naive swap between equal values is a no-op — the row does
 * not move and the button looks broken, with nothing logged and no error.
 *
 * THE DELETE GUARD: website_faq_items.section_id is ON DELETE CASCADE. If the
 * guard is wrong, deleting a section succeeds and takes every published answer
 * with it. There is no error to notice; the page is simply shorter.
 */

const sec = (id: string, sort_order: number | null): FaqSectionRow => ({
  id, slug: id, title_en: id, title_ja: null, sort_order, published: true,
});

describe("inOrder", () => {
  it("sorts by sort_order", () => {
    expect(inOrder([sec("c", 30), sec("a", 10), sec("b", 20)]).map(r => r.id)).toEqual(["a", "b", "c"]);
  });

  it("breaks ties stably by id, so equal rows never swap between renders", () => {
    const once = inOrder([sec("b", 10), sec("a", 10)]).map(r => r.id);
    const twice = inOrder([sec("a", 10), sec("b", 10)]).map(r => r.id);
    expect(once).toEqual(twice);
  });

  it("treats a null sort_order as 0 rather than dropping the row", () => {
    expect(inOrder([sec("a", 10), sec("z", null)]).map(r => r.id)).toEqual(["z", "a"]);
  });
});

describe("nextSortOrder", () => {
  it("starts at the column default for an empty list", () => {
    expect(nextSortOrder([])).toBe(100);
  });
  it("leaves a gap after the last row", () => {
    expect(nextSortOrder([{ sort_order: 100 }, { sort_order: 110 }])).toBe(120);
  });
});

describe("reorder", () => {
  const rows = [sec("a", 10), sec("b", 20), sec("c", 30)];

  it("swaps a row with the one above it", () => {
    const w = reorder(rows, "b", -1)!;
    expect(w).toEqual([{ id: "b", sort_order: 10 }, { id: "a", sort_order: 20 }]);
  });

  it("swaps a row with the one below it", () => {
    const w = reorder(rows, "b", 1)!;
    expect(w).toEqual([{ id: "b", sort_order: 30 }, { id: "c", sort_order: 20 }]);
  });

  it("refuses to move off either end", () => {
    expect(reorder(rows, "a", -1)).toBeNull();
    expect(reorder(rows, "c", 1)).toBeNull();
  });

  it("returns null for a row that is not in the list", () => {
    expect(reorder(rows, "nope", 1)).toBeNull();
  });

  // The case a plain swap gets wrong: equal values swap to themselves.
  it("still moves a row when both rows share a sort_order", () => {
    const tied = [sec("a", 100), sec("b", 100), sec("c", 100)];
    const up = reorder(tied, "b", -1)!;
    expect(up.find(w => w.id === "b")!.sort_order).toBeLessThan(up.find(w => w.id === "a")!.sort_order);
    const down = reorder(tied, "a", 1)!;
    expect(down.find(w => w.id === "a")!.sort_order).toBeGreaterThan(down.find(w => w.id === "b")!.sort_order);
  });

  it("produces an order that actually applies — re-sorting after the write moves the row", () => {
    const applied = rows.map(r => {
      const w = reorder(rows, "c", -1)!.find(x => x.id === r.id);
      return w ? { ...r, sort_order: w.sort_order } : r;
    });
    expect(inOrder(applied).map(r => r.id)).toEqual(["a", "c", "b"]);
  });
});

describe("sectionDeleteBlocker — the guard over ON DELETE CASCADE", () => {
  it("allows deleting an empty section", () => {
    expect(sectionDeleteBlocker(0)).toBeNull();
  });

  it("refuses while any question remains, and says how many", () => {
    expect(sectionDeleteBlocker(1)).toContain("1 question");
    expect(sectionDeleteBlocker(4)).toContain("4 questions");
  });

  it("explains that the questions would go too — the cascade is the whole point", () => {
    expect(sectionDeleteBlocker(2)).toMatch(/would delete them too/i);
  });
});

describe("validation", () => {
  it("requires an English title and a slug on a section", () => {
    expect(validateSection(emptySection(), []).length).toBe(2);
  });

  it("refuses a slug another section already uses, but not the section's own", () => {
    const others = [{ id: "s1", slug: "layaway" }];
    const draft = { ...emptySection(), title_en: "Layaway", slug: "layaway" };
    expect(validateSection(draft, others).some(e => e.includes("already uses"))).toBe(true);
    expect(validateSection({ ...draft, id: "s1" }, others)).toEqual([]);
  });

  it("requires an English question and answer on an item", () => {
    expect(validateItem(emptyItem("s1")).length).toBe(2);
    expect(validateItem({ ...emptyItem("s1"), question_en: "Q", answer_en: "A" })).toEqual([]);
  });
});

describe("drafts and payloads", () => {
  it("defaults published to true, matching the column default on both tables", () => {
    expect(emptySection().published).toBe(true);
    expect(emptyItem("s1").published).toBe(true);
  });

  it("turns nullable columns into strings so no input goes uncontrolled", () => {
    const row: FaqItemRow = {
      id: "i1", section_id: "s1", question_en: "Q", question_ja: null,
      answer_en: "A", answer_ja: null, layaway_only: null, sort_order: null, published: null,
    };
    const d = itemToDraft(row);
    expect(typeof d.question_ja).toBe("string");
    expect(typeof d.answer_ja).toBe("string");
    expect(d.layaway_only).toBe(false);
    // published is NOT NULL in the table; a null read back is treated as the
    // default rather than hiding a live answer.
    expect(d.published).toBe(true);
  });

  it("sends empty optional text as null and omits id when creating", () => {
    const p = itemPayload({ ...emptyItem("s1"), question_en: " Q ", answer_en: " A " }, "u1", 110);
    expect(p.question_en).toBe("Q");
    expect(p.question_ja).toBeNull();
    expect(p.sort_order).toBe(110);
    expect(p.updated_by).toBe("u1");
    expect("id" in p).toBe(false);
  });

  it("omits sort_order when editing, so a save never silently reorders", () => {
    const p = sectionPayload({ ...emptySection(), id: "s1", title_en: "T", slug: "t" }, null);
    expect("sort_order" in p).toBe(false);
    expect(p.id).toBe("s1");
  });

  it("reads a section back into the same draft it came from", () => {
    const row: FaqSectionRow = { id: "s1", slug: "layaway", title_en: "Layaway", title_ja: "分割", sort_order: 100, published: false };
    expect(sectionToDraft(row)).toEqual({ id: "s1", slug: "layaway", title_en: "Layaway", title_ja: "分割", published: false });
  });
});
