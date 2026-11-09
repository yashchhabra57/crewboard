import { checkAssignment } from "./rules.js";
import { ScheduleState } from "./state.js";
import type { Assignment, Employee, LaborRules, Shift, ViolationCode } from "./types.js";

export interface SolveOptions {
  /** Hard cap on search nodes so a pathological roster cannot hang the API. */
  nodeLimit?: number;
}

export interface UnfilledSeat {
  shiftId: string;
  /** How many candidates were blocked by each rule, for the "why is this empty?" UI. */
  blockers: Partial<Record<ViolationCode, number>>;
}

export interface SolveResult {
  assignments: Assignment[];
  unfilled: UnfilledSeat[];
  stats: {
    nodes: number;
    /** True when the search finished, i.e. no schedule fills more seats. */
    exhaustive: boolean;
  };
}

interface Seat {
  shiftId: string;
}

/**
 * Fills shift seats with a depth-first search over seats:
 *
 * - Most-constrained-first: at every node we branch on the open seat with the
 *   fewest legal candidates right now (MRV). Hard seats get decided early,
 *   which is what makes backtracking practical on real rosters.
 * - Candidates are ordered least-loaded first (relative to their personal
 *   cap), then cheapest, which tends to produce balanced schedules on the
 *   first descent.
 * - Leaving a seat empty is always the last branch, so the search returns
 *   the best partial schedule instead of failing when the week is
 *   understaffed. Branch-and-bound on the unfilled count prunes the rest:
 *   any seat that currently has zero candidates must end up empty, which
 *   gives a cheap lower bound.
 */
export function solve(
  employees: readonly Employee[],
  shifts: readonly Shift[],
  rules: LaborRules,
  options: SolveOptions = {},
): SolveResult {
  const nodeLimit = options.nodeLimit ?? 50_000;
  const state = new ScheduleState(employees, shifts, rules);
  const seats: Seat[] = [];
  for (const s of shifts) for (let i = 0; i < s.headcount; i++) seats.push({ shiftId: s.id });

  const decided = new Array<boolean>(seats.length).fill(false);
  let unfilledSoFar = 0;
  let nodes = 0;
  let aborted = false;
  let best: Assignment[] | null = null;
  let bestUnfilled = Number.POSITIVE_INFINITY;

  const candidatesFor = (seat: Seat): string[] =>
    [...state.staticallyEligible(seat.shiftId)].filter((id) => state.canTake(id, seat.shiftId));

  const order = (ids: string[]): string[] =>
    ids.sort((a, b) => {
      const ea = state.employee(a);
      const eb = state.employee(b);
      const ua = state.minutesOf(a) / Math.max(1, ea.maxWeeklyMinutes);
      const ub = state.minutesOf(b) / Math.max(1, eb.maxWeeklyMinutes);
      return ua - ub || ea.hourlyRate - eb.hourlyRate || a.localeCompare(b);
    });

  const dfs = (remaining: number): void => {
    if (aborted) return;
    if (++nodes > nodeLimit) {
      aborted = true;
      return;
    }
    if (remaining === 0) {
      if (unfilledSoFar < bestUnfilled) {
        bestUnfilled = unfilledSoFar;
        best = state.toAssignments();
      }
      return;
    }

    // Pick the most constrained open seat and compute the lower bound in one pass.
    let pick = -1;
    let pickCandidates: string[] = [];
    let forcedEmpty = 0;
    for (let i = 0; i < seats.length; i++) {
      if (decided[i]) continue;
      const c = candidatesFor(seats[i]!);
      if (c.length === 0) forcedEmpty++;
      if (pick < 0 || c.length < pickCandidates.length) {
        pick = i;
        pickCandidates = c;
      }
    }
    if (unfilledSoFar + forcedEmpty >= bestUnfilled) return;

    const seat = seats[pick]!;
    decided[pick] = true;
    for (const id of order(pickCandidates)) {
      state.assign(id, seat.shiftId);
      dfs(remaining - 1);
      state.unassign(id, seat.shiftId);
      if (aborted || bestUnfilled === 0) break;
    }
    // Leaving this seat empty: the other forced-empty seats still count.
    const otherForced = pickCandidates.length === 0 ? forcedEmpty - 1 : forcedEmpty;
    if (!aborted && unfilledSoFar + 1 + otherForced < bestUnfilled) {
      unfilledSoFar++;
      dfs(remaining - 1);
      unfilledSoFar--;
    }
    decided[pick] = false;
  };

  dfs(seats.length);

  // If the node budget ran out before any leaf, fall back to a greedy pass.
  const final = new ScheduleState(employees, shifts, rules);
  if (best) final.load(best);
  else greedyFill(final);

  return {
    assignments: final.toAssignments(),
    unfilled: explainUnfilled(final),
    stats: { nodes: Math.min(nodes, nodeLimit), exhaustive: !aborted },
  };
}

/** One pass, most-constrained shift first. Used only as a safety net. */
export function greedyFill(state: ScheduleState): void {
  const byTightness = [...state.shifts].sort(
    (a, b) => state.staticallyEligible(a.id).size - state.staticallyEligible(b.id).size,
  );
  for (const s of byTightness) {
    for (const id of state.staticallyEligible(s.id)) {
      if (state.openSeats(s.id) === 0) break;
      if (state.canTake(id, s.id)) state.assign(id, s.id);
    }
  }
}

export function explainUnfilled(state: ScheduleState): UnfilledSeat[] {
  const out: UnfilledSeat[] = [];
  for (const s of state.shifts) {
    const open = state.openSeats(s.id);
    if (open <= 0) continue;
    const blockers: Partial<Record<ViolationCode, number>> = {};
    for (const e of state.employees) {
      if (state.crewOf(s.id).includes(e.id)) continue;
      const seen = new Set<ViolationCode>();
      for (const v of checkAssignment(e, s, state.shiftsOf(e.id), state.rules)) seen.add(v.code);
      for (const code of seen) blockers[code] = (blockers[code] ?? 0) + 1;
    }
    for (let i = 0; i < open; i++) out.push({ shiftId: s.id, blockers });
  }
  return out;
}
