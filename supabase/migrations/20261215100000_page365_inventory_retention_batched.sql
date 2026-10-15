-- Page365 stock sync: make the 14-day cleanup and the quick plan fast again.
-- (Lovable issue "Page365 stock sync: cleanup and quick-plan steps time out on
-- every scheduled run", 2026-10-15; docs/FIXED-BUGS.md.)
--
-- WHAT WAS WRONG (measured live 2026-10-15):
--   * page365_inventory_retention tried to clear the WHOLE backlog in one call.
--     Every deleted product row cascades to page365_inventory_items through
--     items.inventory_product_id (ON DELETE CASCADE) — a column with NO index, so
--     each product deleted scanned all ~667k item rows. The call never finished
--     inside the API's 8 s statement_timeout, rolled back, and the backlog grew:
--     268 runs older than 14 days (oldest 2026-09-25), ~1.1 GB of sync data.
--   * page365_inventory_plan_quick step (b) looks up earlier reads of a listing
--     by page365_product_id across ALL runs; items had no index on that column,
--     so it scanned every item row (avg 5 s, max 8 s) and timed out. Each failed
--     quick plan fell back to a FULL fetch (2 quick runs out of 74 in a day).
--
-- THE FIX (no behaviour change — same rows kept, same rows deleted):
--   1. Index items.inventory_product_id (the cascade lookup).
--   2. Index items(page365_product_id, code, run_id) for kind 'page365' (quick
--      plan (b)).
--   3. Index page365_landings.item_id (its FK is ON DELETE SET NULL, also looked
--      up on every item delete).
--   4. Retention works through at most 25 of the OLDEST old runs per call, so a
--      call always fits in the time limit; the backlog drains over the next few
--      hours of scheduled runs. Rules are unchanged: never the latest ready run,
--      never a run still fetching, applied items and the product rows they point
--      at are kept, a run with applied items is pruned once and kept.
--      The result gains 'remaining' (old runs still waiting for a later call).
--
-- page365_inventory_plan_quick's body is NOT changed; the index is enough.
-- Started from live pg_get_functiondef (md5 35b0a06941fcd1690d7093e72a98c52b);
-- the guard below refuses to run if live has moved since (CLAUDE.md, Bug #280).

DO $guard$
BEGIN
  IF md5(pg_get_functiondef('public.page365_inventory_retention(integer)'::regprocedure))
     <> '35b0a06941fcd1690d7093e72a98c52b' THEN
    RAISE EXCEPTION 'page365_inventory_retention changed on live since this migration was written — stop and re-derive from live';
  END IF;
END
$guard$;

CREATE INDEX IF NOT EXISTS idx_page365_inventory_items_inventory_product
  ON public.page365_inventory_items (inventory_product_id)
  WHERE inventory_product_id IS NOT NULL;

-- run_id is included so quick plan (b) is answered from the index alone
-- (dry run on live 2026-10-15: index-only scan, 513 ms -> 167 ms, and no read
-- of the whole 320 MB table, which is what timed out under memory pressure).
CREATE INDEX IF NOT EXISTS idx_page365_inventory_items_listing
  ON public.page365_inventory_items (page365_product_id, code, run_id)
  WHERE kind = 'page365';

CREATE INDEX IF NOT EXISTS idx_page365_landings_item
  ON public.page365_landings (item_id)
  WHERE item_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.page365_inventory_retention(p_keep_days integer DEFAULT 14)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_keep        integer := greatest(coalesce(p_keep_days, 14), 7);
  v_cut         timestamptz := now() - make_interval(days => greatest(coalesce(p_keep_days, 14), 7));
  v_batch       constant integer := 25;
  v_latest      uuid;
  v_ids         uuid[];
  v_deleted     integer := 0;
  v_pruned      integer := 0;
  v_items_gone  integer := 0;
  v_remaining   integer := 0;
  v_n           integer;
BEGIN
  SELECT r.id INTO v_latest FROM public.page365_inventory_runs r
   WHERE r.status = 'ready' ORDER BY r.created_at DESC LIMIT 1;

  -- This call's share of the backlog: the oldest old runs not yet pruned. (A
  -- pruned run always has applied items, so step (a) never wanted it either.)
  v_ids := ARRAY(
    SELECT r.id FROM public.page365_inventory_runs r
     WHERE r.created_at < v_cut AND r.status <> 'fetching' AND r.id IS DISTINCT FROM v_latest
       AND r.pruned_at IS NULL
     ORDER BY r.created_at
     LIMIT v_batch);

  -- (a) Old runs where nothing was ever applied: gone, with their rows.
  WITH gone AS (
    DELETE FROM public.page365_inventory_runs r
     WHERE r.id = ANY (v_ids)
       AND NOT EXISTS (SELECT 1 FROM public.page365_inventory_items i
                        WHERE i.run_id = r.id AND (i.status = 'applied' OR i.applied_at IS NOT NULL))
    RETURNING 1)
  SELECT count(*) INTO v_deleted FROM gone;

  -- (b) Old runs where something was applied: keep the run, the applied items
  --     and the product rows they point at; drop the rest once.
  WITH it AS (
    DELETE FROM public.page365_inventory_items i
     WHERE i.run_id = ANY (v_ids) AND i.status <> 'applied' AND i.applied_at IS NULL
    RETURNING 1)
  SELECT count(*) INTO v_items_gone FROM it;
  DELETE FROM public.page365_inventory_chunks c
   WHERE c.run_id = ANY (v_ids);
  DELETE FROM public.page365_inventory_products p
   WHERE p.run_id = ANY (v_ids)
     AND NOT EXISTS (SELECT 1 FROM public.page365_inventory_items i WHERE i.inventory_product_id = p.id);
  UPDATE public.page365_inventory_runs r SET pruned_at = now()
   WHERE r.id = ANY (v_ids) AND r.pruned_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_pruned := v_n;

  SELECT count(*) INTO v_remaining FROM public.page365_inventory_runs r
   WHERE r.created_at < v_cut AND r.status <> 'fetching' AND r.id IS DISTINCT FROM v_latest
     AND r.pruned_at IS NULL;

  RETURN jsonb_build_object('ok', true, 'keep_days', v_keep, 'runs_deleted', v_deleted,
                            'runs_pruned', v_pruned, 'items_deleted', v_items_gone,
                            'remaining', v_remaining);
END
$function$;

-- Fresh statistics so the planner picks the new indexes straight away.
ANALYZE public.page365_inventory_items;
ANALYZE public.page365_landings;

-- CREATE OR REPLACE keeps the existing ACL; re-asserted anyway (CLAUDE.md).
REVOKE ALL ON FUNCTION public.page365_inventory_retention(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_inventory_retention(integer) TO service_role;
