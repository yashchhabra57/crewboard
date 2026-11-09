import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import { Store } from "../src/server/db/store.js";
import type { LiveEvent } from "../src/server/live.js";
import type { Snapshot } from "../src/server/service.js";
import { emp, shift } from "./helpers.js";

let app: FastifyInstance;
let store: Store;

const M = { "x-actor": "manager" };
const as = (id: string) => ({ "x-actor": id });

beforeEach(async () => {
  store = new Store(":memory:");
  store.upsertEmployee(emp({ id: "ana", name: "Ana" }));
  store.upsertEmployee(emp({ id: "ben", name: "Ben" }));
  store.upsertEmployee(emp({ id: "cat", name: "Cat", roles: ["cook"] }));
  store.upsertShift(shift(0, 9, 17, { id: "mon" }));
  store.upsertShift(shift(1, 9, 17, { id: "tue" }));
  store.upsertShift(shift(2, 9, 17, { id: "wed-cook", role: "cook" }));
  let n = 0;
  ({ app } = await buildApp({ store, newId: () => `sw${++n}` }));
});

afterEach(async () => {
  await app.close();
  store.close();
});

async function generate() {
  const res = await app.inject({ method: "POST", url: "/api/schedule/generate", headers: M });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function schedule(): Promise<Snapshot> {
  return (await app.inject({ method: "GET", url: "/api/schedule" })).json();
}

describe("REST API", () => {
  it("reports health", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.json()).toEqual({ ok: true, liveClients: 0 });
  });

  it("generates a full schedule as manager only", async () => {
    const denied = await app.inject({ method: "POST", url: "/api/schedule/generate", headers: as("ana") });
    expect(denied.statusCode).toBe(403);
    const missing = await app.inject({ method: "POST", url: "/api/schedule/generate" });
    expect(missing.statusCode).toBe(401);

    const result = await generate();
    expect(result.report.filledSeats).toBe(3);
    expect(result.solver.exhaustive).toBe(true);
    const snap = await schedule();
    expect(snap.assignments).toContainEqual({ shiftId: "wed-cook", employeeId: "cat" });
  });

  it("validates bodies with helpful errors", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/shifts",
      headers: M,
      payload: { id: "bad", role: "pilot", start: 10, end: 5, headcount: 0 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues.length).toBeGreaterThan(0);
  });

  it("creates employees and shifts", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/employees",
      headers: M,
      payload: emp({ id: "dee", name: "Dee", roles: ["host"] }),
    });
    expect(res.statusCode).toBe(201);
    const s = await app.inject({ method: "POST", url: "/api/shifts", headers: M, payload: shift(3, 9, 13, { id: "thu" }) });
    expect(s.statusCode).toBe(201);
    const snap = await schedule();
    expect(snap.employees.map((e) => e.id)).toContain("dee");
    expect(snap.report.totalSeats).toBe(4);
  });

  it("runs a swap end to end and moves the assignment", async () => {
    await generate();
    const owner = (await schedule()).assignments.find((a) => a.shiftId === "mon")!.employeeId;
    const other = owner === "ana" ? "ben" : "ana";

    const created = await app.inject({
      method: "POST",
      url: "/api/swaps",
      headers: as(owner),
      payload: { shiftId: "mon", note: "family thing" },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    const cands = await app.inject({ method: "GET", url: `/api/swaps/${id}/candidates` });
    expect(cands.json().employeeIds).toEqual([other]);

    const badClaim = await app.inject({ method: "POST", url: `/api/swaps/${id}/claim`, headers: as("cat") });
    expect(badClaim.statusCode).toBe(422);
    expect(badClaim.json().violations[0].code).toBe("ROLE");

    const claim = await app.inject({ method: "POST", url: `/api/swaps/${id}/claim`, headers: as(other) });
    expect(claim.json().status).toBe("claimed");

    const approve = await app.inject({
      method: "POST",
      url: `/api/swaps/${id}/approve`,
      headers: M,
      payload: { note: "ok" },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().status).toBe("approved");

    const snap = await schedule();
    expect(snap.assignments).toContainEqual({ shiftId: "mon", employeeId: other });

    const again = await app.inject({ method: "POST", url: `/api/swaps/${id}/approve`, headers: M });
    expect(again.statusCode).toBe(409);
  });

  it("returns 404 for unknown swaps and shifts", async () => {
    expect((await app.inject({ method: "POST", url: "/api/swaps/nope/claim", headers: as("ana") })).statusCode).toBe(404);
    const res = await app.inject({ method: "POST", url: "/api/swaps", headers: as("ana"), payload: { shiftId: "zzz" } });
    expect(res.statusCode).toBe(404);
  });

  it("cancels open swaps when the schedule is regenerated", async () => {
    await generate();
    const owner = (await schedule()).assignments.find((a) => a.shiftId === "tue")!.employeeId;
    await app.inject({ method: "POST", url: "/api/swaps", headers: as(owner), payload: { shiftId: "tue" } });
    const result = await generate();
    expect(result.cancelledSwaps).toBe(1);
    const swaps = (await app.inject({ method: "GET", url: "/api/swaps" })).json();
    expect(swaps[0].status).toBe("cancelled");
    expect(swaps[0].history.at(-1).note).toMatch(/regenerated/);
  });

  it("updates labor rules", async () => {
    const snap = await schedule();
    const res = await app.inject({
      method: "PUT",
      url: "/api/rules",
      headers: M,
      payload: { ...snap.rules, minRestMinutes: 480 },
    });
    expect(res.statusCode).toBe(200);
    expect((await schedule()).rules.minRestMinutes).toBe(480);
  });
});

describe("WebSocket live updates", () => {
  it("pushes schedule and swap events to connected clients", async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as { port: number };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const events: LiveEvent[] = [];
    const waitFor = (pred: (e: LiveEvent) => boolean) =>
      new Promise<LiveEvent>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for event")), 3000);
        const check = () => {
          const hit = events.find(pred);
          if (hit) {
            clearTimeout(timer);
            resolve(hit);
          } else setTimeout(check, 10);
        };
        check();
      });
    ws.addEventListener("message", (m) => events.push(JSON.parse(String(m.data))));

    await waitFor((e) => e.type === "hello");
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.json().liveClients).toBe(1);

    await generate();
    await waitFor((e) => e.type === "schedule.updated");

    const owner = (await schedule()).assignments.find((a) => a.shiftId === "mon")!.employeeId;
    await app.inject({ method: "POST", url: "/api/swaps", headers: as(owner), payload: { shiftId: "mon" } });
    const swapEvent = await waitFor((e) => e.type === "swap.updated");
    expect(swapEvent).toMatchObject({ type: "swap.updated", swap: { shiftId: "mon", status: "open" } });
    ws.close();
  });
});
