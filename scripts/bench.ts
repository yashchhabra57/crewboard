/**
 * Solves the demo week and prints timing and quality numbers.
 *   npm run bench
 */
import { optimize } from "../src/server/domain/optimize.js";
import { buildReport } from "../src/server/domain/report.js";
import { solve } from "../src/server/domain/solver.js";
import { DEFAULT_RULES } from "../src/server/domain/types.js";
import { demoEmployees, demoShifts } from "../src/server/seed.js";

let t = performance.now();
const solved = solve(demoEmployees, demoShifts, DEFAULT_RULES);
const solveMs = performance.now() - t;
const first = buildReport(demoEmployees, demoShifts, solved.assignments, DEFAULT_RULES);

t = performance.now();
const tuned = optimize(demoEmployees, demoShifts, solved.assignments, DEFAULT_RULES);
const optMs = performance.now() - t;
const final = buildReport(demoEmployees, demoShifts, tuned.assignments, DEFAULT_RULES);

const spread = (r: typeof final) => {
  const u = r.loads.map((l) => l.utilization);
  return `${Math.min(...u).toFixed(2)}..${Math.max(...u).toFixed(2)}`;
};

console.log(`seats       ${final.filledSeats}/${final.totalSeats} filled`);
console.log(`solver      ${solveMs.toFixed(0)} ms, ${solved.stats.nodes} nodes, exhaustive=${solved.stats.exhaustive}`);
console.log(`optimizer   ${optMs.toFixed(0)} ms, ${tuned.moves} moves`);
console.log(`labor cost  $${first.totalCost} -> $${final.totalCost}`);
console.log(`overtime    ${first.overtimeMinutes / 60}h -> ${final.overtimeMinutes / 60}h`);
console.log(`utilization ${spread(first)} -> ${spread(final)}`);
for (const u of final.unfilled) console.log(`unfilled    ${u.shiftId}`, JSON.stringify(u.blockers));
