import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api, type GenerateResult, type Shift, type Snapshot, type SwapRequest, type Violation } from "./api";
import { HoursChart } from "./components/HoursChart";
import { SwapPanel } from "./components/SwapPanel";
import { WeekBoard } from "./components/WeekBoard";
import { DAYS, clock, dayIndex, hours, money } from "./format";
import { useLive } from "./useLive";

interface Notice {
  kind: "ok" | "error";
  text: string;
  violations?: Violation[];
}

const ACTOR_KEY = "crewboard.actor";

function readActor(): string {
  try {
    return localStorage.getItem(ACTOR_KEY) ?? "manager";
  } catch {
    return "manager";
  }
}

export function App() {
  const [actor, setActor] = useState(readActor);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [swaps, setSwaps] = useState<SwapRequest[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [lastRun, setLastRun] = useState<GenerateResult | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [s, w] = await Promise.all([api.schedule(actor), api.swaps(actor)]);
    setSnap(s);
    setSwaps(w);
  }, [actor]);

  useEffect(() => {
    refresh().catch((e) => setNotice({ kind: "error", text: String(e) }));
  }, [refresh]);

  useEffect(() => {
    try {
      localStorage.setItem(ACTOR_KEY, actor);
    } catch {
      /* storage unavailable */
    }
  }, [actor]);

  const live = useLive(
    useCallback(
      (e: { type: string }) => {
        if (e.type !== "hello") void refresh();
      },
      [refresh],
    ),
  );

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      setNotice({ kind: "ok", text: ok });
    } catch (e) {
      if (e instanceof ApiError) setNotice({ kind: "error", text: e.message, violations: e.violations });
      else setNotice({ kind: "error", text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const employees = useMemo(() => new Map((snap?.employees ?? []).map((e) => [e.id, e])), [snap]);
  const shifts = useMemo(() => new Map((snap?.shifts ?? []).map((s) => [s.id, s])), [snap]);
  const crew = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const a of snap?.assignments ?? []) m.set(a.shiftId, [...(m.get(a.shiftId) ?? []), a.employeeId]);
    return m;
  }, [snap]);

  if (!snap) return <main className="loading">Loading schedule…</main>;
  const r = snap.report;

  const offer = (s: Shift) => {
    const note = window.prompt(`Offer ${DAYS[dayIndex(s.start)]} ${s.role} ${clock(s.start)}–${clock(s.end)}. Note (optional):`);
    if (note === null) return;
    void run(() => api.requestSwap(actor, s.id, note), "Swap offered to your coworkers");
  };

  const act = (id: string, action: "claim" | "approve" | "reject" | "cancel") => {
    const msg = { claim: "Shift claimed, waiting on manager", approve: "Swap approved", reject: "Swap rejected", cancel: "Swap withdrawn" };
    void run(() => api.act(actor, id, action), msg[action]);
  };

  return (
    <main>
      <header className="top">
        <div className="brand">
          <h1>Crewboard</h1>
          <span className="sub">Lakeside Diner · week schedule</span>
        </div>
        <div className="controls">
          <span className={`live ${live}`} title="Live updates">
            {live}
          </span>
          <label>
            Acting as{" "}
            <select value={actor} onChange={(e) => setActor(e.target.value)}>
              <option value="manager">Manager</option>
              {snap.employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
          {actor === "manager" && (
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                run(async () => setLastRun(await api.generate(actor)), "New schedule generated and published")
              }
            >
              {busy ? "Solving…" : "Generate schedule"}
            </button>
          )}
        </div>
      </header>

      <section className="stats">
        <div>
          <b>
            {r.filledSeats}/{r.totalSeats}
          </b>
          <span>seats filled</span>
        </div>
        <div>
          <b>{money(r.totalCost)}</b>
          <span>labor cost</span>
        </div>
        <div>
          <b>{hours(r.overtimeMinutes)}</b>
          <span>overtime</span>
        </div>
        <div>
          <b>{r.violations.length}</b>
          <span>rule violations</span>
        </div>
        {lastRun && (
          <div className="solver">
            <b>
              {lastRun.solver.ms + lastRun.optimizer.ms} ms
            </b>
            <span>
              {lastRun.solver.nodes.toLocaleString()} nodes · {lastRun.optimizer.moves} improving moves
            </span>
          </div>
        )}
      </section>

      {notice && (
        <div className={`notice ${notice.kind}`} role="status">
          <span>{notice.text}</span>
          {notice.violations && notice.violations.length > 0 && (
            <ul>
              {notice.violations.map((v, i) => (
                <li key={i}>{v.message}</li>
              ))}
            </ul>
          )}
          <button className="link" onClick={() => setNotice(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <div className="layout">
        <WeekBoard
          shifts={snap.shifts}
          crew={crew}
          employees={employees}
          unfilled={r.unfilled}
          swaps={swaps}
          actor={actor}
          onOffer={offer}
        />
        <aside>
          <SwapPanel swaps={swaps} shifts={shifts} employees={employees} actor={actor} onAction={act} />
          <HoursChart loads={r.loads} employees={employees} rules={snap.rules} actor={actor} />
        </aside>
      </div>
    </main>
  );
}
