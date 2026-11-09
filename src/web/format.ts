export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function clock(weekMinute: number): string {
  const m = ((weekMinute % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const suffix = h < 12 ? "a" : "p";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const mm = m % 60;
  return `${h12}${mm ? `:${mm.toString().padStart(2, "0")}` : ""}${suffix}`;
}

export function dayIndex(weekMinute: number): number {
  return Math.floor(weekMinute / 1440);
}

export function hours(minutes: number): string {
  const h = minutes / 60;
  return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`;
}

export function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export const BLOCKER_LABELS: Record<string, string> = {
  ROLE: "not trained",
  AVAILABILITY: "unavailable",
  OVERLAP: "double-booked",
  REST: "rest period",
  MAX_HOURS: "at hour cap",
  CONSECUTIVE_DAYS: "too many days in a row",
  MINOR_DAILY: "minor daily cap",
  MINOR_WEEKLY: "minor weekly cap",
  MINOR_LATE: "minor curfew",
};
