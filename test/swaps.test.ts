import { beforeEach, describe, expect, it } from "vitest";
import { buildReport } from "../src/server/domain/report.js";
import { ScheduleState } from "../src/server/domain/state.js";
import {
  approveSwap,
  cancelSwap,
  claimSwap,
  eligibleTakers,
  rejectSwap,
  requestSwap,
  WorkflowError,
  type Actor,
  type SwapRequest,
  type WorkflowContext,
} from "../src/server/domain/swaps.js";
import { DEFAULT_RULES } from "../src/server/domain/types.js";
import { emp, shift } from "./helpers.js";

const manager: Actor = { kind: "manager", id: "manager" };
const as = (id: string): Actor => ({ kind: "employee", id });

const employees = [
  emp({ id: "ana", name: "Ana" }),
  emp({ id: "ben", name: "Ben" }),
  emp({ id: "cat", name: "Cat", roles: ["cook"] }),
  emp({ id: "dev", name: "Dev" }),
];
const shifts = [
  shift(0, 16, 23, { id: "mon-close" }),
  shift(1, 6, 12, { id: "tue-open" }),
  shift(2, 9, 17, { id: "wed" }),
  shift(2, 11, 15, { id: "wed-lunch" }),
];

let ctx: WorkflowContext;
let n = 0;

beforeEach(() => {
  const state = new ScheduleState(employees, shifts, DEFAULT_RULES);
  state.load([
    { shiftId: "mon-close", employeeId: "ben" },
    { shiftId: "tue-open", employeeId: "dev" },
    { shiftId: "wed", employeeId: "ana" },
  ]);
  n = 0;
  ctx = { state, now: () => new Date("2026-11-08T12:00:00Z"), newId: () => `swap-${++n}` };
});

function expectWorkflowError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(WorkflowError);
    expect((e as WorkflowError).code).toBe(code);
    return e as WorkflowError;
  }
  throw new Error(`expected ${code}`);
}

describe("swap workflow", () => {
  it("runs the happy path and records history", () => {
    const open = requestSwap(ctx, as("ana"), { shiftId: "wed", note: "dentist" }, []);
    expect(open.status).toBe("open");
    const claimed = claimSwap(ctx, as("ben"), open);
    expect(claimed).toMatchObject({ status: "claimed", claimedById: "ben" });
    const { swap, change } = approveSwap(ctx, manager, claimed);
    expect(swap.status).toBe("approved");
    expect(change).toEqual({ shiftId: "wed", fromEmployeeId: "ana", toEmployeeId: "ben" });
    expect(swap.history.map((h) => h.action)).toEqual(["request", "claim", "approve"]);
    expect(ctx.state.crewOf("wed")).toEqual(["ben"]);
    // inputs are not mutated
    expect(open.status).toBe("open");
  });

  it("only lets you offer shifts you are on, once", () => {
    expectWorkflowError(() => requestSwap(ctx, as("ana"), { shiftId: "mon-close" }, []), "NOT_ASSIGNED");
    expectWorkflowError(() => requestSwap(ctx, manager, { shiftId: "wed" }, []), "FORBIDDEN");
    const first = requestSwap(ctx, as("ana"), { shiftId: "wed" }, []);
    expectWorkflowError(() => requestSwap(ctx, as("ana"), { shiftId: "wed" }, [first]), "DUPLICATE");
    // a cancelled one does not block a new request
    const cancelled = cancelSwap(ctx, as("ana"), first);
    expect(requestSwap(ctx, as("ana"), { shiftId: "wed" }, [cancelled]).status).toBe("open");
  });

  it("blocks a claim that would create a clopening", () => {
    const open = requestSwap(ctx, as("dev"), { shiftId: "tue-open" }, []);
    const err = expectWorkflowError(() => claimSwap(ctx, as("ben"), open), "RULES");
    expect(err.violations.map((v) => v.code)).toEqual(["REST"]);
  });

  it("blocks untrained coworkers and enforces targeted offers", () => {
    const open = requestSwap(ctx, as("ana"), { shiftId: "wed", targetEmployeeId: "dev" }, []);
    expectWorkflowError(() => claimSwap(ctx, as("ben"), open), "FORBIDDEN");
    expectWorkflowError(() => claimSwap(ctx, as("ana"), open), "FORBIDDEN");
    expect(claimSwap(ctx, as("dev"), open).claimedById).toBe("dev");

    const untargeted = requestSwap(ctx, as("ben"), { shiftId: "mon-close" }, []);
    const err = expectWorkflowError(() => claimSwap(ctx, as("cat"), untargeted), "RULES");
    expect(err.violations.map((v) => v.code)).toContain("ROLE");
  });

  it("re-checks labor rules at approval time", () => {
    // Ben claims Ana's Wednesday, then gets put on an overlapping lunch
    // shift before the manager gets to the request.
    const claimed = claimSwap(ctx, as("ben"), requestSwap(ctx, as("ana"), { shiftId: "wed" }, []));
    ctx.state.assign("ben", "wed-lunch");
    const err = expectWorkflowError(() => approveSwap(ctx, manager, claimed), "RULES");
    expect(err.violations.map((v) => v.code)).toEqual(["OVERLAP"]);
    expect(ctx.state.crewOf("wed")).toEqual(["ana"]);
  });

  it("fails approval if the requester was moved off the shift", () => {
    const claimed = claimSwap(ctx, as("ben"), requestSwap(ctx, as("ana"), { shiftId: "wed" }, []));
    ctx.state.unassign("ana", "wed");
    ctx.state.assign("dev", "wed");
    const err = expectWorkflowError(() => approveSwap(ctx, manager, claimed), "NOT_ASSIGNED");
    expect(err.message).toMatch(/no longer/);
  });

  it("enforces who may reject, cancel and approve", () => {
    const open = requestSwap(ctx, as("ana"), { shiftId: "wed" }, []);
    expectWorkflowError(() => approveSwap(ctx, manager, open), "INVALID_STATE");
    expectWorkflowError(() => rejectSwap(ctx, as("ben"), open), "FORBIDDEN");
    expectWorkflowError(() => cancelSwap(ctx, as("ben"), open), "FORBIDDEN");
    const rejected = rejectSwap(ctx, manager, open, "short staffed");
    expect(rejected.history.at(-1)).toMatchObject({ action: "reject", note: "short staffed" });
    expectWorkflowError(() => cancelSwap(ctx, as("ana"), rejected), "INVALID_STATE");
  });

  it("lists eligible takers", () => {
    const swap: SwapRequest = requestSwap(ctx, as("dev"), { shiftId: "tue-open" }, []);
    // ben closes Monday (rest), cat is a cook, dev is the requester
    expect(eligibleTakers(ctx.state, swap)).toEqual(["ana"]);
  });
});

describe("buildReport", () => {
  it("summarises loads, cost and open seats", () => {
    const r = buildReport(employees, shifts, [{ shiftId: "wed", employeeId: "ana" }], DEFAULT_RULES);
    expect(r.totalSeats).toBe(4);
    expect(r.filledSeats).toBe(1);
    expect(r.totalCost).toBe(120);
    expect(r.loads.find((l) => l.employeeId === "ana")).toMatchObject({ minutes: 480, utilization: 0.2 });
    expect(r.violations).toEqual([]);
  });

  it("surfaces rule violations in hand-edited schedules", () => {
    const r = buildReport(
      employees,
      shifts,
      [
        { shiftId: "mon-close", employeeId: "ana" },
        { shiftId: "tue-open", employeeId: "ana" },
      ],
      DEFAULT_RULES,
    );
    expect(r.violations.map((v) => v.shiftId).sort()).toEqual(["mon-close", "tue-open"]);
  });
});
