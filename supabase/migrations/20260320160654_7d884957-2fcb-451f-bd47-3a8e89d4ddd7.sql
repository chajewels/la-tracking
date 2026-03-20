-- Add 'forfeited' to the account_status enum
ALTER TYPE public.account_status ADD VALUE IF NOT EXISTS 'forfeited';