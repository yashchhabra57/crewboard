import {
  contains,
  dayOf,
  duration,
  formatWeekMinute,
  gapBetween,
  longestDayRun,
  minuteOfDay,
  overlaps,
} from "./time.js";
import type { Employee, LaborRules, Shift, Violation } from "./types.js";

const hours = (m: number) => `${(m / 60).toFixed(m % 60 === 0 ? 0 : 1)}h`;

/**
 * Checks that never change while a schedule is being built: role,
 * availability, and minor rules that depend only on the shift itself.
 * The solver uses these to precompute each slot's candidate list.
 */
export function staticViolations(employee: Employee, shift: Shift, rules: LaborRules): Violation[] {
  const out: Violation[] = [];
  if (!employee.roles.includes(shift.role)) {
    out.push({ code: "ROLE", message: `${employee.name} is not trained as ${shift.role}` });
  }
  if (!employee.availability.some((w) => contains(w, shift))) {
    out.push({
      code: "AVAILABILITY",
      message: `${employee.name} is not available ${formatWeekMinute(shift.start)} to ${formatWeekMinute(shift.end)}`,
    });
  }
  if (employee.isMinor) {
    const endsNextDay = dayOf(shift.end - 1) !== dayOf(shift.start);
    if (endsNextDay || minuteOfDay(shift.end) > rules.minorLatestEndMinuteOfDay) {
      out.push({
        code: "MINOR_LATE",
        message: `${employee.name} is a minor and cannot work past ${formatClock(rules.minorLatestEndMinuteOfDay)}`,
      });
    }
    if (duration(shift) > rules.minorMaxDailyMinutes) {
      out.push({
        code: "MINOR_DAILY",
        message: `${employee.name} is a minor and this shift exceeds ${hours(rules.minorMaxDailyMinutes)}`,
      });
    }
  }
  return out;
}

function formatClock(minuteOfDayValue: number): string {
  const h = Math.floor(minuteOfDayValue / 60);
  const m = minuteOfDayValue % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

/**
 * Checks that depend on what else the employee already works this week:
 * overlaps, rest periods, weekly caps, daily caps for minors, and
 * consecutive-day limits.
 *
 * `existing` must not include `shift` itself.
 */
export function dynamicViolations(
  employee: Employee,
  shift: Shift,
  existing: readonly Shift[],
  rules: LaborRules,
): Violation[] {
  const out: Violation[] = [];
  let weekly = duration(shift);
  let sameDay = duration(shift);
  const day = dayOf(shift.start);
  const days = [day];

  for (const other of existing) {
    weekly += duration(other);
    days.push(dayOf(other.start));
    if (dayOf(other.start) === day) sameDay += duration(other);

    if (overlaps(other, shift)) {
      out.push({
        code: "OVERLAP",
        message: `${employee.name} already works ${formatWeekMinute(other.start)} to ${formatWeekMinute(other.end)}`,
      });
    } else if (gapBetween(other, shift) < rules.minRestMinutes) {
      out.push({
        code: "REST",
        message: `${employee.name} would get only ${hours(gapBetween(other, shift))} of rest next to the ${formatWeekMinute(other.start)} shift (min ${hours(rules.minRestMinutes)})`,
      });
    }
  }

  if (weekly > employee.maxWeeklyMinutes) {
    out.push({
      code: "MAX_HOURS",
      message: `${employee.name} would reach ${hours(weekly)} this week (cap ${hours(employee.maxWeeklyMinutes)})`,
    });
  }
  if (longestDayRun(days) > rules.maxConsecutiveDays) {
    out.push({
      code: "CONSECUTIVE_DAYS",
      message: `${employee.name} would work more than ${rules.maxConsecutiveDays} days in a row`,
    });
  }
  if (employee.isMinor) {
    if (sameDay > rules.minorMaxDailyMinutes) {
      out.push({
        code: "MINOR_DAILY",
        message: `${employee.name} is a minor and would work ${hours(sameDay)} in one day (max ${hours(rules.minorMaxDailyMinutes)})`,
      });
    }
    if (weekly > rules.minorMaxWeeklyMinutes) {
      out.push({
        code: "MINOR_WEEKLY",
        message: `${employee.name} is a minor and would reach ${hours(weekly)} this week (max ${hours(rules.minorMaxWeeklyMinutes)})`,
      });
    }
  }
  return out;
}

function longestBitRun(mask: number): number {
  let best = 0;
  let run = 0;
  for (let m = mask; m > 0; m >>>= 1) {
    run = m & 1 ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

/**
 * Allocation-free equivalent of `dynamicViolations(...).length === 0`.
 * The solver calls this hundreds of thousands of times, so it skips
 * building messages and bails out on the first broken rule. A property
 * test keeps the two implementations in agreement.
 */
export function isDynamicallyLegal(
  employee: Employee,
  shift: Shift,
  existing: readonly Shift[],
  rules: LaborRules,
): boolean {
  const len = shift.end - shift.start;
  const day = dayOf(shift.start);
  let weekly = len;
  let sameDay = len;
  let mask = 1 << day;
  for (let i = 0; i < existing.length; i++) {
    const other = existing[i]!;
    if (other.start < shift.end && shift.start < other.end) return false;
    const gap = other.end <= shift.start ? shift.start - other.end : other.start - shift.end;
    if (gap < rules.minRestMinutes) return false;
    weekly += other.end - other.start;
    const d = dayOf(other.start);
    if (d === day) sameDay += other.end - other.start;
    mask |= 1 << d;
  }
  if (weekly > employee.maxWeeklyMinutes) return false;
  if (employee.isMinor && (sameDay > rules.minorMaxDailyMinutes || weekly > rules.minorMaxWeeklyMinutes)) {
    return false;
  }
  return longestBitRun(mask) <= rules.maxConsecutiveDays;
}

export function checkAssignment(
  employee: Employee,
  shift: Shift,
  existing: readonly Shift[],
  rules: LaborRules,
): Violation[] {
  return [...staticViolations(employee, shift, rules), ...dynamicViolations(employee, shift, existing, rules)];
}

/** Weekly labor cost for one employee, with overtime past the threshold. */
export function laborCost(employee: Employee, weeklyMinutes: number, rules: LaborRules): number {
  const regular = Math.min(weeklyMinutes, rules.overtimeThresholdMinutes);
  const overtime = Math.max(0, weeklyMinutes - rules.overtimeThresholdMinutes);
  return (employee.hourlyRate * (regular + overtime * rules.overtimeMultiplier)) / 60;
}
