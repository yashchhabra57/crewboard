import type { ScheduleReport } from "../server/domain/report.js";
import type { SwapRequest } from "../server/domain/swaps.js";
import type { Assignment, Employee, LaborRules, Shift, Violation } from "../server/domain/types.js";

export type { Assignment, Employee, LaborRules, ScheduleReport, Shift, SwapRequest, Violation };

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

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly violations: Violation[] = [],
  ) {
    super(message);
  }
}

async function call<T>(actor: string, method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "x-actor": actor, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? res.statusText, res.status, data.violations ?? []);
  return data as T;
}

export const api = {
  schedule: (actor: string) => call<Snapshot>(actor, "GET", "/api/schedule"),
  swaps: (actor: string) => call<SwapRequest[]>(actor, "GET", "/api/swaps"),
  generate: (actor: string) => call<GenerateResult>(actor, "POST", "/api/schedule/generate", {}),
  requestSwap: (actor: string, shiftId: string, note: string) =>
    call<SwapRequest>(actor, "POST", "/api/swaps", { shiftId, note }),
  candidates: (actor: string, id: string) =>
    call<{ employeeIds: string[] }>(actor, "GET", `/api/swaps/${id}/candidates`),
  act: (actor: string, id: string, action: "claim" | "approve" | "reject" | "cancel") =>
    call<SwapRequest>(actor, "POST", `/api/swaps/${id}/${action}`, {}),
};
