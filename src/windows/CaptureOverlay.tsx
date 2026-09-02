import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

type VoicePhase = "warming" | "listening";

const PHASE_COPY: Record<VoicePhase, { title: string; hint: string }> = {
  warming: {
    title: "Starting mic…",
    hint: "Wait a moment before you speak",
  },
  listening: {
    title: "Listening",
    hint: "Release to save",
  },
};

/** Compact listening chip shown while the global hotkey is held. */
export default function CaptureOverlay() {
  const [phase, setPhase] = useState<VoicePhase>("warming");
  const [pulseKey, setPulseKey] = useState(0);

  useEffect(() => {
    document.documentElement.classList.add("capture-window");
    document.body.classList.add("capture-window");

    const unPhase = listen<string>("voice-phase", (e) => {
      const next = e.payload;
      if (next === "warming" || next === "listening") {
        setPhase(next);
        if (next === "listening") setPulseKey((k) => k + 1);
      }
    });
    const unStart = listen("voice-start", () => {
      setPhase("listening");
      setPulseKey((k) => k + 1);
    });

    return () => {
      void unPhase.then((f) => f());
      void unStart.then((f) => f());
      document.documentElement.classList.remove("capture-window");
      document.body.classList.remove("capture-window");
    };
  }, []);

  const copy = PHASE_COPY[phase];
  const isListening = phase === "listening";

  return (
    <div
      className="hud-root"
      role="status"
      aria-live="polite"
      aria-label={`${copy.title} — ${copy.hint}`}
    >
      <div className={`hud-chip hud-phase-${phase}`} key={pulseKey}>
        <div className={`hud-pulse${isListening ? " hud-active" : ""}`} aria-hidden>
          {phase === "warming" && <span className="hud-spinner" />}
          {isListening && (
            <>
              <span className="hud-pulse-ring hud-pulse-ring-1" />
              <span className="hud-pulse-ring hud-pulse-ring-2" />
              <span className="hud-pulse-dot" />
            </>
          )}
        </div>
        <div className="hud-copy">
          <span className="hud-title">{copy.title}</span>
          <span className="hud-hint">{copy.hint}</span>
        </div>
      </div>
    </div>
  );
}
