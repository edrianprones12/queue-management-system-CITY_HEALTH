-- Phase A.1 development preflight; prepared 13 October 2026.
-- REVIEW ONLY UNTIL THE TARGET PROJECT IS CONFIRMED AS DEVELOPMENT.
-- This file inspects catalog metadata only. It does not apply the migration,
-- call application RPCs, log in, read patient/user/session rows, or change data.
-- Run as an authorized SQL observer on the identified project. No project name
-- inferred from these results establishes development status by itself.
-- Missing application objects/roles produce NULL/false evidence, not unresolved
-- regclass/regprocedure errors. Inspect every result set, including no rows.
-- Credentials, JWTs, passwords, auth_revision values and session IDs are never
-- selected. Password column metadata is inspected without its default/value.
-- Do not include sensitive literals if an unexpected catalog definition embeds
-- them; redact that definition before saving/exporting results.
-- After approved installation, also run the existing phase-a-verify.sql.

BEGIN TRANSACTION READ ONLY;

-- 01: execution context, not proof of environment identity.
SELECT pg_catalog.current_database() AS database_name,
       CURRENT_USER AS executing_role,
       pg_catalog.current_setting('transaction_read_only') AS transaction_read_only,
       pg_catalog.current_setting('server_version') AS server_version;

-- 02: required relations and actual RLS/owner configuration.
WITH expected(table_name) AS (VALUES
  ('users'), ('patients'), ('counters'), ('staff_auth_sessions')
)
SELECT e.table_name,
       c.oid IS NOT NULL AS exists,
       c.relkind AS relation_kind,
       pg_catalog.pg_get_userbyid(c.relowner) AS owner,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced
FROM expected AS e
LEFT JOIN pg_catalog.pg_namespace AS n ON n.nspname = 'public'
LEFT JOIN pg_catalog.pg_class AS c
  ON c.relnamespace = n.oid AND c.relname = e.table_name
ORDER BY e.table_name;

-- 03: canonical new-column requirements, including missing-object evidence.
-- An IF NOT EXISTS migration does not repair an incompatible existing column.
WITH expected(table_name, column_name, type_name, expected_not_null) AS (VALUES
  ('users', 'auth_revision', 'uuid', true),
  ('staff_auth_sessions', 'session_id', 'uuid', true),
  ('staff_auth_sessions', 'user_id_num', 'text', true),
  ('staff_auth_sessions', 'role', 'text', true),
  ('staff_auth_sessions', 'doctor_name', 'text', false),
  ('staff_auth_sessions', 'created_at', 'timestamp with time zone', true),
  ('staff_auth_sessions', 'last_seen_at', 'timestamp with time zone', true),
  ('staff_auth_sessions', 'expires_at', 'timestamp with time zone', true),
  ('staff_auth_sessions', 'revoked_at', 'timestamp with time zone', false)
)
SELECT e.table_name, e.column_name, e.type_name AS expected_type,
       e.expected_not_null,
       a.attnum IS NOT NULL AS exists,
       pg_catalog.format_type(a.atttypid, a.atttypmod) AS actual_type,
       a.attnotnull AS actual_not_null,
       pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_expression,
       COALESCE(pg_catalog.format_type(a.atttypid, a.atttypmod) = e.type_name
         AND a.attnotnull = e.expected_not_null, false) AS type_nullability_match
FROM expected AS e
LEFT JOIN pg_catalog.pg_namespace AS n ON n.nspname = 'public'
LEFT JOIN pg_catalog.pg_class AS c
  ON c.relnamespace = n.oid AND c.relname = e.table_name
LEFT JOIN pg_catalog.pg_attribute AS a
  ON a.attrelid = c.oid AND a.attname = e.column_name
  AND a.attnum > 0 AND NOT a.attisdropped
LEFT JOIN pg_catalog.pg_attrdef AS d
  ON d.adrelid = a.attrelid AND d.adnum = a.attnum
ORDER BY e.table_name, e.column_name;

-- 04: existing schema dependencies. Only structural metadata is returned.
-- Suppress password defaults even if the existing schema contains one.
SELECT c.relname AS table_name, a.attnum AS ordinal_position,
       a.attname AS column_name,
       pg_catalog.format_type(a.atttypid, a.atttypmod) AS column_type,
       a.attnotnull AS not_null,
       CASE WHEN c.relname = 'users' AND a.attname = 'password'
         THEN '[suppressed: credential-column default]'
         ELSE pg_catalog.pg_get_expr(d.adbin, d.adrelid)
       END AS default_expression
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_attribute AS a
  ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
LEFT JOIN pg_catalog.pg_attrdef AS d
  ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE n.nspname = 'public'
  AND c.relname IN ('users', 'patients', 'counters', 'staff_auth_sessions')
ORDER BY c.relname, a.attnum;

-- 05: constraints, including users.id_num FK eligibility and session constraints.
-- Canonical sessions: PK(session_id), FK(user_id_num)->users(id_num) ON DELETE
-- CASCADE, role IN ('admin','superadmin'), expires_at > created_at. Existing
-- constraints must match their meaning even if their generated names differ.
SELECT c.relname AS table_name, con.conname AS constraint_name,
       con.contype AS constraint_kind, con.convalidated AS validated,
       con.condeferrable AS deferrable, con.condeferred AS initially_deferred,
       pg_catalog.pg_get_constraintdef(con.oid, true) AS definition
FROM pg_catalog.pg_constraint AS con
JOIN pg_catalog.pg_class AS c ON c.oid = con.conrelid
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('users', 'patients', 'counters', 'staff_auth_sessions')
ORDER BY c.relname, con.conname;

-- 06: all current indexes, not just a name-presence check.
SELECT c.relname AS table_name, ix.relname AS index_name,
       i.indisprimary AS is_primary, i.indisunique AS is_unique,
       i.indisvalid AS is_valid, i.indisready AS is_ready,
       pg_catalog.pg_get_indexdef(i.indexrelid) AS definition,
       pg_catalog.pg_get_expr(i.indpred, i.indrelid) AS predicate
FROM pg_catalog.pg_index AS i
JOIN pg_catalog.pg_class AS c ON c.oid = i.indrelid
JOIN pg_catalog.pg_class AS ix ON ix.oid = i.indexrelid
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('users', 'patients', 'counters', 'staff_auth_sessions')
ORDER BY c.relname, ix.relname;

-- 07: exact Phase A lookup-index names, including name collision evidence.
WITH expected(index_name, expected_definition) AS (VALUES
  ('staff_auth_sessions_user_idx',
   'ON public.staff_auth_sessions (user_id_num, last_seen_at DESC)'),
  ('staff_auth_sessions_active_doctor_idx',
   'ON public.staff_auth_sessions (doctor_name, last_seen_at DESC) WHERE revoked_at IS NULL')
)
SELECT e.index_name, e.expected_definition,
       ix.oid IS NOT NULL AS name_exists,
       ix.relkind AS object_kind_at_name,
       c.relname AS actual_indexed_table,
       i.indisvalid AS is_valid, i.indisready AS is_ready,
       pg_catalog.pg_get_indexdef(i.indexrelid) AS actual_definition,
       pg_catalog.pg_get_expr(i.indpred, i.indrelid) AS actual_predicate
FROM expected AS e
LEFT JOIN pg_catalog.pg_namespace AS n ON n.nspname = 'public'
LEFT JOIN pg_catalog.pg_class AS ix
  ON ix.relnamespace = n.oid AND ix.relname = e.index_name
LEFT JOIN pg_catalog.pg_index AS i ON i.indexrelid = ix.oid
LEFT JOIN pg_catalog.pg_class AS c ON c.oid = i.indrelid
ORDER BY e.index_name;

-- 08: every overload under the Phase A function names. Unexpected alternatives
-- can survive a migration that only replaces/drops the documented signatures.
SELECT p.proname AS function_name,
       pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments,
       p.proargnames AS argument_names,
       pg_catalog.oidvectortypes(p.proargtypes) AS input_argument_types,
       p.proargmodes AS argument_modes,
       pg_catalog.pg_get_function_result(p.oid) AS result_type,
       pg_catalog.pg_get_userbyid(p.proowner) AS owner,
       p.prokind AS routine_kind, p.prosecdef AS security_definer,
       p.proconfig AS configuration, p.provolatile AS volatility,
       p.pronargdefaults AS default_argument_count
FROM pg_catalog.pg_proc AS p
JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN (
  'create_staff_auth_session', 'validate_staff_auth_session',
  'heartbeat_staff_auth_session', 'revoke_staff_auth_session',
  'revoke_staff_user_sessions', 'revoke_changed_staff_sessions',
  'get_staff_doctor_presence'
)
ORDER BY p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid);

-- 09: canonical backend signatures and named arguments; null-safe if absent.
-- All seven must be SECURITY DEFINER with an explicitly empty search_path.
-- This is structural evidence, not proof that an arbitrary existing body matches
-- the reviewed migration. Compare unexpected/pre-existing definitions privately.
WITH expected(signature, argument_names, return_type) AS (VALUES
  ('public.create_staff_auth_session(uuid,text,text,text,uuid)',
   ARRAY['p_session_id','p_user_id_num','p_role','p_doctor_name','p_auth_revision']::text[],
   'public.staff_auth_sessions'),
  ('public.validate_staff_auth_session(uuid,text,text,text)',
   ARRAY['p_session_id','p_user_id_num','p_role','p_doctor_name']::text[],
   'public.staff_auth_sessions'),
  ('public.heartbeat_staff_auth_session(uuid,text,text,text)',
   ARRAY['p_session_id','p_user_id_num','p_role','p_doctor_name']::text[],
   'public.staff_auth_sessions'),
  ('public.revoke_staff_auth_session(uuid,text)',
   ARRAY['p_session_id','p_user_id_num']::text[], 'pg_catalog.bool'),
  ('public.revoke_staff_user_sessions(text)',
   ARRAY['p_user_id_num']::text[], 'pg_catalog.int8'),
  ('public.revoke_changed_staff_sessions()', ARRAY[]::text[], 'pg_catalog.trigger'),
  ('public.get_staff_doctor_presence()', ARRAY[]::text[], 'pg_catalog.jsonb')
)
SELECT e.signature, e.argument_names AS expected_argument_names,
       e.return_type AS expected_return_type,
       p.oid IS NOT NULL AS exists,
       p.proargnames AS actual_argument_names,
       pg_catalog.pg_get_function_result(p.oid) AS actual_return_type,
       COALESCE(COALESCE(p.proargnames, ARRAY[]::text[]) = e.argument_names, false)
         AND p.oid IS NOT NULL AS argument_names_match,
       COALESCE(p.prorettype = pg_catalog.to_regtype(e.return_type), false)
         AS return_type_matches,
       p.prosecdef AS security_definer, p.proconfig AS configuration,
       COALESCE(p.proconfig @> ARRAY['search_path=""']::text[], false)
         AS explicitly_empty_search_path,
       pg_catalog.pg_get_userbyid(p.proowner) AS owner
FROM expected AS e
LEFT JOIN pg_catalog.pg_proc AS p
  ON p.oid = pg_catalog.to_regprocedure(e.signature)
ORDER BY e.signature;

-- 10: obsolete creation path must be absent after migration. Presence before
-- migration is a reviewed DROP FUNCTION, whose dependencies appear below.
SELECT pg_catalog.to_regprocedure(
         'public.create_staff_auth_session(uuid,text,text,text)') IS NOT NULL
         AS obsolete_create_signature_exists;

WITH obsolete AS (
  SELECT pg_catalog.to_regprocedure(
    'public.create_staff_auth_session(uuid,text,text,text)') AS function_oid
)
SELECT o.function_oid IS NOT NULL AS obsolete_function_exists,
       d.deptype AS dependency_kind,
       pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid)
         AS dependent_object
FROM obsolete AS o
LEFT JOIN pg_catalog.pg_depend AS d
  ON d.refclassid = 'pg_catalog.pg_proc'::regclass
  AND d.refobjid = o.function_oid
ORDER BY dependent_object;

-- 11: effective EXECUTE for every overload and targeted role. Missing roles
-- return NULL. Backend API RPCs require service_role execution, browser roles
-- must be denied. Trigger-helper service_role execution is not a requirement.
WITH names(function_name) AS (VALUES
  ('create_staff_auth_session'), ('validate_staff_auth_session'),
  ('heartbeat_staff_auth_session'), ('revoke_staff_auth_session'),
  ('revoke_staff_user_sessions'), ('revoke_changed_staff_sessions'),
  ('get_staff_doctor_presence')
), expected_roles(role_name) AS (VALUES ('anon'), ('authenticated'), ('service_role'))
SELECT f.function_name,
       pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments,
       er.role_name, p.oid IS NOT NULL AS function_exists,
       r.oid IS NOT NULL AS role_exists,
       CASE WHEN p.oid IS NOT NULL AND r.oid IS NOT NULL
         THEN pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE')
       END AS can_execute,
       CASE WHEN er.role_name IN ('anon','authenticated')
            AND p.oid IS NOT NULL AND r.oid IS NOT NULL
         THEN NOT pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE')
       END AS browser_execute_denied
FROM names AS f CROSS JOIN expected_roles AS er
LEFT JOIN pg_catalog.pg_namespace AS n ON n.nspname = 'public'
LEFT JOIN pg_catalog.pg_proc AS p
  ON p.pronamespace = n.oid AND p.proname = f.function_name
LEFT JOIN pg_catalog.pg_roles AS r ON r.rolname = er.role_name
ORDER BY f.function_name, identity_arguments, er.role_name;

-- 12: explicit/default function ACLs, including PUBLIC grants inherited by all
-- roles. Owner/default privileges are shown rather than silently omitted.
SELECT p.proname AS function_name,
       pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments,
       CASE WHEN a.grantee = 0 THEN 'PUBLIC'
         ELSE pg_catalog.pg_get_userbyid(a.grantee) END AS grantee,
       pg_catalog.pg_get_userbyid(a.grantor) AS grantor,
       a.privilege_type, a.is_grantable
FROM pg_catalog.pg_proc AS p
JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
CROSS JOIN LATERAL pg_catalog.aclexplode(
  COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS a
WHERE n.nspname = 'public' AND p.proname IN (
  'create_staff_auth_session', 'validate_staff_auth_session',
  'heartbeat_staff_auth_session', 'revoke_staff_auth_session',
  'revoke_staff_user_sessions', 'revoke_changed_staff_sessions',
  'get_staff_doctor_presence'
)
ORDER BY p.proname, identity_arguments, grantee, a.privilege_type;

-- 13: all existing users triggers, including other credential-change behavior.
-- Canonical Phase A trigger: BEFORE UPDATE OF password,role,doctor_name,id_num,
-- auth_revision OR DELETE, FOR EACH ROW; revoke_changed_staff_sessions().
SELECT t.tgname AS trigger_name, t.tgenabled AS enabled,
       t.tgisinternal AS internal_trigger,
       pg_catalog.pg_get_triggerdef(t.oid, true) AS definition,
       pg_catalog.pg_get_userbyid(p.proowner) AS trigger_function_owner
FROM pg_catalog.pg_trigger AS t
JOIN pg_catalog.pg_class AS c ON c.oid = t.tgrelid
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_proc AS p ON p.oid = t.tgfoid
WHERE n.nspname = 'public' AND c.relname = 'users'
ORDER BY t.tgname;

SELECT t.oid IS NOT NULL AS phase_a_trigger_exists,
       t.tgenabled AS enabled,
       pg_catalog.pg_get_triggerdef(t.oid, true) AS definition
FROM (VALUES ('staff_auth_revoke_account_change')) AS e(trigger_name)
LEFT JOIN pg_catalog.pg_namespace AS n ON n.nspname = 'public'
LEFT JOIN pg_catalog.pg_class AS c
  ON c.relnamespace = n.oid AND c.relname = 'users'
LEFT JOIN pg_catalog.pg_trigger AS t
  ON t.tgrelid = c.oid AND t.tgname = e.trigger_name;

-- 14: actual policies. RLS controls rows and does not hide auth_revision from
-- a browser role that already has SELECT on the entire users table.
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_catalog.pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('users', 'patients', 'counters', 'staff_auth_sessions')
ORDER BY tablename, policyname;

-- 15: effective table privileges (including membership/inherited privileges).
WITH targets(table_name) AS (VALUES
  ('users'), ('patients'), ('counters'), ('staff_auth_sessions')
), expected_roles(role_name) AS (VALUES ('anon'), ('authenticated'), ('service_role'))
SELECT t.table_name, er.role_name, c.oid IS NOT NULL AS table_exists,
       r.oid IS NOT NULL AS role_exists,
       CASE WHEN c.oid IS NOT NULL AND r.oid IS NOT NULL
         THEN pg_catalog.has_table_privilege(r.oid, c.oid, 'SELECT') END AS can_select,
       CASE WHEN c.oid IS NOT NULL AND r.oid IS NOT NULL
         THEN pg_catalog.has_table_privilege(r.oid, c.oid, 'INSERT') END AS can_insert,
       CASE WHEN c.oid IS NOT NULL AND r.oid IS NOT NULL
         THEN pg_catalog.has_table_privilege(r.oid, c.oid, 'UPDATE') END AS can_update,
       CASE WHEN c.oid IS NOT NULL AND r.oid IS NOT NULL
         THEN pg_catalog.has_table_privilege(r.oid, c.oid, 'DELETE') END AS can_delete,
       CASE WHEN c.oid IS NOT NULL AND r.oid IS NOT NULL
         THEN pg_catalog.has_table_privilege(r.oid, c.oid, 'TRUNCATE') END AS can_truncate,
       CASE WHEN c.oid IS NOT NULL AND r.oid IS NOT NULL
         THEN pg_catalog.has_table_privilege(r.oid, c.oid, 'TRIGGER') END AS can_create_trigger
FROM targets AS t CROSS JOIN expected_roles AS er
LEFT JOIN pg_catalog.pg_namespace AS n ON n.nspname = 'public'
LEFT JOIN pg_catalog.pg_class AS c
  ON c.relnamespace = n.oid AND c.relname = t.table_name
LEFT JOIN pg_catalog.pg_roles AS r ON r.rolname = er.role_name
ORDER BY t.table_name, er.role_name;

-- 16: direct/default table ACLs, including PUBLIC.
SELECT c.relname AS table_name,
       CASE WHEN a.grantee = 0 THEN 'PUBLIC'
         ELSE pg_catalog.pg_get_userbyid(a.grantee) END AS grantee,
       pg_catalog.pg_get_userbyid(a.grantor) AS grantor,
       a.privilege_type, a.is_grantable
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
CROSS JOIN LATERAL pg_catalog.aclexplode(
  COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) AS a
WHERE n.nspname = 'public'
  AND c.relname IN ('users', 'patients', 'counters', 'staff_auth_sessions')
ORDER BY c.relname, grantee, a.privilege_type;

-- 17: private users column access; only column NAMES/types/privileges, no values.
-- If auth_revision is absent, table SELECT above signals prospective exposure.
WITH expected_columns(column_name) AS (VALUES ('password'), ('auth_revision')),
expected_roles(role_name) AS (VALUES ('anon'), ('authenticated'), ('service_role'))
SELECT ec.column_name, er.role_name,
       a.attnum IS NOT NULL AS column_exists, r.oid IS NOT NULL AS role_exists,
       CASE WHEN a.attnum IS NOT NULL AND r.oid IS NOT NULL
         THEN pg_catalog.has_column_privilege(r.oid, c.oid, a.attnum, 'SELECT')
       END AS can_select_private_column,
       CASE WHEN a.attnum IS NOT NULL AND r.oid IS NOT NULL
         THEN pg_catalog.has_column_privilege(r.oid, c.oid, a.attnum, 'UPDATE')
       END AS can_update_private_column,
       CASE WHEN a.attnum IS NOT NULL AND r.oid IS NOT NULL
         THEN pg_catalog.has_column_privilege(r.oid, c.oid, a.attnum, 'INSERT')
       END AS can_insert_private_column
FROM expected_columns AS ec CROSS JOIN expected_roles AS er
LEFT JOIN pg_catalog.pg_namespace AS n ON n.nspname = 'public'
LEFT JOIN pg_catalog.pg_class AS c
  ON c.relnamespace = n.oid AND c.relname = 'users'
LEFT JOIN pg_catalog.pg_attribute AS a
  ON a.attrelid = c.oid AND a.attname = ec.column_name
  AND a.attnum > 0 AND NOT a.attisdropped
LEFT JOIN pg_catalog.pg_roles AS r ON r.rolname = er.role_name
ORDER BY ec.column_name, er.role_name;

-- 18: all explicit column grants on reviewed tables; no column values.
SELECT c.relname AS table_name, col.attname AS column_name,
       CASE WHEN a.grantee = 0 THEN 'PUBLIC'
         ELSE pg_catalog.pg_get_userbyid(a.grantee) END AS grantee,
       pg_catalog.pg_get_userbyid(a.grantor) AS grantor,
       a.privilege_type, a.is_grantable
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_attribute AS col
  ON col.attrelid = c.oid AND col.attnum > 0 AND NOT col.attisdropped
CROSS JOIN LATERAL pg_catalog.aclexplode(col.attacl) AS a
WHERE n.nspname = 'public'
  AND c.relname IN ('users', 'patients', 'counters', 'staff_auth_sessions')
ORDER BY c.relname, col.attname, grantee, a.privilege_type;

-- 19: role attributes relevant to effective RLS and security-definer owners.
-- pg_roles masks password material; only the listed nonsensitive fields appear.
WITH object_owners(owner_oid) AS (
  SELECT c.relowner FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('users', 'patients', 'counters', 'staff_auth_sessions')
  UNION
  SELECT p.proowner FROM pg_catalog.pg_proc AS p
  JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN (
    'create_staff_auth_session', 'validate_staff_auth_session',
    'heartbeat_staff_auth_session', 'revoke_staff_auth_session',
    'revoke_staff_user_sessions', 'revoke_changed_staff_sessions',
    'get_staff_doctor_presence'
  )
)
SELECT r.rolname AS role_name, r.rolsuper AS superuser,
       r.rolbypassrls AS bypasses_rls, r.rolinherit AS inherits_privileges,
       r.rolcanlogin AS can_login, r.rolcreaterole AS can_create_roles,
       r.oid IN (SELECT owner_oid FROM object_owners) AS reviewed_object_owner
FROM pg_catalog.pg_roles AS r
WHERE r.rolname IN ('anon', 'authenticated', 'service_role', CURRENT_USER)
   OR r.oid IN (SELECT owner_oid FROM object_owners)
ORDER BY r.rolname;

-- 20: transitive role memberships for browser/server roles. Effective privilege
-- checks above account for inheritance; membership paths explain surprises.
WITH RECURSIVE membership(subject_oid, subject_name, inherited_oid, path, depth) AS (
  SELECT r.oid, r.rolname, r.oid, ARRAY[r.oid]::oid[], 0
  FROM pg_catalog.pg_roles AS r
  WHERE r.rolname IN ('anon', 'authenticated', 'service_role')
  UNION ALL
  SELECT m.subject_oid, m.subject_name, am.roleid,
         m.path || am.roleid, m.depth + 1
  FROM membership AS m
  JOIN pg_catalog.pg_auth_members AS am ON am.member = m.inherited_oid
  WHERE NOT am.roleid = ANY(m.path)
)
SELECT m.subject_name AS subject_role, inherited.rolname AS granted_role,
       m.depth AS membership_depth,
       pg_catalog.pg_has_role(m.subject_oid, m.inherited_oid, 'USAGE')
         AS privileges_available_without_set_role,
       inherited.rolsuper AS granted_role_superuser,
       inherited.rolbypassrls AS granted_role_bypasses_rls
FROM membership AS m
JOIN pg_catalog.pg_roles AS inherited ON inherited.oid = m.inherited_oid
WHERE m.depth > 0
ORDER BY m.subject_name, m.depth, inherited.rolname;

-- 21: schema privileges that can affect PostgREST/function access or object
-- replacement risk. NULL indicates a missing schema/role.
WITH expected_roles(role_name) AS (VALUES ('anon'), ('authenticated'), ('service_role'))
SELECT er.role_name, n.oid IS NOT NULL AS public_schema_exists,
       r.oid IS NOT NULL AS role_exists,
       CASE WHEN n.oid IS NOT NULL AND r.oid IS NOT NULL
         THEN pg_catalog.has_schema_privilege(r.oid, n.oid, 'USAGE') END AS can_use_public,
       CASE WHEN n.oid IS NOT NULL AND r.oid IS NOT NULL
         THEN pg_catalog.has_schema_privilege(r.oid, n.oid, 'CREATE') END AS can_create_in_public
FROM expected_roles AS er
LEFT JOIN pg_catalog.pg_roles AS r ON r.rolname = er.role_name
LEFT JOIN pg_catalog.pg_namespace AS n ON n.nspname = 'public'
ORDER BY er.role_name;

COMMIT;

-- Interpretation limits:
-- * Missing expected Phase A objects before installation are pending work,
--   not a failed installation that was already claimed complete.
-- * Catalog signatures do not prove PostgREST schema-cache recognition. That
--   needs an authorized backend probe after approved migration, with no private
--   RPC exposed to the browser and no creation RPC called during preflight.
-- * This metadata-only script does not establish unchanged record values.
--   Capture approved aggregate preservation evidence before/after migration in
--   a separate controlled observation window; never export patient rows,
--   password hashes, tokens, session IDs or auth_revision values.
-- * This file does not execute any concurrency or browser tests and must not be
--   cited as their evidence. No application features or schema are changed.
