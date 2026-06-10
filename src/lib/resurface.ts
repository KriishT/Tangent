import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { dueForResurface, markNotified, stats } from "./db";
import { loadSettings, saveSettings } from "./settings";

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

/** Once per day, nudge the user to triage if there are parked thoughts. */
export async function maybeDailyNudge(): Promise<void> {
  if (!granted) return;
  const s = await loadSettings();
  const today = new Date().toDateString();
  if (s.lastNudge === today) return;

  const st = await stats();
  if (st.parked > 0) {
    sendNotification({
      title: "Tangent",
      body: `You have ${st.parked} parked thought${st.parked === 1 ? "" : "s"} to triage.`,
    });
  }
  await saveSettings({ ...s, lastNudge: today });
}
