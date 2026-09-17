-- ============================================================================
-- Birthday-lot expiry — restore the owner's rule
-- 2026-09-17. Run in the Supabase SQL Editor. Claude Code has NOT run this.
-- ============================================================================
--
-- OWNER DECISION (2026-09-17, stands): a birthday_bonus lot expires at the
-- member's last_purchase_at + 180 days; if that date is already past, or
-- last_purchase_at is NULL, at now() + 180 days. The point is that the member's
-- WHOLE BALANCE shares one expiry date rather than the birthday points drifting
-- onto a calendar of their own.
--
-- WHAT HAPPENED. The rule was applied live by hand earlier today and then
-- overwritten a few hours later by migration
-- 20260917070000_relot_wire_redemption_and_birthday.sql, which had been written
-- against the pre-patch body and expires the lot at v_awarded_at + 180 days
-- (the award instant). Both changes were fixing Bug #280 and neither knew about
-- the other. This restores the owner's rule on top of the migration's body.
--
-- WHY A GUARDED IN-PLACE PATCH RATHER THAN A CREATE OR REPLACE. CLAUDE.md,
-- "FUNCTION CHANGES START FROM LIVE": a full-body replace written from a repo
-- copy is exactly what caused Bug #280. This patch reads the body live, refuses
-- to proceed unless it is byte-for-byte the body Claude Code captured, changes
-- one expression, and asserts that expression occurs exactly once. If anything
-- has moved since the capture it STOPS and changes nothing.
--
-- CAPTURED 2026-09-17 06:3x UTC from live:
--   md5(pg_get_functiondef('public._award_birthday_reward(uuid)'::regprocedure))
--     = 45aea6c7217c2e730597fe9dee44a9c1
--   length = 2818 bytes
--
-- NOT RETROACTIVE. The only birthday lot in existence (CJ-2026-03608,
-- BIRTHDAY-2026) was inserted by hand with an explicit expiry and is untouched
-- by this. This changes the NEXT birthday award and every one after it.
-- ============================================================================

BEGIN;

DO $patch$
DECLARE
  v_expected_md5 CONSTANT text := '45aea6c7217c2e730597fe9dee44a9c1';
  v_old CONSTANT text := $old$v_awarded_at + INTERVAL '180 days'$old$;
  v_new CONSTANT text := $new$(SELECT CASE WHEN lm.last_purchase_at IS NOT NULL
                      AND lm.last_purchase_at + INTERVAL '180 days' > now()
                     THEN lm.last_purchase_at + INTERVAL '180 days'
                     ELSE now() + INTERVAL '180 days' END
           FROM public.loyalty_members lm WHERE lm.id = v_member_id)$new$;
  v_def   text;
  v_body  text;
  v_hits  int;
BEGIN
  v_def := pg_get_functiondef('public._award_birthday_reward(uuid)'::regprocedure);

  -- GUARD 1 — live must be exactly the body this patch was written against.
  IF md5(v_def) <> v_expected_md5 THEN
    RAISE EXCEPTION
      'STOP — _award_birthday_reward has changed since capture. Expected md5 %, live is % (% bytes). Nothing was modified. Re-capture the live body and re-derive this patch before running it again.',
      v_expected_md5, md5(v_def), length(v_def);
  END IF;

  -- GUARD 2 — the expression must occur exactly once, so the replace is unambiguous.
  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION
      'STOP — expected exactly 1 occurrence of the expiry expression, found %. Nothing was modified.',
      v_hits;
  END IF;

  v_body := replace(v_def, v_old, v_new);

  -- GUARD 3 — the replace must actually have changed something.
  IF v_body = v_def THEN
    RAISE EXCEPTION 'STOP — replace was a no-op. Nothing was modified.';
  END IF;

  EXECUTE v_body;

  RAISE NOTICE 'Patched _award_birthday_reward: birthday lots now expire on the member''s purchase clock.';
END
$patch$;

COMMIT;

-- ============================================================================
-- VERIFY — read-only. Run after the COMMIT above.
-- Expect: new_rule_present = true, old_rule_absent = true, and new_md5 to
-- DIFFER from 45aea6c7217c2e730597fe9dee44a9c1.
-- ============================================================================
SELECT
  md5(pg_get_functiondef('public._award_birthday_reward(uuid)'::regprocedure)) AS new_md5,
  length(pg_get_functiondef('public._award_birthday_reward(uuid)'::regprocedure)) AS new_len,
  position($n$FROM public.loyalty_members lm WHERE lm.id = v_member_id)$n$
           IN pg_get_functiondef('public._award_birthday_reward(uuid)'::regprocedure)) > 0
    AS new_rule_present,
  position($o$v_awarded_at + INTERVAL '180 days'$o$
           IN pg_get_functiondef('public._award_birthday_reward(uuid)'::regprocedure)) = 0
    AS old_rule_absent;

-- Send Claude Code the new_md5 from that SELECT. It replaces the placeholder
-- body in supabase/migrations/20260917080000_birthday_lot_expiry_owner_rule.sql
-- with the live definition, so the next rebuild cannot revert this the way the
-- 2026-09-12 rebuild reverted approve_redemption_atomic.
