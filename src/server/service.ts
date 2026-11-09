import { randomUUID } from "node:crypto";
import type { Store } from "./db/store.js";
import { optimize } from "./domain/optimize.js";
import { buildReport, type ScheduleReport } from "./domain/report.js";
import { solve } from "./domain/solver.js";
import { NotFoundError, ScheduleState } from "./domain/state.js";
import {
  approveSwap,
  cancelSwap,
  claimSwap,
  eligibleTakers,
  expireSwap,
  rejectSwap,
  requestSwap,
  WorkflowError,
  type Actor,
  type SwapRequest,
  type WorkflowContext,
} from "./domain/swaps.js";
import type { Assignment, Employee, LaborRules, Shift } from "./domain/types.js";
import type { Broadcaster } from "./live.js";

export interface Snapshot {
  employees: Employee[];
  shifts: Shift[];
  assignments: Assignment[];
  rules: LaborRules;
  report: ScheduleReport;
}

export interface GenerateResult {
  report: ScheduleReport;
  solver: { nodes: number; exhaustive: boolean; ms: number };
  optimizer: { moves: number; before: number; after: number; ms: number };
  cancelledSwaps: number;
}



/**
 * Application service: loads current state from the store, runs the pure
 * domain functions, persists the result, and announces it to live clients.
 */
export class CrewService {
  constructor(
    private readonly store: Store,
    private readonly live: Broadcaster,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}

  snapshot(): Snapshot {
    const employees = this.store.listEmployees();
    const shifts = this.store.listShifts();
    const assignments = this.store.listAssignments();
    const rules = this.store.getRules();
    return { employees, shifts, assignments, rules, report: buildReport(employees, shifts, assignments, rules) };
  }

  hasEmployee(id: string): boolean {
    return this.store.listEmployees().some((e) => e.id === id);
  }

  upsertEmployee(actor: Actor, e: Employee): void {
    this.requireManager(actor);
    this.store.upsertEmployee(e);
    this.live.broadcast({ type: "schedule.updated", reason: `Employee ${e.name} saved` });
  }

  upsertShift(actor: Actor, s: Shift): void {
    this.requireManager(actor);
    this.store.upsertShift(s);
    this.live.broadcast({ type: "schedule.updated", reason: `Shift ${s.id} saved` });
  }

  setRules(actor: Actor, rules: LaborRules): void {
    this.requireManager(actor);
    this.store.setRules(rules);
    this.live.broadcast({ type: "schedule.updated", reason: "Labor rules changed" });
  }

  /** Solve + optimize the week, replace the schedule, and close stale swaps. */
  generate(actor: Actor, nodeLimit?: number): GenerateResult {
    this.requireManager(actor);
    const employees = this.store.listEmployees();
    const shifts = this.store.listShifts();
    const rules = this.store.getRules();

    let t = performance.now();
    const solved = solve(employees, shifts, rules, nodeLimit ? { nodeLimit } : {});
    const solveMs = performance.now() - t;
    t = performance.now();
    const tuned = optimize(employees, shifts, solved.assignments, rules);
    const optMs = performance.now() - t;

    const ctx = this.context();
    const closed = this.store.transaction(() => {
      this.store.replaceAssignments(tuned.assignments);
      return this.store.cancelActiveSwaps((s) => expireSwap(ctx, s, actor.id, "Schedule was regenerated"));
    });

    this.live.broadcast({ type: "schedule.updated", reason: "Schedule generated" });
    for (const s of closed) this.live.broadcast({ type: "swap.updated", swap: s });

    return {
      report: buildReport(employees, shifts, tuned.assignments, rules),
      solver: { ...solved.stats, ms: Math.round(solveMs) },
      optimizer: {
        moves: tuned.moves,
        before: Math.round(tuned.before),
        after: Math.round(tuned.after),
        ms: Math.round(optMs),
      },
      cancelledSwaps: closed.length,
    };
  }

  listSwaps(): SwapRequest[] {
    return this.store.listSwaps();
  }

  candidates(swapId: string): string[] {
    return eligibleTakers(this.context().state, this.getSwap(swapId));
  }

  requestSwap(actor: Actor, input: { shiftId: string; targetEmployeeId?: string | null; note?: string }): SwapRequest {
    const swap = requestSwap(this.context(), actor, input, this.store.listSwaps());
    return this.save(swap);
  }

  claim(actor: Actor, swapId: string): SwapRequest {
    return this.save(claimSwap(this.context(), actor, this.getSwap(swapId)));
  }

  approve(actor: Actor, swapId: string, note?: string): SwapRequest {
    const { swap, change } = approveSwap(this.context(), actor, this.getSwap(swapId), note);
    this.store.transaction(() => {
      this.store.moveAssignment(change.shiftId, change.fromEmployeeId, change.toEmployeeId);
      this.store.saveSwap(swap);
    });
    this.live.broadcast({ type: "swap.updated", swap });
    this.live.broadcast({ type: "schedule.updated", reason: "Swap approved" });
    return swap;
  }

  reject(actor: Actor, swapId: string, note?: string): SwapRequest {
    return this.save(rejectSwap(this.context(), actor, this.getSwap(swapId), note));
  }

  cancel(actor: Actor, swapId: string): SwapRequest {
    return this.save(cancelSwap(this.context(), actor, this.getSwap(swapId)));
  }

  private save(swap: SwapRequest): SwapRequest {
    this.store.saveSwap(swap);
    this.live.broadcast({ type: "swap.updated", swap });
    return swap;
  }

  private getSwap(id: string): SwapRequest {
    const s = this.store.getSwap(id);
    if (!s) throw new NotFoundError(`Swap ${id} not found`);
    return s;
  }

  private context(): WorkflowContext {
    const state = new ScheduleState(this.store.listEmployees(), this.store.listShifts(), this.store.getRules());
    state.load(this.store.listAssignments());
    return { state, now: this.now, newId: this.newId };
  }

  private requireManager(actor: Actor): void {
    if (actor.kind !== "manager") throw new WorkflowError("FORBIDDEN", "Only a manager can do this");
  }
}
