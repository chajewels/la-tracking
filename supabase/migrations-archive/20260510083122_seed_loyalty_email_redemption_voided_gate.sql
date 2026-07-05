-- Phase 6.0 Item 1: seed gate for loyalty-redemption-voided email.
-- Default true to match the other 9 loyalty_email_* keys.
-- Idempotent — does nothing if the row already exists.
INSERT INTO system_settings (key, value)
VALUES ('loyalty_email_redemption_voided', 'true'::jsonb)
ON CONFLICT (key) DO NOTHING;
