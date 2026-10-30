import { useState } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) } } }));

import ProductDialog from "@/components/website/ProductDialog";
import {
  appendStyling, checkStylingSuggestion, stylingProduct, stylingStillApplies,
} from "@/components/website/ai-styling";
import { requestStyling } from "@/components/website/ai-styling-client";
import { type ProductForm, emptyProduct } from "@/components/website/product-form";

/**
 * "Suggest styling text (AI)" (owner 2026-10-31): catalog staff, first photo
 * included, suggestion checked against the business rules before staff see it,
 * added only to the English description and only on "Add to description",
 * saved only by Save. Fixtures and a mocked function call only.
 */

const P = { name: "K18 Rope Chain 45cm", weight_g: 4.2, description_en: "K18 gold rope chain, 45cm, 4.2g." };
const GOOD = "Wear it alone for a clean everyday look, or layer it with a shorter chain for evenings. A thoughtful gift for birthdays and anniversaries.";

describe("what is sent", () => {
  it("name, weight and English description only, trimmed", () => {
    expect(stylingProduct({ name: " Ring ", weight_g: 2, description_en: " K18 gold. " })).toEqual({ name: "Ring", weight_g: 2, description_en: "K18 gold." });
  });
  it("no weight when it is empty or zero", () => {
    expect(stylingProduct({ name: "Ring", weight_g: 0, description_en: "" })).toEqual({ name: "Ring", description_en: "" });
    expect(stylingProduct({ name: "Ring", weight_g: null as unknown as number, description_en: "" })).toEqual({ name: "Ring", description_en: "" });
  });
});

describe("business-rule check before staff see a suggestion", () => {
  it("a plain styling paragraph passes", () => {
    expect(checkStylingSuggestion(GOOD, P)).toEqual({ ok: true, text: GOOD });
  });
  it("numbers already in the product are allowed", () => {
    expect(checkStylingSuggestion("The 45cm length sits just below the collarbone.", P).ok).toBe(true);
  });
  it("ordinary words like 'focal point' are not blocked", () => {
    expect(checkStylingSuggestion("A delicate focal point for an open neckline.", P).ok).toBe(true);
  });
  const blocked: [string, RegExp][] = [
    ["Reserve it today with layaway.", /layaway/],
    ["Pay in easy monthly payments.", /layaway/],
    ["Beautifully Made in Japan.", /Made in Japan/],
    ["日本製のチェーンです。", /Made in Japan/],
    ["Classic Japanese gold for every day.", /country name/],
    ["Saudi gold sparkle.", /country name/],
    ["Crafted in 18 karat gold.", /purity/],
    ["Made from 18k gold.", /purity/],
    ["A genuine piece with a certificate.", /authenticity/],
    ["Guaranteed to last.", /authenticity/],
    ["Only ¥30,000 this week.", /price/],
    ["Now on sale.", /price/],
    ["Earn loyalty points with every purchase.", /price/],
    ["Adds 2 more inches of drape.", /number/],
  ];
  it.each(blocked)("blocks %s", (text, reason) => {
    const r = checkStylingSuggestion(text, P);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  });
  it("blocks empty, over-long and list-formatted replies", () => {
    expect(checkStylingSuggestion("  ", P).ok).toBe(false);
    expect(checkStylingSuggestion("a ".repeat(500), P).ok).toBe(false);
    expect(checkStylingSuggestion("- Wear it daily\n- Gift it", P).ok).toBe(false);
    expect(checkStylingSuggestion("**Style tip** wear it", P).ok).toBe(false);
  });
  it("line breaks inside a paragraph are joined", () => {
    expect(checkStylingSuggestion("Wear it daily.\nGift it.", P)).toEqual({ ok: true, text: "Wear it daily. Gift it." });
  });
});

describe("how an accepted suggestion lands", () => {
  it("a new paragraph at the end of the English description", () => {
    expect(appendStyling("K18 gold rope chain.  \n", GOOD)).toBe(`K18 gold rope chain.\n\n${GOOD}`);
  });
  it("the whole description when it was empty", () => {
    expect(appendStyling("   ", GOOD)).toBe(GOOD);
  });
  it("a suggestion for another product or a reopened editor no longer applies", () => {
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
    expect(screen.getByTestId("suggest-styling").textContent).toMatch("Suggest styling text (AI)");
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
    expect(accept).toMatch(/description_en: appendStyling\(f\.description_en, s\.text\)/);
    expect(accept).not.toMatch(/description_ja|save\.mutate|\.update\(|\.upsert\(/);
  });
  it("the reply is checked before it is shown", () => {
    expect(src).toMatch(/checkStylingSuggestion\(reply\.text/);
  });
});
