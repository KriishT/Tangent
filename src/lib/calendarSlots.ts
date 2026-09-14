import { parseCheckInTime, phoneCheckInTimes, type AppSettings } from "./settings";

const CHECKIN_DURATION_MS = 1 * 60 * 1000;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function toLocalDateTimeString(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** One calendar series per chosen check-in time. */
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
