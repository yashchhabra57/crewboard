import { checkAssignment } from "./rules.js";
import type { ScheduleState } from "./state.js";
import type { Violation } from "./types.js";

/**
 * Shift-swap approval workflow.
 *
 *   open ──claim──▶ claimed ──approve──▶ approved
 *    │                 │
 *    ├──reject─────────┴──▶ rejected     (manager)
 *    └──cancel─────────┴──▶ cancelled    (requester)
 *
 * Rules are checked twice: when a coworker claims the shift (fast feedback)
 * and again at approval time, because the schedule may have changed in
 * between (another swap approved, schedule regenerated).
 *
 * Every function is pure with respect to the swap: it returns a new
 * SwapRequest and never mutates its input. `approve` additionally reports
 * the assignment change for the caller to persist.
 */

export type SwapStatus = "open" | "claimed" | "approved" | "rejected" | "cancelled";
export type SwapAction = "request" | "claim" | "approve" | "reject" | "cancel";

export const ACTIVE_STATUSES: readonly SwapStatus[] = ["open", "claimed"];

export type Actor = { kind: "manager"; id: string } | { kind: "employee"; id: string };

export interface SwapEvent {
  at: string;
  actorId: string;
  action: SwapAction;
  note?: string;
}

export interface SwapRequest {
  id: string;
  shiftId: string;
  fromEmployeeId: string;
  /** If set, only this coworker may claim the shift. */
  targetEmployeeId: string | null;
  claimedById: string | null;
  status: SwapStatus;
  note: string;
  history: SwapEvent[];
  createdAt: string;
  updatedAt: string;
}

export type WorkflowErrorCode = "FORBIDDEN" | "INVALID_STATE" | "NOT_ASSIGNED" | "RULES" | "DUPLICATE";

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  readonly violations: Violation[];
  constructor(code: WorkflowErrorCode, message: string, violations: Violation[] = []) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.violations = violations;
  }
}

export interface WorkflowContext {
  state: ScheduleState;
  now: () => Date;
  newId: () => string;
}

function requireEmployee(actor: Actor): string {
  if (actor.kind !== "employee") throw new WorkflowError("FORBIDDEN", "Only employees can do this");
  return actor.id;
}

function requireManager(actor: Actor): void {
  if (actor.kind !== "manager") throw new WorkflowError("FORBIDDEN", "Only a manager can do this");
}

function requireStatus(swap: SwapRequest, allowed: readonly SwapStatus[]): void {
  if (!allowed.includes(swap.status)) {
    throw new WorkflowError("INVALID_STATE", `Swap is ${swap.status}; expected ${allowed.join(" or ")}`);
  }
}

function transition(
  ctx: WorkflowContext,
  swap: SwapRequest,
  actor: Actor,
  action: SwapAction,
  patch: Partial<SwapRequest>,
  note?: string,
): SwapRequest {
  const at = ctx.now().toISOString();
  const event: SwapEvent = note ? { at, actorId: actor.id, action, note } : { at, actorId: actor.id, action };
  return { ...swap, ...patch, updatedAt: at, history: [...swap.history, event] };
}

/** Rule violations if `employeeId` took over the swap's shift right now. */
export function takeoverViolations(state: ScheduleState, swap: SwapRequest, employeeId: string): Violation[] {
  const shift = state.shift(swap.shiftId);
  if (state.crewOf(shift.id).includes(employeeId)) {
    return [{ code: "OVERLAP", message: `${state.employee(employeeId).name} is already on this shift` }];
  }
  return checkAssignment(state.employee(employeeId), shift, state.shiftsOf(employeeId), state.rules);
}

/** Coworkers who could legally take this shift. Powers the "who can cover?" list. */
export function eligibleTakers(state: ScheduleState, swap: SwapRequest): string[] {
  return state.employees
    .map((e) => e.id)
    .filter((id) => id !== swap.fromEmployeeId)
    .filter((id) => swap.targetEmployeeId === null || id === swap.targetEmployeeId)
    .filter((id) => takeoverViolations(state, swap, id).length === 0);
}

export function requestSwap(
  ctx: WorkflowContext,
  actor: Actor,
  input: { shiftId: string; targetEmployeeId?: string | null; note?: string },
  existing: readonly SwapRequest[],
): SwapRequest {
  const from = requireEmployee(actor);
  ctx.state.shift(input.shiftId); // throws on unknown shift
  if (!ctx.state.crewOf(input.shiftId).includes(from)) {
    throw new WorkflowError("NOT_ASSIGNED", "You can only offer a shift you are scheduled for");
  }
  const target = input.targetEmployeeId ?? null;
  if (target !== null) {
    ctx.state.employee(target);
    if (target === from) throw new WorkflowError("FORBIDDEN", "You cannot swap a shift with yourself");
  }
  const dup = existing.find(
    (s) => s.shiftId === input.shiftId && s.fromEmployeeId === from && ACTIVE_STATUSES.includes(s.status),
  );
  if (dup) throw new WorkflowError("DUPLICATE", "You already have an active swap for this shift");

  const at = ctx.now().toISOString();
  const note = input.note?.trim() ?? "";
  return {
    id: ctx.newId(),
    shiftId: input.shiftId,
    fromEmployeeId: from,
    targetEmployeeId: target,
    claimedById: null,
    status: "open",
    note,
    history: [note ? { at, actorId: from, action: "request", note } : { at, actorId: from, action: "request" }],
    createdAt: at,
    updatedAt: at,
  };
}

export function claimSwap(ctx: WorkflowContext, actor: Actor, swap: SwapRequest): SwapRequest {
  const taker = requireEmployee(actor);
  requireStatus(swap, ["open"]);
  if (taker === swap.fromEmployeeId) throw new WorkflowError("FORBIDDEN", "You cannot claim your own shift");
  if (swap.targetEmployeeId !== null && swap.targetEmployeeId !== taker) {
    throw new WorkflowError("FORBIDDEN", "This swap was offered to someone else");
  }
  const violations = takeoverViolations(ctx.state, swap, taker);
  if (violations.length > 0) {
    throw new WorkflowError("RULES", "Taking this shift would break labor rules", violations);
  }
  return transition(ctx, swap, actor, "claim", { status: "claimed", claimedById: taker });
}

export interface ApprovalResult {
  swap: SwapRequest;
  change: { shiftId: string; fromEmployeeId: string; toEmployeeId: string };
}

export function approveSwap(ctx: WorkflowContext, actor: Actor, swap: SwapRequest, note?: string): ApprovalResult {
  requireManager(actor);
  requireStatus(swap, ["claimed"]);
  const taker = swap.claimedById!;
  if (!ctx.state.crewOf(swap.shiftId).includes(swap.fromEmployeeId)) {
    throw new WorkflowError("NOT_ASSIGNED", "The requester is no longer on this shift");
  }
  const violations = takeoverViolations(ctx.state, swap, taker);
  if (violations.length > 0) {
    throw new WorkflowError("RULES", "The schedule changed and this swap now breaks labor rules", violations);
  }
  ctx.state.unassign(swap.fromEmployeeId, swap.shiftId);
  ctx.state.assign(taker, swap.shiftId);
  return {
    swap: transition(ctx, swap, actor, "approve", { status: "approved" }, note),
    change: { shiftId: swap.shiftId, fromEmployeeId: swap.fromEmployeeId, toEmployeeId: taker },
  };
}

export function rejectSwap(ctx: WorkflowContext, actor: Actor, swap: SwapRequest, note?: string): SwapRequest {
  requireManager(actor);
  requireStatus(swap, ACTIVE_STATUSES);
  return transition(ctx, swap, actor, "reject", { status: "rejected" }, note);
}

export function cancelSwap(ctx: WorkflowContext, actor: Actor, swap: SwapRequest): SwapRequest {
  const who = requireEmployee(actor);
  if (who !== swap.fromEmployeeId) throw new WorkflowError("FORBIDDEN", "Only the requester can cancel");
  requireStatus(swap, ACTIVE_STATUSES);
  return transition(ctx, swap, actor, "cancel", { status: "cancelled" });
}
