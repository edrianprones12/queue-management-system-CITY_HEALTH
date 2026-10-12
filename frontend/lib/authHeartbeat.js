export const AUTH_HEARTBEAT_INTERVAL_MS = 25000;
export const AUTH_HEARTBEAT_TIMEOUT_MS = 10000;

// Tabs may share one JWT. The server throttles shared-session writes; closing a
// tab only stops this timer and must never revoke another tab's session.
export function startAuthHeartbeat({ request, storage, eventTarget, visibilityTarget, timers }) {
  let stopped = false;
  const pending = new Map();
  const pulse = async () => {
    const token = storage.getItem("city_health_token");
    if (stopped || !token || pending.has(token)) return;
    const controller = new AbortController();
    pending.set(token, controller);
    const timeout = timers.setTimeout(() => controller.abort(), AUTH_HEARTBEAT_TIMEOUT_MS);
    try {
      await request("/auth/heartbeat", {
        method: "POST", body: "{}", authToken: token, signal: controller.signal
      });
    } catch (_error) {
      // Transport failures do not revoke a valid login. Retry on the next timer
      // or reconnect; the server independently ages presence out after 75s.
    } finally {
      timers.clearTimeout(timeout);
      pending.delete(token);
    }
  };
  const onVisible = () => {
    if (visibilityTarget.visibilityState === "visible") pulse();
  };
  const timer = timers.setInterval(pulse, AUTH_HEARTBEAT_INTERVAL_MS);
  for (const name of ["online", "focus", "pageshow"]) eventTarget.addEventListener(name, pulse);
  visibilityTarget.addEventListener("visibilitychange", onVisible);
  return {
    pulse,
    stop() {
      stopped = true;
      for (const controller of pending.values()) controller.abort();
      timers.clearInterval(timer);
      for (const name of ["online", "focus", "pageshow"]) eventTarget.removeEventListener(name, pulse);
      visibilityTarget.removeEventListener("visibilitychange", onVisible);
    }
  };
}
