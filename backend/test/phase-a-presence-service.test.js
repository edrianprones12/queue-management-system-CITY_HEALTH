const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");

function harness(response) {
  const calls = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/services/presenceService.js"), "utf8"), {
    module, exports: module.exports,
    require: (name) => {
      assert.equal(name, "../lib/supabase");
      return { rpc: async (name, args) => {
        calls.push({ name, args });
        if (typeof response === "function") return response(name, args);
        return response;
      } };
    }
  });
  return { service: module.exports, calls };
}
const claims = () => ({ jti: randomUUID(), id_num: "admin1", role: "admin", doctor_name: "Doctor 1" });

test("legacy, missing, malformed and nonstaff claims are rejected without database access", async () => {
  const { service, calls } = harness({});
  for (const invalid of [undefined, {}, { ...claims(), jti: null }, { ...claims(), jti: "legacy-token" },
    { ...claims(), role: "patient" }, { ...claims(), id_num: "" }, { ...claims(), doctor_name: 2 }]) {
    await assert.rejects(service.validateAuthSession(invalid), (error) => error.statusCode === 401);
    await assert.rejects(service.heartbeatAuthSession(invalid), (error) => error.statusCode === 401);
  }
  assert.equal(calls.length, 0);
});

test("missing migration produces actionable 503 and never synthesizes offline presence", async () => {
  for (const code of ["PGRST202", "42P01", "42883"]) {
    const { service } = harness({ data: null, error: { code } });
    await assert.rejects(service.createAuthSession({ ...claims(), auth_revision: randomUUID() }, randomUUID()), (error) =>
      error.statusCode === 503 && error.message.includes("20261012-phase-a-auth-presence.sql"));
    await assert.rejects(service.getDoctorPresence([]), (error) => error.statusCode === 503);
  }
});

test("missing private account revision reports required migration and never inserts a session", async () => {
  const { service, calls } = harness({});
  for (const auth_revision of [undefined, null, "not-a-uuid"]) {
    await assert.rejects(service.createAuthSession({ ...claims(), auth_revision }, randomUUID()),
      (error) => error.statusCode === 503 && error.message.includes("20261012-phase-a-auth-presence.sql"));
  }
  assert.equal(calls.length, 0);
});

test("database outages and malformed responses fail closed with 503", async () => {
  for (const response of [{ data: null, error: { code: "08006" } }, { data: null, error: null },
    { data: {}, error: null }, () => { throw new Error("socket down"); }]) {
    const { service } = harness(response);
    await assert.rejects(service.validateAuthSession(claims()), (error) => error.statusCode === 503);
    await assert.rejects(service.getDoctorPresence([]), (error) => error.statusCode === 503);
  }
});

test("SQL authentication rejection returns 401 for both validation and heartbeat", async () => {
  const { service } = harness({ data: null, error: { code: "42501", message: "expired" } });
  await assert.rejects(service.validateAuthSession(claims()), (error) => error.statusCode === 401);
  await assert.rejects(service.heartbeatAuthSession(claims()), (error) => error.statusCode === 401);
});

test("RPC payload derives identity from verified claims and sends no timestamps, passwords or tokens", async () => {
  const row = { session_id: randomUUID(), user_id_num: "admin1", role: "admin", doctor_name: "Doctor 1",
    created_at: "2026-10-12T00:00:00Z", last_seen_at: "2026-10-12T00:00:00Z", expires_at: "2026-10-12T08:00:00Z", revoked_at: null };
  const { service, calls } = harness({ data: row, error: null });
  const identity = { ...claims(), auth_revision: randomUUID(), password: "do-not-send", token: "do-not-send", last_seen_at: "2099-01-01T00:00:00Z" };
  const session = await service.createAuthSession(identity, row.session_id);
  await service.heartbeatAuthSession({ ...identity, jti: row.session_id });
  assert.equal(session.id_num, "admin1");
  assert.equal(Object.hasOwn(session, "auth_revision"), false);
  for (const call of calls) {
    assert.deepEqual(JSON.parse(JSON.stringify(call.args)), {
      p_session_id: row.session_id, p_user_id_num: "admin1", p_role: "admin", p_doctor_name: "Doctor 1",
      ...(call.name === "create_staff_auth_session" ? { p_auth_revision: identity.auth_revision } : {})
    });
  }
});
