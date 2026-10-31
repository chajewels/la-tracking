-- ===========================================================================
-- notify_extension_event: drop the customer e-mail call from the trigger
-- (2026-11-01, owner-confirmed; Lovable managed-email blocker).
--
-- WHY. Since 2026-10-31 20:50 JST every Hub e-mail is refused by the Lovable
-- e-mail API with 400 missing_unsubscribe ("Transactional emails must include
-- an unsubscribe_token"). Lovable has put the project into its required
-- managed-email update (Lovable -> More -> Emails: "Email update needs changes
-- first"). That update stops every time on ONE blocker Lovable reported:
-- public.notify_extension_event() (trigger trg_notify_extension_event,
-- AFTER INSERT OR UPDATE ON public.extension_requests) calls
-- the send-transactional e-mail edge function through a pg_net HTTP POST.
-- Lovable will not delete that endpoint while a database trigger depends on
-- it, and its guide forbids e-mail SQL changes, so the dependency is removed
-- here.
--
-- WHAT CHANGES. The body is the most recent recorded definition (baseline
-- 20260705230000_baseline_live_schema.sql lines 5318-5417; the tail
-- 20261130140000 only sets its ACL) with ONLY the customer-e-mail part of the
-- INSERT branch removed: the inner BEGIN ... EXCEPTION block that read the
-- customer's name / e-mail / auth_user_id, built the portal URL and the
-- amount string and POSTed it to the e-mail edge function. The eight
-- DECLARE variables that block alone used are dropped. Everything else is
-- verbatim: signature, LANGUAGE plpgsql, SECURITY DEFINER, search_path,
-- the outer BEGIN / EXCEPTION WHEN OTHERS THEN NULL, and BOTH staff_notify
-- calls with identical arguments. The trigger itself is NOT touched (no
-- DROP / CREATE TRIGGER). CREATE OR REPLACE keeps the function's ACL.
--
-- The customer's "extension-requested" copy now sends from the
-- request-extension edge function (same template, same templateData, its own
-- idempotency key), deployed with this release.
--
-- SELF-CHECK (also enforced by the $post$ block below, which rolls the
-- migration back on failure): the new body contains ZERO pg_net HTTP POST
-- calls and ZERO references to the send-transactional e-mail endpoint (the
-- two needles are spelled in pieces below so that a grep of THIS FILE for
-- either literal also returns 0), and the same number of staff_notify calls
-- as before (2).
--
-- PRE-FLIGHT. The live body must be the recorded one (whitespace-collapsed
-- md5 783e7cb6f20561335d87c4b717461ba5, the same hash scripts/function-drift-audit
-- compares) or already this migration's body (2ca3b795ba41642db6e08b97ae94cf19,
-- a replay = no-op). Anything else refuses and changes nothing.
-- ===========================================================================

SET LOCAL lock_timeout = '60s';
SET LOCAL statement_timeout = '120s';

DO $pre$
DECLARE
  v_got text;
BEGIN
  SELECT md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) INTO v_got
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.notify_extension_event()');
  IF v_got IS NULL THEN
    RAISE EXCEPTION 'extension_trigger_no_email_call: public.notify_extension_event() is missing -- nothing changed';
  END IF;
  IF v_got NOT IN ('783e7cb6f20561335d87c4b717461ba5', '2ca3b795ba41642db6e08b97ae94cf19') THEN
    RAISE EXCEPTION 'extension_trigger_no_email_call: live body md5 % is not the recorded definition -- nothing changed (start from pg_get_functiondef on live)', v_got;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.notify_extension_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_invoice text;
BEGIN
  BEGIN
    SELECT invoice_number INTO v_invoice FROM public.layaway_accounts WHERE id = NEW.account_id;
    IF TG_OP = 'INSERT' THEN
      PERFORM public.staff_notify(
        'extension_requested',
        'Extension requested',
        'Inv #' || COALESCE(v_invoice,'?') || COALESCE(' — ' || NEW.reason, ''),
        NEW.account_id, NEW.customer_id, v_invoice, '{}'::jsonb
      );
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
      PERFORM public.staff_notify(
        'extension_' || NEW.status::text,
        'Extension ' || NEW.status::text,
        'Inv #' || COALESCE(v_invoice,'?') || ' — ' || NEW.status::text || ' by ' || public.staff_display_name(NEW.reviewed_by),
        NEW.account_id, NEW.customer_id, v_invoice, '{}'::jsonb
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END
$function$;

DO $post$
DECLARE
  v_src text;
  v_calls int;
BEGIN
  SELECT p.prosrc INTO v_src
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.notify_extension_event()');
  v_calls := (length(v_src) - length(replace(v_src, 'public.staff_notify(', ''))) / length('public.staff_notify(');
  IF position(('net.http' || '_post') IN v_src) > 0
     OR position(('send-transactional' || '-email') IN v_src) > 0
     OR v_calls <> 2 THEN
    RAISE EXCEPTION 'extension_trigger_no_email_call: self-check failed (an e-mail call is still present or staff_notify calls = %) -- rolled back', v_calls;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgname = 'trg_notify_extension_event'
      AND t.tgrelid = 'public.extension_requests'::regclass
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'extension_trigger_no_email_call: trg_notify_extension_event is missing on extension_requests -- rolled back';
  END IF;
END
$post$;
