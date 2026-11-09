import type { Employee, ScheduleReport, Shift, SwapRequest } from "../api";
import { BLOCKER_LABELS, DAYS, clock, dayIndex } from "../format";

interface Props {
  shifts: Shift[];
  crew: Map<string, string[]>;
  employees: Map<string, Employee>;
  unfilled: ScheduleReport["unfilled"];
  swaps: SwapRequest[];
  actor: string;
  onOffer: (shift: Shift) => void;
}

function blockerSummary(blockers: Partial<Record<string, number>>): string {
  return Object.entries(blockers)
    .filter(([, n]) => (n ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .slice(0, 3)
    .map(([code, n]) => `${n} ${BLOCKER_LABELS[code] ?? code}`)
    .join(", ");
}

export function WeekBoard({ shifts, crew, employees, unfilled, swaps, actor, onOffer }: Props) {
  const byDay = DAYS.map((_, d) => shifts.filter((s) => dayIndex(s.start) === d));
  const openSwapShift = new Set(
    swaps.filter((s) => s.status === "open" || s.status === "claimed").map((s) => `${s.shiftId}:${s.fromEmployeeId}`),
  );

  return (
    <section className="board" aria-label="Week schedule">
      {byDay.map((dayShifts, d) => (
        <div className="day" key={DAYS[d]}>
          <h3>{DAYS[d]}</h3>
          {dayShifts.map((s) => {
            const people = crew.get(s.id) ?? [];
            const gaps = unfilled.filter((u) => u.shiftId === s.id);
            const mine = people.includes(actor);
            return (
              <article key={s.id} className={`shift role-${s.role}${mine ? " mine" : ""}${gaps.length ? " short" : ""}`}>
                <header>
                  <span className="role">{s.role}</span>
                  <span className="time">
                    {clock(s.start)}–{clock(s.end)}
                  </span>
                </header>
                <ul>
                  {people.map((id) => (
                    <li key={id} className={id === actor ? "me" : undefined}>
                      {employees.get(id)?.name ?? id}
                      {openSwapShift.has(`${s.id}:${id}`) && <span className="badge">swap</span>}
                    </li>
                  ))}
                  {gaps.map((g, i) => (
                    <li key={`gap-${i}`} className="gap" title={blockerSummary(g.blockers)}>
                      Open seat
                      <small>{blockerSummary(g.blockers)}</small>
                    </li>
                  ))}
                </ul>
                {mine && !openSwapShift.has(`${s.id}:${actor}`) && (
                  <button className="link" onClick={() => onOffer(s)}>
                    Offer swap
                  </button>
                )}
              </article>
            );
          })}
        </div>
      ))}
    </section>
  );
}
