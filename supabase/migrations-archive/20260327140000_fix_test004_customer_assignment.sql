-- Fix TEST-004 customer assignment
-- TEST-003 and TEST-004 were both under "TEST ACCOUNT 3 (Split Payment Testing)",
-- causing them to appear mixed on the same customer record.
-- This gives TEST-004 its own dedicated customer.

-- Create dedicated customer for TEST-004
INSERT INTO public.customers (customer_code, full_name)
VALUES ('TEST-004', 'TEST ACCOUNT 4 (Waived Penalty Testing)')
ON CONFLICT (customer_code) DO UPDATE
  SET full_name = 'TEST ACCOUNT 4 (Waived Penalty Testing)';

-- Reassign TEST-004 layaway account to the new customer
UPDATE public.layaway_accounts
SET customer_id = (
  SELECT id FROM public.customers
  WHERE customer_code = 'TEST-004'
)
WHERE invoice_number = 'TEST-004';
