import { checkAssignment, laborCost } from "./rules.js";
import { explainUnfilled, type UnfilledSeat } from "./solver.js";
import { ScheduleState } from "./state.js";
import type { Assignment, Employee, LaborRules, Shift, Violation } from "./types.js";

export interface EmployeeLoad {
  employeeId: string;
  minutes: number;
  overtimeMinutes: number;
  cost: number;
  /** Scheduled minutes divided by the employee's personal cap. */
  utilization: number;
}

export interface ScheduleReport {
  loads: EmployeeLoad[];
  totalCost: number;
  overtimeMinutes: number;
  filledSeats: number;
  totalSeats: number;
  unfilled: UnfilledSeat[];
  /** Assignments that break a rule (only possible after manual edits). */
  violations: { shiftId: string; employeeId: string; violations: Violation[] }[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function buildReport(
  employees: readonly Employee[],
  shifts: readonly Shift[],
  assignments: readonly Assignment[],
  rules: LaborRules,
): ScheduleReport {
  const state = new ScheduleState(employees, shifts, rules);
  state.load(assignments);

  const loads = employees.map((e) => {
    const minutes = state.minutesOf(e.id);
    return {
      employeeId: e.id,
      minutes,
      overtimeMinutes: Math.max(0, minutes - rules.overtimeThresholdMinutes),
      cost: round2(laborCost(e, minutes, rules)),
      utilization: e.maxWeeklyMinutes > 0 ? round2(minutes / e.maxWeeklyMinutes) : 0,
    };
  });

  const violations: ScheduleReport["violations"] = [];
  for (const e of employees) {
    const mine = state.shiftsOf(e.id);
    mine.forEach((s, i) => {
      const v = checkAssignment(e, s, mine.filter((_, j) => j !== i), rules);
      if (v.length > 0) violations.push({ shiftId: s.id, employeeId: e.id, violations: v });
    });
  }

  const totalSeats = shifts.reduce((n, s) => n + s.headcount, 0);
  const unfilled = explainUnfilled(state);
  return {
    loads,
    totalCost: round2(loads.reduce((n, l) => n + l.cost, 0)),
    overtimeMinutes: loads.reduce((n, l) => n + l.overtimeMinutes, 0),
    filledSeats: totalSeats - unfilled.length,
    totalSeats,
    unfilled,
    violations,
  };
}
