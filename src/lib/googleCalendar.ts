import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Thought } from "./types";
import {
  loadSettings,
  saveSettings,
  calendarReminderMinutesFromSettings,
  phoneCheckInTimes,
  parseCheckInTime,
  type AppSettings,
} from "./settings";
import { googleCalendarUrlForThought } from "./calendar";
import { parseDueInput } from "./parse";
import { setCalendarEventId, setDueAt, listWithCalendarEvents, wipeAll, deleteThought } from "./db";
import {
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET,
  isGoogleOAuthConfigured,
} from "./googleOAuthConfig";

const CHECKIN_DURATION_MS = 1 * 60 * 1000;

let checkInSyncChain: Promise<unknown> = Promise.resolve();

function withCheckInSyncLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = checkInSyncChain.then(fn, fn);
  checkInSyncChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function normalizeTimezone(tz: string): string {
  return tz === "Asia/Calcutta" ? "Asia/Kolkata" : tz;
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export interface GoogleOAuthResult {
  email: string;
  tokens: GoogleTokens;
}

interface CreateEventResult {
  htmlLink: string;
  eventId?: string | null;
  tokens: GoogleTokens;
}

interface DeleteEventResult {
  tokens: GoogleTokens;
}

interface SyncCheckInResult {
  eventId: string | null;
  eventIds: string[] | null;
  checkInCalendarId: string | null;
  tokens: GoogleTokens;
}

function localTimezone(): string {
  try {
    return normalizeTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return "UTC";
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Format a Date as local `YYYY-MM-DDTHH:mm:ss` for Google Calendar API. */
function toLocalDateTimeString(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** One Google Calendar series per chosen check-in time (reliable alerts). */
export function buildCheckInSlots(
  s: AppSettings,
): { startLocal: string; endLocal: string }[] {
  const times = phoneCheckInTimes(s);
  if (times.length === 0) return [];

  const now = new Date();
  const slots: { startLocal: string; endLocal: string }[] = [];

  for (const t of times) {
    const p = parseCheckInTime(t);
    if (!p) continue;
    const start = new Date(now);
    start.setHours(p.hour, p.minute, 0, 0);
    if (start <= now) {
      start.setDate(start.getDate() + 1);
    }
    const end = new Date(start.getTime() + CHECKIN_DURATION_MS);
    slots.push({
      startLocal: toLocalDateTimeString(start),
      endLocal: toLocalDateTimeString(end),
    });
  }

  return slots;
}

/** @deprecated use buildCheckInSlots */
export function buildCheckInRecurrence(
  s: AppSettings,
): { rrule: string; rrules: string[]; startLocal: string; endLocal: string } | null {
  const slots = buildCheckInSlots(s);
  if (slots.length === 0) return null;
  const first = slots[0]!;
  return {
    rrule: "RRULE:FREQ=DAILY",
    rrules: slots.map(() => "RRULE:FREQ=DAILY"),
    startLocal: first.startLocal,
    endLocal: first.endLocal,
  };
}

/** Sync recurring "Check Tangent" calendar event (phone + calendar apps). */
export async function syncGoogleCalendarCheckIn(s: AppSettings): Promise<AppSettings> {
  return withCheckInSyncLock(async () => {
    const latest = await loadSettings();
    const base = { ...latest, ...s };

    if (!isGoogleOAuthConfigured() || !base.googleTokens?.refreshToken) {
      return base;
    }

    const mode = base.googleCalendarPhoneMode ?? "off";
    const enabled = mode !== "off";
    const slots = enabled ? buildCheckInSlots(base) : [];

    const result = await invoke<SyncCheckInResult>("google_calendar_sync_checkin", {
      params: {
        clientId: GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: GOOGLE_OAUTH_CLIENT_SECRET || null,
        tokens: base.googleTokens,
        enabled: enabled && slots.length > 0,
        existingEventId: base.googleCheckInEventId ?? null,
        existingEventIds: base.googleCheckInEventIds ?? null,
        checkInCalendarId: base.googleCheckInCalendarId ?? null,
        checkInSlots: slots,
        timezone: localTimezone(),
      },
    });

    return {
      ...base,
      googleTokens: result.tokens,
      googleCheckInEventIds: result.eventIds ?? undefined,
      googleCheckInEventId: result.eventIds?.[0] ?? result.eventId ?? undefined,
      googleCheckInCalendarId: result.checkInCalendarId ?? base.googleCheckInCalendarId,
    };
  });
}

async function deleteCheckInEvent(s: AppSettings): Promise<AppSettings> {
  const ids = s.googleCheckInEventIds?.length
    ? s.googleCheckInEventIds
    : s.googleCheckInEventId
      ? [s.googleCheckInEventId]
      : [];
  if (ids.length === 0 || !s.googleTokens?.refreshToken) {
    return { ...s, googleCheckInEventId: undefined, googleCheckInEventIds: undefined };
  }
  const result = await invoke<SyncCheckInResult>("google_calendar_sync_checkin", {
    params: {
      clientId: GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: GOOGLE_OAUTH_CLIENT_SECRET || null,
      tokens: s.googleTokens,
      enabled: false,
      existingEventId: s.googleCheckInEventId ?? null,
      existingEventIds: ids,
      checkInCalendarId: s.googleCheckInCalendarId ?? null,
      checkInSlots: [],
      timezone: localTimezone(),
    },
  });
  return {
    ...s,
    googleTokens: result.tokens,
    googleCheckInEventId: undefined,
    googleCheckInEventIds: undefined,
  };
}

function eventPayloadForThought(thought: Thought): {
  summary: string;
  description: string;
  startLocal: string;
  endLocal: string;
  timezone: string;
} | null {
  if (!thought.due_at) return null;
  const start = new Date(thought.due_at);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const context =
    thought.ctx_app || thought.ctx_detail
      ? [thought.ctx_app, thought.ctx_detail].filter(Boolean).join(" · ")
      : "";
  const description = context
    ? `Tangent\n\nContext: ${context}`
    : "Tangent";

  return {
    summary: thought.body.slice(0, 120),
    description,
    startLocal: toLocalDateTimeString(start),
    endLocal: toLocalDateTimeString(end),
    timezone: localTimezone(),
  };
}

export { isGoogleOAuthConfigured };

export function isGoogleCalendarConnected(): Promise<boolean> {
  if (!isGoogleOAuthConfigured()) return Promise.resolve(false);
  return loadSettings().then((s) => Boolean(s.googleTokens?.refreshToken));
}

export async function connectGoogleCalendar(): Promise<GoogleOAuthResult> {
  if (!isGoogleOAuthConfigured()) {
    throw new Error("Google Calendar is not configured in this build.");
  }
  const result = await invoke<GoogleOAuthResult>("google_oauth_connect", {
    clientId: GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: GOOGLE_OAUTH_CLIENT_SECRET || null,
  });
  let settings = await loadSettings();
  settings = {
    ...settings,
    googleEmail: result.email,
    googleTokens: result.tokens,
  };
  if (settings.googleCalendarPhoneMode && settings.googleCalendarPhoneMode !== "off") {
    settings = await syncGoogleCalendarCheckIn(settings);
  }
  await saveSettings(settings);
  return result;
}

export const GOOGLE_DISCONNECTED_MESSAGE =
  "Google Calendar disconnected — session expired. Reconnect in Settings when you're ready.";

export function isGoogleAuthExpiredError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("invalid_grant") ||
    m.includes("token has been expired") ||
    m.includes("token has been revoked")
  );
}

export function formatDueDisplay(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function clearGoogleConnectionState(settings: AppSettings): Promise<AppSettings> {
  const cleared: AppSettings = {
    ...settings,
    googleEmail: undefined,
    googleTokens: undefined,
    googleCheckInEventId: undefined,
    googleCheckInEventIds: undefined,
    googleCheckInCalendarId: undefined,
  };
  await saveSettings(cleared);
  await emit("google-calendar-disconnected", {}).catch(() => {});
  return cleared;
}

async function handleGoogleAuthExpired(): Promise<AddToCalendarResult> {
  const settings = await loadSettings();
  await clearGoogleConnectionState(settings);
  return { outcome: "auth_disconnected", error: GOOGLE_DISCONNECTED_MESSAGE };
}

async function calendarFailureMaybeDisconnect(error: unknown): Promise<AddToCalendarResult> {
  const msg = error instanceof Error ? error.message : String(error);
  if (isGoogleAuthExpiredError(msg)) {
    return handleGoogleAuthExpired();
  }
  return { outcome: "failed", error: msg };
}

export async function disconnectGoogleCalendar(): Promise<void> {
  let settings = await loadSettings();
  if (settings.googleTokens?.refreshToken) {
    try {
      await invoke("google_oauth_revoke", {
        refreshToken: settings.googleTokens.refreshToken,
      });
    } catch {
      /* best-effort */
    }
  }
  try {
    settings = await deleteCheckInEvent(settings);
  } catch {
    settings = await loadSettings();
  }
  await clearGoogleConnectionState(settings);
}

export type AddToCalendarOutcome =
  | "created"
  | "updated"
  | "opened"
  | "no_due"
  | "not_connected"
  | "failed"
  | "cancelled"
  | "bad_due"
  | "cleared"
  | "auth_disconnected";

export interface AddToCalendarResult {
  outcome: AddToCalendarOutcome;
  error?: string;
}

export function messageForCalendarOutcome(result: AddToCalendarResult): string {
  switch (result.outcome) {
    case "created":
      return "Added to Google Calendar";
    case "updated":
      return "Due time saved";
    case "auth_disconnected":
      return result.error ?? GOOGLE_DISCONNECTED_MESSAGE;
    case "cleared":
      return "Due time cleared (calendar reminder removed)";
    case "opened":
      return "Opened Google Calendar (connect in Settings for one-click add)";
    case "no_due":
      return "No due time found — try “buy milk at 6 PM” or “tomorrow 7:30 PM”";
    case "bad_due":
      return "Couldn't understand that time — try “tomorrow 6 PM” or “Friday 3 PM”";
    case "cancelled":
      return "";
    case "not_connected":
      return "Connect Google Calendar in Settings first";
    case "failed":
      return result.error ?? "Could not add to Google Calendar";
  }
}

export type DueTimePrompt = (opts: {
  hasDue: boolean;
  currentDueLabel: string | null;
}) => Promise<string | null>;

/** Set or change a thought's due time; syncs to Google Calendar when connected. */
export async function scheduleThoughtDueTime(
  thought: Thought,
  ask: DueTimePrompt,
): Promise<AddToCalendarResult> {
  const currentDueLabel = thought.due_at ? formatDueDisplay(thought.due_at) : null;
  const when = await ask({ hasDue: Boolean(thought.due_at), currentDueLabel });
  if (when == null) return { outcome: "cancelled" };

  if (thought.due_at) {
    return updateThoughtDueTime(thought, when);
  }

  if (!when.trim()) return { outcome: "cancelled" };
  const due = parseDueInput(when);
  if (!due) return { outcome: "bad_due" };
  await setDueAt(thought.id, due);
  const updated = { ...thought, due_at: due };

  if (await isGoogleCalendarConnected()) {
    return addThoughtToGoogleCalendar(updated);
  }
  return { outcome: "updated" };
}

/** @deprecated use scheduleThoughtDueTime */
export async function addThoughtToGoogleCalendarWithDue(
  thought: Thought,
  askDue: () => Promise<string | null>,
  setDue: (id: number, due: string) => Promise<void>,
): Promise<AddToCalendarResult> {
  let t = thought;
  if (!t.due_at) {
    const when = await askDue();
    if (when == null) return { outcome: "cancelled" };
    if (!when.trim()) return { outcome: "cancelled" };
    const due = parseDueInput(when);
    if (!due) return { outcome: "bad_due" };
    await setDue(t.id, due);
    t = { ...t, due_at: due };
  }
  return addThoughtToGoogleCalendar(t);
}

async function deleteThoughtCalendarEvent(thought: Thought): Promise<void> {
  const eventId = thought.calendar_event_id;
  if (!eventId) return;
  const settings = await loadSettings();
  if (!settings.googleTokens?.refreshToken) {
    await setCalendarEventId(thought.id, null);
    return;
  }
  try {
    const result = await invoke<DeleteEventResult>("google_calendar_delete_event", {
      params: {
        clientId: GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: GOOGLE_OAUTH_CLIENT_SECRET || null,
        tokens: settings.googleTokens,
        eventId,
        calendarId: null,
      },
    });
    await saveSettings({ ...settings, googleTokens: result.tokens });
  } catch {
    /* best-effort — still clear local id */
  }
  await setCalendarEventId(thought.id, null);
}

/** Remove the Google Calendar event linked to a thought (best-effort). */
export async function removeThoughtCalendarEvent(thought: Thought): Promise<void> {
  await deleteThoughtCalendarEvent(thought);
}

/** Delete a thought and its calendar event. */
export async function deleteThoughtWithCalendar(thought: Thought): Promise<void> {
  await deleteThoughtCalendarEvent(thought);
  await deleteThought(thought.id);
}

/** Wipe all thoughts after removing linked calendar events. */
export async function wipeAllThoughtsWithCalendar(): Promise<void> {
  const withEvents = await listWithCalendarEvents();
  for (const t of withEvents) {
    await deleteThoughtCalendarEvent(t);
  }
  await wipeAll();
}

/** Create event via Calendar API. Returns updated tokens + event id on success. */
async function createEventViaApi(
  thought: Thought,
): Promise<{ tokens: GoogleTokens; eventId: string | null }> {
  const payload = eventPayloadForThought(thought);
  if (!payload) throw new Error("No due time on this thought");

  const settings = await loadSettings();
  if (!settings.googleTokens?.accessToken || !settings.googleTokens.refreshToken) {
    throw new Error("Not connected to Google Calendar");
  }

  const result = await invoke<CreateEventResult>("google_calendar_create_event", {
    params: {
      clientId: GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: GOOGLE_OAUTH_CLIENT_SECRET || null,
      tokens: settings.googleTokens,
      reminderMinutes: calendarReminderMinutesFromSettings(settings),
      ...payload,
    },
  });

  await saveSettings({
    ...settings,
    googleTokens: result.tokens,
  });
  const eventId = result.eventId ?? null;
  if (eventId) {
    await setCalendarEventId(thought.id, eventId);
  }
  return { tokens: result.tokens, eventId };
}

export async function addThoughtToGoogleCalendar(
  thought: Thought,
): Promise<AddToCalendarResult> {
  const payload = eventPayloadForThought(thought);
  if (!payload) return { outcome: "no_due" };

  const connected = await isGoogleCalendarConnected();

  if (connected) {
    try {
      // Replace any previous event for this thought (avoid duplicates).
      if (thought.calendar_event_id) {
        await deleteThoughtCalendarEvent(thought);
        thought = { ...thought, calendar_event_id: null };
      }
      await createEventViaApi(thought);
      return { outcome: "created" };
    } catch (e) {
      return calendarFailureMaybeDisconnect(e);
    }
  }

  if (isGoogleOAuthConfigured()) {
    return { outcome: "not_connected" };
  }

  const url = googleCalendarUrlForThought(thought);
  if (!url) return { outcome: "no_due" };
  await openUrl(url);
  return { outcome: "opened" };
}

export async function autoAddThoughtToGoogleCalendarIfConnected(
  thought: Thought,
): Promise<AddToCalendarResult | void> {
  if (!thought.due_at) return;
  const connected = await isGoogleCalendarConnected();
  if (!connected) return;
  try {
    if (thought.calendar_event_id) {
      await deleteThoughtCalendarEvent(thought);
      thought = { ...thought, calendar_event_id: null };
    }
    await createEventViaApi(thought);
    return { outcome: "created" };
  } catch (e) {
    return calendarFailureMaybeDisconnect(e);
  }
}

/**
 * Change a thought's due time. If it already has a Google Calendar reminder,
 * removes the old event and creates a new one at the updated time.
 * Pass null/empty to clear the due time (and remove the calendar reminder).
 */
export async function updateThoughtDueTime(
  thought: Thought,
  dueInput: string | null,
): Promise<AddToCalendarResult> {
  const trimmed = dueInput?.trim() ?? "";
  const hadCalendarEvent = Boolean(thought.calendar_event_id);

  if (!trimmed) {
    await setDueAt(thought.id, null);
    if (hadCalendarEvent) {
      await deleteThoughtCalendarEvent(thought);
    }
    return { outcome: "cleared" };
  }

  const due = parseDueInput(trimmed);
  if (!due) return { outcome: "bad_due" };

  await setDueAt(thought.id, due);
  let updated: Thought = { ...thought, due_at: due };

  if (!hadCalendarEvent) {
    return { outcome: "updated" };
  }

  const connected = await isGoogleCalendarConnected();
  if (!connected) {
    await setCalendarEventId(thought.id, null);
    return { outcome: "updated" };
  }

  try {
    await deleteThoughtCalendarEvent(thought);
    updated = { ...updated, calendar_event_id: null };
    await createEventViaApi(updated);
    return { outcome: "updated" };
  } catch (e) {
    return calendarFailureMaybeDisconnect(e);
  }
}

/** Call after saving settings when triage/calendar options change. */
export async function applyGoogleCalendarSettings(
  s: AppSettings,
): Promise<{ settings: AppSettings; message?: string; error?: string }> {
  if (!isGoogleOAuthConfigured() || !s.googleTokens?.refreshToken) {
    return { settings: s };
  }
  if (!s.googleCalendarPhoneMode || s.googleCalendarPhoneMode === "off") {
    try {
      const cleared = await deleteCheckInEvent(s);
      return { settings: cleared, message: "Calendar check-in reminders removed" };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (isGoogleAuthExpiredError(error)) {
        const cleared = await clearGoogleConnectionState(s);
        return { settings: cleared, error: GOOGLE_DISCONNECTED_MESSAGE };
      }
      return { settings: s, error };
    }
  }
  if (phoneCheckInTimes(s).length === 0) {
    return {
      settings: s,
      error: "No check-in times outside quiet hours — adjust interval or quiet hours",
    };
  }
  try {
    const synced = await syncGoogleCalendarCheckIn(s);
    return {
      settings: synced,
      message: 'Recurring "Check Tangent" synced to Google Calendar',
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (isGoogleAuthExpiredError(error)) {
      const cleared = await clearGoogleConnectionState(s);
      return { settings: cleared, error: GOOGLE_DISCONNECTED_MESSAGE };
    }
    return { settings: s, error: `Calendar check-in sync failed: ${error}` };
  }
}
