import type { Employee, LaborRules, ScheduleReport } from "../api";
import { hours, money } from "../format";

interface Props {
  loads: ScheduleReport["loads"];
  employees: Map<string, Employee>;
  rules: LaborRules;
  actor: string;
}

/**
 * Horizontal bars of scheduled hours per person. The tick on each bar is
 * that person's own cap; the dashed line across the chart is the overtime
 * threshold. Sorted by utilization so under-scheduled people float up.
 */
export function HoursChart({ loads, employees, rules, actor }: Props) {
  const scale = Math.max(
    rules.overtimeThresholdMinutes,
    ...loads.map((l) => Math.max(l.minutes, employees.get(l.employeeId)?.maxWeeklyMinutes ?? 0)),
  );
  const pct = (m: number) => `${(m / scale) * 100}%`;
  const sorted = [...loads].sort((a, b) => a.utilization - b.utilization);

  return (
    <section className="panel" aria-label="Hours per employee">
      <h2>Hours this week</h2>
      <div className="chart">
        <div className="ot-line" style={{ left: pct(rules.overtimeThresholdMinutes) }} title="Overtime threshold" />
        {sorted.map((l) => {
          const e = employees.get(l.employeeId);
          if (!e) return null;
          const regular = Math.min(l.minutes, rules.overtimeThresholdMinutes);
          return (
            <div className={`bar-row${l.employeeId === actor ? " me" : ""}`} key={l.employeeId}>
              <span className="who">
                {e.name}
                {e.isMinor && <span className="badge">minor</span>}
              </span>
              <div className="track" title={`${hours(l.minutes)} of ${hours(e.maxWeeklyMinutes)} · ${money(l.cost)}`}>
                <div className="fill" style={{ width: pct(regular) }} />
                {l.overtimeMinutes > 0 && (
                  <div className="fill ot" style={{ left: pct(regular), width: pct(l.overtimeMinutes) }} />
                )}
                <div className="cap" style={{ left: pct(e.maxWeeklyMinutes) }} />
              </div>
              <span className="num">
                {hours(l.minutes)}
                <small> / {hours(e.maxWeeklyMinutes)}</small>
              </span>
            </div>
          );
        })}
      </div>
      <p className="legend">
        Tick = personal cap · dashed line = overtime at {hours(rules.overtimeThresholdMinutes)}
      </p>
    </section>
  );
}
