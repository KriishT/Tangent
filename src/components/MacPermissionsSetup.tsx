import { useCallback, useEffect, useState } from "react";
import {
  markMacPermissionsIntroSeen,
  openMacPrivacyPane,
  readMacPermissionStatus,
  requestAccessibilityAccess,
  requestMicrophoneAccess,
  requestNotificationAccess,
  type PermState,
} from "../lib/macPermissions";

type RowId = "microphone" | "accessibility" | "notifications";

const ROWS: { id: RowId; title: string; why: string }[] = [
  {
    id: "microphone",
    title: "Microphone",
    why: "Hold the hotkey and speak. Nothing is recorded until you do.",
  },
  {
    id: "accessibility",
    title: "Accessibility",
    why: "Saves the app or file you were in, then returns you there.",
  },
  {
    id: "notifications",
    title: "Notifications",
    why: "Due reminders and check-ins while Tangent is in the tray.",
  },
];

function statusLabel(state: PermState, busy: boolean): string {
  if (busy) return "Waiting for macOS…";
  if (state === "allowed") return "Allowed";
  if (state === "needs_access") return "Needs access";
  return "Not granted yet";
}

export function MacPermissionsPanel({ compact }: { compact?: boolean }) {
  const [status, setStatus] = useState<Record<RowId, PermState>>({
    microphone: "unknown",
    accessibility: "unknown",
    notifications: "unknown",
  });
  const [busy, setBusy] = useState<RowId | null>(null);

  const refresh = useCallback(async () => {
    const next = await readMacPermissionStatus();
    setStatus((prev) => ({
      microphone: prev.microphone === "allowed" ? "allowed" : next.microphone,
      accessibility: next.accessibility,
      notifications: next.notifications,
    }));
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  async function allow(id: RowId) {
    setBusy(id);
    try {
      let next: PermState = "needs_access";
      if (id === "microphone") next = await requestMicrophoneAccess();
      if (id === "accessibility") next = await requestAccessibilityAccess();
      if (id === "notifications") next = await requestNotificationAccess();
      setStatus((prev) => ({ ...prev, [id]: next }));
    } finally {
      setBusy(null);
      void refresh();
    }
  }

  return (
    <div className={`perm-panel${compact ? " perm-panel-compact" : ""}`}>
      {ROWS.map((row) => (
        <div className="perm-row" key={row.id}>
          <div className="perm-copy">
            <div className="perm-title">{row.title}</div>
            <div className="perm-why">{row.why}</div>
            <div
              className={`perm-status${status[row.id] === "allowed" ? " ok" : ""}`}
            >
              {statusLabel(status[row.id], busy === row.id)}
            </div>
          </div>
          <div className="perm-actions">
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={() => void allow(row.id)}
            >
              {status[row.id] === "allowed" ? "Recheck" : "Allow"}
            </button>
            {status[row.id] === "needs_access" && (
              <button
                type="button"
                className="btn ghost"
                disabled={busy !== null}
                onClick={() => void openMacPrivacyPane(row.id)}
              >
                Open Settings
              </button>
            )}
          </div>
        </div>
      ))}
      <p className="perm-footnote">
        Chrome, Safari, and Calendar ask separately the first time you capture from a
        browser or connect Apple Calendar.
      </p>
    </div>
  );
}

export default function MacPermissionsSetup({ onDone }: { onDone: () => void }) {
  async function finish() {
    await markMacPermissionsIntroSeen();
    onDone();
  }

  return (
    <div className="perm-overlay" role="dialog" aria-labelledby="perm-heading">
      <div className="perm-card">
        <h1 id="perm-heading" className="perm-heading">
          A few Mac permissions
        </h1>
        <p className="perm-lead">
          Grant these here so macOS doesn&apos;t interrupt you later. You can skip and
          turn them on in Settings anytime.
        </p>
        <MacPermissionsPanel />
        <div className="perm-footer">
          <button type="button" className="btn ghost" onClick={() => void finish()}>
            Skip for now
          </button>
          <button type="button" className="btn" onClick={() => void finish()}>
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
