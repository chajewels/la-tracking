import { useState } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) } } }));

import ProductDialog from "@/components/website/ProductDialog";
import {
  checkStylingSuggestion, placeAboveExisting, stylingProduct, stylingStillApplies,
} from "@/components/website/ai-styling";
import { requestStyling } from "@/components/website/ai-styling-client";
import { type ProductForm, emptyProduct } from "@/components/website/product-form";

/**
 * "Write description (AI)" (owner 2026-10-30/31): catalog staff, first photo
 * included, the approved R8913 sample's shape (piece paragraphs, preloved line,
 * "Lovely for:" line), checked against the business rules before staff see it,
 * placed ABOVE the existing English description (never changed) only on "Add to
 * description", saved only by Save. Fixtures and a mocked function call only.
 */

const P = { name: "K18 Rope Chain 45cm", weight_g: 4.2, description_en: "K18 gold rope chain, 45cm, 4.2g.", metal: "K18", condition: "Preloved" as const, size: "45cm" };
const GOOD = [
  "Fine K18 links twist together in a warm golden rope, catching soft light with every movement. At 45cm it rests just below the collarbone, easy to wear alone or with a pendant.",
  "A preloved piece, carefully checked by our team before listing, ready to start its next chapter with you.",
  "Lovely for: anniversaries · a birthday gift for her · a treat for yourself · everyday elegance",
].join("\n\n");

describe("what is sent", () => {
  const form = {
    name: " Ring ", weight_g: 2, description_en: " K18 gold. ", metals: ["K18", "PT900"], brand: "Tiffany & Co.",
    origin: "BRAND", condition: "Preloved",
    variants: [{ size: "40cm", stone: "Diamond" }, { size: "45cm", stone: "Diamond" }, { size: " ", stone: null }],
  } as unknown as Parameters<typeof stylingProduct>[0];
  it("name, weight, description, metal, brand, condition, sizes and stones, trimmed and de-duplicated", () => {
    expect(stylingProduct(form)).toEqual({
      name: "Ring", weight_g: 2, description_en: "K18 gold.", metal: "K18, PT900", brand: "Tiffany & Co.",
      condition: "Preloved", size: "40cm, 45cm", stone: "Diamond",
    });
  });
  it("never sends origin; the brand only for a Branded piece", () => {
    const out = stylingProduct({ ...form, origin: "JAPAN" } as typeof form);
    expect(out).not.toHaveProperty("origin");
    expect(out.brand).toBeUndefined();
  });
  it("no weight, metal, size or stone when they are empty", () => {
    expect(stylingProduct({ name: "Ring", weight_g: 0, description_en: "" })).toEqual({ name: "Ring", description_en: "" });
  });
  it("silver shows as staff say it", () => {
    expect(stylingProduct({ ...form, metals: ["SILVER925"] } as typeof form).metal).toBe("Silver 925");
  });
});

describe("business-rule check before staff see a description", () => {
  it("the approved shape passes, paragraph breaks kept", () => {
    expect(checkStylingSuggestion(GOOD, P)).toEqual({ ok: true, text: GOOD });
  });
  it("extra blank lines and spaces are tidied", () => {
    const messy = GOOD.replace(/\n\n/g, "\n\n\n  ");
    expect(checkStylingSuggestion(messy, P)).toEqual({ ok: true, text: GOOD });
  });
  it("ordinary words like 'focal point' are not blocked", () => {
    expect(checkStylingSuggestion("A delicate focal point for an open neckline.\n\nLovely for: evenings out · a gift for her", P).ok).toBe(true);
  });
  const L = "\n\nLovely for: anniversaries · a gift for her";
  const blocked: [string, RegExp][] = [
    ["Reserve it today with layaway." + L, /layaway/],
    ["Pay in easy monthly payments." + L, /layaway/],
    ["Beautifully Made in Japan." + L, /Japan/],
    ["日本製のチェーンです。" + L, /Japan/],
    ["A chic Tokyo-inspired look." + L, /Japan or Tokyo/],
    ["Classic Japanese gold for every day." + L, /Japan/],
    ["Saudi gold sparkle." + L, /country name/],
    ["Crafted in 18 karat gold." + L, /purity/],
    ["Made from 18k gold." + L, /purity/],
    ["A genuine piece with a certificate." + L, /authenticity/],
    ["Authenticated before listing." + L, /authenticity/],
    ["Guaranteed to last." + L, /authenticity/],
    ["Only ¥30,000 this week." + L, /price/],
    ["Now on sale." + L, /price/],
    ["Earn loyalty points with every purchase." + L, /price/],
    ["Adds 2 more inches of drape." + L, /number/],
  ];
  it.each(blocked)("blocks %s", (text, reason) => {
    const r = checkStylingSuggestion(text, P);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  });
  it("blocks a reply without the 'Lovely for:' line last", () => {
    const r = checkStylingSuggestion("A lovely chain.", P);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Lovely for:/);
    expect(checkStylingSuggestion("Lovely for: gifts\n\nA lovely chain.", P).ok).toBe(false);
  });
  it("blocks empty, over-long, too many parts and list-formatted replies", () => {
    expect(checkStylingSuggestion("  ", P).ok).toBe(false);
    expect(checkStylingSuggestion("a ".repeat(700) + L, P).ok).toBe(false);
    expect(checkStylingSuggestion("a\n\nb\n\nc\n\nd" + L, P).ok).toBe(false);
    expect(checkStylingSuggestion("- Wear it daily\n- Gift it" + L, P).ok).toBe(false);
    expect(checkStylingSuggestion("1. Wear it daily" + L, P).ok).toBe(false);
    expect(checkStylingSuggestion("**Style tip** wear it" + L, P).ok).toBe(false);
  });
});

describe("how an accepted description lands", () => {
  it("ABOVE the existing English description, which is kept exactly as it is", () => {
    const existing = "PT900 8.90g / Sapphire 0.95ct / Diamond 0.71ct / Halo Cocktail / Sz# 13 [Preloved]  \n";
    expect(placeAboveExisting(existing, GOOD)).toBe(`${GOOD}\n\n${existing}`);
    expect(placeAboveExisting(existing, GOOD).endsWith(existing)).toBe(true);
  });
  it("the whole description when it was empty", () => {
    expect(placeAboveExisting("   ", GOOD)).toBe(GOOD);
  });
  it("a description for another product or a reopened editor no longer applies", () => {
    expect(stylingStillApplies({ session: 3, id: "p1" }, 3, "p1")).toBe(true);
    expect(stylingStillApplies({ session: 3, id: "p1" }, 4, "p1")).toBe(false);
    expect(stylingStillApplies({ session: 3, id: "p1" }, 3, "p2")).toBe(false);
  });
});

describe("the function call", () => {
  beforeEach(() => invoke.mockReset());
  it("calls gemini-product-enhance with the product and returns the paragraph", async () => {
    invoke.mockResolvedValue({ data: { ok: true, addition: GOOD, image_processed: false }, error: null });
    await expect(requestStyling(P, null)).resolves.toEqual({ text: GOOD, usedPhoto: false });
    expect(invoke).toHaveBeenCalledWith("gemini-product-enhance", { body: { product: P } });
  });
  it("a refused reply becomes a plain message", async () => {
    invoke.mockResolvedValue({ data: { ok: false, message: "Gemini is not connected." }, error: null });
    await expect(requestStyling(P, null)).rejects.toThrow("Gemini is not connected.");
  });
  it("an HTTP error uses the function's message", async () => {
    invoke.mockResolvedValue({ data: null, error: { message: "Edge Function returned a non-2xx status code", context: new Response(JSON.stringify({ message: "Missing permission." }), { status: 403 }) } });
    await expect(requestStyling(P, null)).rejects.toThrow("Missing permission.");
  });
  it("a photo that cannot be read is skipped and the text is still sent", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    invoke.mockResolvedValue({ data: { ok: true, addition: GOOD, image_processed: false }, error: null });
    await expect(requestStyling(P, "https://x.test/a.jpg")).resolves.toEqual({ text: GOOD, usedPhoto: false });
    expect(invoke).toHaveBeenCalledWith("gemini-product-enhance", { body: { product: P } });
    f.mockRestore();
  });
});

describe("editor", () => {
  function Harness(props: {
    can?: boolean; styling?: { text: string; usedPhoto: boolean } | null; start?: ProductForm;
    onSuggest?: () => void; onAccept?: () => void; onDiscard?: () => void; suggesting?: boolean;
  }) {
    const [form, setForm] = useState<ProductForm>(props.start ?? { ...emptyProduct(), name: "Ring" });
    return (
      <ProductDialog
        open onOpenChange={() => {}} form={form} setForm={setForm}
        collections={[]} categories={[]} isAdmin translating={false} uploadingKeys={[]}
        peso={String} saving={false} onSave={() => {}} onTranslateDescription={() => {}}
        canSuggestStyling={props.can} suggestingStyling={props.suggesting} styling={props.styling}
        onSuggestStyling={props.onSuggest ?? (() => {})} onAcceptStyling={props.onAccept} onDiscardStyling={props.onDiscard}
        onUploadMedia={() => {}} onPatchVariant={() => {}}
      />
    );
  }
  it("hidden for staff without catalog permission", () => {
    render(<Harness can={false} />);
    expect(screen.queryByTestId("suggest-styling")).toBeNull();
  });
  it("shown for catalog staff; pressing it asks once", () => {
    const onSuggest = vi.fn();
    render(<Harness can onSuggest={onSuggest} />);
    fireEvent.click(screen.getByTestId("suggest-styling"));
    expect(onSuggest).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("suggest-styling").textContent).toMatch("Write description (AI)");
  });
  it("disabled without an English name, and while a request runs", () => {
    const { unmount } = render(<Harness can start={{ ...emptyProduct(), name: " " }} />);
    expect((screen.getByTestId("suggest-styling") as HTMLButtonElement).disabled).toBe(true);
    unmount();
    render(<Harness can suggesting />);
    expect((screen.getByTestId("suggest-styling") as HTMLButtonElement).disabled).toBe(true);
  });
  it("a suggestion is shown with Add / Discard, and says whether the photo was used", () => {
    const onAccept = vi.fn(); const onDiscard = vi.fn();
    render(<Harness can styling={{ text: GOOD, usedPhoto: true }} onAccept={onAccept} onDiscard={onDiscard} />);
    const box = screen.getByTestId("styling-suggestion");
    expect(box.textContent).toContain(GOOD);
    expect(box.textContent).toMatch(/first photo/);
    expect(box.textContent).toMatch(/Japanese description is not changed/);
    expect(box.textContent).toMatch(/above the existing English description/);
    fireEvent.click(screen.getByText("Add to description"));
    fireEvent.click(screen.getByText("Discard"));
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });
  it("no suggestion box until there is a suggestion", () => {
    render(<Harness can />);
    expect(screen.queryByTestId("styling-suggestion")).toBeNull();
  });
});

describe("ProductsCard wiring (source pins)", () => {
  const src = readFileSync(resolve(__dirname, "../components/website/ProductsCard.tsx"), "utf8");
  it("only catalog staff get the button", () => {
    expect(src).toMatch(/canSuggestStyling=\{canManage\}/);
    expect(src).toMatch(/if \(!canManage \|\| save\.isPending \|\| suggestingStyling\) return;/);
  });
  it("a late reply for another product or a reopened editor is dropped", () => {
    expect(src).toMatch(/if \(!stylingStillApplies\(ask, editSession\.current, formRef\.current\.id\)\) return;/);
  });
  it("Add changes only the English description in the form (no save, no Japanese)", () => {
    const accept = src.slice(src.indexOf("function acceptStyling()"), src.indexOf("function acceptStyling()") + 700);
    expect(accept).toMatch(/description_en: placeAboveExisting\(f\.description_en, s\.text\)/);
    expect(accept).not.toMatch(/description_ja|save\.mutate|\.update\(|\.upsert\(/);
  });
  it("the reply is checked before it is shown", () => {
    expect(src).toMatch(/checkStylingSuggestion\(reply\.text/);
  });
});
