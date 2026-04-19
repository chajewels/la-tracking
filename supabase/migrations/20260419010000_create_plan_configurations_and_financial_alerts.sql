-- Plan configuration reference table
CREATE TABLE IF NOT EXISTS plan_configurations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_months integer NOT NULL UNIQUE,
  display_label text NOT NULL,
  risk_tier text NOT NULL DEFAULT 'MODERATE',
  min_amount_jpy numeric(12,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE plan_configurations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read" ON plan_configurations
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admin write" ON plan_configurations
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'admin'));

INSERT INTO plan_configurations (plan_months, display_label, risk_tier, min_amount_jpy) VALUES
  (3,  '3-Month Plan',  'LOW',      500000),
  (6,  '6-Month Plan',  'MODERATE', 1000000),
  (8,  '8-Month Plan',  'MODERATE', 1500000),
  (10, '10-Month Plan', 'HIGH',     2000000),
  (12, '12-Month Plan', 'CRITICAL', 2500000)
ON CONFLICT (plan_months) DO NOTHING;

-- Financial alerts for executive dashboard
CREATE TABLE IF NOT EXISTS financial_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  severity text NOT NULL DEFAULT 'info',
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES auth.users(id)
);

ALTER TABLE financial_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read" ON financial_alerts
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admin write" ON financial_alerts
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'admin'));

-- Enable realtime for financial_alerts
ALTER PUBLICATION supabase_realtime ADD TABLE financial_alerts;
