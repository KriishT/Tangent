import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { WorkContext } from "../lib/types";
import { buildContextFields } from "../lib/parse";

type Phase = "recording" | "transcribing";

export default function CaptureOverlay() {
  const [ctx, setCtx] = useState<WorkContext>({ app_name: null, title: null });
  const [phase, setPhase] = useState<Phase>("recording");
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const u1 = listen<WorkContext>("voice-start", (e) => {
      setCtx(e.payload ?? { app_name: null, title: null });
      setPhase("recording");
      setElapsed(0);
    });
    const u2 = listen("voice-transcribing", () => setPhase("transcribing"));
    return () => {
      u1.then((f) => f());
      u2.then((f) => f());
    };
  }, []);

  useEffect(() => {
    if (phase !== "recording") return;
    const t = setInterval(() => setElapsed((e) => e + 0.1), 100);
    return () => clearInterval(t);
  }, [phase]);

  const label = buildContextFields(ctx.app_name, ctx.title, ctx.process_path ?? null).detail;

  return (
    <div className="hud-root">
      <div className={`hud-card ${phase}`}>
        <div className="hud-viz" aria-hidden>
          {phase === "transcribing" ? (
            <div className="hud-spinner" />
          ) : (
            <div className="hud-wave">
              {Array.from({ length: 5 }).map((_, i) => (
                <span key={i} style={{ animationDelay: `${i * 0.12}s` }} />
              ))}
            </div>
          )}
        </div>

        <div className="hud-mid">
          <div className="hud-status">
            {phase === "transcribing" ? "Transcribing" : "Listening"}
            <span className="hud-dots">
              <i />
              <i />
              <i />
            </span>
          </div>
          {label && (
            <div className="hud-ctx" title={ctx.title ?? ""}>
              {ctx.app_name ? `in ${ctx.app_name} · ` : ""}
              {label}
            </div>
          )}
        </div>

        <div className="hud-right">
          {phase === "recording" ? (
            <span className="hud-timer">{elapsed.toFixed(1)}s</span>
          ) : (
            <span className="hud-spark" />
          )}
        </div>
      </div>
      <div className="hud-hint">release to save</div>
    </div>
  );
}
