-- ============================================================================
-- Shipment tracking (2026-08-30)
--
-- Adds a shipping_methods lookup, tracking columns on BOTH account tables, and
-- an append-only order_tracking_history audit trail.
--
-- NOTE ON SCOPE: this schema has no `orders` table. The two first-class account
-- tables are `cash_orders` and `layaway_accounts`, and per CLAUDE.md
-- "ACCOUNT-SCOPE COVERAGE — NON-NEGOTIABLE" an account-scoped feature must
-- cover both. The history table therefore carries TWO nullable FKs
-- (cash_order_id / account_id) with an XOR check, rather than the single
-- order_id a one-table design would use. Column naming follows the existing
-- convention: `account_id` means layaway, `cash_order_id` means cash order.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. shipping_methods
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.shipping_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_name text NOT NULL,
  title text NOT NULL,
  tracking_url_template text NOT NULL,
  -- Derived, never written by hand: true only when the template can be deep
  -- linked to a specific parcel. Rows without the placeholder are landing-page
  -- only and are upgraded later by UPDATE, not by a code change.
  supports_deeplink boolean
    GENERATED ALWAYS AS (tracking_url_template LIKE '%{tracking_code}%') STORED,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT shipping_methods_provider_title_key UNIQUE (provider_name, title)
);

COMMENT ON COLUMN public.shipping_methods.supports_deeplink IS
  'Generated: true when tracking_url_template contains the {tracking_code} placeholder.';

DROP TRIGGER IF EXISTS update_shipping_methods_updated_at ON public.shipping_methods;
CREATE TRIGGER update_shipping_methods_updated_at
  BEFORE UPDATE ON public.shipping_methods
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Tracking columns on both account tables
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.cash_orders
  ADD COLUMN IF NOT EXISTS shipping_method_id   uuid,
  ADD COLUMN IF NOT EXISTS tracking_number      text,
  ADD COLUMN IF NOT EXISTS shipped_at           timestamp with time zone,
  ADD COLUMN IF NOT EXISTS tracking_set_by      uuid,
  ADD COLUMN IF NOT EXISTS tracking_updated_at  timestamp with time zone;

ALTER TABLE public.layaway_accounts
  ADD COLUMN IF NOT EXISTS shipping_method_id   uuid,
  ADD COLUMN IF NOT EXISTS tracking_number      text,
  ADD COLUMN IF NOT EXISTS shipped_at           timestamp with time zone,
  ADD COLUMN IF NOT EXISTS tracking_set_by      uuid,
  ADD COLUMN IF NOT EXISTS tracking_updated_at  timestamp with time zone;

ALTER TABLE public.cash_orders
  DROP CONSTRAINT IF EXISTS cash_orders_shipping_method_id_fkey,
  DROP CONSTRAINT IF EXISTS cash_orders_tracking_set_by_fkey,
  DROP CONSTRAINT IF EXISTS cash_orders_tracking_pair_check;
ALTER TABLE public.cash_orders
  ADD CONSTRAINT cash_orders_shipping_method_id_fkey
    FOREIGN KEY (shipping_method_id) REFERENCES public.shipping_methods(id) ON DELETE RESTRICT,
  ADD CONSTRAINT cash_orders_tracking_set_by_fkey
    FOREIGN KEY (tracking_set_by) REFERENCES auth.users(id),
  -- A tracking number is meaningless without the carrier that issued it.
  ADD CONSTRAINT cash_orders_tracking_pair_check
    CHECK ((tracking_number IS NULL) = (shipping_method_id IS NULL));

ALTER TABLE public.layaway_accounts
  DROP CONSTRAINT IF EXISTS layaway_accounts_shipping_method_id_fkey,
  DROP CONSTRAINT IF EXISTS layaway_accounts_tracking_set_by_fkey,
  DROP CONSTRAINT IF EXISTS layaway_accounts_tracking_pair_check;
ALTER TABLE public.layaway_accounts
  ADD CONSTRAINT layaway_accounts_shipping_method_id_fkey
    FOREIGN KEY (shipping_method_id) REFERENCES public.shipping_methods(id) ON DELETE RESTRICT,
  ADD CONSTRAINT layaway_accounts_tracking_set_by_fkey
    FOREIGN KEY (tracking_set_by) REFERENCES auth.users(id),
  ADD CONSTRAINT layaway_accounts_tracking_pair_check
    CHECK ((tracking_number IS NULL) = (shipping_method_id IS NULL));

CREATE INDEX IF NOT EXISTS idx_cash_orders_shipping_method
  ON public.cash_orders (shipping_method_id) WHERE shipping_method_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_layaway_accounts_shipping_method
  ON public.layaway_accounts (shipping_method_id) WHERE shipping_method_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. order_tracking_history (append-only audit trail)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.order_tracking_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Exactly one of these is set (XOR check below). account_id = layaway.
  cash_order_id uuid REFERENCES public.cash_orders(id) ON DELETE CASCADE,
  account_id    uuid REFERENCES public.layaway_accounts(id) ON DELETE CASCADE,
  shipping_method_id uuid REFERENCES public.shipping_methods(id) ON DELETE SET NULL,
  tracking_number text,
  action text NOT NULL CHECK (action IN ('set', 'updated', 'cleared')),
  changed_by uuid NOT NULL REFERENCES auth.users(id),
  changed_at timestamp with time zone NOT NULL DEFAULT now(),
  reason text,
  CONSTRAINT order_tracking_history_one_parent_check CHECK (
    (cash_order_id IS NOT NULL)::int + (account_id IS NOT NULL)::int = 1
  )
);

COMMENT ON CONSTRAINT order_tracking_history_one_parent_check ON public.order_tracking_history IS
  'Exactly one parent: cash_order_id XOR account_id (layaway).';

-- The specced (order_id, changed_at DESC) index, one per parent column.
-- Partial so each stays tight — a row only ever populates one of the two.
CREATE INDEX IF NOT EXISTS idx_order_tracking_history_cash_order
  ON public.order_tracking_history (cash_order_id, changed_at DESC)
  WHERE cash_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_order_tracking_history_account
  ON public.order_tracking_history (account_id, changed_at DESC)
  WHERE account_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RLS
--
-- Tracking fields on cash_orders / layaway_accounts need NO new policies:
-- RLS is row-level, and the existing "Customers can view own …" SELECT policies
-- already scope those rows to the owning customer, so the new columns are
-- readable by exactly the right people. Staff/admin UPDATE policies likewise
-- already cover writing them.
--
-- is_staff() admits admin/staff/finance/csr, so it is used only for internal
-- READS. Writes use explicit has_role admin/staff per the stated rule.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.shipping_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_tracking_history ENABLE ROW LEVEL SECURITY;

-- shipping_methods ---------------------------------------------------------
DROP POLICY IF EXISTS "admin_all_shipping_methods" ON public.shipping_methods;
CREATE POLICY "admin_all_shipping_methods" ON public.shipping_methods
  FOR ALL TO public
  USING (has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "internal_read_shipping_methods" ON public.shipping_methods;
CREATE POLICY "internal_read_shipping_methods" ON public.shipping_methods
  FOR SELECT TO public
  USING (is_staff(auth.uid()));

-- Customers (and any authenticated user) see active methods only.
DROP POLICY IF EXISTS "Customers can view active shipping methods" ON public.shipping_methods;
CREATE POLICY "Customers can view active shipping methods" ON public.shipping_methods
  FOR SELECT TO authenticated
  USING (is_active = true);

DROP POLICY IF EXISTS "staff_admin_insert_shipping_methods" ON public.shipping_methods;
CREATE POLICY "staff_admin_insert_shipping_methods" ON public.shipping_methods
  FOR INSERT TO public
  WITH CHECK (has_role(auth.uid(), 'staff'::app_role) OR has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "staff_admin_update_shipping_methods" ON public.shipping_methods;
CREATE POLICY "staff_admin_update_shipping_methods" ON public.shipping_methods
  FOR UPDATE TO public
  USING (has_role(auth.uid(), 'staff'::app_role) OR has_role(auth.uid(), 'admin'::app_role));

-- order_tracking_history ---------------------------------------------------
-- No customer policy: the audit trail is internal only.
DROP POLICY IF EXISTS "admin_all_order_tracking_history" ON public.order_tracking_history;
CREATE POLICY "admin_all_order_tracking_history" ON public.order_tracking_history
  FOR ALL TO public
  USING (has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "internal_read_order_tracking_history" ON public.order_tracking_history;
CREATE POLICY "internal_read_order_tracking_history" ON public.order_tracking_history
  FOR SELECT TO public
  USING (is_staff(auth.uid()));

-- INSERT only for staff — append-only. Admin retains UPDATE/DELETE via
-- admin_all above.
DROP POLICY IF EXISTS "staff_admin_insert_order_tracking_history" ON public.order_tracking_history;
CREATE POLICY "staff_admin_insert_order_tracking_history" ON public.order_tracking_history
  FOR INSERT TO public
  WITH CHECK (has_role(auth.uid(), 'staff'::app_role) OR has_role(auth.uid(), 'admin'::app_role));

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Seed
--
-- Rows 4 and 5 intentionally carry no {tracking_code} placeholder, so
-- supports_deeplink computes to false. They are upgraded later by UPDATE.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.shipping_methods (provider_name, title, tracking_url_template, sort_order, notes)
VALUES
  (
    'Japan Post',
    'Japan Post — EMS (International)',
    'https://trackings.post.japanpost.jp/services/srv/search/direct?reqCodeNo1={tracking_code}&searchKind=S004&locale=en',
    1,
    NULL
  ),
  (
    'LBC',
    'LBC Express (PH Domestic)',
    'https://www.lbcexpress.com/ph/track/{tracking_code}',
    2,
    NULL
  ),
  (
    'Japan Post',
    'Japan Post — Yu-Pack (Domestic JP)',
    'https://trackings.post.japanpost.jp/services/srv/search/direct?reqCodeNo1={tracking_code}&searchKind=S002&locale=en',
    3,
    NULL
  ),
  (
    'DHL',
    'DHL Express',
    'https://www.dhl.com/jp-en/home/tracking.html',
    4,
    'Deep link candidate pending browser test: ?submit=1&tracking-id={tracking_code}'
  ),
  (
    'Yamato',
    'Yamato Transport (Domestic JP)',
    'https://track.kuronekoyamato.co.jp/english/tracking',
    5,
    'New page accepts type/no01/id params but id appears session-bound. Landing page until verified.'
  )
ON CONFLICT (provider_name, title) DO NOTHING;
