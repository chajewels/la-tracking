-- Owner switched web_checkout_mode to 'draft' (operational setting, live value) before PR 10.
SET session_replication_role = replica;
INSERT INTO public.system_settings(key, value) VALUES ('web_checkout_mode', '"draft"'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
