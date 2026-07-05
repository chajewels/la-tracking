-- Add 'cancelled' to submission_status enum so customers can cancel pending submissions
ALTER TYPE public.submission_status ADD VALUE IF NOT EXISTS 'cancelled';
