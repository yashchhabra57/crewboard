import { existsSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { Store } from "./db/store.js";
import { NotFoundError } from "./domain/state.js";
import { WorkflowError, type Actor } from "./domain/swaps.js";
import { ROLES } from "./domain/types.js";
import { LiveHub } from "./live.js";
import { CrewService } from "./service.js";

export interface AppOptions {
  store: Store;
  logger?: boolean;
  /** Directory with the built web client; served when it exists. */
  webRoot?: string;
  now?: () => Date;
  newId?: () => string;
}

const WEEK_MINUTES = 7 * 24 * 60;
const timeWindow = z
  .object({ start: z.number().int().min(0).max(WEEK_MINUTES), end: z.number().int().min(0).max(WEEK_MINUTES + 1440) })
  .refine((w) => w.end > w.start, "end must be after start");

const employeeBody = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  name: z.string().trim().min(1).max(80),
  roles: z.array(z.enum(ROLES)).min(1),
  hourlyRate: z.number().positive().max(500),
  maxWeeklyMinutes: z.number().int().min(0).max(WEEK_MINUTES),
  isMinor: z.boolean(),
  availability: z.array(timeWindow),
});

const shiftBody = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,60}$/),
    role: z.enum(ROLES),
    start: z.number().int().min(0).max(WEEK_MINUTES - 1),
    end: z.number().int().min(1).max(WEEK_MINUTES + 1440),
    headcount: z.number().int().min(1).max(20),
  })
  .refine((s) => s.end > s.start, "end must be after start");

const rulesBody = z.object({
  minRestMinutes: z.number().int().min(0).max(1440),
  overtimeThresholdMinutes: z.number().int().min(0).max(WEEK_MINUTES),
  overtimeMultiplier: z.number().min(1).max(3),
  maxConsecutiveDays: z.number().int().min(1).max(7),
  minorMaxDailyMinutes: z.number().int().min(0).max(1440),
  minorMaxWeeklyMinutes: z.number().int().min(0).max(WEEK_MINUTES),
  minorLatestEndMinuteOfDay: z.number().int().min(0).max(1440),
});

const swapBody = z.object({
  shiftId: z.string().min(1),
  targetEmployeeId: z.string().min(1).nullish(),
  note: z.string().max(280).optional(),
});

const noteBody = z.object({ note: z.string().max(280).optional() }).default({});
const generateBody = z.object({ nodeLimit: z.number().int().min(1).max(500_000).optional() }).default({});

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const STATUS_BY_CODE: Record<WorkflowError["code"], number> = {
  FORBIDDEN: 403,
  INVALID_STATE: 409,
  NOT_ASSIGNED: 409,
  DUPLICATE: 409,
  RULES: 422,
};

/**
 * Demo-grade identity: the client says who it is acting as in the
 * `x-actor` header ("manager" or an employee id). Real deployments would
 * put this behind proper auth; see the README's limitations.
 */
function actorFrom(req: FastifyRequest, service: CrewService): Actor {
  const raw = req.headers["x-actor"];
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (!id) throw new HttpError(401, "Missing x-actor header");
  if (id === "manager") return { kind: "manager", id };
  if (!service.hasEmployee(id)) throw new HttpError(401, `Unknown actor ${id}`);
  return { kind: "employee", id };
}

export async function buildApp(opts: AppOptions): Promise<{ app: FastifyInstance; hub: LiveHub; service: CrewService }> {
  const app = Fastify({ logger: opts.logger ?? false });
  const hub = new LiveHub();
  const service = new CrewService(opts.store, hub, opts.now, opts.newId);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: "Invalid request", issues: err.issues });
    }
    if (err instanceof WorkflowError) {
      return reply.status(STATUS_BY_CODE[err.code]).send({ error: err.message, code: err.code, violations: err.violations });
    }
    if (err instanceof NotFoundError) return reply.status(404).send({ error: err.message });
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).message });
    app.log.error(err);
    return reply.status(500).send({ error: "Internal error" });
  });

  await app.register(fastifyWebsocket);

  app.get("/ws", { websocket: true }, (socket) => hub.add(socket));

  app.get("/api/health", async () => ({ ok: true, liveClients: hub.size }));

  app.get("/api/schedule", async () => service.snapshot());

  app.post("/api/schedule/generate", async (req) => {
    const body = generateBody.parse(req.body ?? {});
    return service.generate(actorFrom(req, service), body.nodeLimit);
  });

  app.post("/api/employees", async (req, reply) => {
    const body = employeeBody.parse(req.body);
    service.upsertEmployee(actorFrom(req, service), body);
    return reply.status(201).send(body);
  });

  app.post("/api/shifts", async (req, reply) => {
    const body = shiftBody.parse(req.body);
    service.upsertShift(actorFrom(req, service), body);
    return reply.status(201).send(body);
  });

  app.put("/api/rules", async (req) => {
    const body = rulesBody.parse(req.body);
    service.setRules(actorFrom(req, service), body);
    return body;
  });

  app.get("/api/swaps", async () => service.listSwaps());

  app.post("/api/swaps", async (req, reply) => {
    const body = swapBody.parse(req.body);
    return reply.status(201).send(service.requestSwap(actorFrom(req, service), body));
  });

  app.get<{ Params: { id: string } }>("/api/swaps/:id/candidates", async (req) => ({
    employeeIds: service.candidates(req.params.id),
  }));

  app.post<{ Params: { id: string } }>("/api/swaps/:id/claim", async (req) =>
    service.claim(actorFrom(req, service), req.params.id),
  );
  app.post<{ Params: { id: string } }>("/api/swaps/:id/approve", async (req) =>
    service.approve(actorFrom(req, service), req.params.id, noteBody.parse(req.body ?? {}).note),
  );
  app.post<{ Params: { id: string } }>("/api/swaps/:id/reject", async (req) =>
    service.reject(actorFrom(req, service), req.params.id, noteBody.parse(req.body ?? {}).note),
  );
  app.post<{ Params: { id: string } }>("/api/swaps/:id/cancel", async (req) =>
    service.cancel(actorFrom(req, service), req.params.id),
  );

  if (opts.webRoot && existsSync(opts.webRoot)) {
    await app.register(fastifyStatic, { root: opts.webRoot });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api") || req.url.startsWith("/ws")) {
        return reply.status(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return { app, hub, service };
}
