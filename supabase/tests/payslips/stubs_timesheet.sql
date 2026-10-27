-- Extra stand-ins for the second phase (20270201 + 20270202 + 20270204): timesheet_entries as on the baseline
-- (columns, unique key, updated_at trigger, the five RLS policies), and timesheet_profiles' updated_at + trigger.
ALTER TABLE public.timesheet_profiles ADD COLUMN created_at timestamptz DEFAULT now() NOT NULL,
  ADD COLUMN updated_at timestamptz DEFAULT now() NOT NULL;
CREATE TABLE public.timesheet_entries (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY, user_id uuid NOT NULL, work_date date NOT NULL,
  am_in timestamptz, am_out timestamptz, pm_in timestamptz, pm_out timestamptz, note text,
  created_at timestamptz DEFAULT now() NOT NULL, updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT timesheet_entries_user_id_work_date_key UNIQUE (user_id, work_date));
CREATE FUNCTION public.set_timesheet_updated_at() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
CREATE TRIGGER trg_timesheet_entries_updated BEFORE UPDATE ON public.timesheet_entries
  FOR EACH ROW EXECUTE FUNCTION public.set_timesheet_updated_at();
CREATE TRIGGER trg_timesheet_profiles_updated BEFORE UPDATE ON public.timesheet_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_timesheet_updated_at();
ALTER TABLE public.timesheet_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admin Finance can view all timesheet entries" ON public.timesheet_entries FOR SELECT TO authenticated
  USING ((has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'finance'::app_role) OR timesheet_can_view_all(auth.uid())));
CREATE POLICY "Admins manage timesheet entries" ON public.timesheet_entries FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role)) WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Users can insert own timesheet entries" ON public.timesheet_entries FOR INSERT TO authenticated
  WITH CHECK ((user_id = auth.uid()));
CREATE POLICY "Users can update own timesheet entries" ON public.timesheet_entries FOR UPDATE TO authenticated
  USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));
CREATE POLICY "Users can view own timesheet entries" ON public.timesheet_entries FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));
GRANT SELECT, INSERT, UPDATE ON public.timesheet_entries TO authenticated;
GRANT ALL ON public.timesheet_entries TO service_role;
