import type { TimeWindow } from "./types.js";

export const MINUTES_PER_DAY = 24 * 60;
export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export function weekMinute(day: number, hour: number, minute = 0): number {
  return day * MINUTES_PER_DAY + hour * 60 + minute;
}

/** Day index (0 = Monday) a week-minute falls on. */
export function dayOf(weekMinutes: number): number {
  return Math.floor(weekMinutes / MINUTES_PER_DAY);
}

export function minuteOfDay(weekMinutes: number): number {
  return ((weekMinutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

export function duration(w: TimeWindow): number {
  return w.end - w.start;
}

/** True when two half-open intervals [start, end) share any time. */
export function overlaps(a: TimeWindow, b: TimeWindow): boolean {
  return a.start < b.end && b.start < a.end;
}

/** True when `inner` lies entirely inside `outer`. */
export function contains(outer: TimeWindow, inner: TimeWindow): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/**
 * Gap in minutes between two non-overlapping windows (0 if they touch or
 * overlap).
 */
export function gapBetween(a: TimeWindow, b: TimeWindow): number {
  if (overlaps(a, b)) return 0;
  return a.end <= b.start ? b.start - a.end : a.start - b.end;
}

/** Length of the longest run of consecutive day indexes in the set. */
export function longestDayRun(days: Iterable<number>): number {
  const sorted = [...new Set(days)].sort((x, y) => x - y);
  let best = 0;
  let run = 0;
  let prev = Number.NaN;
  for (const d of sorted) {
    run = d === prev + 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/** "Fri 18:00" style label. */
export function formatWeekMinute(weekMinutes: number): string {
  const day = DAYS[dayOf(weekMinutes) % 7] ?? "?";
  const m = minuteOfDay(weekMinutes);
  return `${day} ${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}
