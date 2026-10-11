const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");

let componentCode;
before(async () => {
  await swc.loadBindings();
  const filename = path.join(__dirname, "../components/DoctorAdmin.js");
  componentCode = (await swc.transform(fs.readFileSync(filename, "utf8"), {
    filename,
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" }
  })).code;
});

const clone = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const calledAt = "2026-10-10T01:01:00.000Z";
const acceptedAt = "2026-10-10T01:02:00.000Z";
const startedAt = "2026-10-10T01:03:00.000Z";
const completedAt = "2026-10-10T01:08:00.000Z";

function serving(id = 1, state = {}) {
  return { id, id_num: `Test patient ${id}`, queue_number: `GP-${id}`, service_type: "consultation",
    status: "serving", priority_score: 1, created_at: "2026-10-10T01:00:00.000Z",
    counter_id: "Doctor 1", called_at: calledAt, awaiting_accept: true, accepted_at: null,
    consultation_started_at: null, completed_at: null, ...state };
}
function doctor(number, patientId = null) {
  return { id: number, id_num: `Doctor ${number}`, name: `Doctor ${number}`,
    is_online: true, current_patient_id: patientId };
}

async function harness(initialRows, options = {}) {
  const hooks = [], effectDeps = [], effects = [], calls = [];
  let cursor = 0;
  const props = { doctorId: 1, doctorName: "Doctor 1", ...options.props };
  const user = options.user || { id_num: "admin1", role: "admin", doctor_name: "Doctor 1" };
  const backend = { storage_mode: options.storageMode || "supabase", patients: clone(initialRows), counters: clone(options.counters ||
    [doctor(1, initialRows.find((row) => row.status === "serving" && row.counter_id === "Doctor 1")?.id), doctor(2), doctor(3)]) };
  const settings = { refreshInterval: 5, allowQueueReassignment: true, doctor1Online: true, doctor2Online: true, doctor3Online: true };
  const jsx = (type, props) => ({ type, props: props || {} });
  const react = {
    useMemo(callback) { cursor++; return callback(); },
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
      return [hooks[index], (next) => { hooks[index] = typeof next === "function" ? next(hooks[index]) : next; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index];
    },
    useEffect(callback, deps) {
      const index = cursor++;
      const previous = effectDeps[index];
      if (!previous || !deps || deps.some((value, i) => value !== previous[i])) {
        effectDeps[index] = deps;
        effects.push(callback);
      }
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(componentCode, {
    module, exports: module.exports, Set, Map, console,
    window: { setTimeout: () => 1 }, setInterval: () => 1, clearInterval() {}, clearTimeout() {},
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "../context/AuthContext") return { useAuth: () => ({ user }) };
      if (name === "../components/SiteFrame") return () => {};
      if (name === "./SettingsModal") return { defaultQueueSettings: settings };
      if (name === "../lib/queueSettings") return {
        loadLocalQueueSettings: () => settings, fetchQueueSettings: async () => settings,
        mergeQueueSettings: (value) => ({ ...settings, ...value })
      };
      if (name === "../lib/api") return { request: async (route, init = {}) => {
        calls.push({ route, method: init.method || "GET", ...(init.body ? { body: JSON.parse(init.body) } : {}) });
        if (route === "/queue" && !init.method) return clone(backend);
        if (route === "/account-cancellation-requests/mine") return { success: true, request: null };
        return options.request ? options.request(route, init, backend) : { success: true };
      } };
      throw new Error(`Unexpected dependency: ${name}`);
    }
  });
  const render = () => { cursor = 0; return module.exports.default(props); };
  const flush = async () => {
    for (let i = 0; i < 3; i++) {
      render();
      effects.splice(0).forEach((effect) => effect());
      await tick();
    }
    return render();
  };
  await flush();
  const baselineReads = calls.filter((call) => call.route === "/queue").length;
  return { render, flush, backend, calls,
    get actions() { return calls.filter((call) => call.method === "POST" && call.route.startsWith("/queue/")); },
    get refreshes() { return calls.filter((call) => call.route === "/queue").length - baselineReads; } };
}

function nodes(tree, predicate, result = []) {
  if (Array.isArray(tree)) tree.forEach((node) => nodes(node, predicate, result));
  else if (tree && typeof tree === "object") {
    if (predicate(tree)) result.push(tree);
    nodes(tree.props?.children, predicate, result);
  }
  return result;
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (tree && typeof tree === "object") return text(tree.props?.children);
  return tree == null || typeof tree === "boolean" ? "" : String(tree);
}
const button = (tree, label) => nodes(tree, (node) => node.type === "button" &&
  (node.props["aria-label"] === label || text(node).trim() === label))[0];

test("called patient shows Accept separately from consultation actions", async () => {
  const h = await harness([serving()]);
  const tree = h.render();
  assert.ok(button(tree, "Accept patient"));
  assert.match(text(tree), /Called, awaiting acceptance/);
  assert.equal(button(tree, "Start Consultation"), undefined);
  assert.equal(button(tree, "Complete Consultation"), undefined);
  assert.equal(button(tree, "Re-Call").props.disabled, true);
});

test("Doctor Dashboard identifies temporary consultation records only when the backend reports local fallback", async () => {
  const local = await harness([serving()], { storageMode: "local_fallback" });
  assert.match(text(local.render()), /Development session: consultation records are temporary and will be lost when the backend restarts\./);
  const persisted = await harness([serving()], { storageMode: "supabase" });
  assert.doesNotMatch(text(persisted.render()), /Development session: consultation records are temporary/);
});

test("Accept posts once to the existing endpoint and refreshes acceptance without starting consultation", async () => {
  let finish;
  const h = await harness([serving()], { request: () => new Promise((resolve) => { finish = resolve; }) });
  const accept = button(h.render(), "Accept patient");
  const pending = accept.props.onClick();
  await accept.props.onClick();
  assert.deepEqual(h.actions, [{ route: "/queue/accept", method: "POST", body: { patient_id: 1 } }]);
  assert.equal(button(h.render(), "Accept patient").props.disabled, true);
  assert.equal(button(h.render(), "Cancel").props.disabled, true);
  Object.assign(h.backend.patients[0], { awaiting_accept: false, accepted_at: acceptedAt });
  finish({ success: true, accepted_at: acceptedAt });
  await pending;
  assert.equal(h.backend.patients[0].consultation_started_at, null);
  assert.equal(h.backend.patients[0].called_at, calledAt);
  assert.match(text(h.render()), /Accepted, ready for consultation/);
  assert.ok(button(h.render(), "Start Consultation"));
  assert.equal(button(h.render(), "Complete Consultation"), undefined);
});

test("accepted patient can Start with only patient_id and renders the refreshed server timestamp", async () => {
  const h = await harness([serving(1, { awaiting_accept: false, accepted_at: acceptedAt })], {
    request: async (route, init, backend) => {
      assert.equal(route, "/queue/start");
      backend.patients[0].consultation_started_at = startedAt;
      return { success: true, consultation_started_at: startedAt };
    }
  });
  await button(h.render(), "Start Consultation").props.onClick();
  assert.deepEqual(h.actions, [{ route: "/queue/start", method: "POST", body: { patient_id: 1 } }]);
  assert.equal(h.refreshes, 1);
  assert.equal(h.backend.patients[0].status, "serving");
  assert.equal(h.backend.patients[0].completed_at, null);
  assert.equal(h.backend.patients[0].called_at, calledAt);
  assert.equal(h.backend.patients[0].accepted_at, acceptedAt);
  assert.match(text(h.render()), /Consultation in progress/);
  assert.ok(text(h.render()).includes(new Date(startedAt).toLocaleString()));
  assert.equal(button(h.render(), "Start Consultation"), undefined);
  assert.ok(button(h.render(), "Complete Consultation"));
});

test("start pending locks all actions for that patient and creates no optimistic timestamp", async () => {
  let finish;
  const h = await harness([serving(1, { awaiting_accept: false, accepted_at: acceptedAt })], {
    request: () => new Promise((resolve) => { finish = resolve; })
  });
  const start = button(h.render(), "Start Consultation");
  const pending = start.props.onClick();
  await start.props.onClick();
  const loading = button(h.render(), "Starting...");
  assert.equal(loading.props.disabled, true);
  assert.equal(loading.props["aria-busy"], true);
  assert.equal(button(h.render(), "Cancel").props.disabled, true);
  assert.equal(button(h.render(), "Re-Call").props.disabled, true);
  await button(h.render(), "Cancel").props.onClick();
  await button(h.render(), "Re-Call").props.onClick();
  assert.equal(h.actions.length, 1);
  assert.equal(h.backend.patients[0].consultation_started_at, null);
  assert.doesNotMatch(text(h.render()), /Consultation in progress/);
  finish({ success: true });
  await pending;
  assert.equal(button(h.render(), "Start Consultation").props.disabled, false);
});

test("failed start refreshes stale state, exposes success:false message and releases the lock", async () => {
  const h = await harness([serving(1, { awaiting_accept: false, accepted_at: acceptedAt })], {
    request: async () => ({ success: false, message: "The consultation could not start" })
  });
  await button(h.render(), "Start Consultation").props.onClick();
  assert.match(text(h.render()), /The consultation could not start/);
  assert.equal(h.refreshes, 1);
  assert.equal(h.backend.patients[0].consultation_started_at, null);
  assert.equal(button(h.render(), "Start Consultation").props.disabled, false);
  assert.equal(button(h.render(), "Complete Consultation"), undefined);
});

test("started patient can complete without client timestamp, duration, or doctor override fields", async () => {
  let finish;
  const h = await harness([serving(1, { awaiting_accept: false, accepted_at: acceptedAt, consultation_started_at: startedAt })], {
    request: () => new Promise((resolve) => { finish = resolve; })
  });
  const complete = button(h.render(), "Complete Consultation");
  const pending = complete.props.onClick();
  await complete.props.onClick();
  assert.deepEqual(h.actions, [{ route: "/queue/complete", method: "POST", body: { patient_id: 1 } }]);
  assert.equal(button(h.render(), "Completing...").props.disabled, true);
  assert.equal(button(h.render(), "Cancel").props.disabled, true);
  assert.equal(h.backend.patients[0].completed_at, null);
  Object.assign(h.backend.patients[0], { status: "completed", completed_at: completedAt, service_duration_seconds: 300 });
  h.backend.counters[0].current_patient_id = null;
  finish({ success: true });
  await pending;
  assert.equal(h.backend.patients[0].consultation_started_at, startedAt);
  assert.equal(h.backend.patients[0].service_duration_seconds, 300);
  assert.equal(h.backend.counters[0].current_patient_id, null);
  assert.doesNotMatch(text(h.render()), /Test patient 1/);
  assert.equal(button(h.render(), "Complete Consultation"), undefined);
});

test("failed completion retains in-progress UI and refreshes without marking completed", async () => {
  const h = await harness([serving(1, { awaiting_accept: false, accepted_at: acceptedAt, consultation_started_at: startedAt })], {
    request: async () => { throw new Error("Counter assignment changed"); }
  });
  await button(h.render(), "Complete Consultation").props.onClick();
  assert.match(text(h.render()), /Counter assignment changed/);
  assert.equal(h.backend.patients[0].status, "serving");
  assert.equal(h.backend.patients[0].completed_at, null);
  assert.equal(h.refreshes, 1);
  assert.equal(button(h.render(), "Complete Consultation").props.disabled, false);
});

test("missing acceptance timestamp never exposes Start or Complete even if awaiting flag is false", async () => {
  const h = await harness([serving(1, { awaiting_accept: false, accepted_at: null })]);
  assert.equal(button(h.render(), "Start Consultation"), undefined);
  assert.equal(button(h.render(), "Complete Consultation"), undefined);
  assert.equal(button(h.render(), "Re-Call").props.disabled, true);
});

test("persisted consultation start keeps Complete and Re-Call available after acceptance JSON is lost", async () => {
  const h = await harness([serving(1, { awaiting_accept: false, accepted_at: null, consultation_started_at: startedAt })]);
  assert.match(text(h.render()), /Consultation in progress/);
  assert.equal(button(h.render(), "Accept patient"), undefined);
  assert.equal(button(h.render(), "Start Consultation"), undefined);
  assert.equal(button(h.render(), "Re-Call").props.disabled, false);
  await button(h.render(), "Complete Consultation").props.onClick();
  await button(h.render(), "Re-Call").props.onClick();
  assert.deepEqual(h.actions.map((action) => action.route), ["/queue/complete", "/queue/re-call"]);
  assert.equal(h.backend.patients[0].consultation_started_at, startedAt);
  assert.equal(h.backend.patients[0].accepted_at, null, "the UI must not reconstruct a historical acceptance timestamp");
});

test("a doctor dashboard does not show another doctor's patient or consultation controls", async () => {
  const h = await harness([serving(2, { counter_id: "Doctor 2", service_type: "prenatal", awaiting_accept: false, accepted_at: acceptedAt })], {
    counters: [doctor(1), doctor(2, 2), doctor(3)]
  });
  assert.doesNotMatch(text(h.render()), /Test patient 2/);
  assert.equal(button(h.render(), "Start Consultation"), undefined);
  assert.equal(button(h.render(), "Complete Consultation"), undefined);
  assert.equal(h.actions.length, 0);
});

test("a doctor account viewing a different doctor, or Superadmin, cannot access consultation mutations", async () => {
  for (const user of [
    { id_num: "admin2", role: "admin", doctor_name: "Doctor 2" },
    { id_num: "superadmin", role: "superadmin", doctor_name: null }
  ]) {
    for (const consultation_started_at of [null, startedAt]) {
      const h = await harness([serving(1, { awaiting_accept: false, accepted_at: acceptedAt, consultation_started_at })], { user });
      assert.equal(button(h.render(), "Start Consultation"), undefined);
      assert.equal(button(h.render(), "Complete Consultation"), undefined);
      if (user.role === "superadmin") {
        assert.equal(h.render().props.profileMenuLinks[0].label, "Dashboard");
      }
    }
  }
});

test("stale Start is rejected locally when the current doctor counter belongs to another patient", async () => {
  const h = await harness([serving(1, { awaiting_accept: false, accepted_at: acceptedAt })], {
    counters: [doctor(1, 99), doctor(2), doctor(3)]
  });
  await button(h.render(), "Start Consultation").props.onClick();
  assert.equal(h.actions.length, 0);
  assert.match(text(h.render()), /counter no longer has this patient/);
});

test("waiting and completed rows do not offer consultation actions", async () => {
  const h = await harness([
    serving(1, { status: "waiting", called_at: null, counter_id: null }),
    serving(2, { status: "completed", awaiting_accept: false, accepted_at: acceptedAt, consultation_started_at: startedAt, completed_at: completedAt })
  ]);
  assert.equal(button(h.render(), "Accept patient"), undefined);
  assert.equal(button(h.render(), "Start Consultation"), undefined);
  assert.equal(button(h.render(), "Complete Consultation"), undefined);
});

test("Re-Call remains a separate existing endpoint before and during consultation", async () => {
  for (const consultation_started_at of [null, startedAt]) {
    const h = await harness([serving(1, { awaiting_accept: false, accepted_at: acceptedAt, consultation_started_at })]);
    await button(h.render(), "Re-Call").props.onClick();
    assert.deepEqual(h.actions, [{ route: "/queue/re-call", method: "POST", body: { patient_id: 1, counterId: "Doctor 1" } }]);
    assert.equal(h.backend.patients[0].consultation_started_at, consultation_started_at);
    assert.equal(h.backend.patients[0].accepted_at, acceptedAt);
  }
});

test("Cancel remains available in accepted and started phases, requires reason and locks duplicate confirmation", async () => {
  for (const consultation_started_at of [null, startedAt]) {
    let finish;
    const h = await harness([serving(1, { awaiting_accept: false, accepted_at: acceptedAt, consultation_started_at })], {
      request: () => new Promise((resolve) => { finish = resolve; })
    });
    await button(h.render(), "Cancel").props.onClick();
    await button(h.render(), "Confirm").props.onClick();
    assert.equal(h.actions.length, 0);
    assert.match(text(h.render()), /Please provide a reason/);
    const textarea = nodes(h.render(), (node) => node.type === "textarea")[0];
    textarea.props.onChange({ target: { value: "Patient requested cancellation" } });
    const confirm = button(h.render(), "Confirm");
    const pending = confirm.props.onClick();
    await confirm.props.onClick();
    assert.deepEqual(h.actions, [{ route: "/queue/cancel", method: "POST", body: {
      patient_id: 1, reason: "Patient requested cancellation", counter_id: "Doctor 1"
    } }]);
    assert.equal(button(h.render(), "Confirming...").props.disabled, true);
    finish({ success: true });
    await pending;
    assert.equal(button(h.render(), "Confirm"), undefined);
  }
});

test("existing cancelled patient Undo remains available and shares duplicate-action protection", async () => {
  let finish;
  const h = await harness([serving(1, { status: "cancelled", counter_id: null })], {
    request: () => new Promise((resolve) => { finish = resolve; })
  });
  const undo = button(h.render(), "Undo");
  assert.ok(undo);
  const pending = undo.props.onClick();
  await undo.props.onClick();
  assert.deepEqual(h.actions, [{ route: "/queue/undo", method: "POST", body: { patient_id: 1 } }]);
  assert.equal(button(h.render(), "Undo").props.disabled, true);
  assert.equal(button(h.render(), "Re-queue").props.disabled, true);
  finish({ success: true });
  await pending;
});

test("Doctor 2 and Doctor 3 can start only their mapped active patient with the same endpoint contract", async () => {
  for (const number of [2, 3]) {
    const doctorName = `Doctor ${number}`;
    const h = await harness([serving(number, { counter_id: doctorName, service_type: number === 2 ? "prenatal" : "family_planning",
      awaiting_accept: false, accepted_at: acceptedAt })], {
      props: { doctorId: number, doctorName }, user: { id_num: `admin${number}`, role: "admin", doctor_name: doctorName },
      counters: [doctor(1), doctor(2, number === 2 ? number : null), doctor(3, number === 3 ? number : null)]
    });
    await button(h.render(), "Start Consultation").props.onClick();
    assert.deepEqual(h.actions, [{ route: "/queue/start", method: "POST", body: { patient_id: number } }]);
  }
});
