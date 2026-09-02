import * as chrono from "chrono-node";

/** Explicit clock phrases — if present we trust chrono's full datetime. */
const CLOCK_RE =
  /\b(?:\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?|noon|midnight)\b/i;

/** Day-ish words that often lack a clock time. */
const DAY_WORD_RE = /\b(today|tomorrow|tonight|tmrw)\b/i;

export type DueParseResult = {
  /** Fully resolved ISO datetime (has an explicit clock time). */
  dueAt: string | null;
  /**
   * True when the text names a day (today / tonight / Friday / …) but no
   * clock time — a tentative time is still assigned via tentativeDueAt.
   */
  needsTime: boolean;
  /** Local calendar day `YYYY-MM-DD` when needsTime is true. */
  dayLocal: string | null;
  /** Sensible default clock time when needsTime is true (e.g. 8:30 PM). */
  tentativeDueAt: string | null;
};

/** Default evening due time when only a day is mentioned. */
const TENTATIVE_EVENING_HOUR = 20;
const TENTATIVE_EVENING_MINUTE = 30;
const SAME_DAY_MIN_LEAD_MS = 2 * 60 * 60 * 1000;
const SAME_DAY_LATEST_HOUR = 23;
const SAME_DAY_LATEST_MINUTE = 30;

function roundUpToHalfHour(d: Date): Date {
  const out = new Date(d);
  const mins = out.getMinutes();
  const secs = out.getSeconds();
  if (secs > 0 || mins % 30 !== 0) {
    const add = mins % 30 === 0 ? 30 : 30 - (mins % 30);
    out.setMinutes(mins + add, 0, 0);
  }
  return out;
}

/**
 * Pick a safe default time on the given local day — usually 8:30 PM.
 * Same-day captures get at least 2 hours lead time, rounded to the next half hour.
 */
export function defaultTentativeDueTime(dayLocal: string, now = new Date()): string {
  const [y, m, d] = dayLocal.split("-").map(Number);
  let candidate = new Date(
    y!,
    m! - 1,
    d!,
    TENTATIVE_EVENING_HOUR,
    TENTATIVE_EVENING_MINUTE,
    0,
    0,
  );

  if (formatLocalDay(now) === dayLocal) {
    const minimum = new Date(now.getTime() + SAME_DAY_MIN_LEAD_MS);
    if (candidate < minimum) {
      candidate = roundUpToHalfHour(minimum);
    }
    const cap = new Date(y!, m! - 1, d!, SAME_DAY_LATEST_HOUR, SAME_DAY_LATEST_MINUTE, 0, 0);
    if (candidate > cap) candidate = cap;
    if (candidate <= now) {
      candidate = roundUpToHalfHour(new Date(now.getTime() + 30 * 60 * 1000));
      if (candidate > cap) candidate = cap;
    }
  }

  return candidate.toISOString();
}

/** dueAt if explicit, otherwise the tentative default. */
export function resolvedDueAt(info: DueParseResult): string | null {
  return info.dueAt ?? info.tentativeDueAt;
}

export function isTentativeDue(info: DueParseResult): boolean {
  return !info.dueAt && Boolean(info.tentativeDueAt);
}

export function formatDueTimeLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatLocalDay(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function formatDayLabel(dayLocal: string): string {
  const [y, m, d] = dayLocal.split("-").map(Number);
  if (!y || !m || !d) return dayLocal;
  const date = new Date(y, m - 1, d);
  const today = new Date();
  const todayKey = formatLocalDay(today);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (dayLocal === todayKey) return "today";
  if (dayLocal === formatLocalDay(tomorrow)) return "tomorrow";
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * Detects a due date/time. Day-only phrases get a tentative evening time
 * via tentativeDueAt (usually 8:30 PM).
 */
export function parseDueDateInfo(text: string): DueParseResult {
  const results = chrono.parse(text, new Date(), { forwardDate: true });
  if (results.length === 0) {
    return { dueAt: null, needsTime: false, dayLocal: null, tentativeDueAt: null };
  }
  const r = results[0]!;
  const hasAnyDate =
    r.start.isCertain("day") || r.start.isCertain("weekday") || r.start.isCertain("month");
  const hasTime = r.start.isCertain("hour") || r.start.isCertain("minute");
  const hasClockPhrase = CLOCK_RE.test(text);
  const hasDayWord = DAY_WORD_RE.test(text);

  // Explicit clock in the text → use chrono's full datetime.
  if (hasClockPhrase) {
    return {
      dueAt: r.start.date().toISOString(),
      needsTime: false,
      dayLocal: null,
      tentativeDueAt: null,
    };
  }

  // "today" / "tonight" / "tomorrow" (or a bare weekday/date) without a clock → tentative time.
  if (hasDayWord || hasAnyDate) {
    const dayLocal = formatLocalDay(r.start.date());
    return {
      dueAt: null,
      needsTime: true,
      dayLocal,
      tentativeDueAt: defaultTentativeDueTime(dayLocal),
    };
  }

  // Time-only ("6pm") — chrono + forwardDate picks the next occurrence.
  if (hasTime) {
    return {
      dueAt: r.start.date().toISOString(),
      needsTime: false,
      dayLocal: null,
      tentativeDueAt: null,
    };
  }

  return { dueAt: null, needsTime: false, dayLocal: null, tentativeDueAt: null };
}

/**
 * Detects a high-confidence due datetime. Returns null when missing or when
 * only a day was given (use parseDueDateInfo + ask for time instead).
 */
export function parseDueDate(text: string): string | null {
  return parseDueDateInfo(text).dueAt;
}

/** Attach a clock time to a local calendar day. */
export function combineLocalDayAndTime(dayLocal: string, timeText: string): string | null {
  const trimmed = timeText.trim();
  if (!trimmed || !/^\d{4}-\d{2}-\d{2}$/.test(dayLocal)) return null;

  const [y, m, d] = dayLocal.split("-").map(Number);
  const base = new Date(y!, m! - 1, d!, 12, 0, 0, 0);

  // Prefer chrono against that day (handles "7:30 PM", "18:00", "noon").
  const results = chrono.parse(trimmed, base, { forwardDate: false });
  if (results.length > 0) {
    const r = results[0]!;
    if (r.start.isCertain("hour") || r.start.isCertain("minute") || CLOCK_RE.test(trimmed)) {
      const t = r.start.date();
      const out = new Date(y!, m! - 1, d!, t.getHours(), t.getMinutes(), 0, 0);
      return out.toISOString();
    }
  }

  // Fallback: "HH:mm" / "H:mm"
  const m24 = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) {
    const hh = Number(m24[1]);
    const mm = Number(m24[2]);
    if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
      return new Date(y!, m! - 1, d!, hh, mm, 0, 0).toISOString();
    }
  }

  return null;
}

/** Parse a due time from free text (chrono first, then Date.parse). */
export function parseDueInput(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const info = parseDueDateInfo(trimmed);
  // Explicit clock, day-only (tentative 8:30 PM), or time-only — same as capture.
  const resolved = resolvedDueAt(info);
  if (resolved) return resolved;
  const d = new Date(trimmed);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return null;
}

export type DueUrgency = "overdue" | "soon" | "normal";

/** Visual urgency for a due timestamp (overdue / within 24h / later). */
export function dueUrgency(dueAt: string | null | undefined, now = new Date()): DueUrgency | null {
  if (!dueAt) return null;
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) return null;
  const diff = due.getTime() - now.getTime();
  if (diff < 0) return "overdue";
  if (diff <= 24 * 60 * 60 * 1000) return "soon";
  return "normal";
}

export function dueClassName(dueAt: string | null | undefined): string {
  const u = dueUrgency(dueAt);
  if (u === "overdue") return "due due-overdue";
  if (u === "soon") return "due due-soon";
  return "due";
}

/** Stored in ctx_extra — full context for the "more details" panel. */
export interface ContextExtra {
  window_title: string;
  app: string | null;
  process_path: string | null;
  file: string | null;
  workspace: string | null;
  /** Human-readable location, e.g. "MemRemem › src-tauri › src › context.rs" */
  location: string | null;
  segments: string[];
  /** ISO timestamp when the thought was captured (hotkey press / quick add). */
  captured_at?: string;
  /** Locale-formatted capture time for display. */
  captured_at_local?: string;
}

const EDITOR_APPS =
  /^(cursor|visual studio code|code|vscode|vs code|neovim|nvim|sublime text|intellij idea|webstorm|pycharm|android studio|notepad\+\+|zed)$/i;

function splitTitle(title: string): string[] {
  return title
    .split(/\s+[-|—]\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function looksLikePath(segment: string): boolean {
  return (
    segment.includes("/") ||
    segment.includes("\\") ||
    /^[a-zA-Z]:\\/.test(segment) ||
    segment.startsWith("~/")
  );
}

function normalizePathSegments(segment: string): string[] {
  return segment.split(/[/\\]/).filter(Boolean);
}

/**
 * Parse the active window title + app into a short label and rich metadata.
 *
 * Cursor/VS Code titles are usually: "context.rs - MemRemem - Cursor"
 *   -> file=context.rs, workspace=MemRemem, location="MemRemem › context.rs"
 *
 * If the first segment already contains path separators:
 *   "src-tauri/src/context.rs - MemRemem - Cursor"
 *   -> location="MemRemem › src-tauri › src › context.rs"
 */
export function buildContextFields(
  app: string | null,
  title: string | null,
  processPath: string | null = null,
  capturedAt?: Date
): { detail: string | null; extra: ContextExtra | null } {
  if (!title?.trim()) {
    if (!capturedAt && !app) {
      return { detail: app ?? null, extra: null };
    }
    const extra: ContextExtra = {
      window_title: "",
      app,
      process_path: processPath,
      file: null,
      workspace: null,
      location: null,
      segments: [],
    };
    if (capturedAt) {
      extra.captured_at = capturedAt.toISOString();
      extra.captured_at_local = capturedAt.toLocaleString();
    }
    return { detail: app ?? null, extra };
  }

  const segments = splitTitle(title);
  const appLower = (app ?? "").trim().toLowerCase();

  let file: string | null = null;
  let workspace: string | null = null;
  let location: string | null = null;

  if (segments.length >= 2) {
    const last = segments[segments.length - 1]!.toLowerCase();
    const lastIsApp = EDITOR_APPS.test(last) || last === appLower;

    if (lastIsApp && segments.length >= 2) {
      const doc = segments[0]!;
      if (looksLikePath(doc)) {
        const pathParts = normalizePathSegments(doc);
        file = pathParts[pathParts.length - 1] ?? doc;
        if (segments.length >= 3) {
          workspace = segments[1]!;
          location = [workspace, ...pathParts].join(" › ");
        } else {
          location = pathParts.join(" › ");
        }
      } else {
        file = doc;
        if (segments.length >= 3) {
          workspace = segments[1]!;
          location = `${workspace} › ${file}`;
        } else {
          location = file;
        }
      }
    } else {
      // Generic: "Document - Something" without trailing app name
      file = segments[0]!;
      if (segments.length >= 2) {
        workspace = segments[1]!;
        location = `${workspace} › ${file}`;
      } else {
        location = file;
      }
    }
  } else {
    file = segments[0] ?? title.trim();
    location = looksLikePath(file) ? normalizePathSegments(file).join(" › ") : file;
  }

  const detail = workspace && file ? `${workspace} · ${file}` : file ?? app ?? null;

  const extra: ContextExtra = {
    window_title: title,
    app,
    process_path: processPath,
    file,
    workspace,
    location,
    segments,
  };

  if (capturedAt) {
    extra.captured_at = capturedAt.toISOString();
    extra.captured_at_local = capturedAt.toLocaleString();
  }

  return { detail, extra };
}

/** @deprecated Use buildContextFields — kept for HUD display fallback. */
export function detailFromTitle(app: string | null, title: string | null): string | null {
  return buildContextFields(app, title).detail;
}

export function parseContextExtra(raw: string | null | undefined): ContextExtra | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ContextExtra;
  } catch {
    return null;
  }
}

const ACTION_RE =
  /\b(buy|call|email|send|book|pay|submit|fix|finish|schedule|remind|order|renew|cancel|reply|review|ship|deploy|test|write|read)\b/i;

export function intentHint(text: string): "task" | "note" {
  return ACTION_RE.test(text) ? "task" : "note";
}
