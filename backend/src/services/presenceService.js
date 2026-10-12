const supabase = require("../lib/supabase");

const MIGRATION = "backend/scripts/20261012-phase-a-auth-presence.sql";
const PRESENCE_TIMEOUT_SECONDS = 75;
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function authError(message, statusCode = 401) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.status = statusCode;
  return error;
}

function claimsArguments(claims) {
  if (!claims || typeof claims.jti !== "string" || !SESSION_UUID.test(claims.jti) ||
      typeof claims.id_num !== "string" || !claims.id_num.trim() ||
      !["admin", "superadmin"].includes(claims.role) ||
      (claims.doctor_name != null && typeof claims.doctor_name !== "string")) {
    throw authError("Your authentication session is invalid. Please sign in again.");
  }
  return {
    p_session_id: claims.jti,
    p_user_id_num: claims.id_num,
    p_role: claims.role,
    p_doctor_name: claims.doctor_name || null
  };
}

async function rpc(name, args = {}) {
  let result;
  try {
    result = await supabase.rpc(name, args);
  } catch (error) {
    throw authError("Authentication session storage is temporarily unavailable. Please retry.", 503);
  }
  if (result?.error) {
    if (result.error.code === "42501") {
      throw authError("Your authentication session expired or was revoked. Please sign in again.");
    }
    const missing = ["PGRST202", "42P01", "42883"].includes(result.error.code);
    throw authError(missing
      ? `Authentication session storage is not installed. Apply ${MIGRATION} to the approved Supabase project before using staff login.`
      : "Authentication session storage is temporarily unavailable. Please retry.", 503);
  }
  if (result?.data == null) {
    throw authError("Authentication session storage returned no result. Please retry.", 503);
  }
  return result.data;
}

function sessionResult(data) {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.session_id || !row?.expires_at || !row?.last_seen_at) {
    throw authError("Authentication session storage returned an invalid result. Please retry.", 503);
  }
  return {
    session_id: row.session_id,
    id_num: row.user_id_num,
    role: row.role,
    doctor_name: row.doctor_name,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at
  };
}

async function createAuthSession(user, sessionId) {
  const args = claimsArguments({ ...user, jti: sessionId });
  if (typeof user.auth_revision !== "string" || !SESSION_UUID.test(user.auth_revision)) {
    throw authError(`Authentication account revisions are not installed. Apply ${MIGRATION} to the approved Supabase project before using staff login.`, 503);
  }
  args.p_auth_revision = user.auth_revision;
  return sessionResult(await rpc("create_staff_auth_session", args));
}

async function validateAuthSession(claims) {
  return sessionResult(await rpc("validate_staff_auth_session", claimsArguments(claims)));
}

async function heartbeatAuthSession(claims) {
  // PostgreSQL validates and locks the session, then throttles writes across
  // shared tabs and backend instances. Browser timestamps are never accepted.
  return sessionResult(await rpc("heartbeat_staff_auth_session", claimsArguments(claims)));
}

async function revokeAuthSession(claims) {
  const args = claimsArguments(claims);
  await rpc("revoke_staff_auth_session", {
    p_session_id: args.p_session_id,
    p_user_id_num: args.p_user_id_num
  });
  return { revoked: true };
}

async function revokeUserSessions(idNum) {
  if (typeof idNum !== "string" || !idNum.trim()) throw authError("An account ID is required.", 400);
  return { revoked_count: Number(await rpc("revoke_staff_user_sessions", { p_user_id_num: idNum })) };
}

async function getDoctorPresence(counters) {
  const data = await rpc("get_staff_doctor_presence");
  if (!Array.isArray(data.doctors) || !data.observed_at || data.timeout_seconds !== PRESENCE_TIMEOUT_SECONDS) {
    throw authError("Doctor presence storage returned an invalid result. Please retry.", 503);
  }
  // Occupancy and enabled flags stay in the existing counter API. This service
  // reports only authenticated presence and never writes counters or patients.
  const names = Array.isArray(counters) ? new Set(counters.map((counter) => counter.id_num)) : null;
  return {
    doctors: data.doctors.filter((doctor) => !names || names.has(doctor.doctor_name)),
    observed_at: data.observed_at,
    timeout_seconds: PRESENCE_TIMEOUT_SECONDS
  };
}

module.exports = {
  createAuthSession,
  validateAuthSession,
  heartbeatAuthSession,
  revokeAuthSession,
  revokeUserSessions,
  getDoctorPresence
};
