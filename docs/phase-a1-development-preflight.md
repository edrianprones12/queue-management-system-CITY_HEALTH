# Phase A.1 preflight and verification — 13 October 2026

**Status: development target confirmed; live access remains unavailable. Live verification is incomplete.** The user confirmed the previous development project, and only the local backend URL was updated to that target. Its backend key is still a placeholder, so no database network request, SQL execution, login, heartbeat, migration or patient mutation was attempted. Target confirmation is not database-modification approval; that approval has not been received. Phase B is not ready for approval from this evidence.

## 1. Environment identification

| Item | Observed result |
| --- | --- |
| Source review checkout branch | `fix-phase21-stale-recovery` |
| Source review checkout commit | `5710f25` — Protect consultation history from stale Requeue and Undo |
| Documentation publication base | `main` at `2bc917c`; Phase 2.1 remains outside this publication |
| Included Phase A commit | `2bc917c` |
| Current `backend/.env` Supabase origin | `https://uvmpbgpvmjkfoblrfrdt.supabase.co` |
| Effective Supabase origin for the read-only helper | Same confirmed development origin; no inherited URL override |
| Previously recorded development target | CCHOFPC Queuing System, `uvmpbgpvmjkfoblrfrdt` |
| Current target matches that project | Yes |
| Development/production identification | User confirmed: "Use the previously identified development project"; live Dashboard identity was not independently inspected |
| Backend key/JWT setting | Values are present; backend key matches a placeholder pattern; no values printed; JWT setting was preserved |
| Direct PostgreSQL/management connection | No supported connection setting was found in the backend configuration inspected |
| Supabase integration | Available for installation, currently not installed/connected |
| Browser automation inventory | No available browser or native-app surface |

The Phase 2 guide records prior owner confirmation that `uvmpbgpvmjkfoblrfrdt` was used for development/testing despite its Supabase Dashboard `PRODUCTION` branch label. The user reconfirmed that target for this phase. The local URL was corrected from the placeholder while leaving the backend key, JWT secret and other settings unchanged. Existing environment files/backups were checked by filename; no saved usable backend connection was found. A real backend key still needs to be configured locally, and read-only SQL access is needed for catalog inspection. Do not paste keys, passwords or database connection secrets into chat.

The first read-only helper run refused the mismatched placeholder project. After the user confirmed the target and its URL was updated, the helper refused the placeholder backend key before making any network requests. Sanitized local evidence was recorded at `2026-10-13T14:33:00.815Z` (22:33:00 in Asia/Singapore); the earlier 12–13 October checks found the placeholder URL. Local evidence JSON, helper scripts and the target-confirmation record remain in the ignored `output/phase-a1-development-verification/` directory and are not included in this publication. Target confirmation remains separate from pending migration/test-write approval.

## 2. Implementation and pending migration review

Reviewed the existing presence service, migration and verification SQL, auth middleware/routes, heartbeat/presence helpers, AuthContext, Superadmin page and rollout guide. The Phase A implementation remains unchanged from `2bc917c` in the reviewed presence/auth/frontend files. The source review checkout also contains Phase 2.1 changes; this phase neither applies its migration nor exercises Requeue/Undo. This publication contains only documentation and catalog-query SQL based on `main`; it does not merge or publish Phase 2.1.

Exact pending migration: `backend/scripts/20261012-phase-a-auth-presence.sql`.

SHA-256: `DA9B7F4BA8F807FAF519F15DAA0FF7EA20DE053F63B25C6581F161CFC8A23198`.

The migration was inspected, not regenerated. Its transaction adds private `users.auth_revision`, `staff_auth_sessions`, indexes, a session RLS policy, account-change trigger and backend-only RPCs. It contains no patient/counter reset, truncation or update. It removes the obsolete four-argument session-creation RPC. The schema-cache notification follows `COMMIT`.

| Expected object | Required configuration |
| --- | --- |
| `users.auth_revision` | UUID, NOT NULL, generated default |
| `staff_auth_sessions` | UUID primary key; staff account FK; constrained role; doctor snapshot; database-generated login/activity/expiry/revocation timestamps |
| `staff_auth_sessions_user_idx` | Account ID and descending last-seen timestamp |
| `staff_auth_sessions_active_doctor_idx` | Doctor and descending last-seen timestamp; only unrevoked sessions |
| `create_staff_auth_session` | UUID session, TEXT account/role/doctor, UUID account revision; returns session row |
| `validate_staff_auth_session`, `heartbeat_staff_auth_session` | UUID session and TEXT account/role/doctor; return session row |
| `revoke_staff_auth_session` | UUID session and TEXT account; returns boolean |
| `revoke_staff_user_sessions` | TEXT account; returns bigint |
| `get_staff_doctor_presence` | No arguments; returns JSONB |
| `staff_auth_revoke_account_change` | Enabled BEFORE account credential/role/assignment/revision changes or DELETE; calls `revoke_changed_staff_sessions()` |
| RPC protection | SECURITY DEFINER, empty search path; six API RPCs executable by service_role; PUBLIC/anon/authenticated denied |
| Session table protection | RLS enabled; server-role policy/access; unauthorized browser-role table and column access absent |

Authentication remains custom HS256 JWTs over `public.users`. Login binds the verified account revision to the new session, and public login/profile responses omit the revision. Protected requests validate session, expiry, revocation and current account. Heartbeats run approximately every 25 seconds, time out after ten seconds, and write at most once per session per 20 seconds. Online requires a valid session activity timestamp within 75 seconds. Logout revokes the captured session; independent sessions remain valid. The dashboard monitors every five seconds and displays Unknown for failed/malformed data or a snapshot aged 15 seconds.

## 3. Preflight findings requiring actual SQL inspection

No live schema, constraints, functions, indexes, triggers, policies, grants, users, counters or patients have been inspected in this phase. Their actual compatibility remains unverified.

The existing installation verification SQL is read-only, but it is insufficient by itself for the requested preflight:

- `IF NOT EXISTS` in the migration does not establish compatibility of existing columns, tables or named indexes. Inspect types, nullability, defaults, constraints, index definitions/validity and conflicting object names first.
- The verification SQL does not inspect the expected indexes, all constraints, exact argument names/return types, every overload, effective existing-table/column privileges, role inheritance or function owners.
- Its unguarded function-privilege calls require the expected functions to exist. Running it before installation can abort the transaction instead of returning a complete missing-object report.
- Preserving existing `users` ACL/RLS is a security dependency: browser-role table SELECT may expose the newly added private `auth_revision` column. RLS restricts rows, not individual columns. Existing `users.password` access also needs inspection without retrieving its values. These privilege semantics are described in [Supabase's column security guide](https://supabase.com/docs/guides/database/postgres/column-level-security) and [PostgreSQL's privilege inspection documentation](https://www.postgresql.org/docs/current/functions-info.html).
- Existing session-table column-level grants, if that table already exists, must be inspected separately; table-level revocation alone does not prove all prior column grants are absent.
- The obsolete creation RPC's dependencies and existing user triggers must be checked before deciding the migration can replace/drop those objects safely.

The supplemental [20261013-phase-a1-preflight.sql](../backend/scripts/20261013-phase-a1-preflight.sql) is prepared for catalog-only inspection in a READ ONLY transaction. It is not an application feature or migration and has not been executed on any database. Run it only after identifying the development target and obtaining suitable read-only SQL access. Differences must be reviewed before requesting migration approval; do not silently weaken policies or expand this task into an auth rewrite.

The supplemental query was statically reviewed: its statements are limited to READ ONLY transaction control and catalog SELECT/WITH queries, password defaults are suppressed, and it does not select rows from the application tables or call application RPCs. No runtime PostgreSQL validation is claimed. The local read-only Node helper passed a syntax check. The migration's SHA-256 remains unchanged. This report and the catalog SQL are the published copies; local diagnostic scripts/evidence and environment files remain ignored.

## 4. Approval and migration execution status

| Step | Status |
| --- | --- |
| Intended development target confirmed for this phase | Received: `uvmpbgpvmjkfoblrfrdt` |
| Live read-only catalog preflight | Not executed; connection unavailable |
| Explicit approval for database modifications | Not received |
| Phase A migration applied by this phase | No |
| Original installation verification SQL executed | No |
| PostgREST function recognition checked | No |
| Patient/counter/user preservation comparison | Not executed; no before/after live fingerprints |
| Application restart/deployment | Not performed |

After live access is supplied and catalog configuration is verified, present the exact migration and any observed conflicts for approval. The later approval request must identify the confirmed development project, migration hash, session/login writes and proposed isolated fixtures. Any disposable consultation fixture must be named and approved before creation or use; real patient records must remain untouched. Confirmation of the target is not approval to modify the database.

## 5. Installation verification to execute after approval

Apply only the reviewed Phase A migration using the documented procedure. Run `backend/scripts/20261012-phase-a-verify.sql`, followed by the supplemental catalog checks. Verify all expected types, arguments, return types, indexes, enabled trigger, constraints, RLS, effective column/table grants and function execution privileges. Confirm PostgREST schema-cache recognition without executing mutation RPCs merely to probe their existence.

Before migration and before test fixtures, record counts and deterministic fingerprints for original patient/counter rows and original nonsecret user fields; keep the comparison interval free of unrelated application writes. Compare again immediately after migration, accounting only for the intended new user revision metadata. Do not log raw patient details, passwords, JWTs, revisions, session identifiers or backend keys.

The current application requires the migration and a fresh login; legacy JWTs lack a persisted session. Opening a queue app tab with an existing valid token can immediately write a heartbeat. Browser integration must therefore remain behind the database-change approval gate.

## 6. Actual browser integration results

Every live scenario below is **not executed**:

| Scenario | Planned evidence |
| --- | --- |
| Doctor login | Actual browser login, session creation, correct doctor association and Superadmin Online |
| Explicit logout | Session revocation and Offline after the next monitoring poll when no other session remains active |
| Close doctor browser without logout | Heartbeats stop; Offline after last heartbeat plus 75 seconds and next monitoring poll |
| Network interruption | Offline after timeout; exact original patient/counter state unchanged |
| Network recovery | Valid session heartbeats resume and Online returns |
| Multiple tabs/sessions | Closing one tab does not revoke shared login; logout of one independent session leaves another valid session Online |
| Expired/revoked session | Old authenticated heartbeat rejected; database-controlled expiration on a disposable fixture distinguished from naturally waiting eight hours |
| Serving patient during logout | Only an approved isolated test visit; exact status/assignment/start/end/counter preserved |
| Superadmin monitoring | Independent Enabled/Disabled and Available/Serving, current queue number and occupied-offline warning |
| Monitoring failure | Actual failed/stalled requests produce Unknown; recovery returns authoritative state |

No mocked/PGlite result is represented as a live browser result. Prior local Phase A tests remain historical evidence: 191 backend, 101 frontend, three voice tests and a production build. They were not rerun as a substitute for this phase's required live verification.

## 7. Multi-session and PostgreSQL concurrency results

Independent browser sessions, parallel live PostgreSQL sessions, deliberate lock overlap, logout racing heartbeat, delayed requests after revocation, and credential changes racing active sessions are all **not executed**.

When approved and suitable direct access is available, use disposable staff/session fixtures, two simultaneously held PostgreSQL connections with distinct backend process IDs, and transaction barriers. Verify both race orderings, revocation remaining final, throttled concurrent heartbeats, invalidated credentials and independent valid sessions. Do not change an existing doctor's credentials for testing.

Parallel HTTP requests can prove overlapping API requests, but must not be labelled independent PostgreSQL connection/lock contention without connection and overlap evidence. The previous single-connection PGlite coverage does not establish that result.

## 8. Security observations

The reviewed presence endpoint is authenticated and Superadmin-only. Session mutation endpoints derive identity from verified JWT claims; they do not trust browser account/timestamp fields. The application does not expose a general privileged SQL executor through these endpoints. Service-role use remains backend-only. No Supabase Auth migration is proposed.

Effective live RLS/grants and direct browser access to `users.auth_revision`, `users.password` or session columns remain unverified and are release gates. Presence source omits private fields from public profile and monitoring responses; this does not by itself prove direct database confidentiality.

The existing `admin123` compatibility branch can accept that password for existing account IDs beginning with `admin`, even when the stored password differs. This is a separate production security concern, documented without changing the current authentication architecture.

## 9. Safe failed-rollout recovery

1. If an error occurs before `COMMIT`, explicitly roll back the SQL-editor/direct connection and verify the original schema and patient/counter fingerprints. Diagnose the observed conflict before approving a corrected attempt.
2. If a schema-cache notification fails after `COMMIT`, the migration may already be fully installed. Inspect first; retry only the notification or a reviewed targeted step rather than blindly repeating mutations.
3. If installation succeeds but application checks fail, suspend the development rollout and retain sessions, account revisions and revocation triggers while diagnosing forward. Do not drop the new table/column or reset counters/patients.
4. Do not automatically restore old authentication code: an older version can accept legacy JWTs and bypass the new revocation rules. Any controlled application rollback requires review of security consequences, fresh-login/revocation handling and preserved additive objects.
5. Backup restoration or cleanup of isolated fixtures must have explicit approval and exact scope. No destructive rollback or fixture deletion is currently authorized or attempted.

## 10. Remaining risks and Phase B recommendation

**Recommendation: do not advance to Phase B yet.** The intended development target is confirmed, but live access, actual schema compatibility, effective security permissions, migration approval/installation, actual browser integration and supported PostgreSQL concurrency are outstanding. Session-history cleanup remains unimplemented, and browser suspension can correctly age an otherwise valid login Offline until its next heartbeat.

Phase 2.1 work present on the source review branch and the other audit findings remain outside this phase's execution scope. No Records Management, AST, scheduling or consultation lifecycle changes were made. The user subsequently authorized committing and pushing the preflight documentation. Pre-existing queue-settings, fill-up form changes and the unrelated artifact remain untouched.

To resume, set a valid backend-only key for the confirmed development project in `backend/.env` locally and provide read-only SQL access through Supabase or a signed-in SQL Editor. The local URL is already configured. Complete the live preflight first; then request explicit approval for the concrete migration and controlled test writes.

## Publication scope

This documentation-only update contains this report, the read-only catalog SQL and a README link. It excludes local credentials, diagnostic evidence/helpers, patient data, runtime settings, unrelated form edits and Phase 2.1 application changes. Publishing the report does not approve any migration, login/session test writes, patient fixtures or production action. For the unchanged application rollout procedure, see the [Phase A guide](phase-a-doctor-presence.md).
