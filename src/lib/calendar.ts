import type { Thought } from "./types";

function toGoogleDate(ts: Date): string {
  return ts.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function icsEscape(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function formatIcsUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function contextLine(thought: Thought): string {
  const parts = [thought.ctx_app, thought.ctx_detail].filter(Boolean);
  return parts.length ? `Context: ${parts.join(" · ")}` : "";
}

/** Build RFC 5545 `.ics` content for a thought with a due time. */
export function buildIcsForThought(thought: Thought): string | null {
  const start = normalizeStart(thought);
  if (!start) return null;

  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const uid = `tangent-thought-${thought.id}@tangent.app`;
  const description = [contextLine(thought), "Created by Tangent"].filter(Boolean).join("\\n");

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Tangent//Tangent//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${formatIcsUtc(new Date())}`,
    `DTSTART:${formatIcsUtc(start)}`,
    `DTEND:${formatIcsUtc(end)}`,
    `SUMMARY:${icsEscape(thought.body.slice(0, 120))}`,
    description ? `DESCRIPTION:${icsEscape(description.replace(/\\n/g, "\n"))}` : "",
    "BEGIN:VALARM",
    "TRIGGER:-PT15M",
    "ACTION:DISPLAY",
    "DESCRIPTION:Tangent reminder",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ]
    .filter(Boolean)
    .join("\r\n");
}

/** Save/download a `.ics` file for import into any calendar app (phone alerts, no OAuth). */
export async function exportIcsForThought(thought: Thought): Promise<"saved" | "no_due" | "cancelled"> {
  if (!buildIcsForThought(thought)) return "no_due";
  const ok = downloadIcsForThought(thought);
  return ok ? "saved" : "no_due";
}

/** Trigger a browser download of `.ics` (fallback when dialog plugin unavailable). */
export function downloadIcsForThought(thought: Thought): boolean {
  const content = buildIcsForThought(thought);
  if (!content) return false;
  const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `tangent-${thought.id}.ics`;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}

function normalizeStart(thought: Thought): Date | null {
  if (!thought.due_at) return null;
  const dt = new Date(thought.due_at);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

/** Build a prefilled Google Calendar event URL from a thought. */
export function googleCalendarUrlForThought(thought: Thought): string | null {
  const start = normalizeStart(thought);
  if (!start) return null;

  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const context =
    thought.ctx_app || thought.ctx_detail
      ? [thought.ctx_app, thought.ctx_detail].filter(Boolean).join(" · ")
      : "";

  const details = context
    ? `Tangent\n\nContext: ${context}`
    : "Tangent";

  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: thought.body.slice(0, 120),
    dates: `${toGoogleDate(start)}/${toGoogleDate(end)}`,
    details,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** Open Google Calendar with this thought prefilled. */
export function openGoogleCalendarForThought(thought: Thought): void {
  const url = googleCalendarUrlForThought(thought);
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}
