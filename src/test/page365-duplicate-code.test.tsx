import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findListing, nameScore, nameWords } from "../../supabase/functions/_shared/page365-inventory.ts";
import { SKIP_REASON } from "@/lib/page365-inventory";

/**
 * Page365 duplicate code → match by name (owner rule 2026-10-27).
 * N5245 was 0 in Page365 from 23 Oct but stayed 1 in the Hub: two Page365
 * listings start with N5245, and every row of a duplicated code was skipped.
 * Now the 4 words after the code decide (score >= 3 of 4, no tie); the SQL
 * side is page365_inventory_finish (a2) — local tests in
 * docs/sql/20270215_page365_duplicate_code_local_tests.sql.
 */
const src = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");

const HUB_N5245 = "N5245 Necklace PT850/950 5.20g Diamond 0.563, 0.85ct Square Halo 45cm [Preloved]";
const RUBY_N5245 = "N5245 Necklace K18g 5.28g Diamond 0.32ct Ruby 0.51ct Venetian 45cm [Preloved]";

describe("nameWords / nameScore — twins of the SQL helpers", () => {
  it("drops the code, keeps 4 words, upper-cases", () => {
    expect(nameWords(HUB_N5245, "N5245")).toEqual(["NECKLACE", "PT850/950", "5.20G", "DIAMOND"]);
    expect(nameWords("N5245　Necklace PT850  K18", "n5245")).toEqual(["NECKLACE", "PT850", "K18"]);
    expect(nameWords("N5245", "N5245")).toEqual([]);
    expect(nameWords(null, "N5245")).toEqual([]);
  });
  it("scores the owner's own pieces like the SQL self-check", () => {
    expect(nameScore(HUB_N5245, HUB_N5245, "N5245")).toBe(4);
    expect(nameScore(HUB_N5245, RUBY_N5245, "N5245")).toBe(2);
    expect(nameScore("N1045 Necklace PT850/900 10.80g Diamond 0.54ct Triple Loop 45cm [Preloved]",
      "N1045 Necklace K18 2.15g Black SSP Tahiti 10mm Pearl 45cm Pinslide", "N1045")).toBe(1);
    // A staff-edited Hub name (Sapp -> Sapphire) still scores 3.
    expect(nameScore("R1111 Ring PT900 10.0g Sapphire 2.44ct", "R1111 Ring PT900 10.0g Sapp 2.44ct", "R1111")).toBe(3);
  });
  it("ignores order and counts a repeated word once", () => {
    expect(nameScore("X1 Ring K18 Diamond Halo", "X1 Halo Diamond K18 Ring", "X1")).toBe(4);
    expect(nameScore("W1465 Watch Bvlgari Bvlgari Collection", "W1465 Watch Bvlgari Collection Quartz", "W1465")).toBe(3);
  });
});

describe("findListing — invoice import photo lookup", () => {
  const items = [
    { id: 80537105, name: RUBY_N5245 },
    { id: 82590102, name: HUB_N5245 },
    { id: 1, name: "DT1 Ring K18 2.0g Diamond Halo" },
    { id: 2, name: "DT1 Ring K18 2.0g Diamond Solitaire" },
  ];
  it("a single listing is found exactly as before", () => {
    expect(findListing([{ id: 7, name: "R13R6 Ring" }], "R13R6", "R13R6 Ring")).toEqual({ id: 7 });
  });
  it("two listings and no line name: never guessed (unchanged)", () => {
    expect(findListing(items, "N5245")).toHaveProperty("why", expect.stringMatching(/2 webstore listings share the code N5245, so none/));
  });
  it("two listings: the line's name picks the matching piece", () => {
    expect(findListing(items, "N5245", HUB_N5245)).toEqual({ id: 82590102 });
    expect(findListing(items, "N5245", RUBY_N5245)).toEqual({ id: 80537105 });
  });
  it("a tie or a weak match is never guessed", () => {
    expect(findListing(items, "DT1", "DT1 Ring K18 2.0g Diamond")).toHaveProperty("why",
      expect.stringMatching(/name did not tell them apart/));
    expect(findListing(items, "N5245", "N5245 Bracelet K14 Chain 18cm")).toHaveProperty("why",
      expect.stringMatching(/name did not tell them apart/));
  });
});

describe("wiring", () => {
  it("page365-fetch-order passes the invoice line's own name", () => {
    expect(src("supabase/functions/page365-fetch-order/index.ts")).toContain("findListing(list.items, sku, items[n].name)");
  });
  it("the migration starts from the live finish body and adds step (a2) only", () => {
    const m = src("supabase/migrations/20270215100000_page365_duplicate_code_by_name.sql");
    expect(m).toContain("'page365_inventory_finish(uuid)',         'e44762490fc64019a4cadfd9496fcbc6'");
    expect(m).toContain("(a2) 2026-10-27, owner rule");
    expect(m).toContain("SET match_result = 'pending', category = 'pending', result_note = 'matched_by_name'");
    expect(m).toContain("IF v_errors = 0 AND NOT EXISTS");
    expect(m).toContain("'page365_duplicate_code', 'Page365: same code on two listings'");
    expect(m).not.toMatch(/UPDATE public\.website_product_variants|UPDATE public\.system_settings/);
  });
  it("the bell is a warning that opens Website → Page365 stock", () => {
    const bell = src("src/components/notifications/StaffNotificationBell.tsx");
    expect(bell).toMatch(/case 'page365_duplicate_code':\s*\n\s*case 'media_cutout_cap_near':\s*\n\s*return <AlertTriangle/);
    expect(bell).toContain("|| n.type === 'page365_duplicate_code') {\n      navigate(`${ROUTES.WEBSITE}?tab=page365-stock`);");
  });
  it("review rows explain the three notes in words", () => {
    expect(SKIP_REASON.matched_by_name).toMatch(/matched by name/);
    expect(SKIP_REASON.duplicate_other_piece).toMatch(/another piece/);
    expect(SKIP_REASON.duplicate_unresolved).toMatch(/give one its own code/);
  });
});
