import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  markDuplicates, matchOne, orderedPhotos, parseFileName, type CutoutState, type ProductPhotos,
} from "@/lib/cutout-bulk";

/**
 * Website → Photos → "Upload from Photoroom" (owner request 2026-09-27):
 * files from a Photoroom APP batch edit, matched by name (product code +
 * photo number, both editable), applied as "Upload my own cut-out".
 */

describe("parseFileName — product code first, then the photo number", () => {
  it.each([
    ["AL123.png", "AL123", 1],
    ["al123.png", "AL123", 1],
    ["AL123-2.png", "AL123", 2],
    ["AL123_3.png", "AL123", 3],
    ["AL123 4.png", "AL123", 4],
    ["AL123 (2).png", "AL123", 2],
    ["AL123(5).png", "AL123", 5],
    ["AL123-2_photoroom.png", "AL123", 2],
    ["AL123_photoroom.png", "AL123", 1],
    ["C1395-12.webp", "C1395", 12],
    ["AL123-100.png", "AL123", 1], // 3 digits is not a photo number
    ["---.png", "", 1],
  ])("%s → %s photo %i", (name, code, n) => {
    expect(parseFileName(name)).toEqual({ code, photoNo: n });
  });
});

describe("orderedPhotos — the Catalog order", () => {
  it("variants by sort, then each variant's photos by sort, each link once", () => {
    expect(orderedPhotos([
      { sort: 1, website_product_media: [{ url: "c", sort: 0 }, { url: "a", sort: 1 }] },
      { sort: 0, website_product_media: [{ url: "b", sort: 1 }, { url: "a", sort: 0 }] },
    ])).toEqual(["a", "b", "c"]);
  });
});

describe("matchOne / markDuplicates", () => {
  const product: ProductPhotos = { productId: "p", sku: "AL123", name: "Heart pendant", photos: ["u1", "u2"] };
  const products = new Map([["AL123", [product]], ["DUP1", [product, { ...product, productId: "q" }]]]);
  const states = new Map<string, CutoutState>([
    ["u1", { status: "needs_review", job_state: "done" }],
    ["u2", { status: "approved", job_state: "ready" }],
  ]);
  const png = { isImage: true, transparent: true };

  it("a transparent PNG for an existing photo is ready", () => {
    expect(matchOne("al123", 1, png, products, states)).toMatchObject({ ready: true, problem: null, sourceUrl: "u1", status: "needs_review" });
  });
  it.each([
    ["", 1, png, "no_code"],
    ["ZZ9", 1, png, "not_found"],
    ["DUP1", 1, png, "several_products"],
    ["AL123", 3, png, "no_such_photo"],
    ["AL123", 2, png, "busy"],
    ["AL123", 1, { isImage: true, transparent: false }, "not_transparent"],
    ["AL123", 1, { isImage: false, transparent: false }, "not_image"],
  ])("%s photo %i → %s", (code, n, file, problem) => {
    expect(matchOne(code as string, n as number, file as typeof png, products, states).problem).toBe(problem);
  });
  it("a photo with no cut-out row is not applied", () => {
    expect(matchOne("AL123", 1, png, products, new Map()).problem).toBe("not_in_list");
  });
  it("two files for one photo: neither is applied", () => {
    const a = matchOne("AL123", 1, png, products, states);
    expect(markDuplicates([a, a]).map((r) => r.problem)).toEqual(["duplicate", "duplicate"]);
  });
});

// ---------------------------------------------------------------------------
// The window itself.
// ---------------------------------------------------------------------------
const uploads: string[] = [];
const reviews: Array<{ url: string; action: string; opts: Record<string, unknown> }> = [];

vi.mock("@/lib/media-cutouts", async (orig) => {
  const real = await orig<typeof import("@/lib/media-cutouts")>();
  return {
    ...real,
    hasTransparency: vi.fn(async (f: File) => !f.name.includes("flat")),
    uploadOwnCutout: vi.fn(async (f: File) => { uploads.push(f.name); return `https://x/storage/v1/object/public/promotions/website/derived/own/${f.name}`; }),
    review: vi.fn(async (url: string, action: string, opts: Record<string, unknown>) => { reviews.push({ url, action, opts }); return { ok: true }; }),
  };
});

vi.mock("@/lib/cutout-bulk", async (orig) => {
  const real = await orig<typeof import("@/lib/cutout-bulk")>();
  return {
    ...real,
    fetchProductPhotos: vi.fn(async (codes: string[]) => new Map(
      codes.filter((c) => c === "AL123").map((c) => [c, [{ productId: "p", sku: "AL123", name: "Heart pendant", photos: ["https://src/u1.jpg", "https://src/u2.jpg"] }]]),
    )),
    fetchCutoutStates: vi.fn(async (urls: string[]) => new Map(urls.map((u) => [u, { status: "needs_review", job_state: "done" }]))),
  };
});

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import CutoutBulkUpload from "@/components/website/CutoutBulkUpload";

const wrap = (ui: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};
const file = (name: string) => new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });

describe("Upload from Photoroom window", () => {
  beforeEach(() => {
    uploads.length = 0; reviews.length = 0;
    // jsdom has no object URLs
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:x";
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
  });

  it("matches by name, lets the code be edited, and applies only ready rows as own cut-outs", async () => {
    wrap(<CutoutBulkUpload open onOpenChange={() => {}} />);
    const input = screen.getByLabelText("Photoroom files");
    fireEvent.change(input, { target: { files: [file("AL123.png"), file("AL123-2.png"), file("XX999.png"), file("AL123-3.png")] } });

    const rows = await screen.findAllByTestId("bulk-row");
    expect(rows).toHaveLength(4);
    await waitFor(() => expect(within(rows[0]).getByText(/Photo 1 \(main\) of 2/)).toBeInTheDocument());
    expect(within(rows[1]).getByText(/Photo 2 of 2/)).toBeInTheDocument();
    expect(within(rows[2]).getByText("No product has this code.")).toBeInTheDocument();
    expect(within(rows[3]).getByText(/no photo with that number/)).toBeInTheDocument();

    // Fix the wrong code: XX999 → AL123 photo 1 would duplicate row 1, so make it photo 2… also a duplicate.
    fireEvent.change(within(rows[2]).getByLabelText("Product code for XX999.png"), { target: { value: "al123" } });
    await waitFor(() => expect(within(rows[2]).getByText("Another file is set for the same photo.")).toBeInTheDocument());
    // Remove it instead; drop the extra photo 3.
    fireEvent.click(within(rows[2]).getByLabelText("Remove XX999.png"));
    fireEvent.click(within(screen.getAllByTestId("bulk-row")[2]).getByLabelText("Remove AL123-3.png"));

    const apply = await screen.findByRole("button", { name: "Apply 2" });
    fireEvent.click(apply);
    await waitFor(() => expect(reviews).toHaveLength(2));
    expect(uploads.sort()).toEqual(["AL123-2.png", "AL123.png"]);
    expect(reviews.map((r) => [r.url, r.action]).sort()).toEqual([
      ["https://src/u1.jpg", "own_cutout"], ["https://src/u2.jpg", "own_cutout"],
    ]);
    for (const r of reviews) expect(r.opts).toMatchObject({ expected: "needs_review" });
    expect(await screen.findAllByText(/Saved — lands approved/)).toHaveLength(2);
  });

  it("a file without a transparent background is never applied", async () => {
    wrap(<CutoutBulkUpload open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText("Photoroom files"), { target: { files: [file("AL123-flat.png")] } });
    await screen.findByText(/No transparent background/);
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });
});
