/**
 * Core scheduling domain.
 *
 * All times are expressed as minutes from Monday 00:00 of the scheduled week
 * ("week minutes"). A shift that starts Friday 18:00 and ends Saturday 01:00
 * is simply { start: 4*1440 + 1080, end: 5*1440 + 60 }. Keeping a single
 * linear timeline makes overlap and rest-period checks plain arithmetic.
 */

export type Role = "cook" | "server" | "host" | "dish" | "bartender";

export const ROLES: readonly Role[] = ["cook", "server", "host", "dish", "bartender"];

export interface TimeWindow {
  start: number;
  end: number;
}

export interface Employee {
  id: string;
  name: string;
  roles: Role[];
  /** Hourly wage in dollars. Used for labor-cost and overtime estimates. */
  hourlyRate: number;
  /** Personal cap on scheduled minutes per week (e.g. a part-timer's 24h). */
  maxWeeklyMinutes: number;
  /** Under-18 employees get the stricter minor-labor rules. */
  isMinor: boolean;
  /** Windows in which the employee is willing to work. */
  availability: TimeWindow[];
}

export interface Shift {
  id: string;
  role: Role;
  start: number;
  end: number;
  /** How many people this shift needs. */
  headcount: number;
}

export interface Assignment {
  shiftId: string;
  employeeId: string;
}

/**
 * Configurable labor rules. Defaults are illustrative and loosely modelled on
 * common US rules; they are not legal advice and every jurisdiction differs.
 */
export interface LaborRules {
  /** Minimum gap between the end of one shift and the start of the next ("clopening" guard). */
  minRestMinutes: number;
  /** Weekly minutes after which overtime pay applies. */
  overtimeThresholdMinutes: number;
  overtimeMultiplier: number;
  /** Max days in a row an employee can be scheduled. */
  maxConsecutiveDays: number;
  minorMaxDailyMinutes: number;
  minorMaxWeeklyMinutes: number;
  /** Latest minute-of-day a minor's shift may end (e.g. 22:00 = 1320). */
  minorLatestEndMinuteOfDay: number;
}

export const DEFAULT_RULES: LaborRules = {
  minRestMinutes: 10 * 60,
  overtimeThresholdMinutes: 40 * 60,
  overtimeMultiplier: 1.5,
  maxConsecutiveDays: 6,
  minorMaxDailyMinutes: 8 * 60,
  minorMaxWeeklyMinutes: 18 * 60,
  minorLatestEndMinuteOfDay: 22 * 60,
};

export type ViolationCode =
  | "ROLE"
  | "AVAILABILITY"
  | "OVERLAP"
  | "REST"
  | "MAX_HOURS"
  | "CONSECUTIVE_DAYS"
  | "MINOR_DAILY"
  | "MINOR_WEEKLY"
  | "MINOR_LATE";

export interface Violation {
  code: ViolationCode;
  message: string;
}
