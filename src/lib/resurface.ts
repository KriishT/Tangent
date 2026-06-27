import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { dueForResurface, markNotified, stats } from "./db";
import {
  activeCheckInTimes,
  inQuietHours,
  loadSettings,
  nudgeIntervalMinutes,
  parseCheckInTime,
  saveSettings,
  type AppSettings,
} from "./settings";

let granted = false;

export async function ensureNotifications(): Promise<boolean> {
  granted = await isPermissionGranted();
  if (!granted) {
    granted = (await requestPermission()) === "granted";
  }
  return granted;
}

/** Fire notifications for items whose due/resurface time has arrived. */
export async function runResurfaceTick(): Promise<void> {
  if (!granted) return;
  const due = await dueForResurface();
  for (const t of due) {
    sendNotification({ title: "Tangent reminder", body: t.body });
    await markNotified(t.id);
  }
}

const EVENING_NUDGE_HOUR = 18;

function isDueForPickedTime(s: AppSettings, now: Date): boolean {
  const times = activeCheckInTimes(s);
  if (times.length === 0) return false;

  const nowM = now.getHours() * 60 + now.getMinutes();
  for (const t of times) {
    const p = parseCheckInTime(t);
    if (!p) continue;
    const slotM = p.hour * 60 + p.minute;
    if (Math.abs(nowM - slotM) > 1) continue;
    const slotKey = `${now.toDateString()}-${t}`;
    if (s.lastNudgeSlot === slotKey) continue;
    return true;
  }
  return false;
}

/** Whether a triage nudge should fire now. */
export function shouldSendTriageNudge(s: AppSettings, now = new Date()): boolean {
  if (s.nudgeInterval === "never") return false;
  if (inQuietHours(s, now)) return false;

  if (s.nudgeInterval === "picked_times") {
    return isDueForPickedTime(s, now);
  }

  const lastAt = s.lastNudgeAt ? new Date(s.lastNudgeAt) : null;

  if (s.nudgeInterval === "daily") {
    if (now.getHours() < s.resurfaceHour) return false;
    const today = now.toDateString();
    if (s.lastNudgeAt) {
      const last = new Date(s.lastNudgeAt);
      if (last.toDateString() === today) return false;
    }
    return true;
  }

  if (s.nudgeInterval === "twice_daily") {
    const hour = now.getHours();
    const inMorning = hour >= s.resurfaceHour && hour < 14;
    const inEvening = hour >= EVENING_NUDGE_HOUR && hour < 22;
    if (!inMorning && !inEvening) return false;
    const slot = `${now.toDateString()}-${inMorning ? "am" : "pm"}`;
    return s.lastNudgeSlot !== slot;
  }

  const intervalMs = nudgeIntervalMinutes(s) * 60 * 1000;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return false;
  if (!lastAt) return true;
  return now.getTime() - lastAt.getTime() >= intervalMs;
}

/** Nudge the user on the triage cadence — always, even with an empty inbox. */
export async function maybeTriageNudge(): Promise<void> {
  if (!granted) return;
  const s = await loadSettings();
  if (!shouldSendTriageNudge(s)) return;

  const st = await stats();
  const body =
    st.parked > 0
      ? `Check Tangent now — ${st.parked} parked thought${st.parked === 1 ? "" : "s"} waiting.`
      : "Check Tangent now.";

  sendNotification({
    title: "Tangent",
    body,
  });

  const now = new Date();
  const patch: Partial<AppSettings> = {
    lastNudgeAt: now.toISOString(),
    lastNudge: now.toDateString(),
  };

  if (s.nudgeInterval === "picked_times") {
    const times = activeCheckInTimes(s);
    const nowM = now.getHours() * 60 + now.getMinutes();
    for (const t of times) {
      const p = parseCheckInTime(t);
      if (!p) continue;
      if (Math.abs(nowM - (p.hour * 60 + p.minute)) <= 1) {
        patch.lastNudgeSlot = `${now.toDateString()}-${t}`;
        break;
      }
    }
  } else if (s.nudgeInterval === "twice_daily") {
    const hour = now.getHours();
    const inMorning = hour >= s.resurfaceHour && hour < 14;
    patch.lastNudgeSlot = `${now.toDateString()}-${inMorning ? "am" : "pm"}`;
  }

  await saveSettings({ ...s, ...patch });
}

/** @deprecated use maybeTriageNudge */
export const maybeDailyNudge = maybeTriageNudge;
