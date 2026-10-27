-- Phase 2 extra stand-ins: what 20270201100000 and 20270204100000 need besides the corrections stubs
-- (system_settings, storage.buckets / storage.objects).
CREATE TABLE public.system_settings (key text PRIMARY KEY, value jsonb);
INSERT INTO public.system_settings VALUES ('php_jpy_rate', '"0.42"'::jsonb);
CREATE SCHEMA storage;
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean DEFAULT false,
  file_size_limit bigint, allowed_mime_types text[]);
CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA storage TO authenticated;
GRANT SELECT, INSERT ON storage.objects TO authenticated;
