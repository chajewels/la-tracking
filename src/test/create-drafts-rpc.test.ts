import { describe, it, expect, vi, beforeEach } from "vitest";

// Calls the REAL page365-drafts-api against the REAL supabase-js client.
// Only the network (fetch) is stubbed, so an unbound supabase method fails here
// exactly as it does in production.
describe("page365-drafts-api reaches PostgREST through a bound client", () => {
  let calls: string[] = [];
  beforeEach(() => {
    calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ ok: true, created: 0, skipped: 0, failed: 0 }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }));
  });

  it("createDrafts posts to rpc/page365_inventory_create_drafts", async () => {
    const { createDrafts } = await import("@/lib/page365-drafts-api");
    const r = await createDrafts("00000000-0000-0000-0000-000000000001", ["00000000-0000-0000-0000-000000000002"]);
    expect(r.ok).toBe(true);
    expect(calls.some(u => u.includes("/rest/v1/rpc/page365_inventory_create_drafts"))).toBe(true);
  });

  it("publishProducts posts to rpc/website_publish_products", async () => {
    const { publishProducts } = await import("@/lib/page365-drafts-api");
    const r = await publishProducts(["00000000-0000-0000-0000-000000000003"]);
    expect(r.ok).toBe(true);
    expect(calls.some(u => u.includes("/rest/v1/rpc/website_publish_products"))).toBe(true);
  });
});

// The staff-facing toasts read (e as Error).message. A PostgREST error must still
// arrive as that same message after the switch to callUntypedRpc.
describe("page365-drafts-api surfaces the PostgREST error message unchanged", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ code: "42501", message: "permission denied for function x", details: null, hint: null }), {
        status: 403, headers: { "Content-Type": "application/json" },
      })));
  });

  it("createDrafts rejects with the server's message", async () => {
    const { createDrafts } = await import("@/lib/page365-drafts-api");
    await expect(createDrafts("00000000-0000-0000-0000-000000000001", []))
      .rejects.toMatchObject({ message: "permission denied for function x" });
  });

  it("publishProducts rejects with the server's message", async () => {
    const { publishProducts } = await import("@/lib/page365-drafts-api");
    await expect(publishProducts([])).rejects.toMatchObject({ message: "permission denied for function x" });
  });
});
