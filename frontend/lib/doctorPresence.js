export const DOCTOR_NAMES = ["Doctor 1", "Doctor 2", "Doctor 3"];
export const PRESENCE_REFRESH_MS = 5000;
export const PRESENCE_MAX_AGE_MS = 15000;

export function presenceClock() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

// A doctor's session presence is independent of the counter availability flag.
// Expire monitoring snapshots quickly so a stalled request cannot leave a
// previously verified Online or Offline label on the dashboard indefinitely.
export function captureDoctorPresence(data, receivedAt = presenceClock()) {
  const observedAt = Date.parse(data?.observed_at);
  if (data?.success !== true || !Array.isArray(data.doctors) || !Number.isFinite(observedAt) ||
      data.timeout_seconds !== 75) return null;
  const doctors = {};
  for (const entry of data.doctors) {
    if (DOCTOR_NAMES.includes(entry?.doctor_name) && typeof entry.online === "boolean") {
      doctors[entry.doctor_name] = {
        online: entry.online,
        last_seen_at: Number.isFinite(Date.parse(entry.last_seen_at)) ? entry.last_seen_at : null
      };
    }
  }
  return { doctors, receivedAt, observedAt };
}

export function doctorPresenceStatus(snapshot, doctorName, now = presenceClock()) {
  const fresh = snapshot && now >= snapshot.receivedAt &&
    now - snapshot.receivedAt < PRESENCE_MAX_AGE_MS;
  const presence = fresh ? snapshot.doctors[doctorName] : null;
  return {
    label: presence ? (presence.online ? "Online" : "Offline") : "Unknown",
    lastSeenAt: presence?.last_seen_at || null
  };
}
