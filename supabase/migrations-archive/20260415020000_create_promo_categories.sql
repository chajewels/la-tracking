-- Categories table
CREATE TABLE promo_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  display_order INT DEFAULT 0,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Junction table (many-to-many)
CREATE TABLE promo_category_assignments (
  promo_id UUID REFERENCES promotions(id) ON DELETE CASCADE,
  category_id UUID REFERENCES promo_categories(id) ON DELETE CASCADE,
  PRIMARY KEY (promo_id, category_id)
);

-- RLS: public read
ALTER TABLE promo_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE promo_category_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can read categories"
ON promo_categories FOR SELECT USING (true);

CREATE POLICY "Admin and staff can manage categories"
ON promo_categories FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM user_roles ur
    WHERE ur.user_id = auth.uid()
    AND ur.role IN ('admin', 'staff')
  )
);

CREATE POLICY "Public can read category assignments"
ON promo_category_assignments FOR SELECT USING (true);

CREATE POLICY "Admin and staff can manage category assignments"
ON promo_category_assignments FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM user_roles ur
    WHERE ur.user_id = auth.uid()
    AND ur.role IN ('admin', 'staff')
  )
);

-- Seed default categories
INSERT INTO promo_categories (name, display_order) VALUES
  ('Secret Vault', 1),
  ('Preloved Sales', 2),
  ('Promo Sales', 3),
  ('Other Sales', 4);
