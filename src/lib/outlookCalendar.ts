import { invoke } from "@tauri-apps/api/core";
import type { Thought } from "./types";
import {
  loadSettings,
  saveSettings,
  calendarReminderMinutesFromSettings,
  type AppSettings,
} from "./settings";
import { setOutlookEventId } from "./db";
import { buildCheckInSlots } from "./calendarSlots";
import { MICROSOFT_OAUTH_CLIENT_ID, isOutlookOAuthConfigured } from "./outlookOAuthConfig";

export { isOutlookOAuthConfigured };

export type OutlookTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
};

export async function isOutlookConnected(s?: AppSettings): Promise<boolean> {
  const settings = s ?? (await loadSettings());
  return Boolean(settings.outlookTokens?.refreshToken);
}

export async function connectOutlook(): Promise<AppSettings> {
  if (!isOutlookOAuthConfigured()) {
    throw new Error("Outlook is not configured in this build");
  }
  const result = await invoke<{ email: string; tokens: OutlookTokens }>("outlook_oauth_connect", {
    clientId: MICROSOFT_OAUTH_CLIENT_ID,
  });
  const s = await loadSettings();
  const next = {
    ...s,
    outlookEmail: result.email,
    outlookTokens: result.tokens,
  };
  await saveSettings(next);
  return next;
}

export async function disconnectOutlook(): Promise<AppSettings> {
  const s = await loadSettings();
  const next = {
    ...s,
    outlookEmail: undefined,
    outlookTokens: undefined,
    outlookCalendarId: undefined,
    outlookCheckInEventIds: undefined,
  };
  await saveSettings(next);
  return next;
}

function localTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz === "Asia/Calcutta" ? "Asia/Kolkata" : tz;
  } catch {
    return "UTC";
  }
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
    timezone: localTimezone(),
  };
}

export async function upsertOutlookEvent(thought: Thought): Promise<void> {
  const payload = payloadForThought(thought);
  if (!payload) return;
  const s = await loadSettings();
  if (!s.outlookTokens?.refreshToken) return;
  if (thought.outlook_event_id) {
    try {
      const del = await invoke<{ tokens: OutlookTokens }>("outlook_calendar_delete_event", {
        params: {
          clientId: MICROSOFT_OAUTH_CLIENT_ID,
          tokens: s.outlookTokens,
          eventId: thought.outlook_event_id,
          calendarId: s.outlookCalendarId ?? null,
        },
      });
      await saveSettings({ ...s, outlookTokens: del.tokens });
    } catch {
      /* replace anyway */
    }
  }
  const latest = await loadSettings();
  const result = await invoke<{
    eventId?: string | null;
    calendarId?: string | null;
    tokens: OutlookTokens;
  }>("outlook_calendar_create_event", {
    params: {
      clientId: MICROSOFT_OAUTH_CLIENT_ID,
      tokens: latest.outlookTokens,
      reminderMinutes: calendarReminderMinutesFromSettings(latest),
      calendarId: latest.outlookCalendarId ?? null,
      ...payload,
    },
  });
  await saveSettings({
    ...latest,
    outlookTokens: result.tokens,
    outlookCalendarId: result.calendarId ?? latest.outlookCalendarId,
  });
  await setOutlookEventId(thought.id, result.eventId ?? null);
}

export async function deleteOutlookEvent(thought: Thought): Promise<void> {
  if (!thought.outlook_event_id) return;
  const s = await loadSettings();
  if (s.outlookTokens?.refreshToken) {
    try {
      const result = await invoke<{ tokens: OutlookTokens }>("outlook_calendar_delete_event", {
        params: {
          clientId: MICROSOFT_OAUTH_CLIENT_ID,
          tokens: s.outlookTokens,
          eventId: thought.outlook_event_id,
          calendarId: s.outlookCalendarId ?? null,
        },
      });
      await saveSettings({ ...s, outlookTokens: result.tokens });
    } catch {
      /* best-effort */
    }
  }
  await setOutlookEventId(thought.id, null);
}

export async function syncOutlookCheckIn(s: AppSettings): Promise<AppSettings> {
  if (!s.outlookTokens?.refreshToken || !isOutlookOAuthConfigured()) return s;
  const mode = s.googleCalendarPhoneMode ?? "off";
  const slots = mode !== "off" ? buildCheckInSlots(s) : [];
  const result = await invoke<{
    eventIds: string[];
    calendarId?: string | null;
    tokens: OutlookTokens;
  }>("outlook_calendar_sync_checkin", {
    params: {
      clientId: MICROSOFT_OAUTH_CLIENT_ID,
      tokens: s.outlookTokens,
      enabled: slots.length > 0,
      existingEventIds: s.outlookCheckInEventIds ?? [],
      checkInSlots: slots,
      timezone: localTimezone(),
      calendarId: s.outlookCalendarId ?? null,
    },
  });
  const next = {
    ...s,
    outlookTokens: result.tokens,
    outlookCalendarId: result.calendarId ?? s.outlookCalendarId,
    outlookCheckInEventIds: result.eventIds,
  };
  await saveSettings(next);
  return next;
}
