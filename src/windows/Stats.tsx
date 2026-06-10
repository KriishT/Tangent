import { useEffect, useState } from "react";
import { stats, type Stats as StatsT } from "../lib/db";

export default function Stats() {
  const [s, setS] = useState<StatsT>({ caught: 0, triaged: 0, parked: 0 });

  useEffect(() => {
    void stats().then(setS);
  }, []);

  return (
    <div>
      <div className="page-title">Your mind, externalized</div>
      <div className="page-sub">A quick read on what Tangent has caught for you.</div>
      <div className="stat-grid">
        <div className="stat-card stat-caught">
          <span className="stat-icon" aria-hidden>
            ✦
          </span>
          <div className="n">{s.caught}</div>
          <div className="l">thoughts caught</div>
        </div>
        <div className="stat-card stat-triaged">
          <span className="stat-icon" aria-hidden>
            ✓
          </span>
          <div className="n">{s.triaged}</div>
          <div className="l">triaged</div>
        </div>
        <div className="stat-card stat-parked">
          <span className="stat-icon" aria-hidden>
            ◌
          </span>
          <div className="n">{s.parked}</div>
          <div className="l">still parked</div>
        </div>
      </div>
    </div>
  );
}
