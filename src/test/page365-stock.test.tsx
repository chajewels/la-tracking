import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import {
  applyPage365Stock,
  checkPage365Draft,
  firstWord,
  normaliseServiceLineNos,
  previewPage365Stock,
} from "../../supabase/functions/_shared/page365-stock.ts";
import { FLAG_REASON, importSummary, ledgerChip, previewChip } from "@/lib/page365-stock";

/**
 * Page365 stock sync (2026-09-26). The stock RULES live in SQL — migration
 * 20260926120000_page365_stock_sync.sql — and are exercised against a real
 * Postgres by docs/sql/20260926_page365_stock_sync_local_tests.sql (claim once,
 * cancel/expire/forfeit/delete give back, revive re-takes or flags, ordinary
 * orders never move stock, concurrent calls take once). This file covers what
 * TypeScript owns, and pins the SQL's load-bearing clauses so an edit that
 * drops one fails here, in CI, rather than in the shop.
 */

const MIGRATION = readFileSync(
  resolve(__dirname, "../../supabase/migrations/20260926120000_page365_stock_sync.sql"), "utf8");
const fn = (name: string) => {
  const start = MIGRATION.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  return MIGRATION.slice(start, MIGRATION.indexOf("$fn$;", start));
};
const src = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");

describe("first-word matching", () => {
  it("takes the first word, upper-cased", () => {
    expect(firstWord("R1155 Ring PT900")).toBe("R1155");
    expect(firstWord("r1155 ring")).toBe("R1155");
    expect(firstWord("Em378 Diamond Earrings")).toBe("EM378");
  });

  it("ignores leading and inner spacing, incl. ideographic space, NBSP, tabs and newlines", () => {
    expect(firstWord("   R1155   Ring")).toBe("R1155");
    expect(firstWord("　EM378　Earrings")).toBe("EM378");
    expect(firstWord(" N4575 Necklace")).toBe("N4575");
    expect(firstWord("\tn4575\nNecklace")).toBe("N4575");
  });

  it("returns null for a blank line", () => {
    expect(firstWord("")).toBeNull();
    expect(firstWord("   ")).toBeNull();
    expect(firstWord(null)).toBeNull();
  });

  it("never turns a description word into a code — the literal first word is all that is compared", () => {
    expect(firstWord("Necklace K18 SSP White Pearl 45cm")).toBe("NECKLACE");
    expect(firstWord("Resize # 16")).toBe("RESIZE");
  });

  it("agrees with the SQL twin's self-check vectors", () => {
    // page365_first_word's in-migration self-check uses exactly these.
    expect(MIGRATION).toContain("page365_first_word('  r1155 Ring K18') IS DISTINCT FROM 'R1155'");
    expect(firstWord("  r1155 Ring K18")).toBe("R1155");
    expect(MIGRATION).toContain("page365_first_word(E'\\u3000EM378\\u3000Earrings') IS DISTINCT FROM 'EM378'");
    expect(firstWord("　EM378　Earrings")).toBe("EM378");
    expect(MIGRATION).toContain("page365_first_word(E'\\tn4575\\nNecklace') IS DISTINCT FROM 'N4575'");
    expect(firstWord("\tn4575\nNecklace")).toBe("N4575");
  });

  it("SQL compares case-insensitively on both sides and refuses codes with a space inside", () => {
    const m = fn("page365_match_line");
    expect(m).toContain("public.page365_first_word(wp.sku) = v_word");
    expect(m).toMatch(/wp\.sku !~ '\[\^\\s\\u3000\\u00a0\]\[\\s\\u3000\\u00a0\]\+\[\^\\s\\u3000\\u00a0\]'/);
  });
});

describe("exactly one product, exactly one variant", () => {
  const m = () => fn("page365_match_line");
  it("0 products → unmatched, 2+ → ambiguous_sku", () => {
    expect(m()).toMatch(/IF v_products = 0 THEN[\s\S]*'unmatched'/);
    expect(m()).toMatch(/ELSIF v_products > 1 THEN[\s\S]*'ambiguous_sku'/);
  });
  it("0 variants → no_variant, 2+ (sizes) → ambiguous_variant; only 1 → matched", () => {
    expect(m()).toMatch(/IF v_variants = 0 THEN[\s\S]*'no_variant'/);
    expect(m()).toMatch(/ELSIF v_variants > 1 THEN[\s\S]*'ambiguous_variant'/);
    expect(m()).toMatch(/RETURN QUERY SELECT v_word, 'matched'::text, v_pid, v_vid, v_stock;/);
  });
  it("does not look at product status (D7: draft/archived still reduce)", () => {
    expect(m()).not.toMatch(/status/);
  });
});

describe("claim before stock moves; never twice", () => {
  const a = () => fn("page365_apply_stock");
  it("claims the ledger line before the conditional decrement", () => {
    const claim = a().indexOf("ON CONFLICT ON CONSTRAINT uq_page365_stock_line DO NOTHING");
    const take = a().indexOf("SET stock_qty = wv.stock_qty - v_qty");
    expect(claim).toBeGreaterThan(-1);
    expect(take).toBeGreaterThan(claim);
  });
  it("uses the website's conditional decrement: only if enough is left", () => {
    expect(a()).toContain("WHERE wv.id = v_m.o_variant_id AND wv.stock_qty >= v_qty");
    expect(a()).toMatch(/ELSE[\s\S]*flag = 'insufficient_stock'/);
  });
  it("an already-claimed line is skipped, except a line whose order was deleted", () => {
    expect(a()).toContain("v_skipped := v_skipped + 1");
    expect(a()).toContain("AND l.cash_order_id IS NULL AND l.account_id IS NULL");
    expect(a()).toContain("AND l.stock_state <> 'held'");
  });
  it("reads lines from the stored draft, never from the browser", () => {
    expect(a()).toContain("FROM public.page365_drafts d WHERE d.id = p_draft_id");
    expect(a()).toContain("IF v_draft_no IS DISTINCT FROM v_page365_no THEN");
  });
  it("is callable by the service role only", () => {
    expect(MIGRATION).toContain(
      "REVOKE ALL ON FUNCTION public.page365_apply_stock(text, uuid, uuid, integer[], uuid) FROM PUBLIC, anon, authenticated;");
    expect(MIGRATION).toContain(
      "GRANT EXECUTE ON FUNCTION public.page365_apply_stock(text, uuid, uuid, integer[], uuid) TO service_role;");
  });
});

describe("giving stock back", () => {
  const t = () => fn("page365_stock_follow_order");
  it("covers cancel + expiry (cash) and cancel + forfeit + final forfeit (layaway), and delete", () => {
    expect(t()).toContain("ARRAY['cancelled','expired']");
    expect(t()).toContain("ARRAY['cancelled','forfeited','final_forfeited']");
    for (const trg of ["trg_page365_stock_follow_cash", "trg_page365_stock_follow_layaway"]) {
      expect(MIGRATION).toMatch(new RegExp(`CREATE TRIGGER ${trg}\\s+AFTER UPDATE OF status`));
      expect(MIGRATION).toMatch(new RegExp(`CREATE TRIGGER ${trg}_delete\\s+AFTER DELETE`));
    }
  });
  it("only moves what the ledger holds; orders without page365_no return at once", () => {
    expect(t()).toContain("IF v_no IS NULL OR NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;");
    expect(t()).toContain("WHERE l.page365_no = v_no AND l.stock_state = 'held'");
  });
  it("revive re-takes only if still in stock, else flags rehold_failed and never raises", () => {
    expect(t()).toContain("WHERE wv.id = v_row.variant_id AND wv.stock_qty >= v_row.quantity");
    expect(t()).toContain("SET flag = 'rehold_failed'");
    expect(t()).not.toMatch(/RAISE EXCEPTION/);
  });
});

describe("website checkout is untouched", () => {
  it("the migration defines only its own five functions", () => {
    const defined = [...MIGRATION.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map(m => m[1]).sort();
    expect(defined).toEqual([
      "page365_apply_stock", "page365_first_word", "page365_match_line",
      "page365_stock_follow_order", "resolve_page365_stock_flag",
    ]);
  });
  it("adds no trigger to the website tables", () => {
    expect(MIGRATION).not.toMatch(/CREATE TRIGGER[^;]*ON public\.website_/);
  });
});

describe("normaliseServiceLineNos", () => {
  it("keeps positive integers only, deduplicated and sorted", () => {
    expect(normaliseServiceLineNos([3, "1", 3, 0, -2, 1.5, "x", null])).toEqual([1, 3]);
    expect(normaliseServiceLineNos("4")).toEqual([]);
    expect(normaliseServiceLineNos(undefined)).toEqual([]);
  });
});

function fakeSupabase(opts: { draft?: { id: string; page365_no: number } | null; rpc?: (n: string, a: unknown) => unknown }) {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.draft ?? null, error: null }) }) }),
    }),
    rpc: async (name: string, args: unknown) => {
      calls.push([name, args]);
      return opts.rpc ? opts.rpc(name, args) : { data: null, error: { message: "no rpc" } };
    },
  };
}
const DRAFT = "d0000000-0000-4000-8000-000000001001";

describe("checkPage365Draft — a Page365 import must name its draft", () => {
  it("refuses a missing or malformed draft id (400)", async () => {
    const r = await checkPage365Draft(fakeSupabase({}), 1001, undefined);
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(await checkPage365Draft(fakeSupabase({}), 1001, "nope")).toMatchObject({ ok: false, status: 400 });
  });
  it("refuses a draft that is gone or belongs to another invoice (409)", async () => {
    expect(await checkPage365Draft(fakeSupabase({ draft: null }), 1001, DRAFT)).toMatchObject({ ok: false, status: 409 });
    expect(await checkPage365Draft(fakeSupabase({ draft: { id: DRAFT, page365_no: 9 } }), 1001, DRAFT))
      .toMatchObject({ ok: false, status: 409 });
  });
  it("accepts the matching draft", async () => {
    expect(await checkPage365Draft(fakeSupabase({ draft: { id: DRAFT, page365_no: 1001 } }), 1001, DRAFT))
      .toEqual({ ok: true, draftId: DRAFT });
  });
});

describe("applyPage365Stock", () => {
  it("sends the draft id and service lines, never line names or quantities", async () => {
    const sb = fakeSupabase({ rpc: () => ({ data: { ok: true, held: 1, flagged: 1, services: 1, already_claimed: 0 }, error: null }) });
    const r = await applyPage365Stock(sb, "cash", "o-1", DRAFT, [4], "u-1");
    expect(r.held).toBe(1);
    expect(sb.calls).toEqual([["page365_apply_stock", {
      p_order_kind: "cash", p_order_id: "o-1", p_draft_id: DRAFT, p_service_line_nos: [4], p_actor: "u-1",
    }]]);
  });
  it("throws on a database error so the caller rolls the order back", async () => {
    const sb = fakeSupabase({ rpc: () => ({ data: null, error: { message: "boom" } }) });
    await expect(applyPage365Stock(sb, "layaway", "o-1", DRAFT, [], null)).rejects.toThrow(/boom/);
  });
});

describe("previewPage365Stock — read-only, never blocks a fetch", () => {
  it("skips service lines without asking the matcher", async () => {
    const sb = fakeSupabase({ rpc: () => ({ data: [{ o_first_word: "R1155", o_match_result: "matched", o_stock_qty: 2 }], error: null }) });
    const out = await previewPage365Stock(sb, [
      { kind: "product", name: "R1155 Ring" },
      { kind: "service", name: "Resize # 12" },
    ]);
    expect(out[0]).toMatchObject({ first_word: "R1155", result: "matched", stock_qty: 2 });
    expect(out[1]).toMatchObject({ result: "service", first_word: "RESIZE" });
    expect(sb.calls.map(c => c[0])).toEqual(["page365_match_line"]);
  });
  it("returns null (not checked) when the matcher is not there yet", async () => {
    const out = await previewPage365Stock(fakeSupabase({}), [{ kind: "product", name: "R1155 Ring" }]);
    expect(out).toEqual([null]);
  });
});

describe("previewChip — review screen, before import", () => {
  const m = (result: string, stock_qty: number | null = null) =>
    ({ first_word: "ZT9001", result, stock_qty }) as Parameters<typeof previewChip>[0];
  // 'invoice' = the #195 behaviour, kept as the rollback (PR 2 made
  // inventory_sync the default — see page365-inventory-pr2.test.tsx).
  it("invoice mode: will take when enough is in stock", () => {
    expect(previewChip(m("matched", 2), 1, "product", "invoice")).toMatchObject({ tone: "take" });
  });
  it("invoice mode: will flag when the website already reserved or sold it — the order is still created", () => {
    expect(previewChip(m("matched", 0), 1, "product", "invoice")).toMatchObject({ tone: "flag", label: expect.stringMatching(/reserved or sold/) });
    expect(previewChip(m("matched", 1), 2, "product", "invoice").tone).toBe("flag");
  });
  it("will flag no code / several products / several sizes / no variant", () => {
    for (const r of ["unmatched", "ambiguous_sku", "ambiguous_variant", "no_variant"]) {
      expect(previewChip(m(r), 1, "product").tone).toBe("flag");
    }
    expect(previewChip(m("ambiguous_variant"), 1, "product").label).toMatch(/several sizes/);
  });
  it("resize/service lines are skipped, not flagged", () => {
    expect(previewChip(m("service"), 1, "product")).toMatchObject({ tone: "skip" });
    expect(previewChip(m("matched", 5), 1, "service")).toMatchObject({ tone: "skip" });
  });
  it("an older draft without a preview says not checked", () => {
    expect(previewChip(undefined, 1, "product")).toMatchObject({ tone: "unknown", label: "Stock not checked" });
  });
});

describe("ledgerChip — order pages, after import", () => {
  const l = (over: Partial<Parameters<typeof ledgerChip>[0]>) =>
    ({ match_result: "matched", stock_state: "none", flag: null, resolved_at: null, ...over }) as Parameters<typeof ledgerChip>[0];
  it("stock taken / returned / skipped / flagged", () => {
    expect(ledgerChip(l({ stock_state: "held" })).label).toBe("Stock taken");
    expect(ledgerChip(l({ stock_state: "released" })).label).toBe("Stock returned");
    expect(ledgerChip(l({ match_result: "not_a_product" })).label).toBe("Service — skipped");
    expect(ledgerChip(l({ flag: "insufficient_stock" })).label).toBe("Flagged · Not enough stock");
  });
  it("an open flag outranks the stock state (rehold after revive)", () => {
    expect(ledgerChip(l({ stock_state: "released", flag: "rehold_failed" })).tone).toBe("flag");
  });
  it("the owner's four reasons are worded as agreed", () => {
    expect(FLAG_REASON.unmatched).toBe("No product code");
    expect(FLAG_REASON.ambiguous_sku).toBe("Several products");
    expect(FLAG_REASON.ambiguous_variant).toBe("Several sizes");
    expect(FLAG_REASON.insufficient_stock).toBe("Not enough stock");
  });
  it("import summary", () => {
    expect(importSummary({ held: 1, flagged: 2 })).toBe("1 line took website stock · 2 flagged for staff");
    expect(importSummary({ held: 0, flagged: 0 })).toBeNull();
  });
});

describe("edge wiring", () => {
  for (const [file, kind, table] of [
    ["supabase/functions/create-cash-order/index.ts", "cash", "cash_orders"],
    ["supabase/functions/create-layaway-account/index.ts", "layaway", "layaway_accounts"],
  ] as const) {
    it(`${file}: checks the draft before writing, applies after extras, rolls back on error`, () => {
      const s = src(file);
      const check = s.indexOf("checkPage365Draft(supabase, page365_no, page365_draft_id)");
      const insert = s.indexOf(`.from("${table}")\n      .insert(`);
      const extras = s.indexOf("await writeOrderExtras(");
      const apply = s.indexOf(`applyPage365Stock(\n          supabase, "${kind}"`);
      expect(check).toBeGreaterThan(-1);
      expect(extras).toBeGreaterThan(-1);
      expect(apply).toBeGreaterThan(extras);
      if (insert > -1) expect(check).toBeLessThan(insert);
      const after = s.slice(apply, apply + 700);
      expect(after).toContain(`await supabase.from("${table}").delete().eq("id",`);
      expect(s).toContain("page365_stock: page365Stock");
    });
  }
  it("ordinary staff orders never reach the stock step (gated on page365_no)", () => {
    for (const f of ["supabase/functions/create-cash-order/index.ts", "supabase/functions/create-layaway-account/index.ts"]) {
      const s = src(f);
      expect(s).toMatch(/if \(page365_no != null\) \{\n\s+const draftCheck/);
      expect(s).toContain("if (page365DraftId) {");
    }
  });
  it("page365-fetch-order only previews", () => {
    const s = src("supabase/functions/page365-fetch-order/index.ts");
    expect(s).toContain("await previewPage365Stock(supabase, items)");
    expect(s).not.toContain("page365_apply_stock");
  });
});

// ── Order-page panel ───────────────────────────────────────────────────────
let panelRows: unknown[] = [];
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ order: async () => ({ data: panelRows, error: null }) }) }),
    }),
  },
}));
import Page365StockPanel from "@/components/page365/Page365StockPanel";

function mountPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}><Page365StockPanel kind="cash" orderId="o-1" /></QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("Page365StockPanel", () => {
  beforeEach(() => { panelRows = []; });
  it("renders nothing for an order that never took stock through the ledger", async () => {
    const { container } = mountPanel();
    await new Promise(r => setTimeout(r, 10));
    expect(container.querySelector("[data-testid='page365-stock-panel']")).toBeNull();
  });
  it("shows taken / flagged / returned / skipped per line and links the open flags", async () => {
    const base = { page365_no: 1001, cash_order_id: "o-1", account_id: null, first_word: null, quantity: 1,
      stock_seen: null, held_at: null, released_at: null, resolved_at: null, resolution_note: null, created_at: "" };
    panelRows = [
      { ...base, id: "1", line_no: 1, line_name: "ZT9001 Test ring", match_result: "matched", stock_state: "held", flag: null },
      { ...base, id: "2", line_no: 2, line_name: "ZT9002 Test earrings", match_result: "matched", stock_state: "none", flag: "insufficient_stock" },
      { ...base, id: "3", line_no: 3, line_name: "Necklace test", match_result: "unmatched", stock_state: "none", flag: "unmatched" },
      { ...base, id: "4", line_no: 4, line_name: "Resize # 12", match_result: "not_a_product", stock_state: "none", flag: null },
      { ...base, id: "5", line_no: 5, line_name: "ZT9003 ring", match_result: "matched", stock_state: "released", flag: null },
    ];
    mountPanel();
    expect(await screen.findByText("Stock taken")).toBeInTheDocument();
    expect(screen.getByText("Flagged · Not enough stock")).toBeInTheDocument();
    expect(screen.getByText("Flagged · No product code")).toBeInTheDocument();
    expect(screen.getByText("Service — skipped")).toBeInTheDocument();
    expect(screen.getByText("Stock returned")).toBeInTheDocument();
    expect(screen.getByText(/2 flagged/)).toHaveAttribute("href", "/website?tab=page365-stock");
  });
});
