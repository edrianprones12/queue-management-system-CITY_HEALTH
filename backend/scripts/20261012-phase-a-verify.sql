-- Read-only Phase A installation and existing schema/RLS inspection.
-- Run in the approved Supabase SQL Editor after applying the migration.
-- Returns concrete evidence; never resets or modifies any records or grants.
BEGIN TRANSACTION READ ONLY;

-- Existing deployments can have RLS policies absent from the tracked baseline.
-- Review those policies; this migration intentionally changes only its own table.
SELECT n.nspname AS schema_name, c.relname AS table_name,
       c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('users', 'counters', 'patients', 'staff_auth_sessions')
ORDER BY c.relname;

SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_catalog.pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('users', 'counters', 'patients', 'staff_auth_sessions')
ORDER BY tablename, policyname;

SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'staff_auth_sessions'
ORDER BY ordinal_position;

SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'auth_revision';

-- Every API RPC must allow only service_role. Missing functions produce a
-- visible resolution error instead of a misleading passing installation result.
WITH functions(signature) AS (VALUES
  ('public.create_staff_auth_session(uuid,text,text,text,uuid)'),
  ('public.validate_staff_auth_session(uuid,text,text,text)'),
  ('public.heartbeat_staff_auth_session(uuid,text,text,text)'),
  ('public.revoke_staff_auth_session(uuid,text)'),
  ('public.revoke_staff_user_sessions(text)'),
  ('public.get_staff_doctor_presence()')
), roles(role_name) AS (VALUES ('anon'), ('authenticated'), ('service_role'))
SELECT signature, role_name,
       pg_catalog.has_function_privilege(role_name, signature, 'EXECUTE') AS can_execute,
       pg_catalog.has_function_privilege(role_name, signature, 'EXECUTE') = (role_name = 'service_role') AS check_passed
FROM functions CROSS JOIN roles ORDER BY signature, role_name;

-- The obsolete create signature must be absent (otherwise it bypasses the
-- password-snapshot revision check).
SELECT pg_catalog.to_regprocedure('public.create_staff_auth_session(uuid,text,text,text)') IS NULL
  AS obsolete_create_signature_removed;

-- PUBLIC execute grants would indirectly expose every authenticated/anon role.
SELECT p.proname, p.prosecdef AS security_definer, p.proconfig AS function_config,
       NOT EXISTS (
         SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS a
         WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
       ) AS public_execute_revoked
FROM pg_catalog.pg_proc AS p
JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN (
  'create_staff_auth_session', 'validate_staff_auth_session', 'heartbeat_staff_auth_session',
  'revoke_staff_auth_session', 'revoke_staff_user_sessions', 'get_staff_doctor_presence',
  'revoke_changed_staff_sessions'
)
ORDER BY p.proname;

WITH roles(role_name) AS (VALUES ('anon'), ('authenticated'), ('service_role'))
SELECT role_name,
       pg_catalog.has_table_privilege(role_name, 'public.staff_auth_sessions', 'SELECT') AS can_select,
       pg_catalog.has_table_privilege(role_name, 'public.staff_auth_sessions', 'INSERT') AS can_insert,
       pg_catalog.has_table_privilege(role_name, 'public.staff_auth_sessions', 'UPDATE') AS can_update,
       pg_catalog.has_table_privilege(role_name, 'public.staff_auth_sessions', 'DELETE') AS can_delete
FROM roles ORDER BY role_name;

SELECT tgname AS trigger_name, tgenabled AS enabled,
       pg_catalog.pg_get_triggerdef(oid) AS trigger_definition
FROM pg_catalog.pg_trigger
WHERE tgrelid = 'public.users'::regclass AND tgname = 'staff_auth_revoke_account_change';

-- Contains aggregate doctor presence only, with no user/session IDs or tokens.
SELECT public.get_staff_doctor_presence() AS doctor_presence;
COMMIT;
