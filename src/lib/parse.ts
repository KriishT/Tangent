import * as chrono from "chrono-node";

/**
 * Detects a high-confidence due date in the text (e.g. "due tomorrow",
 * "by Friday", "in 2 days"). Conservative on purpose: returns null unless
 * chrono is reasonably sure, so we never guess wrong dates.
 */
export function parseDueDate(text: string): string | null {
  const results = chrono.parse(text, new Date(), { forwardDate: true });
  if (results.length === 0) return null;
  const r = results[0];
  // Require a date component; ignore bare times like "5pm" with no day.
  if (!r.start.isCertain("day") && !r.start.isCertain("weekday") && !r.start.isCertain("month")) {
    // Allow "tomorrow"/"today" which chrono marks via implied values.
    const lowered = text.toLowerCase();
    if (!/\b(today|tomorrow|tonight|tmrw)\b/.test(lowered)) return null;
  }
  return r.start.date().toISOString();
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
  const sep = segment.includes("\\") ? "\\" : "/";
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
  processPath: string | null = null
): { detail: string | null; extra: ContextExtra | null } {
  if (!title?.trim()) {
    return { detail: app ?? null, extra: null };
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
