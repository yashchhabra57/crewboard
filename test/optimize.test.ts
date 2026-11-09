import { describe, expect, it } from "vitest";
import { DEFAULT_WEIGHTS, objective, optimize } from "../src/server/domain/optimize.js";
import { checkAssignment } from "../src/server/domain/rules.js";
import { solve } from "../src/server/domain/solver.js";
import { ScheduleState } from "../src/server/domain/state.js";
import { DEFAULT_RULES, type Assignment, type Employee, type Shift } from "../src/server/domain/types.js";
import { emp, shift } from "./helpers.js";

function legal(employees: Employee[], shifts: Shift[], assignments: Assignment[]): boolean {
  const byId = new Map(shifts.map((s) => [s.id, s]));
  return employees.every((e) => {
    const mine = assignments.filter((a) => a.employeeId === e.id).map((a) => byId.get(a.shiftId)!);
    return mine.every((s, i) => checkAssignment(e, s, mine.filter((_, j) => j !== i), DEFAULT_RULES).length === 0);
  });
}

describe("optimize", () => {
  it("moves overtime hours to someone with spare capacity", () => {
    const busy = emp({ id: "busy", name: "Busy", maxWeeklyMinutes: 60 * 60 });
    const spare = emp({ id: "spare", name: "Spare", maxWeeklyMinutes: 40 * 60 });
    const shifts = [0, 1, 2, 3, 4, 5].map((d) => shift(d, 9, 17, { id: `d${d}` }));
    // Start with Busy on all six days: 48h, 8h of it overtime.
    const start = shifts.map((s) => ({ shiftId: s.id, employeeId: "busy" }));
    const r = optimize([busy, spare], shifts, start, DEFAULT_RULES);
    expect(r.after).toBeLessThan(r.before);
    const busyShifts = r.assignments.filter((a) => a.employeeId === "busy").length;
    expect(busyShifts).toBeLessThanOrEqual(5);
    expect(r.assignments).toHaveLength(6);
    expect(legal([busy, spare], shifts, r.assignments)).toBe(true);
  });

  it("prefers the cheaper of two equally loaded employees", () => {
    const pricey = emp({ id: "pricey", name: "Pricey", hourlyRate: 25 });
    const cheap = emp({ id: "cheap", name: "Cheap", hourlyRate: 14 });
    const shifts = [shift(0, 9, 17, { id: "mon" })];
    const r = optimize([pricey, cheap], shifts, [{ shiftId: "mon", employeeId: "pricey" }], DEFAULT_RULES, {
      ...DEFAULT_WEIGHTS,
      fairness: 0,
    });
    expect(r.assignments).toEqual([{ shiftId: "mon", employeeId: "cheap" }]);
  });

  it("fills empty seats when a legal candidate exists", () => {
    const a = emp({ id: "a", name: "A" });
    const shifts = [shift(2, 9, 17, { id: "wed" })];
    const r = optimize([a], shifts, [], DEFAULT_RULES);
    expect(r.assignments).toEqual([{ shiftId: "wed", employeeId: "a" }]);
  });

  it("uses swaps when no single reassignment is legal", () => {
    // Two overlapping Monday shifts. Moving either shift to the other person
    // would double-book them, so only a swap can put the cheap employee on
    // the long shift.
    const a = emp({ id: "a", name: "A", hourlyRate: 30 });
    const b = emp({ id: "b", name: "B", hourlyRate: 12 });
    const shifts = [shift(0, 9, 19, { id: "mon-long" }), shift(0, 10, 14, { id: "mon-short" })];
    const start = [
      { shiftId: "mon-long", employeeId: "a" },
      { shiftId: "mon-short", employeeId: "b" },
    ];
    const r = optimize([a, b], shifts, start, DEFAULT_RULES, { ...DEFAULT_WEIGHTS, fairness: 0 });
    expect(r.moves).toBe(1);
    expect(r.assignments).toContainEqual({ shiftId: "mon-long", employeeId: "b" });
    expect(r.assignments).toContainEqual({ shiftId: "mon-short", employeeId: "a" });
  });

  it("never makes a solved schedule worse and keeps it legal", () => {
    const employees = Array.from({ length: 8 }, (_, i) =>
      emp({ id: `e${i}`, name: `E${i}`, hourlyRate: 12 + i, maxWeeklyMinutes: (24 + i * 3) * 60 }),
    );
    const shifts = Array.from({ length: 7 }, (_, d) => [
      shift(d, 7, 15, { id: `am${d}`, headcount: 2 }),
      shift(d, 15, 23, { id: `pm${d}`, headcount: 2 }),
    ]).flat();
    const solved = solve(employees, shifts, DEFAULT_RULES);
    const r = optimize(employees, shifts, solved.assignments, DEFAULT_RULES);
    expect(r.after).toBeLessThanOrEqual(r.before);
    expect(legal(employees, shifts, r.assignments)).toBe(true);

    const check = new ScheduleState(employees, shifts, DEFAULT_RULES);
    check.load(r.assignments);
    expect(objective(check, DEFAULT_WEIGHTS)).toBeCloseTo(r.after, 6);
  });
});
