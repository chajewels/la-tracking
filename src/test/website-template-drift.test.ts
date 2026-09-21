import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import {
  CONDITION_VALUES, DATA_START_ROW, METAL_VALUES, ORIGIN_LABELS, SHEET_NAME,
  TEMPLATE_HUB_COLUMNS,
} from "@/lib/website-catalog-import";

/**
 * The shipped upload template cannot drift away from the product editor.
 *
 * The static .xlsx stays static — staff download it, Excel fills the formulas,
 * the dropdowns work offline. What changes is the code around it, and this file
 * is the thing that notices: it measures the workbook against the SAME
 * TEMPLATE_HUB_COLUMNS the importer is typed from, so adding, renaming or
 * orphaning a field breaks CI instead of a staff member's upload.
 *
 * SHEETJS SCOPE. `xlsx` is pinned at 0.18.5 with two accepted advisories
 * (GHSA-4r6h-8v6p-xvw6 prototype pollution, GHSA-5pgg-2g8v-p4x9 ReDoS) —
 * accepted 2026-09-09 because the only thing parsed is an admin-chosen
 * spreadsheet in the Hub. This test stays INSIDE that accepted scope: its input
 * is public/templates/cha-jewels-product-upload-template.xlsx, a fixture this
 * repo owns and ships, never a customer- or portal-supplied file.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(here, "../../public/templates/cha-jewels-product-upload-template.xlsx");

// bookFiles keeps the raw zip parts. We need them because SheetJS 0.18.5 does
// not model data validation at ALL — a parsed sheet has no !dataValidation key,
// so the only way to prove the dropdowns are still in the file is to read the
// worksheet XML that Excel reads.
const wb = XLSX.read(readFileSync(file), { type: "buffer", bookFiles: true });

const rawPart = (name: string): string => {
  const files = (wb as unknown as { files?: Record<string, { content?: Buffer }> }).files;
  const entry = files?.[name];
  if (!entry?.content) throw new Error(`missing zip part ${name}`);
  return Buffer.from(entry.content).toString("utf8");
};

/** xl/workbook.xml names sheets; the rels file says which part each one is. */
const worksheetPartFor = (sheetName: string): string => {
  const rel = new RegExp(`<sheet[^>]*name="${sheetName}"[^>]*r:id="([^"]+)"`)
    .exec(rawPart("xl/workbook.xml"))?.[1];
  if (!rel) throw new Error(`no <sheet> named ${sheetName}`);
  const target = new RegExp(`<Relationship[^>]*Id="${rel}"[^>]*Target="([^"]+)"`)
    .exec(rawPart("xl/_rels/workbook.xml.rels"))?.[1];
  if (!target) throw new Error(`no relationship ${rel}`);
  return target.startsWith("/") ? target.slice(1) : `xl/${target}`;
};

const gridOf = (sheetName: string): string[][] => {
  const sheet = wb.Sheets[sheetName];
  if (!sheet) throw new Error(`the template has no "${sheetName}" sheet`);
  return XLSX.utils
    .sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "", blankrows: true })
    .map((row) => (row ?? []).map((c) => String(c ?? "").trim()));
};

const uploadGrid = gridOf(SHEET_NAME);
const header = uploadGrid[0] ?? [];
/** Row 4 is the per-column note staff read in Excel. */
const notes = uploadGrid[3] ?? [];

/**
 * hub_design is the ONE header the importer does not read, and it is deliberate:
 * it is an input to the product_name formula, so deleting the column would break
 * every generated name. Its row-4 note has to say so — that pairing is asserted
 * below, which is what keeps this exemption honest rather than a hole. Anything
 * else that looks like a Hub field and is not in TEMPLATE_HUB_COLUMNS is an
 * orphan and fails.
 */
const NOT_IMPORTED_BY_DESIGN = ["hub_design"];

describe("Upload sheet header vs TEMPLATE_HUB_COLUMNS", () => {
  it("carries every column the importer reads", () => {
    expect(header).toEqual(expect.arrayContaining([...TEMPLATE_HUB_COLUMNS]));
  });

  it("carries them in the order the list declares", () => {
    const positions = TEMPLATE_HUB_COLUMNS.map((name) => header.indexOf(name));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("has no Hub-looking header the importer ignores", () => {
    const hubLooking = header.filter((h) => h.startsWith("hub_") || h.endsWith("_slugs"));
    const orphans = hubLooking.filter(
      (h) => !TEMPLATE_HUB_COLUMNS.includes(h) && !NOT_IMPORTED_BY_DESIGN.includes(h),
    );
    expect(orphans).toEqual([]);
  });

  it("labels each by-design exception as not imported", () => {
    for (const name of NOT_IMPORTED_BY_DESIGN) {
      const note = notes[header.indexOf(name)] ?? "";
      expect(note).toMatch(/not imported/i);
      // The old note promised a "Hub: Edit product › design" field that never existed.
      expect(note).not.toMatch(/Edit product/i);
    }
  });
});

describe("Lists sheet vs the importer's enums", () => {
  const lists = gridOf("Lists");
  const listsHeader = lists[0] ?? [];
  const column = (name: string): string[] => {
    const i = listsHeader.indexOf(name);
    expect(i, `Lists has no "${name}" column`).toBeGreaterThanOrEqual(0);
    return lists.slice(1).map((r) => r[i] ?? "").filter((v) => v !== "");
  };

  it("offers exactly the metals the importer accepts", () => {
    expect(column("metal")).toEqual([...METAL_VALUES]);
  });

  it("offers exactly the conditions the importer accepts", () => {
    expect(column("condition")).toEqual([...CONDITION_VALUES]);
  });

  it("offers exactly the origin labels the importer accepts", () => {
    expect(column("origin")).toEqual(Object.values(ORIGIN_LABELS));
  });
});

describe("Hub field map sheet", () => {
  /** "image_1 … image_10" stands for ten columns; other cells list them by comma. */
  const expand = (cellText: string): string[] => {
    const span = /^(\w+?)_(\d+)\s*(?:…|\.\.\.)\s*\1_(\d+)$/.exec(cellText);
    if (span) {
      const [, stem, from, to] = span;
      return Array.from({ length: Number(to) - Number(from) + 1 },
        (_, i) => `${stem}_${Number(from) + i}`);
    }
    return cellText.split(",").map((s) => s.trim()).filter(Boolean);
  };

  it("documents every column the importer reads", () => {
    const documented = new Set(gridOf("Hub field map").slice(1).flatMap((r) => expand(r[0] ?? "")));
    const undocumented = TEMPLATE_HUB_COLUMNS.filter((name) => !documented.has(name));
    expect(undocumented).toEqual([]);
  });
});

describe("Upload sheet dropdowns", () => {
  const xml = rawPart(worksheetPartFor(SHEET_NAME));
  const sqrefs = Array.from(
    xml.matchAll(/<dataValidation\b[^>]*\bsqref="([^"]+)"/g), (m) => m[1],
  );

  // The four the storefront's data integrity rests on. hub_status and
  // show_on_page365_store also have dropdowns; they are not this test's subject.
  const GUARDED: [string, string][] = [
    ["hub_jewelry_type", "jewelry type"],
    ["hub_metal", "metal"],
    ["hub_condition", "condition"],
    ["hub_origin", "origin"],
  ];

  it.each(GUARDED)("keeps the %s dropdown (%s)", (columnName) => {
    const index = header.indexOf(columnName);
    expect(index, `Upload has no "${columnName}" column`).toBeGreaterThanOrEqual(0);
    const letter = XLSX.utils.encode_col(index);
    const covering = sqrefs.filter((ref) =>
      ref.split(/\s+/).some((part) => {
        const [from, to] = part.split(":");
        const span = XLSX.utils.decode_range(`${from}:${to ?? from}`);
        return span.s.c <= index && index <= span.e.c && span.e.r >= DATA_START_ROW - 1;
      }),
    );
    expect(covering, `no dataValidation covers column ${letter}`).not.toEqual([]);
  });
});
