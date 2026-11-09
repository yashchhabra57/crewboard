import { describe, expect, it } from "vitest";
import {
  checkAssignment,
  dynamicViolations,
  isDynamicallyLegal,
  laborCost,
  staticViolations,
} from "../src/server/domain/rules.js";
import { longestDayRun, weekMinute } from "../src/server/domain/time.js";
import { DEFAULT_RULES } from "../src/server/domain/types.js";
import { codes, emp, shift } from "./helpers.js";

describe("staticViolations", () => {
  it("passes a trained, available adult", () => {
    expect(staticViolations(emp(), shift(0, 9, 17), DEFAULT_RULES)).toEqual([]);
  });

  it("flags a missing role", () => {
    expect(codes(staticViolations(emp(), shift(0, 9, 17, { role: "cook" }), DEFAULT_RULES))).toEqual(["ROLE"]);
  });

  it("flags shifts that fall partly outside availability", () => {
    const e = emp({ availability: [{ start: weekMinute(0, 8), end: weekMinute(0, 14) }] });
    expect(codes(staticViolations(e, shift(0, 9, 17), DEFAULT_RULES))).toEqual(["AVAILABILITY"]);
    expect(staticViolations(e, shift(0, 9, 14), DEFAULT_RULES)).toEqual([]);
  });

  it("blocks minors from late and overnight shifts", () => {
    const minor = emp({ isMinor: true });
    expect(codes(staticViolations(minor, shift(4, 17, 23), DEFAULT_RULES))).toContain("MINOR_LATE");
    expect(codes(staticViolations(minor, shift(4, 20, 26), DEFAULT_RULES))).toContain("MINOR_LATE");
    expect(staticViolations(minor, shift(4, 16, 22), DEFAULT_RULES)).toEqual([]);
  });

  it("blocks minors from a single shift longer than the daily cap", () => {
    expect(codes(staticViolations(emp({ isMinor: true }), shift(5, 8, 17), DEFAULT_RULES))).toEqual(["MINOR_DAILY"]);
  });
});

describe("dynamicViolations", () => {
  it("flags overlapping shifts", () => {
    const v = dynamicViolations(emp(), shift(0, 12, 18), [shift(0, 9, 14)], DEFAULT_RULES);
    expect(codes(v)).toEqual(["OVERLAP"]);
  });

  it("flags clopening: closing at 23:00 then opening at 06:00", () => {
    const close = shift(0, 16, 23);
    const open = shift(1, 6, 12);
    expect(codes(dynamicViolations(emp(), open, [close], DEFAULT_RULES))).toEqual(["REST"]);
    expect(codes(dynamicViolations(emp(), close, [open], DEFAULT_RULES))).toEqual(["REST"]);
  });

  it("allows exactly the minimum rest", () => {
    const close = shift(0, 13, 21);
    const open = shift(1, 7, 12); // 21:00 -> 07:00 is exactly 10h
    expect(dynamicViolations(emp(), open, [close], DEFAULT_RULES)).toEqual([]);
  });

  it("enforces the employee's personal weekly cap", () => {
    const e = emp({ maxWeeklyMinutes: 16 * 60 });
    const existing = [shift(0, 9, 17), shift(1, 9, 17)];
    expect(codes(dynamicViolations(e, shift(2, 9, 10), existing, DEFAULT_RULES))).toEqual(["MAX_HOURS"]);
  });

  it("enforces max consecutive days", () => {
    const existing = [0, 1, 2, 3, 4, 5].map((d) => shift(d, 10, 14));
    expect(codes(dynamicViolations(emp(), shift(6, 10, 14), existing, DEFAULT_RULES))).toEqual(["CONSECUTIVE_DAYS"]);
  });

  it("applies minor daily and weekly limits across shifts", () => {
    const minor = emp({ isMinor: true });
    expect(codes(dynamicViolations(minor, shift(5, 14, 19), [shift(5, 8, 13)], DEFAULT_RULES))).toContain(
      "MINOR_DAILY",
    );
    const week = [shift(0, 16, 21), shift(1, 16, 21), shift(2, 16, 21)];
    expect(codes(dynamicViolations(minor, shift(3, 16, 21), week, DEFAULT_RULES))).toEqual(["MINOR_WEEKLY"]);
  });
});

describe("isDynamicallyLegal", () => {
  it("agrees with dynamicViolations on 2000 random cases", () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let i = 0; i < 2000; i++) {
      const e = emp({ isMinor: rand(3) === 0, maxWeeklyMinutes: (8 + rand(40)) * 60 });
      const mk = () => {
        const start = rand(7) * 1440 + rand(20) * 60;
        return { id: `x${i}`, role: "server" as const, start, end: start + (2 + rand(9)) * 60, headcount: 1 };
      };
      const existing = Array.from({ length: rand(7) }, mk);
      const s = mk();
      expect(isDynamicallyLegal(e, s, existing, DEFAULT_RULES)).toBe(
        dynamicViolations(e, s, existing, DEFAULT_RULES).length === 0,
      );
    }
  });
});

describe("checkAssignment", () => {
  it("combines static and dynamic violations", () => {
    const v = checkAssignment(emp(), shift(0, 10, 12, { role: "cook" }), [shift(0, 9, 11)], DEFAULT_RULES);
    expect(codes(v).sort()).toEqual(["OVERLAP", "ROLE"]);
  });
});

describe("laborCost", () => {
  it("charges overtime past the threshold", () => {
    expect(laborCost(emp(), 40 * 60, DEFAULT_RULES)).toBe(600);
    expect(laborCost(emp(), 42 * 60, DEFAULT_RULES)).toBe(600 + 2 * 15 * 1.5);
  });
});

describe("longestDayRun", () => {
  it("counts consecutive days, ignoring duplicates", () => {
    expect(longestDayRun([0, 1, 1, 2, 4, 5])).toBe(3);
    expect(longestDayRun([])).toBe(0);
  });
});
