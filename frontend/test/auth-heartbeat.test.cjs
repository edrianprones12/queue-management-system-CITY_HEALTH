const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");
let startAuthHeartbeat;
before(async () => {
  await swc.loadBindings();
  const filename = path.resolve(__dirname, "../lib/authHeartbeat.js");
  const { code } = await swc.transform(fs.readFileSync(filename, "utf8"), {
    filename, jsc: { parser: { syntax: "ecmascript" } }, module: { type: "commonjs" }
  });
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, Map, AbortController });
  startAuthHeartbeat = module.exports.startAuthHeartbeat;
});

function harness(request = async () => ({ success: true })) {
  let token = "doctor-session-one";
  const calls = [], intervals = new Map(), timeouts = new Map(), listeners = new Map();
  const target = {
    visibilityState: "visible",
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); }
  };
  const heartbeat = startAuthHeartbeat({
    request: async (route, options) => { calls.push({ route, options }); return request(route, options); },
    storage: { getItem: () => token }, eventTarget: target, visibilityTarget: target,
    timers: {
      setInterval(callback, ms) { intervals.set(1, { callback, ms }); return 1; },
      clearInterval(id) { intervals.delete(id); },
      setTimeout(callback, ms) { timeouts.set(2, { callback, ms }); return 2; },
      clearTimeout(id) { timeouts.delete(id); }
    }
  });
  return { heartbeat, calls, intervals, timeouts, listeners, target, setToken(value) { token = value; } };
}

test("heartbeat sends a captured authenticated session every 25 seconds without browser identity or timestamps", async () => {
  const h = harness();
  assert.equal(h.intervals.get(1).ms, 25000);
  await h.heartbeat.pulse();
  assert.equal(h.calls[0].route, "/auth/heartbeat");
  assert.equal(h.calls[0].options.authToken, "doctor-session-one");
  assert.equal(h.calls[0].options.body, "{}");
  h.setToken("doctor-session-two");
  await h.intervals.get(1).callback();
  assert.equal(h.calls[1].options.authToken, "doctor-session-two");
});

test("network interruption retries on reconnect without logging out, and no token sends nothing", async () => {
  const h = harness(async () => { throw new TypeError("offline"); });
  await h.heartbeat.pulse();
  await h.listeners.get("online")();
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every((call) => call.route === "/auth/heartbeat"));
  h.setToken(null);
  await h.heartbeat.pulse();
  assert.equal(h.calls.length, 2);
});

test("pending heartbeat does not overlap for the same session but permits a changed account", async () => {
  const resolvers = [];
  const h = harness(() => new Promise((resolve) => resolvers.push(resolve)));
  const first = h.heartbeat.pulse();
  await h.heartbeat.pulse();
  assert.equal(h.calls.length, 1);
  h.setToken("doctor-session-two");
  const second = h.heartbeat.pulse();
  assert.equal(h.calls.length, 2);
  resolvers.forEach((resolve) => resolve({ success: true }));
  await Promise.all([first, second]);
});

test("tab closure removes heartbeat listeners and timers without a logout call", async () => {
  const h = harness();
  h.heartbeat.stop();
  assert.equal(h.intervals.size, 0);
  assert.equal(h.listeners.size, 0);
  await h.heartbeat.pulse();
  assert.equal(h.calls.length, 0);
});

test("returning to a suspended visible tab refreshes activity while hiding alone does not revoke", async () => {
  const h = harness();
  h.target.visibilityState = "hidden";
  await h.listeners.get("visibilitychange")();
  assert.equal(h.calls.length, 0);
  h.target.visibilityState = "visible";
  await h.listeners.get("visibilitychange")();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].route, "/auth/heartbeat");
});

test("a stalled heartbeat is aborted after ten seconds and reconnect can retry that session", async () => {
  const h = harness((_route, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("aborted")));
  }));
  const stalled = h.heartbeat.pulse();
  assert.equal(h.timeouts.get(2).ms, 10000);
  h.timeouts.get(2).callback();
  await stalled;
  assert.equal(h.timeouts.size, 0);
  const retry = h.listeners.get("online")();
  assert.equal(h.calls.length, 2);
  h.heartbeat.stop();
  await retry;
  assert.equal(h.calls[1].options.signal.aborted, true);
});
