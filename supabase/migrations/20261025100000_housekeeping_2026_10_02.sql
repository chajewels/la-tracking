-- Housekeeping 2026-10-02 (backlog S4 #32, #26). Three small items, one file.

-- hero_pick_reason(text, text, integer, integer, boolean) was created on
-- 2026-10-13 (20261013100000_hero_picks.sql) without re-asserting its ACL, so
-- the default grant left EXECUTE to PUBLIC (live acl: {=X/postgres,...}).
-- Backlog S4 #32, 2026-10-02. The function is a pure IMMUTABLE expression
-- over its arguments (no table access), so nothing was exposed; this aligns
-- it with the rule "after any CREATE FUNCTION, re-assert REVOKE/GRANT"
-- (CLAUDE.md "Migrations baseline & FUNCTION CHANGES", 2026-09-24).
-- Callers: list_media_cutouts / hero_* functions (authenticated or
-- SECURITY DEFINER as postgres) and the website edge function (service_role).
REVOKE ALL ON FUNCTION public.hero_pick_reason(text, text, integer, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hero_pick_reason(text, text, integer, integer, boolean) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- extension_requests: the two anon "token customer" policies are DEAD and are
-- dropped (backlog S4 #26). Both test the token against customer_portal_tokens,
-- which has RLS on and NO anon policy, so for anon the EXISTS is always empty
-- and the policies fail closed (Bug #165 pattern) — they have never granted
-- anything. The portal writes through request-extension and reads through
-- customer-portal (both service role), so nothing depends on them. Dropping
-- them removes a path that only LOOKS like it lets anon insert with a token.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Token customers can insert own extension_requests" ON public.extension_requests;
DROP POLICY IF EXISTS "Token customers can view own extension_requests" ON public.extension_requests;

-- ---------------------------------------------------------------------------
-- Yamato tracking deep link (backlog S4 #26). Verified 2026-10-02 in a browser
-- with a real parcel (472572424892, delivered 31 Aug): the Kuroneko Members
-- parcel page shows the full status without sign-in for
--   https://member.kms.kuronekoyamato.co.jp/parcel/detail?pno=<12 digits>
-- The number must be digits only — "4725-7551-6733" answers "システムエラー";
-- the Hub strips spaces and hyphens before filling any template (commit with
-- this migration). The old toi.kuronekoyamato.co.jp form ignores GET
-- parameters, which is why it stayed a landing page. Data row, so a migration
-- (shipping_methods has no editor).
-- ---------------------------------------------------------------------------
-- supports_deeplink is GENERATED ALWAYS AS (tracking_url_template LIKE
-- '%{tracking_code}%') on live and cannot be set directly (first apply attempt
-- failed with 428C9); the new template makes it true by itself.
UPDATE public.shipping_methods
   SET tracking_url_template = 'https://member.kms.kuronekoyamato.co.jp/parcel/detail?pno={tracking_code}',
       notes = 'Kuroneko Members parcel page; digits only (the Hub strips hyphens/spaces). Verified with a real parcel 2026-10-02.',
       updated_at = now()
 WHERE id = 'aaf61b27-9b7b-426b-a26b-632a69726ba4'
   AND provider_name = 'Yamato';
