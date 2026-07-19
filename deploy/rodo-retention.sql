-- ============================================================
-- CFG RODO pack — retention + erasure for wacrm (hosted Supabase)
-- Paste into the Supabase SQL Editor AFTER all-migrations.sql.
--
-- Policy implemented (confirm with counsel before changing):
--   * Messages and conversations: deleted 24 months after the
--     conversation's last activity.
--   * Contacts: deleted when they have had no conversation activity
--     for 24 months AND are not linked to any deal.
--   * Erasure on request: rodo_erase_contact_by_phone() removes a
--     data subject across all tables immediately (Art. 17 GDPR).
--
-- The schedule runs weekly (Mon 03:15 UTC) via pg_cron.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Single source of truth for the retention window.
CREATE OR REPLACE FUNCTION public.rodo_retention_interval()
RETURNS interval LANGUAGE sql IMMUTABLE AS $$ SELECT interval '24 months' $$;

-- ------------------------------------------------------------
-- Scheduled purge
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rodo_retention_purge()
RETURNS TABLE (purged_conversations int, purged_contacts int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_conv int;
  v_cont int;
BEGIN
  -- deals.conversation_id is a plain FK (no CASCADE / SET NULL —
  -- 001:273) and would abort the conversation delete. Detach first;
  -- the deal itself is retained (may carry contract/tax grounds).
  UPDATE deals SET conversation_id = NULL
  WHERE conversation_id IN (
    SELECT id FROM conversations
    WHERE COALESCE(last_message_at, created_at)
          < NOW() - rodo_retention_interval());

  -- Conversations (messages/reactions cascade via FK) whose last
  -- activity predates the retention window.
  WITH doomed AS (
    DELETE FROM conversations c
    WHERE COALESCE(c.last_message_at, c.created_at)
          < NOW() - rodo_retention_interval()
    RETURNING id
  ) SELECT count(*) INTO v_conv FROM doomed;

  -- Contacts with no remaining conversations, older than the window,
  -- and not attached to any deal (deals may carry their own legal
  -- retention, e.g. contract/tax grounds — handled separately).
  WITH doomed AS (
    DELETE FROM contacts ct
    WHERE ct.created_at < NOW() - rodo_retention_interval()
      AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.contact_id = ct.id)
      AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.contact_id = ct.id)
    RETURNING id
  ) SELECT count(*) INTO v_cont FROM doomed;

  RETURN QUERY SELECT v_conv, v_cont;
END $$;

REVOKE ALL ON FUNCTION public.rodo_retention_purge() FROM PUBLIC, anon, authenticated;

-- Weekly schedule (idempotent re-registration).
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'rodo-retention-purge';
SELECT cron.schedule('rodo-retention-purge', '15 3 * * 1',
                     $$SELECT public.rodo_retention_purge()$$);

-- ------------------------------------------------------------
-- Erasure on request (Art. 17) — call from SQL editor:
--   SELECT * FROM rodo_erase_contact_by_phone('48500100200');
-- Matches on the normalized suffix so formatting differences
-- ('+48 500...', '0048500...') still hit.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rodo_erase_contact_by_phone(p_phone text)
RETURNS TABLE (erased_contacts int, erased_conversations int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_suffix text := right(regexp_replace(p_phone, '\D', '', 'g'), 8);
  v_ids uuid[];
  v_conv int;
BEGIN
  IF length(v_suffix) < 8 THEN
    RAISE EXCEPTION 'phone too short after normalization';
  END IF;

  SELECT array_agg(id) INTO v_ids FROM contacts
  WHERE right(regexp_replace(phone, '\D', '', 'g'), 8) = v_suffix;

  IF v_ids IS NULL THEN
    RETURN QUERY SELECT 0, 0; RETURN;
  END IF;

  -- Erasure removes the deal rows outright (data-subject request
  -- trumps pipeline history; export first if a legal ground requires
  -- keeping financial records — see procedure doc). Deals must go
  -- BEFORE conversations (plain FK on deals.conversation_id).
  DELETE FROM deals WHERE contact_id = ANY(v_ids)
     OR conversation_id IN (SELECT id FROM conversations WHERE contact_id = ANY(v_ids));

  WITH doomed AS (
    DELETE FROM conversations WHERE contact_id = ANY(v_ids) RETURNING id
  ) SELECT count(*) INTO v_conv FROM doomed;

  DELETE FROM broadcast_recipients WHERE contact_id = ANY(v_ids);
  DELETE FROM contact_notes       WHERE contact_id = ANY(v_ids);
  DELETE FROM contact_tags        WHERE contact_id = ANY(v_ids);
  DELETE FROM contact_custom_values WHERE contact_id = ANY(v_ids);
  DELETE FROM contacts WHERE id = ANY(v_ids);

  RETURN QUERY SELECT COALESCE(array_length(v_ids,1),0), v_conv;
END $$;

REVOKE ALL ON FUNCTION public.rodo_erase_contact_by_phone(text) FROM PUBLIC, anon, authenticated;

-- Verify installation:
--   SELECT jobname, schedule FROM cron.job WHERE jobname = 'rodo-retention-purge';
