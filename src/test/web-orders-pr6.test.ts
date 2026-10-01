import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Website orders PR 6 — the checkout Hub side (docs/WEB-ORDER-DRAFTS.md "PR 6").
 * Source-level guards on the edge functions (they run on Deno, not here).
 * Comment lines are stripped so a pattern can only match code.
 */
const code = (f: string) =>
  readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

const WEBSITE = "supabase/functions/website/index.ts";
const SWEEP = "supabase/functions/web-reservation-sweep/index.ts";
const CONFIRM = "supabase/functions/confirm-web-draft/index.ts";
const EMAILS = "supabase/functions/_shared/reservation-emails.ts";

describe("the checkout switch", () => {
  const src = code(WEBSITE);

  // WEBSITE ORDERS PR 10 (2026-10-01): the switch is no longer read by the
  // website function — every checkout is a draft. The old writers are gone.
  it("pay: the draft writer is the ONLY checkout writer; the old writers and the switch read are gone", () => {
    const pay = src.slice(src.indexOf('segments[1] === "pay"'));
    expect(pay).toMatch(/rpc\("create_web_draft_atomic", \{/);
    expect(src).not.toMatch(/rpc\("create_web_layaway_atomic"/);
    expect(src).not.toMatch(/rpc\("create_web_order_atomic"/);
    expect(src).not.toMatch(/checkoutDraftMode|reservationModeOn|web_checkout_mode|readReservationMode/);
    expect(src).not.toMatch(/p_reserve/);
  });

  it("a draft response carries draft_id and never an order_id / account_id or bank details", () => {
    const pay = src.slice(src.indexOf('rpc("create_web_draft_atomic", {'));
    const resp = pay.slice(pay.indexOf("return jsonResponse(scrub({"), pay.indexOf("}));"));
    expect(resp).toMatch(/draft_id: draft\.draft_id/);
    expect(resp).not.toMatch(/order_id|account_id/);
    expect(resp).toMatch(/transfer_methods: \[\]/);
  });

  it("quote: a destination with no published rate is 'added at confirmation', never a dead end", () => {
    expect(src).toMatch(/const shippingAtConfirmation = shipping === null;/);
    expect(src).not.toMatch(/shipping_quote_required" \}, 400\)/);
    expect(src).toMatch(/requires_manual_quote: false,/);
    expect(src).toMatch(/shipping_at_confirmation: shippingJpy === null,/);
  });
});

describe("a customer's drafts", () => {
  const src = code(WEBSITE);
  it("both draft reads are scoped to the signed-in customer", () => {
    const reads = src.slice(src.indexOf('segments[0] === "drafts" && !segments[1]'), src.indexOf('segments[0] === "orders" && !segments[1]'));
    expect(reads.match(/\.from\("web_order_drafts"\)/g)).toHaveLength(2);
    expect(reads.match(/\.eq\("customer_id", customer\.id\)/g)).toHaveLength(2);
  });

  it("/me counts open drafts, so a draft-only customer raises no blank-account bell", () => {
    expect(src).toMatch(/records\.layaway === 0 && records\.orders === 0 && records\.drafts === 0 && sharesEmail/);
  });

  it("a service request may target an open draft of the same customer", () => {
    expect(src).toMatch(/\.from\("web_order_drafts"\)\.select\("id, invoice_seq, status"\)\s*\.eq\("id", draftId\)\.eq\("customer_id", customer\.id\)/);
    expect(src).toMatch(/web_draft_id: draftId \|\| null,/);
  });
});

describe("sweep, decline and emails", () => {
  it("the hourly sweep expires drafts after 72 hours and tells the customer", () => {
    const src = code(SWEEP);
    expect(src).toMatch(/rpc\("expire_web_drafts_atomic", \{/);
    expect(src).toMatch(/sendDraftClosedEmail\(supabase, String\(d\.id\), "lapsed"\)/);
    expect(src).toMatch(/\.from\("web_order_drafts"\)\s*\.update\(\{ reservation_reminded_at: stampedAt \}\)/);
  });

  it("Can't supply emails the customer after the decline commits", () => {
    const src = code(CONFIRM);
    const decline = src.slice(src.indexOf('rpc("decline_web_draft_atomic", {'));
    expect(decline).toMatch(/sendDraftClosedEmail\(supabase, draftId, "declined", reason\)/);
  });

  it("draft emails are keyed per draft and never reuse an order's key", () => {
    const src = code(EMAILS);
    expect(src).toMatch(/idempotencyKey: `draft-reserved-\$\{draftId\}`/);
    expect(src).toMatch(/idempotencyKey: `draft-\$\{kind\}-\$\{draftId\}`/);
  });
});
