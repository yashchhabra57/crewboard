import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/server/db/store.js";
import type { SwapRequest } from "../src/server/domain/swaps.js";
import { DEFAULT_RULES } from "../src/server/domain/types.js";
import { emp, shift } from "./helpers.js";

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => store.close());

const swap = (overrides: Partial<SwapRequest> = {}): SwapRequest => ({
  id: "sw1",
  shiftId: "s-0-9",
  fromEmployeeId: "a",
  targetEmployeeId: null,
  claimedById: null,
  status: "open",
  note: "",
  history: [],
  createdAt: "2026-11-08T00:00:00.000Z",
  updatedAt: "2026-11-08T00:00:00.000Z",
  ...overrides,
});

describe("Store", () => {
  it("round-trips employees and shifts", () => {
    expect(store.isEmpty()).toBe(true);
    const e = emp({ id: "a", name: "Ana", roles: ["server", "host"], isMinor: true });
    store.upsertEmployee(e);
    store.upsertShift(shift(0, 9, 17));
    expect(store.listEmployees()).toEqual([e]);
    expect(store.listShifts()).toEqual([shift(0, 9, 17)]);
    store.upsertEmployee({ ...e, name: "Ana B" });
    expect(store.listEmployees()[0]?.name).toBe("Ana B");
    expect(store.isEmpty()).toBe(false);
  });

  it("replaces and moves assignments", () => {
    store.upsertEmployee(emp({ id: "a" }));
    store.upsertEmployee(emp({ id: "b", name: "Ben" }));
    store.upsertShift(shift(0, 9, 17));
    store.replaceAssignments([{ shiftId: "s-0-9", employeeId: "a" }]);
    store.moveAssignment("s-0-9", "a", "b");
    expect(store.listAssignments()).toEqual([{ shiftId: "s-0-9", employeeId: "b" }]);
    expect(() => store.moveAssignment("s-0-9", "a", "b")).toThrow(/No assignment/);
  });

  it("rolls back a failed transaction", () => {
    store.upsertEmployee(emp({ id: "a" }));
    store.upsertShift(shift(0, 9, 17));
    store.replaceAssignments([{ shiftId: "s-0-9", employeeId: "a" }]);
    // second row violates the foreign key, so nothing should change
    expect(() =>
      store.replaceAssignments([
        { shiftId: "s-0-9", employeeId: "a" },
        { shiftId: "s-0-9", employeeId: "ghost" },
      ]),
    ).toThrow();
    expect(store.listAssignments()).toEqual([{ shiftId: "s-0-9", employeeId: "a" }]);
  });

  it("stores swaps and cancels the active ones", () => {
    store.upsertShift(shift(0, 9, 17));
    store.saveSwap(swap());
    store.saveSwap(swap({ id: "sw2", status: "approved" }));
    const closed = store.cancelActiveSwaps((s) => ({ ...s, status: "cancelled" }));
    expect(closed.map((s) => s.id)).toEqual(["sw1"]);
    expect(store.getSwap("sw1")?.status).toBe("cancelled");
    expect(store.getSwap("sw2")?.status).toBe("approved");
    expect(store.getSwap("nope")).toBeUndefined();
  });

  it("persists rule overrides on top of defaults", () => {
    expect(store.getRules()).toEqual(DEFAULT_RULES);
    store.setRules({ ...DEFAULT_RULES, minRestMinutes: 8 * 60 });
    expect(store.getRules().minRestMinutes).toBe(480);
  });
});
