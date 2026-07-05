
ALTER TABLE public.layaway_accounts
ADD COLUMN downpayment_amount numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.layaway_accounts.downpayment_amount IS 'The 30% downpayment amount required before installments begin';
