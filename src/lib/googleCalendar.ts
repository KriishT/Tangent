import { invoke } from "@tauri-apps/api/core";
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
  tokens: GoogleTokens;
}

interface SyncCheckInResult {
  eventId: string | null;
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

/** Build a clean recurring series from user-picked times only (not every-X-hours). */
export function buildCheckInRecurrence(
  s: AppSettings,
): { rrule: string; rrules: string[]; startLocal: string; endLocal: string } | null {
  const times = phoneCheckInTimes(s);
  if (times.length === 0) return null;

  const parsed = times
    .map((t) => ({ t, p: parseCheckInTime(t) }))
    .filter((x): x is { t: string; p: { hour: number; minute: number } } => x.p !== null);

  if (parsed.length === 0) return null;

  const now = new Date();
  let start: Date | null = null;
  for (const { p } of parsed) {
    const candidate = new Date(now);
    candidate.setHours(p.hour, p.minute, 0, 0);
    if (candidate > now && (!start || candidate < start)) start = candidate;
  }
  if (!start) {
    const first = parsed[0]!.p;
    start = new Date(now);
    start.setDate(start.getDate() + 1);
    start.setHours(first.hour, first.minute, 0, 0);
  }

  const byHour = [...new Set(parsed.map(({ p }) => p.hour))].sort((a, b) => a - b);
  const byMinute = [...new Set(parsed.map(({ p }) => p.minute))].sort((a, b) => a - b);
  const pairSet = new Set(parsed.map(({ p }) => `${p.hour}:${p.minute}`));
  const isCartesian =
    byHour.length * byMinute.length === pairSet.size &&
    byHour.every((h) => byMinute.every((m) => pairSet.has(`${h}:${m}`)));

  let recurrence: string[];
  if (isCartesian && byMinute.length === 1 && byMinute[0] === 0) {
    recurrence = [`RRULE:FREQ=DAILY;BYHOUR=${byHour.join(",")};BYMINUTE=0;BYSECOND=0`];
  } else if (isCartesian) {
    recurrence = [
      `RRULE:FREQ=DAILY;BYHOUR=${byHour.join(",")};BYMINUTE=${byMinute.join(",")};BYSECOND=0`,
    ];
  } else {
    recurrence = parsed.map(
      ({ p }) => `RRULE:FREQ=DAILY;BYHOUR=${p.hour};BYMINUTE=${p.minute};BYSECOND=0`,
    );
  }

  const end = new Date(start.getTime() + CHECKIN_DURATION_MS);
  return {
    rrule: recurrence[0]!,
    rrules: recurrence,
    startLocal: toLocalDateTimeString(start),
    endLocal: toLocalDateTimeString(end),
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
    const recurrence = enabled ? buildCheckInRecurrence(base) : null;

    const result = await invoke<SyncCheckInResult>("google_calendar_sync_checkin", {
      params: {
        clientId: GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: GOOGLE_OAUTH_CLIENT_SECRET || null,
        tokens: base.googleTokens,
        enabled: enabled && recurrence !== null,
        existingEventId: base.googleCheckInEventId ?? null,
        checkInCalendarId: base.googleCheckInCalendarId ?? null,
        rrule: recurrence?.rrule ?? null,
        rrules: recurrence?.rrules ?? null,
        startLocal: recurrence?.startLocal ?? null,
        endLocal: recurrence?.endLocal ?? null,
        timezone: localTimezone(),
      },
    });

    return {
      ...base,
      googleTokens: result.tokens,
      googleCheckInEventId: result.eventId ?? undefined,
      googleCheckInCalendarId: result.checkInCalendarId ?? base.googleCheckInCalendarId,
    };
  });
}

async function deleteCheckInEvent(s: AppSettings): Promise<AppSettings> {
  if (!s.googleCheckInEventId || !s.googleTokens?.refreshToken) {
    return { ...s, googleCheckInEventId: undefined };
  }
  const result = await invoke<SyncCheckInResult>("google_calendar_sync_checkin", {
    params: {
      clientId: GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: GOOGLE_OAUTH_CLIENT_SECRET || null,
      tokens: s.googleTokens,
      enabled: false,
      existingEventId: s.googleCheckInEventId,
      checkInCalendarId: s.googleCheckInCalendarId ?? null,
      rrule: null,
      startLocal: null,
      endLocal: null,
      timezone: localTimezone(),
    },
  });
  return {
    ...s,
    googleTokens: result.tokens,
    googleCheckInEventId: undefined,
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
  settings = await deleteCheckInEvent(settings);
  await saveSettings({
    ...settings,
    googleEmail: undefined,
    googleTokens: undefined,
  });
}

export type AddToCalendarOutcome =
  | "created"
  | "opened"
  | "no_due"
  | "not_connected"
  | "failed";

export interface AddToCalendarResult {
  outcome: AddToCalendarOutcome;
  error?: string;
}

export function messageForCalendarOutcome(result: AddToCalendarResult): string {
  switch (result.outcome) {
    case "created":
      return "Added to Google Calendar";
    case "opened":
      return "Opened Google Calendar (connect in Settings for one-click add)";
    case "no_due":
      return "No due time found — try “buy milk at 6 PM” or “tomorrow”";
    case "not_connected":
      return "Connect Google Calendar in Settings first";
    case "failed":
      return result.error ?? "Could not add to Google Calendar";
  }
}

/** Create event via Calendar API. Returns updated tokens on success. */
async function createEventViaApi(thought: Thought): Promise<GoogleTokens> {
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
  return result.tokens;
}

export async function addThoughtToGoogleCalendar(
  thought: Thought,
): Promise<AddToCalendarResult> {
  const payload = eventPayloadForThought(thought);
  if (!payload) return { outcome: "no_due" };

  const connected = await isGoogleCalendarConnected();

  if (connected) {
    try {
      await createEventViaApi(thought);
      return { outcome: "created" };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return { outcome: "failed", error };
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
): Promise<void> {
  if (!thought.due_at) return;
  const connected = await isGoogleCalendarConnected();
  if (!connected) return;
  try {
    await createEventViaApi(thought);
  } catch {
    /* non-blocking */
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
    return { settings: s, error: `Calendar check-in sync failed: ${error}` };
  }
}
