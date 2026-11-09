import { useState } from "react";
import { api, type Employee, type Shift, type SwapRequest } from "../api";
import { DAYS, clock, dayIndex } from "../format";

interface Props {
  swaps: SwapRequest[];
  shifts: Map<string, Shift>;
  employees: Map<string, Employee>;
  actor: string;
  onAction: (id: string, action: "claim" | "approve" | "reject" | "cancel") => void;
}

const ACTIVE = new Set(["open", "claimed"]);

function shiftLabel(s: Shift | undefined): string {
  if (!s) return "Unknown shift";
  return `${DAYS[dayIndex(s.start)]} ${s.role} ${clock(s.start)}–${clock(s.end)}`;
}

export function SwapPanel({ swaps, shifts, employees, actor, onAction }: Props) {
  const [covers, setCovers] = useState<Record<string, string[] | "loading">>({});
  const name = (id: string | null) => (id ? (employees.get(id)?.name ?? id) : "—");
  const active = swaps.filter((s) => ACTIVE.has(s.status));
  const done = swaps.filter((s) => !ACTIVE.has(s.status)).slice(0, 8);
  const isManager = actor === "manager";

  const loadCovers = async (id: string) => {
    setCovers((c) => ({ ...c, [id]: "loading" }));
    const { employeeIds } = await api.candidates(actor, id);
    setCovers((c) => ({ ...c, [id]: employeeIds }));
  };

  const row = (s: SwapRequest) => {
    const cov = covers[s.id];
    return (
      <li key={s.id} className={`swap status-${s.status}`}>
        <div className="swap-head">
          <strong>{shiftLabel(shifts.get(s.shiftId))}</strong>
          <span className={`pill ${s.status}`}>{s.status}</span>
        </div>
        <div className="swap-body">
          {name(s.fromEmployeeId)} → {s.claimedById ? name(s.claimedById) : <em>anyone eligible</em>}
          {s.note && <q>{s.note}</q>}
          {s.history.at(-1)?.note && s.history.at(-1)?.action !== "request" && (
            <small className="muted"> · {s.history.at(-1)?.note}</small>
          )}
        </div>
        {ACTIVE.has(s.status) && (
          <div className="actions">
            {s.status === "open" && !isManager && actor !== s.fromEmployeeId && (
              <button onClick={() => onAction(s.id, "claim")}>Take shift</button>
            )}
            {s.status === "claimed" && isManager && (
              <button className="primary" onClick={() => onAction(s.id, "approve")}>
                Approve
              </button>
            )}
            {isManager && <button onClick={() => onAction(s.id, "reject")}>Reject</button>}
            {actor === s.fromEmployeeId && <button onClick={() => onAction(s.id, "cancel")}>Withdraw</button>}
            {s.status === "open" && (
              <button className="link" onClick={() => loadCovers(s.id)}>
                Who can cover?
              </button>
            )}
          </div>
        )}
        {cov && (
          <p className="covers">
            {cov === "loading"
              ? "Checking labor rules…"
              : cov.length
                ? `Eligible: ${cov.map((id) => name(id)).join(", ")}`
                : "Nobody can legally take this shift."}
          </p>
        )}
      </li>
    );
  };

  return (
    <section className="panel" aria-label="Shift swaps">
      <h2>Shift swaps</h2>
      {active.length === 0 && <p className="muted">No open swap requests.</p>}
      <ul className="swaps">{active.map(row)}</ul>
      {done.length > 0 && (
        <>
          <h3 className="sub">Recent</h3>
          <ul className="swaps">{done.map(row)}</ul>
        </>
      )}
    </section>
  );
}
