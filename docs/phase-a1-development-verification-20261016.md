# Phase A.1 development verification — final report, 16 October 2026

## 1. Result and development environment

**The installation checks, actual session API tests and guided browser presence checks passed at their recorded observations. Phase A.1 is partially verified, with specific tests still unexecuted. Do not proceed to Phase B.**

Target: owner-confirmed development/testing project **CCHOFPC Web-Based Queuing System**, Supabase project reference `uvmpbgpvmjkfoblrfrdt`, API origin `https://uvmpbgpvmjkfoblrfrdt.supabase.co`. The dashboard's main-branch Production badge was not used as evidence of development identity; the owner's explicit development confirmation was retained. No production deployment or production project change was performed.

The app ran locally at `http://127.0.0.1:3000`, with its backend on port 4000. The saved development connection was restored and validated after a temporary sample-URL configuration. The existing approval covered replacing the restored placeholder JWT secret with a private 256-bit value and restarting only the verified development backend. Fresh Superadmin and Doctor 1 browser logins subsequently succeeded by user report.

This task changed no application source, migration definition, scheduling rule or consultation workflow. It did not implement or verify Phase 2.2, Records Management or AST. Unrelated work in `fix-phase22-audit-findings`, HEAD `9c8da15` at the last Git check, was preserved. No commit or push was performed during verification. The owner subsequently requested publication of this A.1 report only.

## 2. Preflight findings

The reviewed Phase A implementation uses custom Node JWT authentication over `public.users`, private account revisions and persisted staff sessions. Heartbeats run every 25 seconds; Online requires valid activity within 75 seconds. Sessions expire after eight hours, explicit logout revokes the selected session, and Superadmin presence monitoring polls every five seconds. Supabase Auth was not introduced.

Review covered `presenceService.js`, the Phase A migration/verifier, auth middleware/routes, frontend heartbeat/presence helpers, AuthContext, the dashboard and the existing rollout guide. Startup/auth/presence blocks were independently compared with Phase A baseline `2bc917c`; existing startup only inserts missing counters with `ON CONFLICT DO NOTHING`. All three counters existed before each approved restart.

The owner supplied a complete, actual SQL Editor catalog export with **36 sections**. Twenty local analysis assertions passed; schema and grant findings were independently reviewed. All seven normalized function-body fingerprints matched the reviewed migration. These findings establish the observed installed contracts, not who installed them.

The saved configuration temporarily contained the sample Supabase URL. An exact-target guard stopped that check **before any database request**. After the owner restored the approved URL/key, actual GET-only preservation checks passed again. A restored placeholder JWT setting was replaced under the existing approval; other environment settings were preserved. The backend restarted successfully at `2026-10-16T12:55:31Z` (20:55:31 Asia/Singapore). No migration was used to repair configuration.

## 3. Approval and migration execution

| Action | Status |
| --- | --- |
| Development target identification | Explicitly confirmed by owner |
| Session-only login/heartbeat/logout tests, local JWT replacement and described backend startup | Explicitly approved: “Approve session-only tests” |
| Phase A migration approval/execution by this agent | Neither received nor performed; observed installation required no rerun |
| Installation provenance | Unknown; owner said they did not apply it; this agent did not apply it |
| Exposed old backend key | Owner confirmed deletion; replacement connection succeeded; no management audit or old-key reuse attempted |
| Patient fixtures, credential-change fixtures or grant changes | Not performed |
| Production or later workflow phases | Not performed |
| Report publication | Owner subsequently requested an A.1-only commit/push; no application change included |

The existing additive migration was reviewed, not regenerated. No reset, truncation, seed-schema execution or destructive rollback occurred. Backend credential values, passwords, JWTs, private revisions and private session identifiers were not saved in reports.

## 4. Actual read-only Supabase installation verification

The owner-run SQL export reports PostgreSQL 17.6, executing role/database postgres and `transaction_read_only = on`. Its SHA-256 is `51744623ecd98b280ef20419a5de8d02106ae1fe7e05df1c561020373ec7af18`. The catalog observation is from 14 October; a fresh complete catalog export was not obtained on 16 October.

| Installation requirement | Observed result |
| --- | --- |
| Session table/revision | Eight expected session columns; `users.auth_revision` UUID NOT NULL with database UUID default |
| Constraints and dependencies | Expected primary key, role/expiry checks and user foreign key with ON DELETE CASCADE, validated |
| Indexes | Both required lookup indexes have expected definitions and are valid/ready; session primary-key index present |
| RPC contracts | All six API RPCs match backend named arguments and return types; trigger helper also matches |
| Function definitions | Exactly seven expected variants, reviewed body fingerprints, SECURITY DEFINER, postgres owner, explicitly empty search path |
| Obsolete creation signature | Removed |
| Function execute grants | PUBLIC/anon/authenticated denied; required service-role execution present |
| Account-change trigger | Enabled for the expected credential/identity fields |
| Session privacy | RLS enabled; service-role-only policy; browser table and effective column access denied |
| PostgREST | Expected contracts discoverable; actual RPC-backed session and aggregate calls succeeded |

Broader existing table grants differ from the narrow session-table model; see section 8. No grant or policy was changed. PGlite tests are not the basis of these actual catalog findings.

## 5. Actual browser integration results

Browser automation was unavailable: the enabled inventory was empty and opening the in-app browser failed. The following evidence is **guided operation reported by the user**, separately recorded in `browser-user-observations-20261016.json`. Exact transition times were not independently measured.

| Scenario | User-observed result |
| --- | --- |
| Doctor 1 login | Superadmin showed Online, in response to the requested approximately ten-second check |
| Explicit doctor logout | Doctor returned to login and Superadmin showed Offline |
| Close browser without logout | Offline after approximately 90 seconds |
| Doctor-tab network interruption | With Chrome DevTools Offline selected only for the doctor tab, connected Superadmin showed Offline after approximately 90 seconds |
| Doctor-tab network recovery | Restoring No throttling returned Online automatically without signing in again |
| Monitoring transport failure | Disconnecting only Superadmin's tab produced Unknown by user report |
| Monitoring recovery | After restoration and one reload, dashboard returned with Doctor 1 Online |
| Independent browser sessions | Logging out Chrome Incognito left Doctor 1 signed in in Edge InPrivate after the requested 90 seconds and reload; Superadmin remained Online |
| Counter and queue display | Doctor 1 showed Counter: Enabled, Serving and Current queue; its queue number matched the doctor page without sharing the number |
| Fresh login after restored configuration/restart | Fresh Superadmin and Doctor 1 logins succeeded; Doctor 1 showed Online |
| Monitoring cadence | User confirmed HTTP 200 requests roughly every five seconds during the requested 30-second foreground observation |
| Final doctor logout/offline warning | Doctor 1 became Offline while enabled counter and current queue remained; occupied-counter warning appeared |
| Final Superadmin logout | Returned to login |

The network test emulated tab connectivity, not physical Wi-Fi failure. Chrome's supplied screenshot showed an offline document error page; it did not itself show Unknown badges. The Unknown finding relies on the user's text report. Monitoring recovery required a reload in the guided procedure; automatic recovery without reload was not established. HTTP 500 handling was not separately tested. Poll timing was approximate; exact request start times/counts were not captured. The [Chrome DevTools reference](https://developer.chrome.com/docs/devtools/network/reference/#offline) describes the Offline control.

Doctor 1 was the real-browser account exercised. All three doctors were exercised through the actual API tests below. Disabled/Available rendering was not exercised because current counters were enabled and occupied; no counter or patient was changed to manufacture those states.

The fresh Edge doctor and normal-Chrome Superadmin sessions were logged out by user report. Their private session rows were not inspected individually. Earlier manual JWTs were invalidated by the second signing-secret replacement, but their persisted rows were **not selectively revoked** because exact owned identifiers were not retained. Those rows age out of presence and keep their normal expiry; no unrelated sessions were revoked.

## 6. Actual API, multiple-session and concurrency results

The API run on 15 October, `13:37:25.833Z–13:38:51.199Z` (21:37:25–21:38:51 Asia/Singapore), passed **83 assertions, zero failed, no skipped API scenarios**, across **55 local backend HTTP requests** backed by actual development Supabase RPCs. Additional read-only helpers are outside that request count.

Verified behavior included all three doctor profiles/associations; successful Superadmin monitoring; anonymous rejection; doctor-to-monitoring rejection; malformed-token rejection; response privacy/no-store; independent Doctor 1 sessions; single-session logout isolation; immediate and delayed concurrent heartbeats; inactivity past 75 seconds; recovery with the same valid session; and rejection of an intentionally already-expired signed JWT.

Six immediate heartbeats stayed inside the throttle window. Eight heartbeats after 21 seconds converged on advanced database activity without extending expiry. In a heartbeat/logout overlap, six heartbeats and the logout returned 200; all four requests submitted after the completed logout returned 401, while an independent session stayed valid. This is a valid race ordering, not proof that a delayed transaction was deterministically held across revocation.

All six automated test-owned sessions received successful logout responses. A later read-only window/account-distribution check found six matching rows, all with revocation timestamps and exactly eight-hour creation-to-expiry intervals. Exact private UUIDs were not retained; attribution is by window and account distribution. Doctor 2 had independent pre-existing activity, which was preserved.

**Controlled independent-session PostgreSQL contention was not executed.** Parallel HTTP/PostgREST requests used the real database, but no connection identities or transaction barriers were established. Single-connection PGlite tests do not fill that gap. Natural unrevoked database-session expiration and credential-change races were not tested.

## 7. Patient, counter and runtime preservation

Before startup and at multiple checkpoints after API/browser operations, **105 patients, including three serving visits**, and **three occupied counters** were observed. No queue or consultation action was called by this task. No isolated patient fixture was created.

The final **full patient-row fingerprint changed** because `visit_state_revision` is now present. A second read-only comparison excluded **only that column** and reproduced the original baseline hash exactly for all 105 rows. Thus all originally snapshotted patient values, including consultation timestamps, status and assignments, match at these observations. This is not a claim that every current field or the schema stayed unchanged.

| Comparison | Result |
| --- | --- |
| Original patient baseline | `05528bbc6ac27bcc652948f905bb18ab1470957882fc506af813fea5e868947b` |
| Final full patient rows | `7339ade63ebb4c0417db843e92706286ce27dd05eae0096d4c2f6814a716f38b` — different |
| Final rows excluding only `visit_state_revision` | Exact original baseline hash match |
| Revision metadata | Present with UUID-shaped values on 105 rows; correctness/provenance not established |
| Complete counter values | Baseline hash match: `44eedd2719b9682becd1f0846327e9a8e2be41ec6f226862fb39360e451122c8` |
| Public account assignments | Baseline hash match; only id_num/role/doctor_name covered |
| Queue settings, acceptance and voice JSON | All three baseline file hashes match |

This Phase A.1 agent did not add or update the revision column. Its actor/time and Phase 2.1/2.2 correctness were not inferred or verified. Both the full-row mismatch and the narrowly normalized match are retained in `post-browser-doctor-logout-preservation-20261016.json` and `final-patient-metadata-difference-20261016.json`.

Snapshots are separate observations, not an atomic or continuous immutability proof. Password/revision values were not snapshotted for account comparison. Preserving existing serving records under session operations is useful evidence, but does not replace the requested isolated serving-patient logout fixture.

## 8. Authentication, RLS and security observations

Custom JWT authentication and server-side authorization were preserved. Actual API role checks rejected unauthorized presence monitoring. Targeted session/RPC restrictions and returned-field privacy passed. Backend key/JWT values stayed outside reports and frontend configuration; no Supabase Auth migration occurred.

A final exact-value scan checked the current backend key and JWT secret against 63 task artifact files and found no matches. This check covers those current values, not historical credentials or attached screenshots. `backend/.env` and the verification output remain ignored by Git.

The existing users/patients/counters tables have enabled, nonforced RLS and no policies in the supplied catalog export. Browser roles have broad grants, including private-user columns and TRUNCATE/TRIGGER. For ordinary row access, nonowner/nonbypass browser roles are default-denied by the observed RLS configuration; grants alone do not establish a credential leak. RLS does not govern TRUNCATE, so the excessive grants remain a latent concern. No public truncation path/exploit was tested or established. No broad routine/view inventory or live SET ROLE probes were executed. [PostgreSQL RLS documentation](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

Service-role session-table TRUNCATE/TRIGGER and trigger-helper execution privileges were also present beyond the migration's explicit minimum; their origin was not established. Browser session-table/column and targeted RPC access remained denied. No authorization was weakened.

The documented legacy shared compatibility-password behavior for doctor login remains a separate production security concern. These tests exercise that existing branch and do not prove individual doctor-password security. It was not rewritten. Owner-confirmed old-key deletion was not independently audited through management access.

## 9. Unexecuted tests, remaining risks and recovery

The following remain unexecuted or incomplete:

- Natural eight-hour expiry of an otherwise unrevoked database session. An expired JWT rejection and eight-hour stored lifetimes are different evidence.
- Controlled simultaneous independent PostgreSQL sessions, including held heartbeat/logout/revocation barriers and credential changes versus delayed requests.
- Credential-change fixtures and the isolated serving-patient logout fixture. No account password or patient was modified for testing.
- Disabled/Available counter rendering, real-browser Doctor 2/3 flows and exact instrumented polling/transition timing.
- Automatic monitoring recovery without reload, a separate HTTP 500 failure case and physical network interruption.
- A fresh full catalog/grant export after 14 October, migration provenance and an atomic before/after observation of installation.

Outstanding account/patient fixtures need a concrete isolated setup and separate approval before writes. Direct PostgreSQL testing needs supported access and separate sessions; it cannot be replaced with claims from PGlite or concurrent HTTP alone.

For a failed development rollout: stop further test writes, retain sanitized evidence and inspect catalogs/read-only state. Confirm whether a failed transaction rolled back rather than assuming it did. Restore a known working Phase A configuration/application compatible with installed contracts, retain the strong private signing setting, and use fresh logins. Revoke only identifiable test-owned sessions through authorized paths. Do not drop the session/revision objects, reset tables, restore external patient changes, weaken authorization or rerun the seed schema as a rollback. Schema repair requires a separately reviewed plan preserving existing records; dropping new tables is not assumed safe.

## 10. Readiness recommendation and evidence

**Core development presence behavior is supported by actual database-backed API results and guided user browser observations. Phase A.1 is not fully verified; Phase B is not recommended until outstanding coverage and security concerns are reviewed. Work stops after Phase A.1.**

Primary local evidence is retained in `output/phase-a1-development-verification/`. These diagnostic files are ignored and are not part of this documentation publication:

- `live-sql-editor-results-20261014.json`, `live-sql-editor-review-20261014.json` and the 14 October report: complete catalog evidence and analysis.
- `live-session-api-results-20261015.json`: 83 assertions, actual requests, six test-session logouts and preservation checkpoints.
- `session-window-metadata-verification-20261016.json`: persisted revocation/eight-hour lifetime observations.
- `browser-user-observations-20261016.json`: all 13 guided user observations, with timing/evidence limits.
- `local-target-check-20261016.json`, restoration/restart/readiness files and `post-restored-backend-start-preservation-20261016.json`: configuration recovery and restart evidence.
- `post-browser-doctor-logout-preservation-20261016.json` and `final-patient-metadata-difference-20261016.json`: final full-row difference and original-field preservation.
- `approval-status.json`: current execution, approval, cleanup and unexecuted-scope status.
- `final-current-secret-boundary-check-20261016.json`: scoped current-key/JWT artifact scan without emitting either value.

Earlier progress reports and diagnostic evidence remain local as historical observations. This is the published copy of the final Phase A.1 report.
