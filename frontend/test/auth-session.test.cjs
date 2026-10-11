const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");

let authCode, apiCode;
before(async () => {
  await swc.loadBindings();
  async function compile(relative) {
    const filename = path.join(__dirname, "..", relative);
    return (await swc.transform(fs.readFileSync(filename, "utf8"), {
      filename,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
      module: { type: "commonjs" }
    })).code;
  }
  [authCode, apiCode] = await Promise.all([compile("context/AuthContext.js"), compile("lib/api.js")]);
});

const doctor = (number) => ({ id_num: `admin${number}`, role: "admin", doctor_name: `Doctor ${number}` });
const clone = (value) => JSON.parse(JSON.stringify(value));

function harness(options = {}) {
  const values = new Map();
  const storedUser = options.user ?? doctor(1);
  if (storedUser) values.set("city_health_user", JSON.stringify(storedUser));
  if (options.token !== null) values.set("city_health_token", options.token || "doctor-one-test-token");
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear()
  };
  const listeners = new Map(), events = [], routes = [], hooks = [], effects = [], cleanups = [];
  let cursor = 0;
  const window = {
    localStorage: storage,
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
    },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
    dispatchEvent(event) {
      events.push(event.type);
      for (const callback of listeners.get(event.type) || []) callback(event);
    }
  };
  const react = {
    createContext: () => ({ Provider: "provider" }),
    useContext: () => null,
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
      return [hooks[index], (next) => { hooks[index] = typeof next === "function" ? next(hooks[index]) : next; }];
    },
    useEffect(callback) {
      const index = cursor++;
      if (!(index in hooks)) { hooks[index] = true; effects.push(callback); }
    }
  };
  const response = (status, data) => ({
    ok: status >= 200 && status < 300, status, statusText: "Test response",
    headers: { get: () => "application/json" }, text: async () => JSON.stringify(data)
  });
  const apiModule = { exports: {} };
  vm.runInNewContext(apiCode, {
    module: apiModule, exports: apiModule.exports, process: { env: {} }, window, localStorage: storage, Event,
    console: { log() {}, error() {} },
    fetch: async (url, init) => options.fetch ? options.fetch(url, init, response) : response(200, { success: true })
  });
  const router = { push: (route) => routes.push(route) };
  const authModule = { exports: {} };
  vm.runInNewContext(authCode, {
    module: authModule, exports: authModule.exports, window, localStorage: storage, console,
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }) };
      if (name === "next/router") return { useRouter: () => router };
      if (name === "../lib/api") return apiModule.exports;
      throw new Error(`Unexpected dependency: ${name}`);
    }
  });
  const render = () => { cursor = 0; return authModule.exports.AuthProvider({ children: null }).props.value; };
  render();
  effects.splice(0).forEach((effect) => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); });
  const storageEvent = (key, storageArea = storage) => window.dispatchEvent({ type: "storage", key, storageArea });
  return { render, storage, storageEvent, request: apiModule.exports.request, events, routes, listeners,
    cleanup: () => cleanups.forEach((cleanup) => cleanup()) };
}

test("hydration restores the persisted account without changing login persistence", () => {
  const h = harness();
  assert.deepEqual(clone(h.render().user), doctor(1));
  assert.equal(h.render().loading, false);
  assert.equal(h.storage.getItem("city_health_token"), "doctor-one-test-token");
});

test("another tab's login updates dashboard identity to the account used by API requests", async () => {
  let authorization;
  const h = harness({ fetch: async (_url, init, response) => {
    authorization = init.headers.Authorization;
    return response(200, { success: true });
  } });
  h.storage.setItem("city_health_token", "doctor-three-test-token");
  h.storage.setItem("city_health_user", JSON.stringify(doctor(3)));
  h.storageEvent("city_health_user");
  await h.request("/queue");
  assert.equal(h.render().user.id_num, "admin3");
  assert.equal(h.render().user.doctor_name, "Doctor 3");
  assert.equal(authorization, "Bearer doctor-three-test-token");
});

test("another tab's logout removes the current dashboard account", () => {
  const h = harness();
  h.storage.removeItem("city_health_token");
  h.storage.removeItem("city_health_user");
  h.storageEvent("city_health_token");
  assert.equal(h.render().user, null);
  assert.equal(h.render().loading, false);
});

test("clearing shared storage clears the dashboard account", () => {
  const h = harness();
  h.storage.clear();
  h.storageEvent(null);
  assert.equal(h.render().user, null);
});

test("unrelated settings and session-storage events do not replace the dashboard account", () => {
  const h = harness();
  h.storage.setItem("city_health_user", JSON.stringify(doctor(3)));
  h.storageEvent("city_health_queue_settings");
  h.storageEvent("city_health_user", {});
  assert.equal(h.render().user.id_num, "admin1");
});

for (const [status, message] of [[403, "Invalid or expired token"], [401, "Authentication required"]]) {
  test(`${status} authentication failure clears the matching token and current dashboard account`, async () => {
    const h = harness({ fetch: async (_url, _init, response) => response(status, { success: false, message }) });
    const result = await h.request("/queue");
    assert.equal(result.error, message);
    assert.equal(h.storage.getItem("city_health_token"), null);
    assert.equal(h.storage.getItem("city_health_user"), null);
    assert.equal(h.render().user, null);
    assert.deepEqual(h.events, ["city-health-auth-session-changed"]);
  });
}

for (const message of ["Unauthorized access", "Only the assigned doctor can start this consultation."]) {
  test(`permission denial keeps a valid session: ${message}`, async () => {
    const h = harness({ fetch: async (_url, _init, response) => response(403, { success: false, message }) });
    assert.equal((await h.request("/queue/start")).error, message);
    assert.equal(h.storage.getItem("city_health_token"), "doctor-one-test-token");
    assert.equal(h.render().user.id_num, "admin1");
    assert.deepEqual(h.events, []);
  });
}

test("failed login does not clear an existing valid account", async () => {
  const h = harness({ fetch: async (_url, _init, response) => response(401, { success: false, message: "Invalid credentials" }) });
  assert.equal((await h.render().login("admin3", "test-password")).success, false);
  assert.equal(h.storage.getItem("city_health_token"), "doctor-one-test-token");
  assert.equal(h.render().user.id_num, "admin1");
});

test("a delayed failure from an older token cannot sign out a new account", async () => {
  let finish;
  const h = harness({ fetch: (_url, _init, response) => new Promise((resolve) => {
    finish = () => resolve(response(403, { success: false, message: "Invalid or expired token" }));
  }) });
  const pending = h.request("/queue");
  h.storage.setItem("city_health_token", "doctor-three-test-token");
  h.storage.setItem("city_health_user", JSON.stringify(doctor(3)));
  h.storageEvent("city_health_user");
  finish();
  await pending;
  assert.equal(h.storage.getItem("city_health_token"), "doctor-three-test-token");
  assert.equal(h.render().user.id_num, "admin3");
  assert.deepEqual(h.events, ["storage"]);
});

test("a normal login persists and displays the returned account", async () => {
  const h = harness({ fetch: async (_url, _init, response) => response(200, {
    success: true, token: "doctor-three-test-token", user: doctor(3)
  }) });
  assert.equal((await h.render().login("admin3", "test-password")).success, true);
  assert.equal(h.render().user.id_num, "admin3");
  assert.equal(h.storage.getItem("city_health_token"), "doctor-three-test-token");
  assert.deepEqual(JSON.parse(h.storage.getItem("city_health_user")), doctor(3));
  assert.deepEqual(h.routes, ["/admin3"]);
});

test("corrupt persisted profile data clears both credentials during hydration", () => {
  const h = harness({ user: "invalid saved user" });
  assert.equal(h.render().user, null);
  assert.equal(h.storage.getItem("city_health_token"), null);
  assert.equal(h.storage.getItem("city_health_user"), null);
});

test("unmount removes the authentication listeners", () => {
  const h = harness();
  assert.equal(h.listeners.get("storage")?.size, 1);
  assert.equal(h.listeners.get("city-health-auth-session-changed")?.size, 1);
  h.cleanup();
  assert.equal(h.listeners.get("storage").size, 0);
  assert.equal(h.listeners.get("city-health-auth-session-changed").size, 0);
});
