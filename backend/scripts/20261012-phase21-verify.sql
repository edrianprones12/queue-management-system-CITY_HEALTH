-- Read-only Phase 2.1 installation checks. Missing migration returns FAIL.
BEGIN TRANSACTION READ ONLY;
WITH recovery AS (
  SELECT p.* FROM pg_catalog.pg_proc AS p
  WHERE p.oid = pg_catalog.to_regprocedure('public.recover_patient_visit(bigint,text,text,uuid,text,timestamptz,timestamptz,timestamptz,timestamptz,text,text)')
), checks AS (
  SELECT 'revision_column' AS check_name, EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'patients'
      AND column_name = 'visit_state_revision' AND data_type = 'uuid'
      AND is_nullable = 'NO' AND column_default LIKE '%gen_random_uuid()%'
  ) AS passed
  UNION ALL SELECT 'revision_update_trigger', EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger AS t
    JOIN pg_catalog.pg_proc AS p ON p.oid = t.tgfoid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE t.tgrelid = pg_catalog.to_regclass('public.patients')
      AND t.tgname = 'patients_rotate_visit_revision' AND NOT t.tgisinternal
      AND t.tgenabled IN ('O', 'A') AND (t.tgtype::INTEGER & 19) = 19
      AND t.tgattr::TEXT = '' AND n.nspname = 'public'
      AND p.proname = 'rotate_patient_visit_revision'
  )
  UNION ALL SELECT 'recovery_rpc_arguments', EXISTS (
    SELECT 1 FROM recovery WHERE proargnames = ARRAY[
      'p_patient_id', 'p_action', 'p_user_id_num', 'p_expected_revision',
      'p_expected_status', 'p_expected_created_at', 'p_expected_called_at',
      'p_expected_started_at', 'p_expected_completed_at', 'p_expected_counter_id', 'p_reason'
    ]::TEXT[] AND prorettype = pg_catalog.to_regtype('public.patients')
  )
  UNION ALL SELECT 'recovery_definer_empty_path', EXISTS (
    SELECT 1 FROM recovery WHERE prosecdef AND proconfig @> ARRAY['search_path=""']::TEXT[]
  )
  UNION ALL SELECT 'public_execute_denied', EXISTS (
    SELECT 1 FROM recovery AS p WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS a
      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
    )
  )
  UNION ALL SELECT 'anon_execute_denied', EXISTS (
    SELECT 1 FROM recovery WHERE NOT pg_catalog.has_function_privilege('anon', oid, 'EXECUTE')
  )
  UNION ALL SELECT 'authenticated_execute_denied', EXISTS (
    SELECT 1 FROM recovery WHERE NOT pg_catalog.has_function_privilege('authenticated', oid, 'EXECUTE')
  )
  UNION ALL SELECT 'service_role_execute_allowed', EXISTS (
    SELECT 1 FROM recovery WHERE pg_catalog.has_function_privilege('service_role', oid, 'EXECUTE')
  )
)
SELECT check_name, CASE WHEN passed THEN 'PASS' ELSE 'FAIL' END AS result,
       bool_and(passed) OVER () AS all_pass
FROM checks ORDER BY check_name;
COMMIT;
