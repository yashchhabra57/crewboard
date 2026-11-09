import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SwapRequest } from "../domain/swaps.js";
import { DEFAULT_RULES, type Assignment, type Employee, type LaborRules, type Shift } from "../domain/types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  roles TEXT NOT NULL,
  hourly_rate REAL NOT NULL,
  max_weekly_minutes INTEGER NOT NULL,
  is_minor INTEGER NOT NULL,
  availability TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  start_minute INTEGER NOT NULL,
  end_minute INTEGER NOT NULL CHECK (end_minute > start_minute),
  headcount INTEGER NOT NULL CHECK (headcount > 0)
);
CREATE TABLE IF NOT EXISTS assignments (
  shift_id TEXT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  PRIMARY KEY (shift_id, employee_id)
);
CREATE TABLE IF NOT EXISTS swaps (
  id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS swaps_status_idx ON swaps(status);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

interface EmployeeRow {
  id: string;
  name: string;
  roles: string;
  hourly_rate: number;
  max_weekly_minutes: number;
  is_minor: number;
  availability: string;
}

interface ShiftRow {
  id: string;
  role: string;
  start_minute: number;
  end_minute: number;
  headcount: number;
}

/**
 * Thin repository over SQLite (Node's built-in driver). Arrays and the
 * swap history are stored as JSON text; everything the app filters on has
 * its own column.
 */
export class Store {
  private readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON;");
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  private depth = 0;

  /**
   * Runs `fn` atomically. Re-entrant: nested calls become savepoints, so
   * repository methods can be transactional on their own and still compose
   * inside a larger service-level transaction.
   */
  transaction<T>(fn: () => T): T {
    const sp = `sp${this.depth}`;
    this.db.exec(this.depth === 0 ? "BEGIN" : `SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const out = fn();
      this.depth--;
      this.db.exec(this.depth === 0 ? "COMMIT" : `RELEASE ${sp}`);
      return out;
    } catch (err) {
      this.depth--;
      this.db.exec(this.depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw err;
    }
  }

  isEmpty(): boolean {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM employees").get() as { n: number };
    return row.n === 0;
  }

  listEmployees(): Employee[] {
    const rows = this.db.prepare("SELECT * FROM employees ORDER BY name").all() as unknown as EmployeeRow[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      roles: JSON.parse(r.roles),
      hourlyRate: r.hourly_rate,
      maxWeeklyMinutes: r.max_weekly_minutes,
      isMinor: r.is_minor === 1,
      availability: JSON.parse(r.availability),
    }));
  }

  upsertEmployee(e: Employee): void {
    this.db
      .prepare(
        `INSERT INTO employees (id, name, roles, hourly_rate, max_weekly_minutes, is_minor, availability)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, roles = excluded.roles,
           hourly_rate = excluded.hourly_rate, max_weekly_minutes = excluded.max_weekly_minutes,
           is_minor = excluded.is_minor, availability = excluded.availability`,
      )
      .run(
        e.id,
        e.name,
        JSON.stringify(e.roles),
        e.hourlyRate,
        e.maxWeeklyMinutes,
        e.isMinor ? 1 : 0,
        JSON.stringify(e.availability),
      );
  }

  listShifts(): Shift[] {
    const rows = this.db.prepare("SELECT * FROM shifts ORDER BY start_minute, role, id").all() as unknown as ShiftRow[];
    return rows.map((r) => ({
      id: r.id,
      role: r.role as Shift["role"],
      start: r.start_minute,
      end: r.end_minute,
      headcount: r.headcount,
    }));
  }

  upsertShift(s: Shift): void {
    this.db
      .prepare(
        `INSERT INTO shifts (id, role, start_minute, end_minute, headcount) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET role = excluded.role, start_minute = excluded.start_minute,
           end_minute = excluded.end_minute, headcount = excluded.headcount`,
      )
      .run(s.id, s.role, s.start, s.end, s.headcount);
  }

  listAssignments(): Assignment[] {
    return (
      this.db.prepare("SELECT shift_id, employee_id FROM assignments ORDER BY shift_id, employee_id").all() as {
        shift_id: string;
        employee_id: string;
      }[]
    ).map((r) => ({ shiftId: r.shift_id, employeeId: r.employee_id }));
  }

  replaceAssignments(assignments: readonly Assignment[]): void {
    this.transaction(() => {
      this.db.exec("DELETE FROM assignments");
      const insert = this.db.prepare("INSERT INTO assignments (shift_id, employee_id) VALUES (?, ?)");
      for (const a of assignments) insert.run(a.shiftId, a.employeeId);
    });
  }

  moveAssignment(shiftId: string, fromEmployeeId: string, toEmployeeId: string): void {
    const result = this.db
      .prepare("UPDATE assignments SET employee_id = ? WHERE shift_id = ? AND employee_id = ?")
      .run(toEmployeeId, shiftId, fromEmployeeId);
    if (result.changes !== 1) throw new Error(`No assignment of ${fromEmployeeId} on ${shiftId}`);
  }

  listSwaps(): SwapRequest[] {
    return (this.db.prepare("SELECT body FROM swaps ORDER BY updated_at DESC, id").all() as { body: string }[]).map(
      (r) => JSON.parse(r.body) as SwapRequest,
    );
  }

  getSwap(id: string): SwapRequest | undefined {
    const row = this.db.prepare("SELECT body FROM swaps WHERE id = ?").get(id) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as SwapRequest) : undefined;
  }

  saveSwap(s: SwapRequest): void {
    this.db
      .prepare(
        `INSERT INTO swaps (id, shift_id, status, body, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, body = excluded.body, updated_at = excluded.updated_at`,
      )
      .run(s.id, s.shiftId, s.status, JSON.stringify(s), s.updatedAt);
  }

  /** Closes any open/claimed swaps, e.g. after the schedule is regenerated. */
  cancelActiveSwaps(cancel: (s: SwapRequest) => SwapRequest): SwapRequest[] {
    const active = this.listSwaps().filter((s) => s.status === "open" || s.status === "claimed");
    const closed = active.map(cancel);
    this.transaction(() => closed.forEach((s) => this.saveSwap(s)));
    return closed;
  }

  getRules(): LaborRules {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'rules'").get() as { value: string } | undefined;
    return row ? { ...DEFAULT_RULES, ...(JSON.parse(row.value) as Partial<LaborRules>) } : DEFAULT_RULES;
  }

  setRules(rules: LaborRules): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES ('rules', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(rules));
  }
}
