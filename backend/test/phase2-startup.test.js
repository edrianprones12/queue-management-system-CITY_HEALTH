const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, createDatabase, clone } = require("./helpers/queueHarness");

const doctor = (number) => ({ id_num: `admin${number}`, role: "admin", doctor_name: `Doctor ${number}` });
const baseTime = Date.parse("2026-10-10T01:00:00.000Z");

async function callAndAccept(h, number) {
  const patient = await h.service.createQueueEntry({
    idNum: `Startup test patient ${number}`,
    serviceType: ["consultation", "prenatal", "family_planning"][number - 1],
    vulnerabilityFlags: []
  });
  const called = await h.request("POST", "/queue/call", { patient_id: patient.id });
  assert.equal(called.status, 200, called.body.message);
  h.advance();
  const accepted = await h.request("POST", "/queue/accept", { patient_id: patient.id }, doctor(number));
  assert.equal(accepted.status, 200, accepted.body.message);
  h.advance();
  return patient;
}

test("startup and a fresh backend module preserve accepted and started consultations, counter identities and availability", async () => {
  const h = createHarness({ clock: { now: baseTime } });
  await h.initialize();
  const accepted = await callAndAccept(h, 1);
  const started = await callAndAccept(h, 2);
  assert.equal((await h.request("POST", "/queue/start", { patient_id: started.id }, doctor(2))).status, 200);
  const unrelated = await callAndAccept(h, 3);

  // Existing deployment IDs, service mappings and availability are persisted
  // configuration. Startup must not replace them with initial seed defaults.
  h.database.counters.forEach((counter, index) => { counter.id = 41 + index; });
  h.database.counters[0].service_types.push("dental");
  h.database.counters[2].is_online = false;
  const patientsBefore = clone(h.database.patients);
  const countersBefore = clone(h.database.counters);
  const acceptanceBefore = [accepted, started, unrelated].map((patient) => h.settings.getAcceptedAt(patient.id));
  const eventsBefore = clone(h.settings.getVoiceAnnouncementEvents());

  assert.equal((await h.service.seedCounters()).created, 0);
  assert.equal((await h.service.seedCounters()).created, 0);
  assert.deepEqual(clone(h.database.patients), patientsBefore);
  assert.deepEqual(clone(h.database.counters), countersBefore);

  // A new VM module has fresh module caches and rereads the existing acceptance
  // JSON. It shares only the persisted fake database and virtual disk files.
  const restarted = createHarness({ database: h.database, files: h.virtualFs.files, clock: h.clock });
  await restarted.initialize();
  assert.equal((await restarted.service.seedCounters()).created, 0);
  assert.deepEqual(clone(h.database.patients), patientsBefore);
  assert.deepEqual(clone(h.database.counters), countersBefore);
  assert.deepEqual([accepted, started, unrelated].map((patient) => restarted.settings.getAcceptedAt(patient.id)), acceptanceBefore);
  assert.deepEqual(clone(restarted.settings.getVoiceAnnouncementEvents()), eventsBefore);

  const resumedStart = await restarted.request("POST", "/queue/start", { patient_id: accepted.id }, doctor(1));
  assert.equal(resumedStart.status, 200, resumedStart.body.message);
  restarted.advance(2000);
  const resumedComplete = await restarted.request("POST", "/queue/complete", { patient_id: started.id }, doctor(2));
  assert.equal(resumedComplete.status, 200, resumedComplete.body.message);
  assert.equal(resumedComplete.body.patient.consultation_started_at, patientsBefore.find((row) => row.id === started.id).consultation_started_at);
  assert.equal(h.database.counters[1].current_patient_id, null);
  assert.deepEqual(clone(h.database.counters[2]), countersBefore[2]);
  assert.deepEqual(clone(restarted.settings.getVoiceAnnouncementEvents()), eventsBefore);
  assert.equal(h.database.calls.some((call) => call.table === "counters" && call.action === "delete"), false);
});

test("startup adds only missing doctor mappings and repeated or concurrent startups produce no duplicates", async () => {
  const database = createDatabase();
  database.counters = database.counters.filter((counter) => counter.id_num !== "Doctor 2");
  database.counters[0].id = 21;
  database.counters[0].current_patient_id = 91;
  database.counters[0].service_types = ["consultation", "dental"];
  database.counters[1].id = 27;
  database.counters[1].is_online = false;
  database.counters.push({ id: 31, id_num: "Archive counter", service_types: ["archive"], is_online: false, current_patient_id: null });
  const existing = clone(database.counters);
  const h = createHarness({ database, clock: { now: baseTime } });
  const anotherBackend = createHarness({ database, clock: h.clock });

  const results = await Promise.all([h.service.seedCounters(), anotherBackend.service.seedCounters()]);
  assert.equal(results.reduce((total, result) => total + result.created, 0), 1);
  for (const counter of existing) {
    assert.deepEqual(clone(database.counters.find((row) => row.id_num === counter.id_num)), counter);
  }
  const added = database.counters.find((counter) => counter.id_num === "Doctor 2");
  assert.ok(added);
  assert.deepEqual(clone(added.service_types), ["prenatal", "maternity"]);
  assert.equal(added.is_online, true);
  assert.equal(added.current_patient_id, null);
  assert.equal(new Set(database.counters.map((counter) => counter.id)).size, database.counters.length);
  assert.equal(new Set(database.counters.map((counter) => counter.id_num)).size, database.counters.length);
  const visibleCounters = await h.service.getCounters();
  assert.deepEqual(clone(visibleCounters.map((counter) => counter.id_num).sort()), ["Doctor 1", "Doctor 2", "Doctor 3"],
    "Preserving unrelated counters must not hide a later-created doctor from the dashboards");
  const after = clone(database.counters);
  assert.equal((await h.service.seedCounters()).created, 0);
  assert.deepEqual(clone(database.counters), after);
});

for (const transportThrows of [false, true]) {
  test(`failed startup seed preserves ongoing consultations and Supabase storage (${transportThrows ? "transport rejection" : "database error"})`, async () => {
    const h = createHarness({ clock: { now: baseTime } });
    const patient = await callAndAccept(h, 1);
    assert.equal((await h.request("POST", "/queue/start", { patient_id: patient.id }, doctor(1))).status, 200);
    h.database.counters[2].is_online = false;
    const patientsBefore = clone(h.database.patients);
    const countersBefore = clone(h.database.counters);
    const acceptedAt = h.settings.getAcceptedAt(patient.id);
    h.database.beforeQuery = (query) => {
      if (query.table !== "counters" || query.action === "select") return;
      if (transportThrows) throw new Error("Isolated startup transport failure");
      return { data: null, error: { code: "42501", message: "Isolated startup write denied" } };
    };

    await assert.rejects(h.service.seedCounters(), /Isolated startup/);
    assert.deepEqual(clone(h.database.patients), patientsBefore);
    assert.deepEqual(clone(h.database.counters), countersBefore);
    const overview = await h.service.getQueueOverview();
    assert.equal(overview.storage_mode, "supabase");
    assert.equal(overview.patients.find((row) => row.id === patient.id).accepted_at, acceptedAt);
    assert.equal(overview.counters.find((counter) => counter.id_num === "Doctor 1").current_patient_id, patient.id);

    h.database.beforeQuery = null;
    h.advance(2000);
    const completed = await h.request("POST", "/queue/complete", { patient_id: patient.id }, doctor(1));
    assert.equal(completed.status, 200, completed.body.message);
    assert.equal(completed.body.patient.consultation_started_at, patientsBefore[0].consultation_started_at);
    assert.equal(completed.body.patient.status, "completed");
  });
}

test("development fallback startup preserves its active consultation and offline doctor", async () => {
  const h = createHarness({ localFallback: true, clock: { now: baseTime } });
  await h.initialize();
  const patient = await callAndAccept(h, 1);
  assert.equal((await h.request("POST", "/queue/start", { patient_id: patient.id }, doctor(1))).status, 200);
  await h.service.setCounterOnline("Doctor 3", false);
  const before = clone(await h.service.getQueueOverview());
  assert.equal((await h.service.seedCounters()).created, 0);
  assert.deepEqual(clone(await h.service.getQueueOverview()), before);
});
