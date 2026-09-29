import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Website orders PR 3 — the draft foundation (docs/WEB-ORDER-DRAFTS.md). The
 * behaviour is proven by docs/sql/20261018_web_order_drafts_local_tests.sql
 * against a stub built from the live schema; this file pins the invariants a
 * later edit must not lose.
 */

const MIGRATION = "supabase/migrations/20261018100000_web_order_drafts.sql";
const sqlRaw = readFileSync(MIGRATION, "utf8");
// Comments stripped, so a pattern can only match code (never an explanation).
const sql = sqlRaw.replace(/--.*$/gm, "");
const fn = (name: string) => {
  const start = sql.indexOf(`FUNCTION public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  const end = sql.indexOf("$fn$;", start);
  return sql.slice(start, end);
};

describe("dormant until the owner flips the switch", () => {
  it("seeds web_checkout_mode = order, never draft", () => {
    expect(sql).toMatch(/VALUES \('web_checkout_mode', '"order"'::jsonb,/);
    expect(sql).toMatch(/ON CONFLICT \(key\) DO NOTHING/);
    expect(sql).not.toMatch(/'"draft"'::jsonb/);
  });
  it("the draft writer refuses unless the switch says draft", () => {
    expect(fn("create_web_draft_atomic")).toMatch(/IF public\.web_checkout_mode\(\) <> 'draft' THEN\s+RETURN jsonb_build_object\('error', 'checkout_mode_not_draft'\)/);
  });
  it("the switch fails closed and is admin-only, audited and guarded", () => {
    expect(fn("web_checkout_mode")).toMatch(/= 'draft'\s+THEN 'draft' ELSE 'order' END/);
    const set = fn("set_web_checkout_mode");
    expect(set).toMatch(/NOT public\.has_role\(v_uid, 'admin'::public\.app_role\)/);
    expect(set).toMatch(/'set_web_checkout_mode'/);
    expect(sql).toMatch(/CREATE TRIGGER trg_guard_web_checkout_mode\s+BEFORE UPDATE OR DELETE ON public\.system_settings/);
  });
});

describe("stock", () => {
  it("the Page365 sync counts held draft lines (else it puts a drafted piece back on sale)", () => {
    expect(fn("page365_web_holds")).toMatch(/FROM public\.web_order_draft_lines l\s+WHERE l\.variant_id = p_variant_id AND l\.hold_state = 'held'/);
  });
  it("Confirm transfers the hold and never touches stock", () => {
    const m = fn("materialize_web_draft_atomic");
    expect(m).toMatch(/SET hold_state = 'transferred'/);
    expect(m).not.toMatch(/stock_qty/);
  });
  it("decline releases only held lines, then returns stock", () => {
    const d = fn("decline_web_draft_atomic");
    expect(d).toMatch(/SET hold_state = 'released', released_at = v_now\s+WHERE l\.draft_id = p_draft_id AND l\.hold_state = 'held'/);
    expect(d).toMatch(/SET stock_qty = v\.stock_qty \+ pv\.qty/);
  });
  it("the writer takes stock with the same guarded decrement as the order writers", () => {
    expect(fn("create_web_draft_atomic")).toMatch(/SET stock_qty = stock_qty - v_qty, updated_at = now\(\)\s+WHERE id = v_variant\.id AND stock_qty >= v_qty/);
  });
});

describe("function changes start from live (Bug #280)", () => {
  it.each([
    ["page365_web_holds(uuid)", "6417708e3c92f960abb519fca2daea5b", "45bb5a67f283468824870545ca41c204"],
    ["email_delivery_report(integer)", "c5e8e93e89c8edc2cdcfc9383880360a", "640083183d6b994101543ebbea7810eb"],
    ["web_reservation_expiring_bells()", "0909b5efefdac33ea37d9d0078e7850c", "a90b52945e1acde7c279d3190a99ee8e"],
  ])("%s is md5-guarded against live and self-checked", (sig, live, mine) => {
    expect(sqlRaw).toContain(`to_regprocedure('public.${sig}')`);
    expect(sqlRaw).toContain(`'${live}', '${mine}'`);
    expect(sqlRaw).toContain(`'public.${sig}'::regprocedure)) <> '${mine}'`);
  });
});

describe("grants", () => {
  it.each([
    "create_web_draft_atomic(uuid, uuid, text, text, timestamptz)",
    "decline_web_draft_atomic(uuid, text, uuid, text)",
    "expire_web_drafts_atomic(integer, integer)",
    "materialize_web_draft_atomic(uuid, uuid, jsonb, jsonb, jsonb)",
  ])("%s is service-role only", (sig) => {
    expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`);
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO service_role;`);
  });
  it("draft tables: RLS on, staff read by permission in a scalar sub-select, no browser writes", () => {
    expect(sql).toMatch(/ALTER TABLE public\.web_order_drafts ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/USING \(\(SELECT public\.has_permission\(\(SELECT auth\.uid\(\)\), 'confirm_web_order_ready'\)\)\)/);
    expect(sql).toMatch(/GRANT SELECT ON public\.web_order_drafts, public\.web_order_draft_lines TO authenticated;/);
  });
});

describe("the released stamp", () => {
  it("fires on both money tables, excludes loyalty redemptions, is web-only and sticky", () => {
    const f = fn("web_mark_released");
    expect(f).toMatch(/NEW\.payment_method IS DISTINCT FROM 'loyalty_redemption'/);
    expect(f).toMatch(/NOT LIKE 'LOYALTY-%'/);
    expect(f).toMatch(/source_channel = 'web' AND web_released_at IS NULL/);
    expect(sql).toMatch(/AFTER INSERT OR UPDATE OF voided_at, amount_paid ON public\.payments/);
    expect(sql).toMatch(/AFTER INSERT OR UPDATE OF voided_at, amount_paid ON public\.cash_payments/);
  });
});

describe("Confirm", () => {
  const m = () => fn("materialize_web_draft_atomic");
  it("writes a confirmed, deadline-bearing web order with the draft's reserved number", () => {
    expect(m()).toMatch(/v_draft\.invoice_seq::text/);
    expect(m()).toMatch(/'pending_transfer'/);
    expect(m()).toMatch(/RETURN jsonb_build_object\('error', 'deadline_required'\)/);
    expect(m()).toMatch(/v_now, p_user_id, p_user_id/);
  });
  it("locks the layaway term (W2-3) and requires the schedule to add up", () => {
    expect(m()).toMatch(/'term_locked'/);
    expect(m()).toMatch(/IF v_dp \+ v_sum <> v_total THEN/);
  });
  it("needs the confirm permission and the create permission for the mode", () => {
    expect(m()).toMatch(/has_permission\(p_user_id, 'confirm_web_order_ready'\)/);
    expect(m()).toMatch(/CASE WHEN v_draft\.mode = 'full' THEN 'create_cash_order' ELSE 'create_account' END/);
  });
});
