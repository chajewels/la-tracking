import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Website orders W2-7 (owner decision 2026-09-27): a web cash order that has
 * received a real payment (web_released_at) is never expired by the clock and
 * never sent a payment reminder. docs/WEB-ORDER-DRAFTS.md "W2-7".
 */
const MIG = readFileSync("supabase/migrations/20261019100000_w2_7_part_paid_web_orders.sql", "utf8");
const SWEEP = readFileSync("supabase/functions/auto-expire-cash-orders/index.ts", "utf8");

describe("W2-7", () => {
  it("starts from the live bodies (md5-guarded) and changes only by the guards", () => {
    expect(MIG).toContain("'3f6044fd1e267df17f526de4bb9278e4'");
    expect(MIG).toContain("'5809da9e0cd909103413258d508bc610'");
    expect(MIG).toMatch(/PERFORM 1 FROM public\.cash_orders WHERE id = p_order_id FOR UPDATE;/);
    expect(MIG).toMatch(/web_released_at IS NOT NULL\) THEN\s+RETURN jsonb_build_object\('ok', false, 'reason', 'part_paid_released'\);/);
    expect(MIG).toMatch(/AND o\.web_released_at IS NULL {3}-- W2-7/);
    expect(MIG).not.toMatch(/DROP FUNCTION/);
  });

  it("the expiry sweep leaves released web orders out of its candidates", () => {
    expect(SWEEP).toContain('.or("source_channel.is.null,source_channel.neq.web,web_released_at.is.null")');
  });
});
