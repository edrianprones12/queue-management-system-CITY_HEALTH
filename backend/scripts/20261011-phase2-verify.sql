-- Phase 2 installation check: one read-only result table, no patient records.
-- Run this in the development project's Supabase SQL Editor after applying
-- 20261010-phase2-consultation-lifecycle.sql. All 15 checks should show PASS
-- and all_pass should be true.
-- Missing functions/roles produce FAIL rows instead of privilege-query errors.
WITH expected_columns(position, column_name, data_type, is_nullable) AS (
  VALUES
    (1, 'id', 'bigint', 'NO'),
    (2, 'status', 'USER-DEFINED', 'NO'),
    (3, 'counter_id', 'character varying', 'YES'),
    (4, 'called_at', 'timestamp with time zone', 'YES'),
    (5, 'consultation_started_at', 'timestamp with time zone', 'YES'),
    (6, 'completed_at', 'timestamp with time zone', 'YES'),
    (7, 'reason', 'text', 'YES')
), expected_functions(position, function_name, signature, identity_arguments) AS (
  VALUES
    (8, 'start_patient_consultation',
      'public.start_patient_consultation(bigint,text,text,timestamptz)',
      'p_patient_id bigint, p_doctor_name text, p_user_id_num text, p_accepted_at timestamp with time zone'),
    (9, 'complete_patient_consultation',
      'public.complete_patient_consultation(bigint,text,text,timestamptz,text)',
      'p_patient_id bigint, p_doctor_name text, p_user_id_num text, p_expected_started_at timestamp with time zone, p_reason text')
), resolved_functions AS (
  SELECT f.*, pg_catalog.to_regprocedure(f.signature) AS function_oid
  FROM expected_functions AS f
), expected_roles(role_position, role_name, may_execute) AS (
  VALUES (1, 'anon', false), (2, 'authenticated', false), (3, 'service_role', true)
), resolved_privileges AS (
  SELECT f.position, f.function_name, f.function_oid,
         r.role_position, r.role_name, r.may_execute AS expected_execute,
         role.oid AS role_oid,
         CASE WHEN f.function_oid IS NOT NULL AND role.oid IS NOT NULL
              THEN pg_catalog.has_function_privilege(role.oid, f.function_oid::oid, 'EXECUTE')
              ELSE NULL END AS actual_execute
  FROM resolved_functions AS f
  CROSS JOIN expected_roles AS r
  LEFT JOIN pg_catalog.pg_roles AS role ON role.rolname = r.role_name
), checks AS (
  SELECT e.position, 'patients.' || e.column_name AS check_name,
         e.data_type || ', nullable=' || e.is_nullable ||
           CASE WHEN e.column_name = 'consultation_started_at' THEN ', no default' ELSE '' END AS expected,
         CASE WHEN c.column_name IS NULL THEN 'MISSING COLUMN'
              ELSE c.data_type || ', nullable=' || c.is_nullable ||
                CASE WHEN e.column_name = 'consultation_started_at'
                     THEN ', default=' || COALESCE(c.column_default, 'none') ELSE '' END END AS actual,
         COALESCE(c.data_type = e.data_type AND c.is_nullable = e.is_nullable AND
           (e.column_name <> 'consultation_started_at' OR c.column_default IS NULL), false) AS passed
  FROM expected_columns AS e
  LEFT JOIN information_schema.columns AS c
    ON c.table_schema = 'public' AND c.table_name = 'patients' AND c.column_name = e.column_name

  UNION ALL

  SELECT f.position, f.function_name || ' arguments', f.identity_arguments,
         CASE WHEN f.function_oid IS NULL THEN 'MISSING FUNCTION'
              ELSE pg_catalog.pg_get_function_identity_arguments(f.function_oid) END,
         COALESCE(pg_catalog.pg_get_function_identity_arguments(f.function_oid) = f.identity_arguments, false)
  FROM resolved_functions AS f

  UNION ALL

  SELECT 10 + (p.position - 8) * 3 + p.role_position - 1,
         p.function_name || ' / ' || p.role_name || ' EXECUTE',
         p.expected_execute::text,
         CASE WHEN p.function_oid IS NULL THEN 'MISSING FUNCTION'
              WHEN p.role_oid IS NULL THEN 'MISSING ROLE'
              ELSE p.actual_execute::text END,
         COALESCE(p.actual_execute = p.expected_execute, false)
  FROM resolved_privileges AS p
)
SELECT check_name, expected, actual, CASE WHEN passed THEN 'PASS' ELSE 'FAIL' END AS result,
       pg_catalog.bool_and(passed) OVER () AS all_pass
FROM checks
ORDER BY position;
