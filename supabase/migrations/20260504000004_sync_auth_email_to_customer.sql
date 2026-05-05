-- Sync auth.users.email -> customers.email when customer changes
-- email via Supabase Auth.
-- APPLIED TO PRODUCTION: 2026-05-04 via SQL Editor (ahead of plan).

CREATE OR REPLACE FUNCTION public.sync_auth_email_to_customer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    UPDATE public.customers
    SET email = NEW.email, updated_at = now()
    WHERE auth_user_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_email_change
  AFTER UPDATE OF email ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_auth_email_to_customer();
