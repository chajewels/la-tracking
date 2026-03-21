
-- Table for secure, non-guessable statement access tokens
CREATE TABLE public.statement_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.layaway_accounts(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  created_by_user_id uuid,
  expires_at timestamp with time zone DEFAULT (now() + interval '90 days'),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Index for fast token lookup
CREATE INDEX idx_statement_tokens_token ON public.statement_tokens(token);
CREATE INDEX idx_statement_tokens_account ON public.statement_tokens(account_id);

-- RLS
ALTER TABLE public.statement_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view tokens"
  ON public.statement_tokens FOR SELECT
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Staff can create tokens"
  ON public.statement_tokens FOR INSERT
  TO authenticated
  WITH CHECK (is_staff(auth.uid()));

CREATE POLICY "Staff can update tokens"
  ON public.statement_tokens FOR UPDATE
  TO authenticated
  USING (is_staff(auth.uid()));
