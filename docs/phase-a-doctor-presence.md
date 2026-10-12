# Phase A: doctor login presence and counter monitoring

Implemented locally on 12 October 2026. The migration is prepared and has **not** been applied to a live Supabase project. Staff login with this version requires the migration; deploy the database and application together, then sign in again. Existing JWTs without a session identifier are rejected.

## Root cause and authentication inspection

Authentication is custom Node.js JWT authentication over `public.users`, with an eight-hour login. Supabase supplies PostgreSQL storage through a backend-only service key; Supabase Auth is not the login provider. Previously there was no persisted authentication session, server logout, heartbeat or token revocation. Browser logout only removed local storage.

The Superadmin cards labelled `counters.is_online` as Online/Offline. That field is an administrative enablement policy used by registration and Call, so it cannot establish authenticated presence. A hardcoded dashboard ONLINE label also supplied no session evidence.

The implementation preserves this authentication provider and the existing eight-hour lifetime. It keeps authenticated presence, administrative counter enablement, and patient occupancy separate. It does not change weighted scheduling, registration, consultation timestamps, AST, or the Call/Accept/Complete/Cancel service logic.

## Presence and logout behavior

- A successful verified login creates a random UUID session. The JWT contains its `jti`; PostgreSQL records account ID, role, doctor assignment, login/last-heartbeat times, expiration, and revocation time. No password, password hash, JWT, access token, or server secret is stored in the session table.
- PostgreSQL generates all session timestamps. A heartbeat runs approximately every 25 seconds and on reconnect, focus, page restoration, and return to a visible tab. Each request has a ten-second transport timeout. Multiple tabs can send heartbeats, but PostgreSQL permits at most one timestamp write per session per 20 seconds.
- A doctor is Online when at least one current-account, unrevoked, unexpired session has a heartbeat within 75 seconds. Stopping all heartbeats, closing the browser, network loss, or browser suspension produces Offline after that window, visible on the next five-second monitoring poll. A valid session can become Online again after reconnection without another login.
- Explicit logout revokes only the captured login session immediately. Shared tabs use the same token and follow its logout; independently logged-in browsers/profiles have separate sessions. A tab closing or unmounting never revokes another tab. Another active independent session keeps the doctor Online.
- Logout clears browser credentials after server acknowledgement. If the request fails or times out, an on-screen message asks the user to retry and the session remains signed in. A delayed response cannot clear a newer login. An already-invalid session can be cleared safely.
- Every protected API request validates both the existing JWT and the persisted session/current account. Expired or revoked tokens cannot maintain presence or continue using queue APIs. Password, role, assignment, or account-revision changes revoke sessions; account deletion removes associated sessions. Reverting an account change does not revive them.
- A private `users.auth_revision` UUID ties session creation to the account snapshot whose password was verified. It rotates on account changes and differs for a recreated account, preventing a delayed login from bypassing revocation. The revision is omitted from the browser profile, JWT and session table.

Presence never updates patients, counters, acceptance files, or announcements. Logout during a consultation leaves status, assignment, actual start/end, and occupied counter intact for authorized recovery.

## API and dashboard

The existing bearer-token convention remains:

| Endpoint | Access | Result |
| --- | --- | --- |
| `POST /auth/login` | Existing credential verification | Creates a persisted session and returns the existing public user profile plus JWT. |
| `POST /auth/heartbeat` | Verified staff session | Refreshes its own server activity; ignores client identity/timing fields. |
| `POST /auth/logout` | Verified staff session | Revokes its own session; does not touch a queue. |
| `GET /doctors/presence` | Verified Superadmin | Aggregate doctor presence, server observation time, 75-second threshold, and current counter snapshots. No session IDs or tokens. |

Responses use `Cache-Control: no-store`. Missing migration/database transport errors return 503; invalid sessions return 401, and invalid JWTs or unauthorized monitoring return the existing 403 conventions. Database errors do not fabricate presence or replace it with in-memory sessions. Persisted staff login therefore requires configured Supabase even though legacy unconfigured queue development fixtures still exist.

Superadmin polls presence and counters every five seconds, including when automatic queue refresh is disabled. Doctor 1/2/3 cards show authenticated Online/Offline, Available/Serving when online, independent Counter Enabled/Disabled, and the current patient queue number. Offline cards show the last verified activity, or no recorded activity. Offline plus occupied warns that the patient assignment is preserved and requires authorized recovery. Counter queue-number snapshots retain monitoring across midnight without changing the inherited date-filtered queue query.

Failed or malformed monitoring responses display Unknown. A monitoring snapshot also becomes Unknown after 15 seconds without a fresh response. Freshness uses local elapsed time rather than comparing the computer's wall clock with PostgreSQL's clock. The existing enablement policy remains the condition used by Call; login presence does not silently change admission or scheduling policy.

## Database migration and rollout

Review [20261012-phase-a-auth-presence.sql](../backend/scripts/20261012-phase-a-auth-presence.sql) and the [read-only verification SQL](../backend/scripts/20261012-phase-a-verify.sql). The migration:

1. Adds `users.auth_revision UUID NOT NULL` with a generated default.
2. Creates `staff_auth_sessions`, its account foreign key, validation constraints and lookup indexes.
3. Creates session creation/validation/heartbeat/revocation and doctor aggregation RPCs. Heartbeat locks the user and session before checking expiration/revocation, so an overlapping logout cannot be undone by a late heartbeat.
4. Adds a user-change trigger to rotate the private revision and revoke old sessions. Drops the obsolete creation signature so it cannot bypass revision verification.
5. Enables RLS on the new table, grants access only to `service_role`, denies table access and function execution to PUBLIC/anon/authenticated, and fixes definer-function search paths. Existing patient/counter/user RLS policies are preserved.
6. Notifies PostgREST to reload its schema cache. Reapplying the migration preserves existing session data and unchanged account revisions.

The tracked baseline contains no RLS policies for users/counters/patients. Deployed policies have not been queried through live SQL in this phase. The verification script reports their actual RLS flags and policies, along with new columns, RPC/table grants, the revocation trigger, removal of the obsolete RPC signature, and aggregate presence. Review all result sets in the chosen project's SQL Editor.

Apply first to the previously confirmed development/testing project, after reviewing its schema and policies. **Production migration application requires explicit approval.** The application never applies this SQL automatically. Do not run the original full schema/seed script against an existing deployment: it truncates counters.

After migration verification, restart the backend/frontend together and sign in again in each browser/profile. Verify the Superadmin cards before considering deployment complete. No live patient or schema changes were made by the local implementation/tests.

## Files and validation

New implementation files: `backend/src/services/presenceService.js`, the two versioned SQL scripts, `frontend/lib/authHeartbeat.js`, and `frontend/lib/doctorPresence.js`. Integration changes: backend auth middleware, routes and the private login return; frontend AuthContext/API, SiteFrame logout-error feedback, existing Superadmin status cards, and enablement wording in DoctorAdmin/SettingsModal. Tests cover SQL/service boundaries, real JWT middleware/routes, browser heartbeat/logout, and dashboard monitoring; the existing queue harness now stubs the new dependency only for its established queue regression tests.

For actual SQL tests, reuse the installed temporary PGlite package described in the Phase 2 guide:

```powershell
$env:PHASE2_PGLITE_MODULE = Join-Path $env:TEMP 'city-health-phase2-pg-tests/node_modules/@electric-sql/pglite'
npm.cmd --prefix backend test
npm.cmd --prefix frontend test
npm.cmd --prefix frontend run build
Remove-Item Env:PHASE2_PGLITE_MODULE
```

The local verification report and logs are saved in ignored `output/phase-a-development-verification/`. The SQL engine uses one connection; it cannot prove simultaneous deployed PostgreSQL connection behavior.

Final local verification on 12 October 2026 passed **191 backend/SQL tests**, **101 frontend tests**, and **3 Python voice tests**: **295 passed, none failed or skipped**. The Next.js production build also passed, generated every page, and produced `BUILD_ID = VT9SVSqrU-UXCJfG155JU`. `git diff --check` passed. Test workers and build workers required execution outside the Windows sandbox after its `spawn EPERM` denial; the test fixtures remained isolated from live Supabase.

## Live manual verification and remaining limits

After migration, use separate browser profiles for Superadmin and doctors. These scenarios have automated coverage but still need live browser/Supabase confirmation:

| Scenario | Expected live result |
| --- | --- |
| Doctor login, no patient | Online, Available; enablement displayed independently. |
| Doctor serving a patient | Online, Serving and current queue number. |
| Explicit logout | Offline on the next monitoring poll when no other session is active. |
| Close all doctor tabs/browser | Offline after the 75-second heartbeat window. |
| Disconnect the doctor network | Offline after the same window; no patient/counter mutation. |
| Restore network with valid login | Heartbeat resumes and Online returns. |
| Multiple tabs and independent sessions | Closing one tab or logging out one independent session leaves remaining active sessions Online. |
| Expire/revoke/reset the account | Old JWT cannot heartbeat; a fresh valid login is required. |
| Logout during a started visit | Offline warning while the exact patient start/status/assignment and occupied counter remain intact. |
| Doctor 1 activity | Doctor 2/3 presence and assignments stay unchanged. |
| Disable queue auto-refresh | Session and counter monitoring still updates every five seconds. |
| Superadmin transport outage | Unknown monitoring; recovery replaces it with authoritative state. |

Check concurrent heartbeat/logout from separate deployed PostgreSQL connections, real browser timer suspension, network restoration, and deployed RLS/grants. Browser sleep can age an otherwise valid session Offline until its next heartbeat; that reflects the lack of recent server activity. Session-history retention has no automatic cleanup job in this phase and should be planned before sustained deployment.

The existing legacy `admin123` compatibility password branch remains in `loginUser`; this phase reuses the existing credential rules rather than changing them. The six previously documented Phase 2 audit findings remain outside this phase's scope, including broader legacy queue mutation and date-range issues. No unrelated local queue settings or fill-up form edits were overwritten.
