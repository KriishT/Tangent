import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { stats, type Stats as StatsT } from "../lib/db";

export default function Stats() {
  const [s, setS] = useState<StatsT>({
    caught: 0,
    triaged: 0,
    parked: 0,
    never_triaged: 0,
    triage_rate_pct: 0,
  });

  useEffect(() => {
    const reload = () => void stats().then(setS);
    reload();
    const un = listen("thought-added", reload);
    const t = setInterval(reload, 10_000);
    return () => {
      un.then((f) => f());
      clearInterval(t);
    };
  }, []);

  return (
    <div className="stats-page">
      <div className="page-title">Your mind, externalized</div>
      <div className="page-sub">A quick read on what Tangent has caught for you.</div>

      <section className="stat-hero" aria-label="Triage rate">
        <p className="stat-hero-label">Triage rate</p>
        <p className="stat-hero-value">{s.triage_rate_pct}%</p>
        <p className="stat-hero-caption">
          The health metric — capture is easy; sorting is the product.
        </p>
      </section>

      <dl className="stat-metrics">
        <div className="stat-metric">
          <dt>Caught</dt>
          <dd>{s.caught}</dd>
        </div>
        <div className="stat-metric">
          <dt>Triaged</dt>
          <dd>{s.triaged}</dd>
        </div>
        <div className="stat-metric">
          <dt>Parked</dt>
          <dd>{s.parked}</dd>
        </div>
        <div className="stat-metric">
          <dt>Never triaged</dt>
          <dd>{s.never_triaged}</dd>
        </div>
      </dl>
    </div>
  );
}
