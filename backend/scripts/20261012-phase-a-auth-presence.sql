-- Phase A: persisted custom-JWT staff sessions and independent doctor presence.
-- Apply first to an approved development project. Production needs approval.
-- Additive: never writes patients, consultation timestamps, or counters.
BEGIN;

-- Bind the verified-password snapshot to a particular credential/account
-- incarnation. A reset, change-back, or delete/recreate must invalidate an
-- already verified but delayed login before its session can be inserted.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS auth_revision UUID
  NOT NULL DEFAULT pg_catalog.gen_random_uuid();
COMMENT ON COLUMN public.users.auth_revision IS
  'Private account/credential incarnation for custom-JWT session creation. Rotated on identity, password, role, or doctor assignment changes. Never expose in a JWT or public user response.';

CREATE TABLE IF NOT EXISTS public.staff_auth_sessions (
  session_id UUID PRIMARY KEY,
  user_id_num TEXT NOT NULL REFERENCES public.users(id_num) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'superadmin')),
  doctor_name TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS staff_auth_sessions_user_idx
  ON public.staff_auth_sessions (user_id_num, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS staff_auth_sessions_active_doctor_idx
  ON public.staff_auth_sessions (doctor_name, last_seen_at DESC)
  WHERE revoked_at IS NULL;
COMMENT ON TABLE public.staff_auth_sessions IS
  'Server-side UUID references for existing custom JWTs. Stores no password/hash, access token, or authentication secret. Presence expires after 75 seconds without a heartbeat; authentication expires after 8 hours.';

ALTER TABLE public.staff_auth_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.staff_auth_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.staff_auth_sessions TO service_role;
DROP POLICY IF EXISTS staff_auth_sessions_service_role ON public.staff_auth_sessions;
CREATE POLICY staff_auth_sessions_service_role ON public.staff_auth_sessions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Remove the old signature so reapplying this additive migration cannot leave
-- an alternative creation path that bypasses the verified account revision.
DROP FUNCTION IF EXISTS public.create_staff_auth_session(UUID, TEXT, TEXT, TEXT);
CREATE OR REPLACE FUNCTION public.create_staff_auth_session(
  p_session_id UUID, p_user_id_num TEXT, p_role TEXT, p_doctor_name TEXT,
  p_auth_revision UUID
)
RETURNS public.staff_auth_sessions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_user public.users%ROWTYPE;
  v_session public.staff_auth_sessions%ROWTYPE;
  v_now TIMESTAMPTZ;
BEGIN
  SELECT u.* INTO v_user FROM public.users AS u
    WHERE u.id_num = p_user_id_num FOR SHARE;
  IF NOT FOUND OR p_session_id IS NULL
     OR p_auth_revision IS NULL OR v_user.auth_revision IS DISTINCT FROM p_auth_revision
     OR v_user.role::TEXT IS DISTINCT FROM p_role
     OR NULLIF(v_user.doctor_name, '') IS DISTINCT FROM NULLIF(p_doctor_name, '') THEN
    RAISE EXCEPTION 'Authenticated account changed; sign in again' USING ERRCODE = '42501';
  END IF;
  v_now := pg_catalog.clock_timestamp();
  INSERT INTO public.staff_auth_sessions
      (session_id, user_id_num, role, doctor_name, created_at, last_seen_at, expires_at)
    VALUES (p_session_id, p_user_id_num, p_role, NULLIF(p_doctor_name, ''), v_now, v_now, v_now + interval '8 hours')
    RETURNING * INTO v_session;
  RETURN v_session;
END;
$function$;

CREATE OR REPLACE FUNCTION public.validate_staff_auth_session(
  p_session_id UUID, p_user_id_num TEXT, p_role TEXT, p_doctor_name TEXT
)
RETURNS public.staff_auth_sessions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_user public.users%ROWTYPE;
  v_session public.staff_auth_sessions%ROWTYPE;
BEGIN
  SELECT u.* INTO v_user FROM public.users AS u WHERE u.id_num = p_user_id_num FOR SHARE;
  IF NOT FOUND OR v_user.role::TEXT IS DISTINCT FROM p_role
     OR NULLIF(v_user.doctor_name, '') IS DISTINCT FROM NULLIF(p_doctor_name, '') THEN
    RAISE EXCEPTION 'Authenticated account changed; sign in again' USING ERRCODE = '42501';
  END IF;
  SELECT s.* INTO v_session FROM public.staff_auth_sessions AS s
    WHERE s.session_id = p_session_id AND s.user_id_num = p_user_id_num;
  IF NOT FOUND OR v_session.role IS DISTINCT FROM p_role
     OR v_session.doctor_name IS DISTINCT FROM NULLIF(p_doctor_name, '')
     OR v_session.revoked_at IS NOT NULL
     OR v_session.expires_at <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'Authentication session expired or revoked; sign in again' USING ERRCODE = '42501';
  END IF;
  RETURN v_session;
END;
$function$;

CREATE OR REPLACE FUNCTION public.heartbeat_staff_auth_session(
  p_session_id UUID, p_user_id_num TEXT, p_role TEXT, p_doctor_name TEXT
)
RETURNS public.staff_auth_sessions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_user public.users%ROWTYPE;
  v_session public.staff_auth_sessions%ROWTYPE;
  v_now TIMESTAMPTZ;
BEGIN
  -- User then session locks: user credential/assignment changes and concurrent
  -- heartbeats serialize. Never validate in one request then blindly upsert.
  SELECT u.* INTO v_user FROM public.users AS u WHERE u.id_num = p_user_id_num FOR SHARE;
  IF NOT FOUND OR v_user.role::TEXT IS DISTINCT FROM p_role
     OR NULLIF(v_user.doctor_name, '') IS DISTINCT FROM NULLIF(p_doctor_name, '') THEN
    RAISE EXCEPTION 'Authenticated account changed; sign in again' USING ERRCODE = '42501';
  END IF;
  SELECT s.* INTO v_session FROM public.staff_auth_sessions AS s
    WHERE s.session_id = p_session_id AND s.user_id_num = p_user_id_num FOR UPDATE;
  v_now := pg_catalog.clock_timestamp();
  IF NOT FOUND OR v_session.role IS DISTINCT FROM p_role
     OR v_session.doctor_name IS DISTINCT FROM NULLIF(p_doctor_name, '')
     OR v_session.revoked_at IS NOT NULL OR v_session.expires_at <= v_now THEN
    RAISE EXCEPTION 'Authentication session expired or revoked; sign in again' USING ERRCODE = '42501';
  END IF;
  -- Shared tabs and multiple backend instances cause at most one write/20s.
  IF v_session.last_seen_at <= v_now - interval '20 seconds' THEN
    UPDATE public.staff_auth_sessions AS s SET last_seen_at = v_now
      WHERE s.session_id = p_session_id RETURNING s.* INTO v_session;
  END IF;
  RETURN v_session;
END;
$function$;

CREATE OR REPLACE FUNCTION public.revoke_staff_auth_session(p_session_id UUID, p_user_id_num TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
BEGIN
  -- Idempotent and owner-bound; never changes last_seen or any queue state.
  UPDATE public.staff_auth_sessions AS s SET revoked_at = pg_catalog.clock_timestamp()
    WHERE s.session_id = p_session_id AND s.user_id_num = p_user_id_num AND s.revoked_at IS NULL;
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.revoke_staff_user_sessions(p_user_id_num TEXT)
RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE v_count BIGINT;
BEGIN
  UPDATE public.staff_auth_sessions AS s SET revoked_at = pg_catalog.clock_timestamp()
    WHERE s.user_id_num = p_user_id_num AND s.revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.revoke_changed_staff_sessions()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.revoke_staff_user_sessions(OLD.id_num);
    RETURN OLD;
  END IF;
  IF OLD.password IS DISTINCT FROM NEW.password OR OLD.role IS DISTINCT FROM NEW.role
     OR OLD.doctor_name IS DISTINCT FROM NEW.doctor_name OR OLD.id_num IS DISTINCT FROM NEW.id_num
     OR OLD.auth_revision IS DISTINCT FROM NEW.auth_revision THEN
    PERFORM public.revoke_staff_user_sessions(OLD.id_num);
    NEW.auth_revision := pg_catalog.gen_random_uuid();
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS staff_auth_revoke_account_change ON public.users;
CREATE TRIGGER staff_auth_revoke_account_change
  BEFORE UPDATE OF password, role, doctor_name, id_num, auth_revision OR DELETE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.revoke_changed_staff_sessions();

CREATE OR REPLACE FUNCTION public.get_staff_doctor_presence()
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE v_now TIMESTAMPTZ := pg_catalog.clock_timestamp(); v_doctors JSONB;
BEGIN
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'doctor_name', presence.doctor_name, 'online', presence.online, 'last_seen_at', presence.last_seen_at
    ) ORDER BY presence.doctor_name), '[]'::JSONB) INTO v_doctors
  FROM (
    SELECT c.id_num AS doctor_name,
      COALESCE(pg_catalog.bool_or(s.revoked_at IS NULL AND s.expires_at > v_now
        AND s.last_seen_at >= v_now - interval '75 seconds'), false) AS online,
      pg_catalog.max(s.last_seen_at) AS last_seen_at
    FROM public.counters AS c
    LEFT JOIN (
      SELECT account.*, assigned.id AS assigned_counter_id
      FROM public.users AS account
      CROSS JOIN LATERAL (
        SELECT candidate.id FROM public.counters AS candidate
        WHERE pg_catalog.lower(pg_catalog.btrim(candidate.id_num)) = pg_catalog.lower(pg_catalog.btrim(account.doctor_name))
          OR candidate.id::TEXT = pg_catalog.lower(pg_catalog.btrim(account.doctor_name))
          OR pg_catalog.lower(candidate.id_num) = CASE
            WHEN pg_catalog.lower(pg_catalog.btrim(account.doctor_name)) ~ '^(doctor[[:space:]]*)?[0-9]+$'
              THEN 'doctor ' || (pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.btrim(account.doctor_name)), '^doctor[[:space:]]*', '')::NUMERIC)::TEXT
            ELSE NULL
          END
        -- Match the application's first-counter resolver; aliases can collide
        -- with a real counter ID and must never make two doctors online.
        ORDER BY candidate.id LIMIT 1
      ) AS assigned
      WHERE account.role::TEXT = 'admin' AND account.doctor_name IS NOT NULL
    ) AS u ON u.assigned_counter_id = c.id
    LEFT JOIN public.staff_auth_sessions AS s ON s.user_id_num = u.id_num
      AND s.role = u.role::TEXT AND s.doctor_name IS NOT DISTINCT FROM NULLIF(u.doctor_name, '')
    GROUP BY c.id_num
  ) AS presence;
  RETURN pg_catalog.jsonb_build_object('doctors', v_doctors, 'observed_at', v_now, 'timeout_seconds', 75);
END;
$function$;

REVOKE ALL ON FUNCTION public.create_staff_auth_session(UUID, TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.validate_staff_auth_session(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.heartbeat_staff_auth_session(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_staff_auth_session(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_staff_user_sessions(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_changed_staff_sessions() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_staff_doctor_presence() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_staff_auth_session(UUID, TEXT, TEXT, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.validate_staff_auth_session(UUID, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.heartbeat_staff_auth_session(UUID, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_staff_auth_session(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_staff_user_sessions(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_staff_doctor_presence() TO service_role;

COMMIT;
NOTIFY pgrst, 'reload schema';
