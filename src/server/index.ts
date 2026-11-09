import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { Store } from "./db/store.js";
import { demoEmployees, demoShifts } from "./seed.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const dbPath = process.env.DATABASE_PATH ?? "data/crewboard.db";
const seedDemo = (process.env.SEED_DEMO ?? "true") !== "false";
const webRoot = fileURLToPath(new URL("../web", import.meta.url));

const store = new Store(dbPath);
const { app, service } = await buildApp({ store, logger: true, webRoot });

if (seedDemo && store.isEmpty()) {
  store.transaction(() => {
    demoEmployees.forEach((e) => store.upsertEmployee(e));
    demoShifts.forEach((s) => store.upsertShift(s));
  });
  const r = service.generate({ kind: "manager", id: "manager" });
  app.log.info(`Seeded demo week: ${r.report.filledSeats}/${r.report.totalSeats} seats filled`);
}

const shutdown = async () => {
  await app.close();
  store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port, host });
