-- Extension requests from customers for forfeited accounts
CREATE TABLE IF NOT EXISTS extension_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES layaway_accounts(id),
  customer_id uuid REFERENCES customers(id),
  portal_token text,
  reason text,
  status text NOT NULL DEFAULT 'pending',
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES auth.users(id),
  reviewer_notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE extension_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anon can insert extension requests"
  ON extension_requests FOR INSERT
  TO anon WITH CHECK (true);

CREATE POLICY "Anon can read own extension requests"
  ON extension_requests FOR SELECT
  TO anon USING (true);

CREATE POLICY "Authenticated full access"
  ON extension_requests FOR ALL
  TO authenticated USING (true) WITH CHECK (true);
