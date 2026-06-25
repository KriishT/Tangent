import { useEffect } from "react";

/** Minimal floating blob shown while the global hotkey is held. */
export default function CaptureOverlay() {
  useEffect(() => {
    document.documentElement.classList.add("capture-window");
    document.body.classList.add("capture-window");
    return () => {
      document.documentElement.classList.remove("capture-window");
      document.body.classList.remove("capture-window");
    };
  }, []);

  return (
    <div className="hud-root" role="status" aria-live="polite" aria-label="Recording">
      <div className="hud-blob-wrap hud-active">
        <span className="hud-blob-ring hud-blob-ring-1" aria-hidden />
        <span className="hud-blob-ring hud-blob-ring-2" aria-hidden />
        <span className="hud-blob-ring hud-blob-ring-3" aria-hidden />
        <span className="hud-blob-core" aria-hidden />
      </div>
    </div>
  );
}
