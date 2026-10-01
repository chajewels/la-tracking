BEGIN;
-- ============================================================================
-- RLS: every auth.uid() / is_staff() / has_role() / has_permission() /
-- is_admin() call inside a public RLS policy becomes a scalar sub-select — an
-- InitPlan Postgres evaluates ONCE per statement instead of once per row.
-- Rule: CLAUDE.md "Migrations baseline & FUNCTION CHANGES" (PR #265,
-- 2026-09-29: bare calls = 8 s timeouts on the big tables). Backlog S4 #28.
--
-- 2026-10-02. Live census before this migration: 311 public policies, 210
-- with a bare auth.uid(), 181 with a bare helper call (the sets overlap).
--
-- HOW. One DO block (one transaction): for every public policy whose USING or
-- WITH CHECK text carries a bare call, the expression is rewritten by a pure
-- text transform — `auth.uid()` → `(SELECT auth.uid())`, and a top-level
-- `fn(args)` of the four helpers → `(SELECT fn(args))` — and re-applied with
-- ALTER POLICY. Roles, command and permissive flag are untouched. The
-- transform only ever inserts "(SELECT " … ")" around a call that was already
-- there, so the policy's meaning is identical; ALTER POLICY re-parses every
-- expression, so a malformed rewrite aborts the whole block and NOTHING is
-- changed. The block ends by asserting that no bare call survives and that the
-- policy count is unchanged. Dry-run on live inside BEGIN … ROLLBACK on
-- 2026-10-02: 311 policies before and after, 210 rewritten, 0 bare calls
-- left; stripping the inserted wrappers from every rewritten expression gave
-- back the original text exactly (0 meaning differences, 311/311).
--
-- LOCKS. ALTER POLICY takes an exclusive lock on its table, so a long-running
-- reader (a schema dump, a pg_dump) blocks the whole block. lock_timeout makes
-- it fail fast and clean instead — the transaction rolls back, nothing is
-- changed, and the apply is simply re-run. (The dry-run met exactly that: a
-- Supabase schema dump held audit_logs for ~2 minutes.)
-- ============================================================================

SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION pg_temp.rls_wrap_calls(p text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $f$
DECLARE
  s text := p; out text := ''; i int := 1; n int; m text; j int; depth int; c text;
BEGIN
  IF s IS NULL THEN RETURN NULL; END IF;
  n := length(s);
  WHILE i <= n LOOP
    -- the capture group is the whole "name(" (a bare group would return the
    -- name alone and the paren scan below would start one character early)
    m := substring(substr(s, i) from '^((?:is_staff|has_role|has_permission|is_admin)\()');
    IF m IS NOT NULL AND NOT (rtrim(substr(s, 1, i - 1)) ~ 'SELECT$') THEN
      j := i + length(m); depth := 1;
      WHILE depth > 0 AND j <= n LOOP
        c := substr(s, j, 1);
        IF c = '(' THEN depth := depth + 1; ELSIF c = ')' THEN depth := depth - 1; END IF;
        j := j + 1;
      END LOOP;
      out := out || '(SELECT ' || regexp_replace(substr(s, i, j - i), '(?<!SELECT )auth\.uid\(\)', '(SELECT auth.uid())', 'g') || ')';
      i := j;
    ELSE
      out := out || substr(s, i, 1); i := i + 1;
    END IF;
  END LOOP;
  RETURN regexp_replace(out, '(?<!SELECT )auth\.uid\(\)', '(SELECT auth.uid())', 'g');
END
$f$;

DO $$
DECLARE
  r record; v_before int; v_after int; v_n int := 0; v_q text; v_w text; v_sql text;
BEGIN
  SELECT count(*) INTO v_before FROM pg_policies WHERE schemaname = 'public';
  FOR r IN
    SELECT tablename, policyname, cmd, qual, with_check
      FROM pg_policies
     WHERE schemaname = 'public'
       AND (coalesce(qual,'') || ' ' || coalesce(with_check,''))
            ~ '(?<!SELECT )(auth\.uid\(\)|is_staff\(|has_role\(|has_permission\(|is_admin\()'
     ORDER BY tablename, policyname
  LOOP
    v_q := pg_temp.rls_wrap_calls(r.qual);
    v_w := pg_temp.rls_wrap_calls(r.with_check);
    v_sql := format('ALTER POLICY %I ON public.%I', r.policyname, r.tablename);
    IF v_q IS NOT NULL THEN v_sql := v_sql || ' USING (' || v_q || ')'; END IF;
    IF v_w IS NOT NULL THEN v_sql := v_sql || ' WITH CHECK (' || v_w || ')'; END IF;
    EXECUTE v_sql;
    v_n := v_n + 1;
  END LOOP;

  SELECT count(*) INTO v_after FROM pg_policies WHERE schemaname = 'public';
  IF v_after <> v_before THEN
    RAISE EXCEPTION 'RLS rewrite: policy count changed (% -> %)', v_before, v_after;
  END IF;
  IF v_n < 200 THEN
    RAISE EXCEPTION 'RLS rewrite: only % policies matched — expected about 210; refusing', v_n;
  END IF;
  SELECT count(*) INTO v_after FROM pg_policies
   WHERE schemaname = 'public'
     AND (coalesce(qual,'') || ' ' || coalesce(with_check,''))
         ~ '(?<!SELECT )(auth\.uid\(\)|is_staff\(|has_role\(|has_permission\(|is_admin\()';
  IF v_after > 0 THEN
    RAISE EXCEPTION 'RLS rewrite: % policies still carry a bare call', v_after;
  END IF;
  RAISE NOTICE 'RLS rewrite: % policies rewritten, % policies total, 0 bare calls left', v_n, v_before;
END $$;

DROP FUNCTION IF EXISTS pg_temp.rls_wrap_calls(text);
COMMIT;