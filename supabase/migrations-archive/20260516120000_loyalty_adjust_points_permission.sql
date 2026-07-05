-- Adds the loyalty_adjust_points permission key to role_permissions.
-- Default grants: admin = TRUE, finance = TRUE, staff = FALSE, csr = FALSE.
--
-- Actual schema (verified): role_permissions(role public.app_role,
-- permission_key text, is_allowed boolean, UNIQUE(role, permission_key)).
-- app_role enum = ('admin','staff','finance','csr').

INSERT INTO public.role_permissions (role, permission_key, is_allowed)
VALUES
  ('admin'::public.app_role,   'loyalty_adjust_points', true),
  ('finance'::public.app_role, 'loyalty_adjust_points', true),
  ('staff'::public.app_role,   'loyalty_adjust_points', false),
  ('csr'::public.app_role,     'loyalty_adjust_points', false)
ON CONFLICT (role, permission_key) DO NOTHING;
