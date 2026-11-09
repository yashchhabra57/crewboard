import { ScheduleState } from "./state.js";
import type { Assignment, Employee, LaborRules, Shift } from "./types.js";

export interface ObjectiveWeights {
  /** Dollars-equivalent penalty per empty seat. Dominates everything else. */
  unfilledSeat: number;
  /** Multiplier on utilization variance (0..~0.25). */
  fairness: number;
}

export const DEFAULT_WEIGHTS: ObjectiveWeights = { unfilledSeat: 10_000, fairness: 2_000 };

export interface OptimizeResult {
  assignments: Assignment[];
  before: number;
  after: number;
  moves: number;
}

export function objective(state: ScheduleState, w: ObjectiveWeights): number {
  return state.unfilledSeats() * w.unfilledSeat + state.totalCost() + state.utilizationVariance() * w.fairness;
}

/**
 * Hill-climbing over three neighbourhoods, best improvement first:
 *
 *   fill      put an eligible employee into an empty seat
 *   reassign  move a seat from one employee to another
 *   swap      exchange two employees between two shifts
 *
 * Every candidate move is checked against the full labor rules before it
 * is scored, so the schedule stays legal after each step. The loop stops
 * at a local optimum or after `maxMoves` accepted moves.
 */
export function optimize(
  employees: readonly Employee[],
  shifts: readonly Shift[],
  assignments: readonly Assignment[],
  rules: LaborRules,
  weights: ObjectiveWeights = DEFAULT_WEIGHTS,
  maxMoves = 500,
): OptimizeResult {
  const state = new ScheduleState(employees, shifts, rules);
  state.load(assignments);
  const before = objective(state, weights);
  let current = before;
  let moves = 0;

  while (moves < maxMoves) {
    let bestDelta = -1e-9;
    let apply: (() => void) | null = null;

    const consider = (doMove: () => void, undo: () => void) => {
      doMove();
      const delta = objective(state, weights) - current;
      undo();
      if (delta < bestDelta) {
        bestDelta = delta;
        apply = doMove;
      }
    };

    for (const s of shifts) {
      // fill
      if (state.openSeats(s.id) > 0) {
        for (const id of state.staticallyEligible(s.id)) {
          if (!state.canTake(id, s.id)) continue;
          consider(
            () => state.assign(id, s.id),
            () => state.unassign(id, s.id),
          );
        }
      }
      // reassign
      for (const from of [...state.crewOf(s.id)]) {
        for (const to of state.staticallyEligible(s.id)) {
          if (to === from) continue;
          state.unassign(from, s.id);
          const legal = state.canTake(to, s.id);
          state.assign(from, s.id);
          if (!legal) continue;
          consider(
            () => {
              state.unassign(from, s.id);
              state.assign(to, s.id);
            },
            () => {
              state.unassign(to, s.id);
              state.assign(from, s.id);
            },
          );
        }
      }
    }

    // swap
    for (let i = 0; i < shifts.length; i++) {
      for (let j = i + 1; j < shifts.length; j++) {
        const s1 = shifts[i]!;
        const s2 = shifts[j]!;
        for (const a of [...state.crewOf(s1.id)]) {
          for (const b of [...state.crewOf(s2.id)]) {
            if (a === b) continue;
            if (!state.staticallyEligible(s2.id).has(a) || !state.staticallyEligible(s1.id).has(b)) continue;
            state.unassign(a, s1.id);
            state.unassign(b, s2.id);
            let legal = state.canTake(a, s2.id);
            if (legal) {
              state.assign(a, s2.id);
              legal = state.canTake(b, s1.id);
              state.unassign(a, s2.id);
            }
            state.assign(a, s1.id);
            state.assign(b, s2.id);
            if (!legal) continue;
            consider(
              () => {
                state.unassign(a, s1.id);
                state.unassign(b, s2.id);
                state.assign(a, s2.id);
                state.assign(b, s1.id);
              },
              () => {
                state.unassign(a, s2.id);
                state.unassign(b, s1.id);
                state.assign(a, s1.id);
                state.assign(b, s2.id);
              },
            );
          }
        }
      }
    }

    if (!apply) break;
    (apply as () => void)();
    current += bestDelta;
    moves++;
  }

  return { assignments: state.toAssignments(), before, after: objective(state, weights), moves };
}
