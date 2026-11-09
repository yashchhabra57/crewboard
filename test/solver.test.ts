import { describe, expect, it } from "vitest";
import { checkAssignment } from "../src/server/domain/rules.js";
import { solve } from "../src/server/domain/solver.js";
import { DEFAULT_RULES, type Assignment, type Employee, type Shift } from "../src/server/domain/types.js";
import { emp, shift } from "./helpers.js";

/** Re-checks every assignment from scratch, independent of solver internals. */
function assertLegal(employees: Employee[], shifts: Shift[], assignments: Assignment[]) {
  const byId = new Map(shifts.map((s) => [s.id, s]));
  for (const e of employees) {
    const mine = assignments.filter((a) => a.employeeId === e.id).map((a) => byId.get(a.shiftId)!);
    mine.forEach((s, i) => {
      const others = mine.filter((_, j) => j !== i);
      expect(checkAssignment(e, s, others, DEFAULT_RULES), `${e.name} on ${s.id}`).toEqual([]);
    });
  }
  for (const s of shifts) {
    expect(assignments.filter((a) => a.shiftId === s.id).length).toBeLessThanOrEqual(s.headcount);
  }
}

describe("solve", () => {
  it("fills a simple week completely", () => {
    const employees = [emp({ id: "a", name: "A" }), emp({ id: "b", name: "B" })];
    const shifts = [0, 1, 2, 3].map((d) => shift(d, 9, 17, { headcount: 1 }));
    const r = solve(employees, shifts, DEFAULT_RULES);
    expect(r.unfilled).toEqual([]);
    expect(r.assignments).toHaveLength(4);
    assertLegal(employees, shifts, r.assignments);
  });

  it("balances load across employees", () => {
    const employees = [emp({ id: "a", name: "A" }), emp({ id: "b", name: "B" })];
    const shifts = [0, 1, 2, 3].map((d) => shift(d, 9, 17));
    const r = solve(employees, shifts, DEFAULT_RULES);
    const count = (id: string) => r.assignments.filter((a) => a.employeeId === id).length;
    expect(count("a")).toBe(2);
    expect(count("b")).toBe(2);
  });

  it("decides the most constrained seat first so a greedy order cannot strand it", () => {
    // Only "flex" can work the cook shift. A naive greedy that gives the
    // earlier server shift to "flex" leaves the cook seat empty.
    const flex = emp({ id: "flex", name: "Flex", roles: ["server", "cook"], hourlyRate: 10 });
    const srv = emp({ id: "srv", name: "Srv", roles: ["server"], hourlyRate: 20 });
    const shifts = [shift(0, 9, 17, { id: "server-mon" }), shift(0, 10, 18, { id: "cook-mon", role: "cook" })];
    const r = solve([srv, flex], shifts, DEFAULT_RULES);
    expect(r.unfilled).toEqual([]);
    expect(r.assignments).toContainEqual({ shiftId: "cook-mon", employeeId: "flex" });
    expect(r.assignments).toContainEqual({ shiftId: "server-mon", employeeId: "srv" });
  });

  it("returns the best partial schedule with blockers when understaffed", () => {
    const employees = [emp({ id: "a", name: "A" })];
    const shifts = [
      shift(0, 9, 17, { id: "mon", headcount: 2 }),
      shift(1, 9, 17, { id: "tue-cook", role: "cook" }),
    ];
    const r = solve(employees, shifts, DEFAULT_RULES);
    expect(r.assignments).toEqual([{ shiftId: "mon", employeeId: "a" }]);
    expect(r.unfilled).toHaveLength(2);
    expect(r.unfilled.find((u) => u.shiftId === "tue-cook")?.blockers).toEqual({ ROLE: 1 });
    expect(r.stats.exhaustive).toBe(true);
  });

  it("never schedules a clopening or a minor past curfew", () => {
    const adult = emp({ id: "adult", name: "Adult" });
    const teen = emp({ id: "teen", name: "Teen", isMinor: true });
    const shifts = [
      shift(0, 16, 23, { id: "mon-close" }),
      shift(1, 6, 12, { id: "tue-open" }),
    ];
    const r = solve([adult, teen], shifts, DEFAULT_RULES);
    expect(r.unfilled).toEqual([]);
    expect(r.assignments).toContainEqual({ shiftId: "mon-close", employeeId: "adult" });
    expect(r.assignments).toContainEqual({ shiftId: "tue-open", employeeId: "teen" });
  });

  it("produces a legal schedule for a realistic randomised roster", () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const roles = ["cook", "server", "host", "dish"] as const;
    const employees: Employee[] = Array.from({ length: 14 }, (_, i) =>
      emp({
        id: `e${i}`,
        name: `E${i}`,
        roles: roles.filter(() => rand() < 0.45).concat(roles[i % roles.length]!),
        isMinor: i % 6 === 0,
        maxWeeklyMinutes: (20 + Math.floor(rand() * 20)) * 60,
        hourlyRate: 12 + Math.floor(rand() * 10),
      }),
    );
    const shifts: Shift[] = [];
    for (let d = 0; d < 7; d++) {
      for (const role of roles) {
        shifts.push(shift(d, 10, 16, { id: `${role}-${d}-am`, role, headcount: role === "server" ? 2 : 1 }));
        shifts.push(shift(d, 16, 22, { id: `${role}-${d}-pm`, role, headcount: role === "server" ? 2 : 1 }));
      }
    }
    const r = solve(employees, shifts, DEFAULT_RULES, { nodeLimit: 5000 });
    assertLegal(employees, shifts, r.assignments);
    const seats = shifts.reduce((n, s) => n + s.headcount, 0);
    expect(r.assignments.length + r.unfilled.length).toBe(seats);
  });

  it("respects the node limit and still returns a legal schedule", () => {
    const employees = Array.from({ length: 6 }, (_, i) => emp({ id: `e${i}`, name: `E${i}`, maxWeeklyMinutes: 8 * 60 }));
    const shifts = Array.from({ length: 7 }, (_, d) => shift(d, 9, 17, { id: `d${d}`, headcount: 2 }));
    const r = solve(employees, shifts, DEFAULT_RULES, { nodeLimit: 3 });
    expect(r.stats.exhaustive).toBe(false);
    assertLegal(employees, shifts, r.assignments);
  });
});
