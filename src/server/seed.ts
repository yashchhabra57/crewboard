import { weekMinute } from "./domain/time.js";
import type { Employee, Role, Shift, TimeWindow } from "./domain/types.js";

/**
 * Demo data: "Lakeside Diner", open 07:00 to 23:00 every day, 17 staff
 * including two high-school students and a few part-timers with limited
 * availability.
 */

const H = 60;

/** Same daily window on each listed day (0 = Mon). */
function daily(days: number[], fromHour: number, toHour: number): TimeWindow[] {
  return days.map((d) => ({ start: weekMinute(d, fromHour), end: weekMinute(d, toHour) }));
}

const ALL = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [0, 1, 2, 3, 4];
const WEEKEND = [5, 6];

function person(
  id: string,
  name: string,
  roles: Role[],
  hourlyRate: number,
  maxHours: number,
  availability: TimeWindow[],
  isMinor = false,
): Employee {
  return { id, name, roles, hourlyRate, maxWeeklyMinutes: maxHours * H, isMinor, availability };
}

export const demoEmployees: Employee[] = [
  person("maria", "Maria Lopez", ["cook"], 21, 40, daily(ALL, 6, 24)),
  person("dave", "Dave Kowalski", ["cook", "dish"], 19, 40, daily(ALL, 6, 24)),
  person("kenji", "Kenji Sato", ["cook"], 20, 32, daily([0, 1, 2, 4, 5, 6], 12, 24)),
  person("tasha", "Tasha Greene", ["server", "bartender"], 14, 40, daily(ALL, 6, 24)),
  person("omar", "Omar Haddad", ["server", "host"], 13, 36, daily(ALL, 6, 24)),
  person("lily", "Lily Chen", ["server"], 13, 30, daily(ALL, 6, 17)),
  person("jake", "Jake Miller", ["server", "bartender"], 14, 32, daily([2, 3, 4, 5, 6], 12, 24)),
  person("priya", "Priya Nair", ["server", "host"], 13, 28, daily(ALL, 6, 24)),
  person("sam", "Sam Okafor", ["dish", "cook"], 16, 40, daily(ALL, 6, 24)),
  person("rosa", "Rosa Diaz", ["server"], 13, 24, [...daily(WEEKEND, 6, 24), ...daily([0, 2], 15, 24)]),
  person("ben", "Ben Fischer", ["dish"], 13, 30, daily(ALL, 14, 24)),
  person("carlos", "Carlos Ruiz", ["cook", "dish"], 18, 38, daily(ALL, 6, 24)),
  person("mei", "Mei Park", ["server", "bartender"], 14, 32, daily([0, 1, 3, 4, 5, 6], 6, 24)),
  person("grace", "Grace Kim", ["server", "dish"], 13, 30, daily(ALL, 10, 24)),
  person("hannah", "Hannah Weiss", ["host", "server"], 12, 20, daily(ALL, 6, 24)),
  person(
    "ava",
    "Ava Johnson",
    ["host", "dish"],
    11,
    16,
    [...daily(WEEKDAYS, 15, 22), ...daily(WEEKEND, 7, 22)],
    true,
  ),
  person(
    "leo",
    "Leo Martin",
    ["dish", "host"],
    11,
    16,
    [...daily(WEEKDAYS, 15, 22), ...daily(WEEKEND, 7, 22)],
    true,
  ),
];

function s(day: number, role: Role, label: string, from: number, to: number, headcount = 1): Shift {
  return { id: `d${day}-${role}-${label}`, role, start: weekMinute(day, from), end: weekMinute(day, to), headcount };
}

export const demoShifts: Shift[] = ALL.flatMap((d) => {
  const weekend = d >= 5;
  const busyNight = d === 4 || d === 5; // Fri, Sat
  const out: Shift[] = [
    s(d, "cook", "am", 7, 15),
    s(d, "server", "am", 7, 14, weekend ? 2 : 1),
    s(d, "dish", "am", 8, 15),
    s(d, "server", "lunch", 11, 16),
    s(d, "cook", "pm", 15, 23, busyNight ? 2 : 1),
    s(d, "server", "pm", 16, 23, 2),
    s(d, "dish", "pm", 16, 23),
  ];
  if (weekend) out.push(s(d, "host", "am", 8, 14));
  if (busyNight || d === 6) out.push(s(d, "host", "pm", 16, 21));
  if (d >= 3 && d <= 5) out.push(s(d, "bartender", "pm", 17, 23));
  return out;
});
