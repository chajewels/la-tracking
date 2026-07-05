-- Add new account statuses
ALTER TYPE public.account_status ADD VALUE IF NOT EXISTS 'reactivated';
ALTER TYPE public.account_status ADD VALUE IF NOT EXISTS 'extension_active';
ALTER TYPE public.account_status ADD VALUE IF NOT EXISTS 'final_forfeited';

-- Add reactivation tracking columns to layaway_accounts
ALTER TABLE public.layaway_accounts 
  ADD COLUMN IF NOT EXISTS is_reactivated boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reactivated_at timestamptz,
  ADD COLUMN IF NOT EXISTS reactivated_by_user_id uuid,
  ADD COLUMN IF NOT EXISTS extension_end_date date,
  ADD COLUMN IF NOT EXISTS penalty_count_at_reactivation integer DEFAULT 0;