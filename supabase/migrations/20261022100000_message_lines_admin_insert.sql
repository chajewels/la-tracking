-- Message lines editor (Hub → Settings → Message lines), 2026-10-01.
--
-- message_lines already has "Staff can view" (SELECT) and "Admins can update"
-- (UPDATE). The editor also ADDS lines, so admins need INSERT. There is still
-- no DELETE policy on purpose: a line is switched off (active = false), never
-- deleted, so a message a customer received can always be traced to its line.
--
-- Same scalar sub-select form as the existing policies (never a bare
-- has_role(auth.uid()) — it would run once per row).

DROP POLICY IF EXISTS "Admins can insert message lines" ON public.message_lines;
CREATE POLICY "Admins can insert message lines"
  ON public.message_lines
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT has_role((SELECT auth.uid()), 'admin'::app_role)));
