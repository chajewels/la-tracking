-- Add 'customer' value to app_role enum.
-- APPLIED TO PRODUCTION: 2026-05-04 via SQL Editor (ahead of plan).
-- This file is the historical migration record.

ALTER TYPE public.app_role ADD VALUE 'customer';
