-- Team-only access for the sales log, commissions and product inquiries
-- (security triage of the 2026-10-04 deep scan; docs/FIXED-BUGS.md).
--
-- WHY: these five tables carried `USING (true) WITH CHECK (true)` for role
-- `authenticated`. Every portal customer with a password (139 on 2026-10-04)
-- holds an `authenticated` session, so any of them could read, change or delete
-- the 1,084-row sales log (client names, amounts, invoice numbers), the
-- commission agents and splits, and all 924 product inquiries (inquirer names)
-- straight through PostgREST. The scanner never named this; it was found while
-- checking its search findings.
--
-- WHO KEEPS ACCESS: anyone with ANY Hub role. is_staff() is NOT used on purpose:
-- it covers admin/staff/finance/csr only, and the live_agent role (2 active
-- members on 2026-10-04) can open /commissions (PUBLIC_AUTHENTICATED_PATHS).
-- Every team member keeps exactly today's access; only non-team sessions
-- (customers) lose it. Service-role callers (sync-backup-sheets,
-- review-payment-submission) bypass RLS and are unaffected.
--
-- Policies call the helper inside a scalar sub-select (CLAUDE.md, PR #265).

CREATE OR REPLACE FUNCTION public.is_team_member(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id)
$function$;

REVOKE ALL ON FUNCTION public.is_team_member(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_team_member(uuid) TO authenticated, service_role;

-- sales_log
DROP POLICY IF EXISTS "sales_log_auth_all" ON public.sales_log;
CREATE POLICY "team_members_all_sales_log" ON public.sales_log
  FOR ALL TO authenticated
  USING ((SELECT public.is_team_member((SELECT auth.uid()))))
  WITH CHECK ((SELECT public.is_team_member((SELECT auth.uid()))));

-- commission_agents
DROP POLICY IF EXISTS "commission_agents_auth_all" ON public.commission_agents;
CREATE POLICY "team_members_all_commission_agents" ON public.commission_agents
  FOR ALL TO authenticated
  USING ((SELECT public.is_team_member((SELECT auth.uid()))))
  WITH CHECK ((SELECT public.is_team_member((SELECT auth.uid()))));

-- commission_splits
DROP POLICY IF EXISTS "commission_splits_auth_all" ON public.commission_splits;
CREATE POLICY "team_members_all_commission_splits" ON public.commission_splits
  FOR ALL TO authenticated
  USING ((SELECT public.is_team_member((SELECT auth.uid()))))
  WITH CHECK ((SELECT public.is_team_member((SELECT auth.uid()))));

-- product_inquiries (product_inquiries_with_accumulated is security_invoker,
-- so it follows these policies)
DROP POLICY IF EXISTS "authenticated_read_inquiries" ON public.product_inquiries;
DROP POLICY IF EXISTS "authenticated_write_inquiries" ON public.product_inquiries;
CREATE POLICY "team_members_all_product_inquiries" ON public.product_inquiries
  FOR ALL TO authenticated
  USING ((SELECT public.is_team_member((SELECT auth.uid()))))
  WITH CHECK ((SELECT public.is_team_member((SELECT auth.uid()))));

-- inquiry_dropdown_options
DROP POLICY IF EXISTS "authenticated_read_dropdown" ON public.inquiry_dropdown_options;
DROP POLICY IF EXISTS "authenticated_write_dropdown" ON public.inquiry_dropdown_options;
CREATE POLICY "team_members_all_inquiry_dropdown_options" ON public.inquiry_dropdown_options
  FOR ALL TO authenticated
  USING ((SELECT public.is_team_member((SELECT auth.uid()))))
  WITH CHECK ((SELECT public.is_team_member((SELECT auth.uid()))));
