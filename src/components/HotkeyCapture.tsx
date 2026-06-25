import { useCallback, useEffect, useRef, useState } from "react";
import {
  acceleratorFromKeyboardEvent,
  formatHotkeyDisplay,
  validateHotkey,
} from "../lib/hotkeyFormat";
import { applyHotkey, pauseHotkey } from "../lib/hotkey";

type Props = {
  value: string;
  onChange: (accelerator: string) => void;
};

export default function HotkeyCapture({ value, onChange }: Props) {
  const [listening, setListening] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLButtonElement>(null);

  const cancelListening = useCallback(() => {
    setListening(false);
    setPending(null);
    setError(null);
    void applyHotkey().catch(() => {});
  }, []);

  const confirmListening = useCallback(() => {
    if (pending) {
      const check = validateHotkey(pending);
      if (check.ok) {
        onChange(pending);
      }
    }
    setListening(false);
    setPending(null);
    setError(null);
    void applyHotkey().catch(() => {});
  }, [pending, onChange]);

  const startListening = useCallback(() => {
    setError(null);
    setPending(null);
    setListening(true);
    void pauseHotkey().catch(() => {});
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!listening) return;

    function onKeyDown(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        if (pending) {
          confirmListening();
        } else {
          cancelListening();
        }
        return;
      }

      const accelerator = acceleratorFromKeyboardEvent(e);
      if (!accelerator) return;

      const check = validateHotkey(accelerator);
      if (!check.ok) {
        setError(check.reason ?? "Invalid shortcut");
        setPending(null);
        return;
      }

      setPending(accelerator);
      setError(null);
    }

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [listening, pending, confirmListening, cancelListening]);

  return (
    <div className="hotkey-capture">
      <button
        ref={inputRef}
        type="button"
        className={`hotkey-capture-btn${listening ? " listening" : ""}`}
        onClick={() => {
          if (!listening) startListening();
        }}
        onBlur={() => {
          if (listening) cancelListening();
        }}
        aria-label="Capture hotkey"
      >
        {listening ? (
          pending ? (
            <span className="hotkey-capture-pending">
              <span className="hotkey-capture-value">{formatHotkeyDisplay(pending)}</span>
              <span className="hotkey-capture-hint">Press Esc to confirm</span>
            </span>
          ) : (
            <span className="hotkey-capture-prompt">Press your shortcut…</span>
          )
        ) : (
          <span className="hotkey-capture-value">{formatHotkeyDisplay(value)}</span>
        )}
      </button>
      <div className="desc">
        Click, press a shortcut (e.g. Shift+D), then Esc to confirm. Needs a modifier — not a
        single key. Ctrl+C, Alt+Tab, and similar system shortcuts are blocked.
      </div>
      {error && <div className="hotkey-capture-error">{error}</div>}
    </div>
  );
}
