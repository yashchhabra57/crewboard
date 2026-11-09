import { isDynamicallyLegal, laborCost, staticViolations } from "./rules.js";
import { duration } from "./time.js";
import type { Assignment, Employee, LaborRules, Shift } from "./types.js";

/**
 * Mutable working copy of a week's schedule with O(1) lookups for the
 * things the solver and optimizer ask about constantly: who is on a shift,
 * what an employee already works, and how many minutes they have.
 */
export class ScheduleState {
  readonly employees: readonly Employee[];
  readonly shifts: readonly Shift[];
  readonly rules: LaborRules;

  private readonly employeeById = new Map<string, Employee>();
  private readonly shiftById = new Map<string, Shift>();
  /** shiftId -> employee ids who pass role/availability/minor-static checks. */
  private readonly eligible = new Map<string, Set<string>>();
  private readonly worked = new Map<string, Shift[]>();
  private readonly minutes = new Map<string, number>();
  private readonly crew = new Map<string, string[]>();

  constructor(employees: readonly Employee[], shifts: readonly Shift[], rules: LaborRules) {
    this.employees = employees;
    this.shifts = shifts;
    this.rules = rules;
    for (const e of employees) {
      this.employeeById.set(e.id, e);
      this.worked.set(e.id, []);
      this.minutes.set(e.id, 0);
    }
    for (const s of shifts) {
      this.shiftById.set(s.id, s);
      this.crew.set(s.id, []);
      const ok = new Set<string>();
      for (const e of employees) {
        if (staticViolations(e, s, rules).length === 0) ok.add(e.id);
      }
      this.eligible.set(s.id, ok);
    }
  }

  employee(id: string): Employee {
    const e = this.employeeById.get(id);
    if (!e) throw new Error(`Unknown employee ${id}`);
    return e;
  }

  shift(id: string): Shift {
    const s = this.shiftById.get(id);
    if (!s) throw new Error(`Unknown shift ${id}`);
    return s;
  }

  crewOf(shiftId: string): readonly string[] {
    return this.crew.get(shiftId) ?? [];
  }

  shiftsOf(employeeId: string): readonly Shift[] {
    return this.worked.get(employeeId) ?? [];
  }

  minutesOf(employeeId: string): number {
    return this.minutes.get(employeeId) ?? 0;
  }

  openSeats(shiftId: string): number {
    return this.shift(shiftId).headcount - this.crewOf(shiftId).length;
  }

  staticallyEligible(shiftId: string): ReadonlySet<string> {
    return this.eligible.get(shiftId) ?? new Set();
  }

  /** Can this employee legally be added to this shift right now? */
  canTake(employeeId: string, shiftId: string): boolean {
    if (!this.staticallyEligible(shiftId).has(employeeId)) return false;
    if (this.crewOf(shiftId).includes(employeeId)) return false;
    return isDynamicallyLegal(this.employee(employeeId), this.shift(shiftId), this.shiftsOf(employeeId), this.rules);
  }

  assign(employeeId: string, shiftId: string): void {
    const s = this.shift(shiftId);
    this.crew.get(shiftId)!.push(employeeId);
    this.worked.get(employeeId)!.push(s);
    this.minutes.set(employeeId, this.minutesOf(employeeId) + duration(s));
  }

  unassign(employeeId: string, shiftId: string): void {
    const s = this.shift(shiftId);
    const crew = this.crew.get(shiftId)!;
    const i = crew.indexOf(employeeId);
    if (i < 0) throw new Error(`${employeeId} is not on ${shiftId}`);
    crew.splice(i, 1);
    const worked = this.worked.get(employeeId)!;
    worked.splice(worked.indexOf(s), 1);
    this.minutes.set(employeeId, this.minutesOf(employeeId) - duration(s));
  }

  unfilledSeats(): number {
    let n = 0;
    for (const s of this.shifts) n += this.openSeats(s.id);
    return n;
  }

  totalCost(): number {
    let total = 0;
    for (const e of this.employees) total += laborCost(e, this.minutesOf(e.id), this.rules);
    return total;
  }

  /**
   * Variance of utilization (scheduled / personal cap) across the crew.
   * Zero means everyone is equally loaded relative to what they asked for.
   */
  utilizationVariance(): number {
    if (this.employees.length === 0) return 0;
    const utils = this.employees.map((e) =>
      e.maxWeeklyMinutes > 0 ? this.minutesOf(e.id) / e.maxWeeklyMinutes : 0,
    );
    const mean = utils.reduce((a, b) => a + b, 0) / utils.length;
    return utils.reduce((a, u) => a + (u - mean) ** 2, 0) / utils.length;
  }

  toAssignments(): Assignment[] {
    const out: Assignment[] = [];
    for (const s of this.shifts) {
      for (const employeeId of this.crewOf(s.id)) out.push({ shiftId: s.id, employeeId });
    }
    return out;
  }

  /** Loads existing assignments, skipping any that reference unknown ids. */
  load(assignments: readonly Assignment[]): void {
    for (const a of assignments) {
      if (this.employeeById.has(a.employeeId) && this.shiftById.has(a.shiftId)) {
        this.assign(a.employeeId, a.shiftId);
      }
    }
  }
}
