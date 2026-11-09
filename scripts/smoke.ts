/**
 * End-to-end smoke test against a real listening server with the built
 * web client: serves the SPA, seeds the demo week, generates a schedule,
 * runs a swap through approval, and checks a WebSocket client saw it.
 *
 *   npm run build && npm run smoke
 */
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/server/app.js";
import { Store } from "../src/server/db/store.js";
import type { LiveEvent } from "../src/server/live.js";
import { demoEmployees, demoShifts } from "../src/server/seed.js";

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`SMOKE FAIL: ${msg}`);
  console.log(`  ok  ${msg}`);
}

const store = new Store(":memory:");
demoEmployees.forEach((e) => store.upsertEmployee(e));
demoShifts.forEach((s) => store.upsertShift(s));
const webRoot = fileURLToPath(new URL("../dist/web", import.meta.url));
const { app } = await buildApp({ store, webRoot });
await app.listen({ port: 0, host: "127.0.0.1" });
const { port } = app.server.address() as { port: number };
const base = `http://127.0.0.1:${port}`;

const req = async (method: string, path: string, actor?: string, body?: unknown) => {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(actor ? { "x-actor": actor } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text() };
};

try {
  const html = await req("GET", "/");
  check(html.status === 200 && String(html.body).includes('<div id="root">'), "serves the web client");
  const deep = await req("GET", "/some/client/route");
  check(deep.status === 200, "SPA fallback serves index.html");
  const missing = await req("GET", "/api/nope");
  check(missing.status === 404, "unknown API routes 404 as JSON");

  const events: LiveEvent[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.addEventListener("message", (m) => events.push(JSON.parse(String(m.data))));
  await new Promise((r) => ws.addEventListener("open", r));

  const gen = await req("POST", "/api/schedule/generate", "manager", {});
  const report = gen.body.report;
  check(gen.status === 200, `generates demo week (${report.filledSeats}/${report.totalSeats} seats, ${gen.body.solver.ms + gen.body.optimizer.ms} ms)`);
  check(report.violations.length === 0, "generated schedule has no rule violations");

  const snap = (await req("GET", "/api/schedule")).body;
  // A tight week can leave a shift nobody may legally take; offer shifts
  // until one has a cover, withdrawing the ones that don't.
  let a: { shiftId: string; employeeId: string } | undefined;
  let offer: { status: number; body: { id: string } } | undefined;
  let cands: string[] = [];
  let withdrawn = 0;
  for (const x of snap.assignments as { shiftId: string; employeeId: string }[]) {
    const o = await req("POST", "/api/swaps", x.employeeId, { shiftId: x.shiftId, note: "smoke test" });
    check(o.status === 201 || o.status === 409, `${x.employeeId} offers ${x.shiftId}`);
    if (o.status !== 201) continue;
    const c = (await req("GET", `/api/swaps/${o.body.id}/candidates`)).body.employeeIds as string[];
    if (c.length > 0) {
      [a, offer, cands] = [x, o, c];
      break;
    }
    const w = await req("POST", `/api/swaps/${o.body.id}/cancel`, x.employeeId);
    check(w.body.status === "cancelled", "requester withdraws an uncoverable offer");
    withdrawn++;
  }
  check(a && offer, `found a shift with ${cands.length} legal cover(s) after ${withdrawn} uncoverable offer(s)`);
  const claim = await req("POST", `/api/swaps/${offer.body.id}/claim`, cands[0]);
  check(claim.body.status === "claimed", `${cands[0]} claims it`);
  const ok = await req("POST", `/api/swaps/${offer.body.id}/approve`, "manager", { note: "approved" });
  check(ok.body.status === "approved", "manager approves");
  const after = (await req("GET", "/api/schedule")).body;
  check(
    after.assignments.some((x: { shiftId: string; employeeId: string }) => x.shiftId === a.shiftId && x.employeeId === cands[0]),
    "assignment moved to the new employee",
  );

  await new Promise((r) => setTimeout(r, 100));
  check(events.some((e) => e.type === "swap.updated" && e.swap.status === "approved"), "WebSocket client saw the approval");
  ws.close();
  console.log("smoke passed");
} finally {
  await app.close();
  store.close();
}
