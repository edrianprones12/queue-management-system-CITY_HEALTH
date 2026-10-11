-- Phase 2: additive consultation timing and transactional doctor completion.
-- Apply to an approved development Supabase project first, in its SQL Editor.
-- Do not rerun the full schema/seeding script: it truncates counters.
-- This migration changes no existing patient timestamps, statuses, or records.
BEGIN;

ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS consultation_started_at TIMESTAMPTZ NULL;

-- Older deployments may not yet have run scripts/add-reason-column.sql.
-- Keep the existing completion note field available; this is not a new status.
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS reason TEXT;

COMMENT ON COLUMN public.patients.consultation_started_at IS
  'Actual doctor consultation start, recorded by the server-side PostgreSQL RPC. NULL for unstarted and historical consultations; never backfill from called_at.';

CREATE OR REPLACE FUNCTION public.start_patient_consultation(
  p_patient_id BIGINT,
  p_doctor_name TEXT,
  p_user_id_num TEXT,
  p_accepted_at TIMESTAMPTZ
)
RETURNS public.patients
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user public.users%ROWTYPE;
  v_counter public.counters%ROWTYPE;
  v_patient public.patients%ROWTYPE;
  v_assigned_doctor TEXT;
  v_started_at TIMESTAMPTZ;
  v_updated_count INTEGER;
BEGIN
  IF p_patient_id IS NULL OR p_patient_id <= 0
     OR p_doctor_name IS NULL OR p_doctor_name NOT IN ('Doctor 1', 'Doctor 2', 'Doctor 3')
     OR p_user_id_num IS NULL OR pg_catalog.btrim(p_user_id_num) = '' THEN
    RAISE EXCEPTION 'A patient and authenticated doctor identity are required' USING ERRCODE = '22023';
  END IF;

  SELECT u.* INTO v_user FROM public.users AS u WHERE u.id_num = p_user_id_num;
  IF NOT FOUND OR v_user.role::TEXT <> 'admin' OR v_user.doctor_name IS NULL THEN
    RAISE EXCEPTION 'Only the assigned doctor can start a consultation' USING ERRCODE = '42501';
  END IF;

  -- Match the backend's existing doctor aliases, including numeric counter IDs.
  SELECT c.id_num INTO v_assigned_doctor
    FROM public.counters AS c
    WHERE c.id::TEXT = pg_catalog.btrim(v_user.doctor_name)
       OR pg_catalog.lower(c.id_num) = pg_catalog.lower(pg_catalog.btrim(v_user.doctor_name));
  IF v_assigned_doctor IS NULL THEN
    v_assigned_doctor := CASE
      WHEN pg_catalog.lower(pg_catalog.btrim(v_user.doctor_name)) ~ '^doctor[[:space:]]*[123]$'
        THEN 'Doctor ' || pg_catalog.regexp_replace(v_user.doctor_name, '[^0-9]', '', 'g')
      WHEN pg_catalog.btrim(v_user.doctor_name) ~ '^[123]$'
        THEN 'Doctor ' || pg_catalog.btrim(v_user.doctor_name)
      ELSE pg_catalog.btrim(v_user.doctor_name)
    END;
  END IF;
  IF v_assigned_doctor IS DISTINCT FROM p_doctor_name THEN
    RAISE EXCEPTION 'Only the assigned doctor can start a consultation' USING ERRCODE = '42501';
  END IF;

  -- Both lifecycle RPCs acquire the counter before the patient. Duplicate
  -- requests wait for these row locks, then validate the committed state.
  SELECT c.* INTO v_counter FROM public.counters AS c
    WHERE c.id_num = p_doctor_name FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Assigned doctor counter not found';
  END IF;
  SELECT p.* INTO v_patient FROM public.patients AS p
    WHERE p.id = p_patient_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Patient not found';
  END IF;

  IF v_patient.counter_id IS NULL OR NOT (
    v_patient.counter_id = v_counter.id_num
    OR v_patient.counter_id = v_counter.id::TEXT
    OR pg_catalog.lower(pg_catalog.btrim(v_patient.counter_id)) = pg_catalog.lower(v_counter.id_num)
    OR pg_catalog.lower(pg_catalog.btrim(v_patient.counter_id)) = pg_catalog.lower(pg_catalog.replace(v_counter.id_num, ' ', ''))
  ) OR v_counter.current_patient_id IS DISTINCT FROM p_patient_id THEN
    RAISE EXCEPTION 'Patient is not currently assigned to this doctor' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.counters AS c
      WHERE c.current_patient_id = p_patient_id AND c.id <> v_counter.id) THEN
    RAISE EXCEPTION 'Patient has conflicting doctor assignments';
  END IF;
  IF v_patient.status::TEXT <> 'serving' OR v_patient.called_at IS NULL
     OR v_patient.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Only a called, serving patient can start consultation';
  END IF;
  IF v_patient.consultation_started_at IS NOT NULL THEN
    RAISE EXCEPTION 'Consultation has already started';
  END IF;
  -- Acceptance lives in awaiting-accept.json, not in PostgreSQL. The trusted
  -- Node backend reads and validates it before providing this attestation.
  -- Restrict EXECUTE to service_role; never accept this parameter from clients.
  IF p_accepted_at IS NULL OR NOT pg_catalog.isfinite(p_accepted_at) THEN
    RAISE EXCEPTION 'Accept this patient before starting consultation';
  END IF;
  IF p_accepted_at < v_patient.called_at THEN
    -- The Node backend generates both timestamps. Revalidate under the row
    -- locks so an acceptance read before cancel/requeue/new call cannot start
    -- a later call cycle while this request was waiting for the counter.
    RAISE EXCEPTION 'Accept the current call before starting consultation';
  END IF;

  v_started_at := pg_catalog.clock_timestamp();
  UPDATE public.patients AS p SET consultation_started_at = v_started_at
    WHERE p.id = p_patient_id RETURNING p.* INTO v_patient;
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count <> 1 THEN
    RAISE EXCEPTION 'Unable to record the consultation start';
  END IF;
  RETURN v_patient;
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_patient_consultation(
  p_patient_id BIGINT,
  p_doctor_name TEXT,
  p_user_id_num TEXT,
  p_expected_started_at TIMESTAMPTZ,
  p_reason TEXT DEFAULT NULL
)
RETURNS public.patients
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user public.users%ROWTYPE;
  v_counter public.counters%ROWTYPE;
  v_patient public.patients%ROWTYPE;
  v_assigned_doctor TEXT;
  v_completed_at TIMESTAMPTZ;
  v_updated_count INTEGER;
  v_released_count INTEGER;
BEGIN
  IF p_patient_id IS NULL OR p_patient_id <= 0
     OR p_doctor_name IS NULL OR p_doctor_name NOT IN ('Doctor 1', 'Doctor 2', 'Doctor 3')
     OR p_user_id_num IS NULL OR pg_catalog.btrim(p_user_id_num) = '' THEN
    RAISE EXCEPTION 'A patient and authenticated doctor identity are required' USING ERRCODE = '22023';
  END IF;

  SELECT u.* INTO v_user FROM public.users AS u WHERE u.id_num = p_user_id_num;
  IF NOT FOUND OR v_user.role::TEXT <> 'admin' OR v_user.doctor_name IS NULL THEN
    RAISE EXCEPTION 'Only the assigned doctor can complete a consultation' USING ERRCODE = '42501';
  END IF;
  SELECT c.id_num INTO v_assigned_doctor
    FROM public.counters AS c
    WHERE c.id::TEXT = pg_catalog.btrim(v_user.doctor_name)
       OR pg_catalog.lower(c.id_num) = pg_catalog.lower(pg_catalog.btrim(v_user.doctor_name));
  IF v_assigned_doctor IS NULL THEN
    v_assigned_doctor := CASE
      WHEN pg_catalog.lower(pg_catalog.btrim(v_user.doctor_name)) ~ '^doctor[[:space:]]*[123]$'
        THEN 'Doctor ' || pg_catalog.regexp_replace(v_user.doctor_name, '[^0-9]', '', 'g')
      WHEN pg_catalog.btrim(v_user.doctor_name) ~ '^[123]$'
        THEN 'Doctor ' || pg_catalog.btrim(v_user.doctor_name)
      ELSE pg_catalog.btrim(v_user.doctor_name)
    END;
  END IF;
  IF v_assigned_doctor IS DISTINCT FROM p_doctor_name THEN
    RAISE EXCEPTION 'Only the assigned doctor can complete a consultation' USING ERRCODE = '42501';
  END IF;

  SELECT c.* INTO v_counter FROM public.counters AS c
    WHERE c.id_num = p_doctor_name FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Assigned doctor counter not found';
  END IF;
  SELECT p.* INTO v_patient FROM public.patients AS p
    WHERE p.id = p_patient_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Patient not found';
  END IF;

  IF v_patient.counter_id IS NULL OR NOT (
    v_patient.counter_id = v_counter.id_num
    OR v_patient.counter_id = v_counter.id::TEXT
    OR pg_catalog.lower(pg_catalog.btrim(v_patient.counter_id)) = pg_catalog.lower(v_counter.id_num)
    OR pg_catalog.lower(pg_catalog.btrim(v_patient.counter_id)) = pg_catalog.lower(pg_catalog.replace(v_counter.id_num, ' ', ''))
  ) OR v_counter.current_patient_id IS DISTINCT FROM p_patient_id THEN
    RAISE EXCEPTION 'Patient is not currently assigned to this doctor' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.counters AS c
      WHERE c.current_patient_id = p_patient_id AND c.id <> v_counter.id) THEN
    RAISE EXCEPTION 'Patient has conflicting doctor assignments';
  END IF;
  IF v_patient.status::TEXT <> 'serving' OR v_patient.called_at IS NULL
     OR v_patient.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Only a called, serving patient can complete consultation';
  END IF;
  IF v_patient.consultation_started_at IS NULL THEN
    RAISE EXCEPTION 'Start consultation before completing this patient';
  END IF;
  IF p_expected_started_at IS NULL OR NOT pg_catalog.isfinite(p_expected_started_at) THEN
    RAISE EXCEPTION 'An expected consultation start is required';
  END IF;
  IF p_expected_started_at IS DISTINCT FROM v_patient.consultation_started_at THEN
    -- The backend passes the exact persisted start it validated, preserving
    -- PostgreSQL microseconds. A delayed request must not finish a later
    -- consultation attempt after cancel/requeue/call/start on this patient ID.
    RAISE EXCEPTION 'Consultation attempt changed; refresh before completing';
  END IF;

  v_completed_at := pg_catalog.clock_timestamp();
  IF NOT pg_catalog.isfinite(v_patient.consultation_started_at)
     OR v_completed_at <= v_patient.consultation_started_at THEN
    RAISE EXCEPTION 'Completion must occur after consultation start';
  END IF;
  UPDATE public.patients AS p
    SET status = 'completed', completed_at = v_completed_at,
        reason = NULLIF(pg_catalog.btrim(p_reason), '')
    WHERE p.id = p_patient_id RETURNING p.* INTO v_patient;
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count <> 1 THEN
    RAISE EXCEPTION 'Unable to record the consultation completion';
  END IF;
  UPDATE public.counters AS c SET current_patient_id = NULL
    WHERE c.id = v_counter.id AND c.current_patient_id = p_patient_id;
  GET DIAGNOSTICS v_released_count = ROW_COUNT;
  IF v_released_count <> 1 THEN
    -- An exception rolls the patient update back with the counter update.
    RAISE EXCEPTION 'Unable to release the assigned doctor counter';
  END IF;
  RETURN v_patient;
END;
$function$;

REVOKE ALL ON FUNCTION public.start_patient_consultation(BIGINT, TEXT, TEXT, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_patient_consultation(BIGINT, TEXT, TEXT, TIMESTAMPTZ, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_patient_consultation(BIGINT, TEXT, TEXT, TIMESTAMPTZ)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_patient_consultation(BIGINT, TEXT, TEXT, TIMESTAMPTZ, TEXT)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
