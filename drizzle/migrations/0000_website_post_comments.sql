-- ═══════════════════════════════════════════════════════════════════════════
-- Article comments (owner-approved plan 2026-10-16 18:47 JST, decisions C1–C8).
--
-- Verified customers comment under blog articles on chajewelsjp.com; nothing is public until
-- the owner approves it in the Hub. Same shape as product reviews: the customer writes
-- through the `website` edge function (service role) → a pending row here → moderation in
-- Hub → Website → Content (CommentsCard) → staff bell 'comment_submitted'.
--
--   C1 Author = a customer whose auth user is email-confirmed AND linked to a customers row.
--      Shown publicly as first name + "Verified customer"; never the email.
--   C2 status pending → approved | rejected; approved ↔ hidden. The API returns approved only
--      (plus the author's own pending ones, to her).
--   C3 One staff reply per comment, editable, shown as "Cha Jewels" (reply_body / reply_by /
--      reply_at).
--   C4 The author edits while pending and soft-deletes her own at any time (deleted_at).
--   C5 body 1–1000 characters of plain text; 5 per customer per rolling 24 h (edge function).
--   C6 Shown on both language sites as written; the Hub shows a grey layaway hint only.
--   C7 Moderation is moderate_post_comment() (moderate_reviews, the ReviewsCard gate); every
--      action writes one audit_logs row (entity_type 'post_comment').
--   C8 Only on website_posts with type = 'article' and published = true (edge function).
--
-- Freshness: the existing notify_website_revalidate() (the website_posts / FAQ mechanism)
-- sends tag 'content' for any website_* table. Its trigger here fires only when the PUBLIC
-- view of a comment can change (an approved row before or after the write).
--
-- New objects only; nothing existing is changed.
-- ═══════════════════════════════════════════════════════════════════════════

SET lock_timeout = '15s';

CREATE TABLE IF NOT EXISTS public.website_post_comments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id       uuid NOT NULL REFERENCES public.website_posts(id) ON DELETE CASCADE,
  customer_id   uuid NOT NULL REFERENCES public.customers(id),
  auth_user_id  uuid NOT NULL,
  body          text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 1000),
  lang          text NOT NULL CHECK (lang IN ('en', 'ja')),
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected', 'hidden')),
  reply_body    text CHECK (reply_body IS NULL OR length(btrim(reply_body)) BETWEEN 1 AND 1000),
  reply_by      uuid,
  reply_at      timestamptz,
  moderated_by  uuid,
  moderated_at  timestamptz,
  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS website_post_comments_post_status_idx
  ON public.website_post_comments (post_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS website_post_comments_customer_idx
  ON public.website_post_comments (customer_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_website_post_comments_updated_at ON public.website_post_comments;
CREATE TRIGGER trg_website_post_comments_updated_at
  BEFORE UPDATE ON public.website_post_comments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_website_post_comments_revalidate ON public.website_post_comments;
CREATE TRIGGER trg_website_post_comments_revalidate
  AFTER UPDATE ON public.website_post_comments
  FOR EACH ROW
  WHEN ((OLD.status = 'approved' OR NEW.status = 'approved')
        AND (OLD.status IS DISTINCT FROM NEW.status
             OR OLD.body IS DISTINCT FROM NEW.body
             OR OLD.reply_body IS DISTINCT FROM NEW.reply_body
             OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at))
  EXECUTE FUNCTION public.notify_website_revalidate();

-- RLS: moderators read and update; no anon or customer policy (the website function writes
-- with the service role, which bypasses RLS).
ALTER TABLE public.website_post_comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS website_post_comments_moderators_select ON public.website_post_comments;
CREATE POLICY website_post_comments_moderators_select ON public.website_post_comments
  FOR SELECT TO authenticated
  USING ((SELECT public.has_permission((SELECT auth.uid()), 'moderate_reviews')));

DROP POLICY IF EXISTS website_post_comments_moderators_update ON public.website_post_comments;
CREATE POLICY website_post_comments_moderators_update ON public.website_post_comments
  FOR UPDATE TO authenticated
  USING ((SELECT public.has_permission((SELECT auth.uid()), 'moderate_reviews')))
  WITH CHECK ((SELECT public.has_permission((SELECT auth.uid()), 'moderate_reviews')));

-- Moderation: approve / reject / hide / show / reply. One audit_logs row per action.
CREATE OR REPLACE FUNCTION public.moderate_post_comment(p_id uuid, p_action text, p_reply text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid   uuid := auth.uid();
  v_old   public.website_post_comments%ROWTYPE;
  v_new   public.website_post_comments%ROWTYPE;
  v_to    text;
  v_reply text := btrim(coalesce(p_reply, ''));
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'moderate_reviews') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('approve', 'reject', 'hide', 'show', 'reply') THEN
    RETURN jsonb_build_object('error', 'bad_action');
  END IF;

  SELECT * INTO v_old FROM public.website_post_comments WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF v_old.deleted_at IS NOT NULL THEN RETURN jsonb_build_object('error', 'comment_deleted'); END IF;

  IF p_action = 'reply' THEN
    IF length(v_reply) NOT BETWEEN 1 AND 1000 THEN
      RETURN jsonb_build_object('error', 'reply_invalid');
    END IF;
    UPDATE public.website_post_comments
       SET reply_body = v_reply, reply_by = v_uid, reply_at = now()
     WHERE id = p_id RETURNING * INTO v_new;
  ELSE
    -- C2: pending → approved | rejected; approved ↔ hidden.
    v_to := CASE
      WHEN p_action = 'approve' AND v_old.status = 'pending'  THEN 'approved'
      WHEN p_action = 'reject'  AND v_old.status = 'pending'  THEN 'rejected'
      WHEN p_action = 'hide'    AND v_old.status = 'approved' THEN 'hidden'
      WHEN p_action = 'show'    AND v_old.status = 'hidden'   THEN 'approved'
    END;
    IF v_to IS NULL THEN
      RETURN jsonb_build_object('error', 'invalid_transition', 'status', v_old.status);
    END IF;
    UPDATE public.website_post_comments
       SET status = v_to, moderated_by = v_uid, moderated_at = now()
     WHERE id = p_id RETURNING * INTO v_new;
  END IF;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('post_comment', p_id, p_action, to_jsonb(v_old), to_jsonb(v_new), v_uid, now());

  RETURN jsonb_build_object('ok', true, 'comment', to_jsonb(v_new));
END
$fn$;
REVOKE ALL ON FUNCTION public.moderate_post_comment(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.moderate_post_comment(uuid, text, text) TO authenticated;
COMMENT ON FUNCTION public.moderate_post_comment(uuid, text, text) IS
  'Article comments: approve / reject / hide / show / reply. moderate_reviews only; one audit_logs row (post_comment / <action>).';