import { getSettingRaw, setSettingRaw } from "./db";

export const DEFAULT_HOTKEY = "CommandOrControl+Shift+Space";

export type GoogleCalendarPhoneMode = "off" | "picked_times" | "interval";

export const GOOGLE_CALENDAR_PHONE_LABELS: Record<GoogleCalendarPhoneMode, string> = {
  off: "Off",
  picked_times: "At chosen times",
  interval: "Every X hours (same as desktop interval)",
};

export type NudgeInterval = "never" | "1" | "2" | "4" | "custom" | "daily" | "twice_daily" | "picked_times";

export const NUDGE_INTERVAL_LABELS: Record<NudgeInterval, string> = {
  never: "Never",
  "1": "Every hour",
  "2": "Every 2 hours",
  "4": "Every 4 hours",
  custom: "Every X hours/minutes (custom)",
  daily: "Once daily (morning)",
  twice_daily: "Twice daily (morning & 6 PM)",
  picked_times: "At chosen times each day",
};

// Dev default for the on-device Whisper model. For distribution this should be
// replaced by a bundled resource path resolved at runtime.
export const DEFAULT_MODEL_PATH =
  "C:\\Users\\kriis\\OneDrive\\Desktop\\MemRemem\\tangent\\models\\ggml-small.en.bin";

/** Best → good fallback order when resolving a local Whisper model. */
export const WHISPER_MODEL_CANDIDATES = [
  "ggml-medium.en.bin",
  "ggml-small.en.bin",
  "ggml-base.en.bin",
  "ggml-tiny.en.bin",
] as const;

export interface AppSettings {
  hotkey: string;
  voiceEnabled: boolean;
  modelPath: string;
  faithfulMode: boolean;
  contextEnabled: boolean;
  blocklist: string; // newline-separated app-name fragments
  resurfaceHour: number;
  nudgeInterval: NudgeInterval;
  /** Used when nudgeInterval is "custom" (0–24 hours). */
  nudgeCustomHours: number;
  /** Used when nudgeInterval is "custom" (0–59 minutes). */
  nudgeCustomMinutes: number;
  /** Local hours (0–23) when desktop/calendar check-ins are silenced. */
  nudgeQuietStartHour: number;
  nudgeQuietEndHour: number;
  /**
   * Chosen check-in times as "HH:mm" (24h). Used for phone calendar sync and when
   * nudgeInterval is "picked_times".
   */
  checkInTimes: string[];
  liteMode: boolean;
  deleteAudioAfter: boolean;
  cleanupTier: "off" | "local" | "cloud";
  localEndpoint: string;
  localModel: string;
  byokProvider: "openai" | "anthropic";
  byokKey: string;
  lastNudgeAt?: string;
  lastNudgeSlot?: string;
  lastNudge?: string;
  googleEmail?: string;
  googleTokens?: {
    accessToken: string;
    refreshToken?: string;
    expiresAt: number;
  };
  /** Add popup reminders on Google Calendar events (uses triage reminder interval). */
  googleCalendarReminders?: boolean;
  /** Phone check-in reminders via separate Google calendar. */
  googleCalendarPhoneMode?: GoogleCalendarPhoneMode;
  /** @deprecated use googleCalendarPhoneMode */
  googleCalendarTriageSync?: boolean;
  googleCheckInEventId?: string;
  /** One recurring series per chosen check-in time. */
  googleCheckInEventIds?: string[];
  googleCheckInCalendarId?: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  hotkey: DEFAULT_HOTKEY,
  voiceEnabled: true,
  modelPath: DEFAULT_MODEL_PATH,
  faithfulMode: false,
  contextEnabled: true,
  blocklist: "",
  resurfaceHour: 9,
  nudgeInterval: "2",
  nudgeCustomHours: 3,
  nudgeCustomMinutes: 0,
  nudgeQuietStartHour: 0,
  nudgeQuietEndHour: 6,
  checkInTimes: ["10:00", "18:00"],
  liteMode: false,
  deleteAudioAfter: true,
  cleanupTier: "off",
  localEndpoint: "http://localhost:11434/api/generate",
  localModel: "qwen2.5:1.5b",
  byokProvider: "openai",
  byokKey: "",
  googleCalendarReminders: true,
  googleCalendarPhoneMode: "off",
};

export async function loadSettings(): Promise<AppSettings> {
  const raw = await getSettingRaw("app");
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const merged = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    if (!merged.modelPath) merged.modelPath = DEFAULT_MODEL_PATH;
    if (merged.voiceEnabled === undefined) {
      merged.voiceEnabled = DEFAULT_SETTINGS.voiceEnabled;
    }
    if (!merged.nudgeInterval) merged.nudgeInterval = DEFAULT_SETTINGS.nudgeInterval;
    if (merged.nudgeCustomHours === undefined || merged.nudgeCustomHours < 0) {
      merged.nudgeCustomHours = DEFAULT_SETTINGS.nudgeCustomHours;
    }
    if (merged.nudgeCustomMinutes === undefined || merged.nudgeCustomMinutes < 0) {
      merged.nudgeCustomMinutes = DEFAULT_SETTINGS.nudgeCustomMinutes;
    }
    merged.nudgeCustomHours = Math.min(24, Math.max(0, merged.nudgeCustomHours));
    merged.nudgeCustomMinutes = Math.min(59, Math.max(0, merged.nudgeCustomMinutes));
    if (merged.googleCalendarReminders === undefined) {
      merged.googleCalendarReminders = DEFAULT_SETTINGS.googleCalendarReminders;
    }
    if (!merged.googleCalendarPhoneMode) {
      merged.googleCalendarPhoneMode = merged.googleCalendarTriageSync
        ? "picked_times"
        : "off";
    }
    if (merged.nudgeQuietStartHour === undefined) {
      merged.nudgeQuietStartHour = DEFAULT_SETTINGS.nudgeQuietStartHour;
    }
    if (merged.nudgeQuietEndHour === undefined) {
      merged.nudgeQuietEndHour = DEFAULT_SETTINGS.nudgeQuietEndHour;
    }
    if (!Array.isArray(merged.checkInTimes) || merged.checkInTimes.length === 0) {
      merged.checkInTimes = [...DEFAULT_SETTINGS.checkInTimes];
    }
    if (!Array.isArray(merged.googleCheckInEventIds) && merged.googleCheckInEventId) {
      merged.googleCheckInEventIds = [merged.googleCheckInEventId];
    }
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(s: AppSettings): Promise<void> {
  await setSettingRaw("app", JSON.stringify(s));
}

export async function getSettingNumber(_key: "resurfaceHour", fallback: number): Promise<number> {
  const s = await loadSettings();
  const v = s[_key];
  return typeof v === "number" && !Number.isNaN(v) ? v : fallback;
}

/**
 * Popup reminder offsets (minutes before event) for Google Calendar, derived from
 * triage reminder cadence. Google Calendar uses "before event" alerts, not repeating nudges.
 */
/**
 * Desktop / phone interval length in minutes for preset and custom cadences.
 * Custom allows hours + minutes (e.g. 3 hr 30 min). Minimum 1 minute.
 */
export function nudgeIntervalMinutes(s: AppSettings): number {
  switch (s.nudgeInterval) {
    case "1":
      return 60;
    case "2":
      return 120;
    case "4":
      return 240;
    case "custom": {
      const total = s.nudgeCustomHours * 60 + s.nudgeCustomMinutes;
      return Math.max(1, Math.min(24 * 60, total));
    }
    default:
      return Math.max(
        1,
        Math.min(24 * 60, (s.nudgeCustomHours || 3) * 60 + (s.nudgeCustomMinutes ?? 0)),
      );
  }
}

/** Human-readable interval for Settings UI. */
export function formatNudgeIntervalLabel(s: AppSettings): string {
  if (s.nudgeInterval === "custom") {
    const mins = nudgeIntervalMinutes(s);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h === 0) return `${m} min`;
    if (m === 0) return `${h} hr`;
    return `${h} hr ${m} min`;
  }
  if (s.nudgeInterval === "1" || s.nudgeInterval === "2" || s.nudgeInterval === "4") {
    return `${s.nudgeInterval} hr`;
  }
  return formatNudgeIntervalLabel({ ...s, nudgeInterval: "custom" });
}

export function calendarReminderMinutesFromSettings(s: AppSettings): number[] {
  if (!s.googleCalendarReminders) return [];

  switch (s.nudgeInterval) {
    case "never":
      return [30];
    case "1":
      return [60];
    case "2":
      return [120];
    case "4":
      return [240];
    case "custom":
      return [nudgeIntervalMinutes(s)];
    case "daily":
      return [24 * 60];
    case "twice_daily":
      return [12 * 60, 30];
    default:
      return [120];
  }
}

/** Human-readable summary for Settings UI. */
export function calendarReminderLabel(s: AppSettings): string {
  if (!s.googleCalendarReminders) return "Off";
  const mins = calendarReminderMinutesFromSettings(s);
  const parts = mins.map((m) => {
    if (m >= 24 * 60 && m % (24 * 60) === 0) return `${m / (24 * 60)} day${m / (24 * 60) > 1 ? "s" : ""} before`;
    if (m >= 60 && m % 60 === 0) return `${m / 60} hr before`;
    return `${m} min before`;
  });
  return parts.join(" + ");
}

/** True when local time falls inside quiet hours (e.g. midnight–6 AM). */
export function inQuietHours(s: AppSettings, now = new Date()): boolean {
  const start = s.nudgeQuietStartHour ?? 0;
  const end = s.nudgeQuietEndHour ?? 6;
  if (start === end) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  const startM = start * 60;
  const endM = end * 60;
  if (startM < endM) return mins >= startM && mins < endM;
  return mins >= startM || mins < endM;
}

/** Valid chosen times as stored (no quiet-hour filtering). */
export function chosenCheckInTimes(s: AppSettings): string[] {
  return [...new Set((s.checkInTimes ?? []).map((t) => t.trim()).filter(Boolean))]
    .filter((t) => parseCheckInTime(t) !== null)
    .sort();
}

/** True when desktop popups should use the chosen check-in times list. */
export function desktopUsesChosenTimes(s: AppSettings): boolean {
  return s.nudgeInterval === "picked_times";
}

/** True when phone calendar should use the chosen check-in times list. */
export function phoneUsesChosenTimes(s: AppSettings): boolean {
  return (s.googleCalendarPhoneMode ?? "off") === "picked_times";
}

/** Parse "HH:mm" → { hour, minute } or null. */
export function parseCheckInTime(t: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** Times every X hours/minutes from desktop interval, excluding quiet hours. */
export function intervalCheckInTimes(s: AppSettings): string[] {
  const stepMins = nudgeIntervalMinutes(s);
  const times: string[] = [];
  for (let mins = 0; mins < 24 * 60; mins += stepMins) {
    const hour = Math.floor(mins / 60);
    const minute = mins % 60;
    const probe = new Date();
    probe.setHours(hour, minute, 0, 0);
    if (!inQuietHours(s, probe)) {
      times.push(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
    }
  }
  return times;
}

/** Active phone check-in slots for the current mode. */
export function phoneCheckInTimes(s: AppSettings): string[] {
  const mode = s.googleCalendarPhoneMode ?? "off";
  if (mode === "off") return [];
  if (mode === "interval") return intervalCheckInTimes(s);
  return chosenCheckInTimes(s);
}

/** Check-in times excluding quiet hours, sorted. */
export function activeCheckInTimes(s: AppSettings): string[] {
  const unique = [...new Set((s.checkInTimes ?? []).map((t) => t.trim()).filter(Boolean))];
  return unique
    .filter((t) => {
      const p = parseCheckInTime(t);
      if (!p) return false;
      const probe = new Date();
      probe.setHours(p.hour, p.minute, 0, 0);
      return !inQuietHours(s, probe);
    })
    .sort();
}

export function formatCheckInTimesLabel(times: string[]): string {
  if (times.length === 0) return "none";
  return times
    .map((t) => {
      const p = parseCheckInTime(t);
      if (!p) return t;
      const d = new Date();
      d.setHours(p.hour, p.minute, 0, 0);
      return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    })
    .join(", ");
}

/** True if the given active-window app/title should NOT have its context stored. */
export function isBlocked(s: AppSettings, app: string | null, title: string | null): boolean {
  if (!s.contextEnabled) return true;
  const list = s.blocklist
    .split(/\r?\n/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) return false;
  const hay = `${app ?? ""} ${title ?? ""}`.toLowerCase();
  return list.some((frag) => hay.includes(frag));
}
