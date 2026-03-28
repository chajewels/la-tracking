-- Per-member permission overrides
-- Allows granting or revoking specific permissions for individual users,
-- overriding their role-based defaults.
--
-- Resolution order:
--   1. user_permission_overrides for this user  → use if exists
--   2. role_permissions for the user's role     → fallback
--   3. admin role                               → always full access regardless

CREATE TABLE IF NOT EXISTS user_permission_overrides (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  permission_key text        NOT NULL,
  granted        boolean     NOT NULL,
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now(),
  UNIQUE (user_id, permission_key)
);

ALTER TABLE user_permission_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage overrides"
  ON user_permission_overrides
  FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_user_permission_overrides_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_user_permission_overrides_updated_at
  BEFORE UPDATE ON user_permission_overrides
  FOR EACH ROW EXECUTE FUNCTION update_user_permission_overrides_updated_at();
