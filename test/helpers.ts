import { weekMinute } from "../src/server/domain/time.js";
import type { Employee, Shift } from "../src/server/domain/types.js";

export const WHOLE_WEEK = { start: 0, end: 7 * 24 * 60 };

export function emp(overrides: Partial<Employee> = {}): Employee {
  return {
    id: "e1",
    name: "Ana",
    roles: ["server"],
    hourlyRate: 15,
    maxWeeklyMinutes: 40 * 60,
    isMinor: false,
    availability: [WHOLE_WEEK],
    ...overrides,
  };
}

export function shift(day: number, startHour: number, endHour: number, overrides: Partial<Shift> = {}): Shift {
  const start = weekMinute(day, startHour);
  return {
    id: `s-${day}-${startHour}`,
    role: "server",
    start,
    end: start + (endHour - startHour) * 60,
    headcount: 1,
    ...overrides,
  };
}

export const codes = (v: { code: string }[]) => v.map((x) => x.code);
