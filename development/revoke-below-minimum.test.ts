// revoke_loyalty_points: an order below the loyalty minimum is silent on
// reversal (migration 20261211100000, 2026-10-11). award-loyalty-points writes
// nothing for loyalty_jpy_amount < 10000 ("below_minimum"), so the
// unsourced-reversal bell must not ring for such an order. Pins the migration's
// guard and the one added block; the live md5 the guard checks is the body the
// repo's newest copy (20261017100000) was verified identical to.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const mig = await Deno.readTextFile(new URL("../supabase/migrations/20261211100000_revoke_below_minimum_silent.sql", import.meta.url));
const award = await Deno.readTextFile(new URL("../supabase/functions/award-loyalty-points/index.ts", import.meta.url));

Deno.test("the migration is guarded on the live body and refuses anything else", () => {
  assert(mig.includes("md5(v_def)"), "guard reads the live definition's md5");
  assert(mig.includes("'9ac8a0f02cff3bb6606faf584d25fb6d'"), "the live md5 of 2026-10-11");
  assert(mig.includes("RAISE EXCEPTION 'STOP - revoke_loyalty_points has moved on live"), "stops on a moved body");
  assert(mig.includes("position('BELOW THE MINIMUM (2026-10-11)' IN v_def) > 0"), "idempotent re-apply");
});

Deno.test("below the minimum, money received, no ledger row: the bell stays silent; a NULL basis still rings", () => {
  const block = "IF v_money_received AND v_order_basis IS NOT NULL AND v_order_basis < 10000 THEN\n        v_money_received := false;\n      END IF;";
  assertEquals(mig.split(block).length - 1, 1, "exactly one silencing block");
  assert(mig.indexOf(block) < mig.indexOf("IF v_money_received THEN\n        INSERT INTO public.audit_logs ("), "the block precedes the bell");
  assert(mig.includes("'loyalty_reversal_unsourced'"), "the bell itself is untouched");
});

Deno.test("the minimum the SQL silences on is the minimum the award path skips on", () => {
  assert(/loyaltyJpy < 10000\)\s*\{\s*return json\(\{ skipped: true, reason: "below_minimum" \}\);/s.test(award), "award-loyalty-points skips below 10000 and writes nothing");
});
