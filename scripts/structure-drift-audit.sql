-- structure-drift-audit.sql — ONE read-only SELECT. Writes nothing.
-- Run it on LIVE (SQL Editor, export the result as CSV or JSON) and on a scratch
-- database rebuilt from supabase/migrations/ (scripts/structure-drift-audit replay);
-- scripts/structure-drift-audit compare diffs the two. Every row is (kind, item).
-- Normalised so the same structure prints the same text on both sides:
--   * whitespace runs collapse to one space; function definitions drop blank lines
--   * Lovable's platform roles (sandbox_exec*) are ignored
--   * PostgreSQL 17's MAINTAIN privilege ("m") is ignored (live is 17, scratch may be 16)
WITH acl AS (
  SELECT a AS raw, regexp_replace(a, '=([a-zA-Z]*)m/', '=\1/') AS norm
    FROM (SELECT DISTINCT unnest(relacl::text[]) a FROM pg_class
          UNION SELECT DISTINCT unnest(proacl::text[]) FROM pg_proc) s
   WHERE a NOT LIKE 'sandbox_exec%'
)
SELECT kind, item FROM (
  SELECT 'column' AS kind,
         c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
         || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
         || CASE a.attgenerated WHEN 's' THEN ' generated' ELSE '' END
         || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '') AS item
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p','v','m')
     AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'constraint', conrelid::regclass::text || ' ' || conname || ' '
         || regexp_replace(pg_get_constraintdef(oid), '\s+', ' ', 'g')
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conrelid <> 0
  UNION ALL
  SELECT 'index', regexp_replace(indexdef, '\s+', ' ', 'g') FROM pg_indexes WHERE schemaname = 'public'
  UNION ALL
  SELECT 'trigger', pg_get_triggerdef(t.oid)
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
  UNION ALL
  SELECT 'view', c.relname || ' ' || md5(regexp_replace(pg_get_viewdef(c.oid), '\s+', ' ', 'g'))
         || ' ' || coalesce(c.reloptions::text, '')
    FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v','m')
  UNION ALL
  SELECT 'enum', t.typname || ' ' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
    FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
   WHERE t.typnamespace = 'public'::regnamespace GROUP BY t.typname
  UNION ALL
  SELECT 'function', p.oid::regprocedure::text || ' '
         || md5(regexp_replace(regexp_replace(pg_get_functiondef(p.oid), '[ \t]+\n', E'\n', 'g'), '\n+', E'\n', 'g'))
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f','p')
  UNION ALL
  SELECT 'policy', regexp_replace(tablename || ' | ' || policyname || ' | ' || permissive || ' | '
         || roles::text || ' | ' || cmd || ' | ' || coalesce(qual, '') || ' | ' || coalesce(with_check, ''), '\s+', ' ', 'g')
    FROM pg_policies WHERE schemaname = 'public'
  UNION ALL
  SELECT 'relation', c.relname || ' ' || c.relkind::text || ' rls=' || c.relrowsecurity::text || ' '
         || coalesce((SELECT string_agg(acl.norm, ',' ORDER BY acl.norm) FROM unnest(c.relacl::text[]) g
                       JOIN acl ON acl.raw = g), '<default>')
    FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p','v','m','S')
  UNION ALL
  SELECT 'function_grant', p.oid::regprocedure::text || ' '
         || coalesce((SELECT string_agg(acl.norm, ',' ORDER BY acl.norm) FROM unnest(p.proacl::text[]) g
                       JOIN acl ON acl.raw = g), '<default>')
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
) s
ORDER BY kind, item;
