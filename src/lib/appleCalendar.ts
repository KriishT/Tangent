import { invoke } from "@tauri-apps/api/core";
import type { Thought } from "./types";
import { loadSettings, saveSettings, calendarReminderMinutesFromSettings, type AppSettings } from "./settings";
import { setAppleEventId } from "./db";
import { buildCheckInSlots } from "./calendarSlots";

export async function isAppleCalendarConnected(s?: AppSettings): Promise<boolean> {
  const settings = s ?? (await loadSettings());
  return Boolean(settings.appleCalendarEnabled);
}

export async function connectAppleCalendar(): Promise<AppSettings> {
  await invoke("apple_calendar_connect");
  const s = await loadSettings();
  const next = { ...s, appleCalendarEnabled: true };
  await saveSettings(next);
  return next;
}

export async function disconnectAppleCalendar(): Promise<AppSettings> {
  const s = await loadSettings();
  if (s.appleCheckInEventIds?.length) {
    try {
      await invoke("apple_calendar_sync_checkin", {
        params: { enabled: false, existingEventIds: s.appleCheckInEventIds, slots: [] },
      });
    } catch {
      /* best-effort */
    }
  }
  const next = {
    ...s,
    appleCalendarEnabled: false,
    appleCheckInEventIds: undefined,
  };
  await saveSettings(next);
  return next;
}

function payloadForThought(thought: Thought) {
  if (!thought.due_at) return null;
  const start = new Date(thought.due_at);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const local = (d: Date) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const context = [thought.ctx_app, thought.ctx_detail].filter(Boolean).join(" · ");
  return {
    summary: thought.body.slice(0, 120),
    description: context ? `Tangent\n\nContext: ${context}` : "Tangent",
    startLocal: local(start),
    endLocal: local(end),
  };
}

export async function upsertAppleEvent(thought: Thought): Promise<void> {
  const payload = payloadForThought(thought);
  if (!payload) return;
  const s = await loadSettings();
  if (!s.appleCalendarEnabled) return;
  const eventId = await invoke<string>("apple_calendar_upsert_event", {
    params: {
      ...payload,
      reminderMinutes: calendarReminderMinutesFromSettings(s),
      existingEventId: thought.apple_event_id ?? null,
    },
  });
  await setAppleEventId(thought.id, eventId);
}

export async function deleteAppleEvent(thought: Thought): Promise<void> {
  if (!thought.apple_event_id) return;
  try {
    await invoke("apple_calendar_delete_event", { eventId: thought.apple_event_id });
  } catch {
    /* best-effort */
  }
  await setAppleEventId(thought.id, null);
}

export async function syncAppleCheckIn(s: AppSettings): Promise<AppSettings> {
  if (!s.appleCalendarEnabled) return s;
  const mode = s.googleCalendarPhoneMode ?? "off";
  const slots = mode !== "off" ? buildCheckInSlots(s) : [];
  const eventIds = await invoke<string[]>("apple_calendar_sync_checkin", {
    params: {
      enabled: slots.length > 0,
      existingEventIds: s.appleCheckInEventIds ?? [],
      slots,
    },
  });
  const next = { ...s, appleCheckInEventIds: eventIds };
  await saveSettings(next);
  return next;
}
