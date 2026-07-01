import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

/** Compact listening chip shown while the global hotkey is held. */
export default function CaptureOverlay() {
  const [pulseKey, setPulseKey] = useState(0);

  useEffect(() => {
    document.documentElement.classList.add("capture-window");
    document.body.classList.add("capture-window");

    const un = listen("voice-start", () => {
      setPulseKey((k) => k + 1);
    });

    return () => {
      void un.then((f) => f());
      document.documentElement.classList.remove("capture-window");
      document.body.classList.remove("capture-window");
    };
  }, []);

  return (
    <div className="hud-root" role="status" aria-live="polite" aria-label="Listening — release hotkey to save">
      <div className="hud-chip" key={pulseKey}>
        <div className="hud-pulse hud-active" aria-hidden>
          <span className="hud-pulse-ring hud-pulse-ring-1" />
          <span className="hud-pulse-ring hud-pulse-ring-2" />
          <span className="hud-pulse-dot" />
        </div>
        <div className="hud-copy">
          <span className="hud-title">Listening</span>
          <span className="hud-hint">Release to save</span>
        </div>
      </div>
    </div>
  );
}
