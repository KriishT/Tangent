import type { Thought } from "./types";

function toGoogleDate(ts: Date): string {
  return ts.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
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
