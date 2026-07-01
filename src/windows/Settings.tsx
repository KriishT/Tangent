import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  NUDGE_INTERVAL_LABELS,
  calendarReminderLabel,
  GOOGLE_CALENDAR_PHONE_LABELS,
  formatCheckInTimesLabel,
  formatNudgeIntervalLabel,
  activeCheckInTimes,
  phoneCheckInTimes,
  saveSettings,
  type AppSettings,
  type GoogleCalendarPhoneMode,
  type NudgeInterval,
} from "../lib/settings";
import { useDialog } from "../components/DialogProvider";
import HotkeyCapture from "../components/HotkeyCapture";
import { applyHotkey } from "../lib/hotkey";
import { validateHotkey } from "../lib/hotkeyFormat";
import {
  connectGoogleCalendar,
  disconnectGoogleCalendar,
  isGoogleOAuthConfigured,
  applyGoogleCalendarSettings,
} from "../lib/googleCalendar";
import { wipeAll } from "../lib/db";
import { emit } from "@tauri-apps/api/event";

function applyChosenTimesModes(prev: AppSettings, checkInTimes: string[]): AppSettings {
  const updated = { ...prev, checkInTimes };
  const hasTimes = checkInTimes.some((t) => t.trim());
  if (hasTimes) {
    updated.nudgeInterval = "picked_times";
    if (isGoogleOAuthConfigured() && prev.googleTokens?.refreshToken) {
      updated.googleCalendarPhoneMode = "picked_times";
    }
  }
  return updated;
}

function localTzLabel(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "system default";
  }
}

export default function Settings() {
  const { confirm } = useDialog();
  const [s, setS] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [autostart, setAutostart] = useState(false);
  const [toast, setToast] = useState("");
  const [googleBusy, setGoogleBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [micBusy, setMicBusy] = useState(false);

  useEffect(() => {
    void loadSettings().then(setS);
    void isEnabled()
      .then(setAutostart)
      .catch(() => {});
  }, []);

  function set<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setS((prev) => ({ ...prev, [key]: value }));
  }

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 2200);
  }

  async function onTestMic() {
    if (micBusy) return;
    setMicBusy(true);
    try {
      const r = await invoke<{ device: string; samples: number }>("voice_test_microphone");
      flash(`Mic OK: ${r.device} (${r.samples.toLocaleString()} samples)`);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setMicBusy(false);
    }
  }

  async function onSave() {
    if (saving) return;
    const check = validateHotkey(s.hotkey);
    if (!check.ok) {
      flash(check.reason ?? "Invalid hotkey");
      return;
    }
    setSaving(true);
    try {
      let toSave = { ...s };
      if (toSave.googleCalendarPhoneMode === "picked_times") {
        toSave.nudgeInterval = "picked_times";
      } else if (
        toSave.nudgeInterval === "picked_times" &&
        (toSave.googleCalendarPhoneMode ?? "off") !== "off"
      ) {
        toSave.googleCalendarPhoneMode = "picked_times";
      }

      await saveSettings(toSave);
      const { settings: synced, message, error } = await applyGoogleCalendarSettings(toSave);
      await saveSettings(synced);
      setS(synced);
      await applyHotkey().catch(() => {});
      if (error) flash(error);
      else flash(message ?? "Settings saved");
    } finally {
      setSaving(false);
    }
  }

  async function onToggleAutostart(next: boolean) {
    try {
      if (next) await enable();
      else await disable();
      setAutostart(next);
    } catch {
      /* ignore */
    }
  }

  async function onConnectGoogle() {
    if (!isGoogleOAuthConfigured()) {
      flash("Google Calendar is not configured in this build");
      return;
    }
    setGoogleBusy(true);
    try {
      await saveSettings(s);
      const result = await connectGoogleCalendar();
      const { settings: synced, message, error } = await applyGoogleCalendarSettings({
        ...s,
        googleEmail: result.email,
        googleTokens: result.tokens,
      });
      await saveSettings(synced);
      setS(synced);
      if (error) flash(error);
      else flash(message ?? `Connected as ${result.email}`);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setGoogleBusy(false);
    }
  }

  async function onDisconnectGoogle() {
    await disconnectGoogleCalendar();
    const fresh = await loadSettings();
    setS(fresh);
    flash("Google Calendar disconnected");
  }

  async function onWipe() {
    const ok = await confirm({
      title: "Delete all thoughts?",
      message: "This permanently removes every captured thought. It cannot be undone.",
      confirmLabel: "Delete everything",
      cancelLabel: "Cancel",
      variant: "danger",
    });
    if (ok) {
      await wipeAll();
      void emit("thought-added", {}).catch(() => {});
      flash("All data wiped");
    }
  }

  return (
    <div>
      <div className="page-title">Settings</div>
      <div className="page-sub">Private and local by default.</div>

      <div className="setting">
        <label>Capture hotkey</label>
        <HotkeyCapture value={s.hotkey} onChange={(hotkey) => set("hotkey", hotkey)} />
      </div>

      <div className="setting">
        <div className="row">
          <div>
            <label>Voice capture</label>
            <div className="desc">
              Hold the hotkey anywhere and speak — release to transcribe and save to Triage.
              On-device voice model is included; no setup needed.
            </div>
          </div>
          <input
            type="checkbox"
            checked={s.voiceEnabled}
            onChange={(e) => set("voiceEnabled", e.target.checked)}
          />
        </div>
        {s.voiceEnabled && (
          <>
            <div className="desc" style={{ marginTop: 10 }}>
              Windows: Settings → Privacy &amp; security → Microphone — turn on access and
              allow <strong>desktop apps</strong>. Set your mic as the default input in Sound
              settings.
            </div>
            <button
              type="button"
              className="btn"
              style={{ marginTop: 10 }}
              disabled={micBusy}
              onClick={() => void onTestMic()}
            >
              {micBusy ? "Testing mic…" : "Test microphone"}
            </button>
          </>
        )}
      </div>

      <div className="setting">
        <div className="row">
          <div>
            <label>Launch on startup</label>
            <div className="desc">Keep Tangent in your tray, ready to catch a thought.</div>
          </div>
          <input
            type="checkbox"
            checked={autostart}
            onChange={(e) => onToggleAutostart(e.target.checked)}
          />
        </div>
      </div>

      <div className="setting">
        <div className="row">
          <div>
            <label>Faithful transcripts</label>
            <div className="desc">Skip automatic filler-word cleanup on voice capture.</div>
          </div>
          <input
            type="checkbox"
            checked={s.faithfulMode}
            onChange={(e) => set("faithfulMode", e.target.checked)}
          />
        </div>
      </div>

      <div className="setting">
        <div className="row">
          <div>
            <label>Capture work context</label>
            <div className="desc">Remember which app/file you were in when a thought fired.</div>
          </div>
          <input
            type="checkbox"
            checked={s.contextEnabled}
            onChange={(e) => set("contextEnabled", e.target.checked)}
          />
        </div>
        {s.contextEnabled && (
          <>
            <div className="desc" style={{ marginTop: 10 }}>
              Blocklist (one fragment per line) — never store context from matching apps/titles.
            </div>
            <textarea
              rows={3}
              value={s.blocklist}
              onChange={(e) => set("blocklist", e.target.value)}
              placeholder={"1Password\nKeePass\nInPrivate"}
            />
          </>
        )}
      </div>

      <div className="setting">
        <label>Triage reminders</label>
        <div className="desc">
          Desktop popup on this cadence saying &quot;Check Tangent now&quot; — even when
          triage is empty. Tangent must be running (tray).
        </div>
        <select
          value={s.nudgeInterval}
          onChange={(e) => {
            const next = e.target.value as NudgeInterval;
            setS((prev) => {
              const updated = { ...prev, nudgeInterval: next };
              if (
                next === "picked_times" &&
                (updated.googleCalendarPhoneMode ?? "off") !== "off"
              ) {
                updated.googleCalendarPhoneMode = "picked_times";
              }
              return updated;
            });
          }}
        >
          {(Object.keys(NUDGE_INTERVAL_LABELS) as NudgeInterval[]).map((k) => (
            <option key={k} value={k}>
              {NUDGE_INTERVAL_LABELS[k]}
            </option>
          ))}
        </select>
        {s.nudgeInterval === "custom" && (
          <div className="row" style={{ marginTop: 10, gap: 8, alignItems: "center" }}>
            <input
              type="number"
              min={0}
              max={24}
              value={s.nudgeCustomHours}
              onChange={(e) =>
                set("nudgeCustomHours", Math.min(24, Math.max(0, Number(e.target.value))))
              }
              style={{ width: 64 }}
              aria-label="Custom reminder interval hours"
            />
            <span className="desc">hr</span>
            <input
              type="number"
              min={0}
              max={59}
              value={s.nudgeCustomMinutes}
              onChange={(e) =>
                set("nudgeCustomMinutes", Math.min(59, Math.max(0, Number(e.target.value))))
              }
              style={{ width: 64 }}
              aria-label="Custom reminder interval minutes"
            />
            <span className="desc">min</span>
          </div>
        )}
        <div className="row" style={{ marginTop: 14, gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label>Quiet hours (no desktop pings)</label>
            <div className="desc">e.g. midnight–6 AM while you sleep.</div>
          </div>
          <input
            type="number"
            min={0}
            max={23}
            value={s.nudgeQuietStartHour}
            onChange={(e) => set("nudgeQuietStartHour", Number(e.target.value))}
            aria-label="Quiet hours start"
            style={{ width: 56 }}
          />
          <span className="desc">to</span>
          <input
            type="number"
            min={0}
            max={23}
            value={s.nudgeQuietEndHour}
            onChange={(e) => set("nudgeQuietEndHour", Number(e.target.value))}
            aria-label="Quiet hours end"
            style={{ width: 56 }}
          />
        </div>
        <div className="desc" style={{ marginTop: 8 }}>
          All times use your computer&apos;s local timezone ({localTzLabel()}).
        </div>
      </div>

      <div className="setting">
        <label>Check-in times</label>
        <div className="desc">
          Each time becomes its own daily &quot;Check Tangent&quot; on Google Calendar plus a
          desktop popup (Tangent must stay in the tray). Saving creates one event per time.
        </div>
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          {(s.checkInTimes ?? []).map((t, i) => (
            <div className="row" key={`${i}-${t}`} style={{ gap: 8 }}>
              <input
                type="time"
                value={t}
                onChange={(e) => {
                  const next = [...(s.checkInTimes ?? [])];
                  next[i] = e.target.value;
                  setS((prev) => applyChosenTimesModes(prev, next));
                }}
              />
              <button
                type="button"
                className="btn"
                onClick={() =>
                  setS((prev) =>
                    applyChosenTimesModes(
                      prev,
                      (prev.checkInTimes ?? []).filter((_, j) => j !== i),
                    ),
                  )
                }
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn"
            onClick={() =>
              setS((prev) =>
                applyChosenTimesModes(prev, [...(prev.checkInTimes ?? []), "18:00"]),
              )
            }
          >
            + Add time
          </button>
        </div>
        <div className="desc" style={{ marginTop: 8 }}>
          Active (outside quiet hours): {formatCheckInTimesLabel(activeCheckInTimes(s))}
        </div>
      </div>

      <div className="setting">
        <label>Morning hour</label>
        <div className="desc">
          Local time (0–23) for &quot;Do Soon&quot; resurfacing and daily nudges. Evening nudge is
          6 PM local when twice-daily is selected.
        </div>
        <input
          type="number"
          min={0}
          max={23}
          value={s.resurfaceHour}
          onChange={(e) => set("resurfaceHour", Number(e.target.value))}
        />
      </div>

      <div className="setting">
        <label>Google Calendar</label>
        <div className="desc">
          Connect once to add events automatically. On any thought in <strong>Triage</strong> or{" "}
          <strong>Board</strong>, click <strong>Calendar</strong> (or press <strong>g</strong> in
          Triage). If there&apos;s no due time yet, you&apos;ll be asked when to schedule it.
          Voice notes with a due time (e.g. &quot;call mom tomorrow at 6&quot;) auto-add after
          capture when connected.
        </div>
        {isGoogleOAuthConfigured() ? (
          <div className="row" style={{ marginTop: 12, gap: 10 }}>
            {s.googleTokens?.refreshToken ? (
              <>
                <span className="desc" style={{ flex: 1 }}>
                  Connected{s.googleEmail ? ` as ${s.googleEmail}` : ""}
                </span>
                <button
                  className="btn"
                  onClick={() => void onDisconnectGoogle()}
                  disabled={googleBusy}
                >
                  Disconnect
                </button>
              </>
            ) : (
              <button className="btn" onClick={() => void onConnectGoogle()} disabled={googleBusy}>
                {googleBusy ? "Waiting for browser…" : "Connect Google Calendar"}
              </button>
            )}
          </div>
        ) : (
          <div className="desc" style={{ marginTop: 10 }}>
            Not available in this build (publisher OAuth credentials missing).
          </div>
        )}
        {isGoogleOAuthConfigured() && (
          <>
            <div style={{ marginTop: 14 }}>
              <label>Phone check-in reminders</label>
              <div className="desc">
                Uses a separate <strong>Tangent Reminders</strong> calendar so your main
                calendar stays clean. Saving replaces the old schedule (no duplicates).
              </div>
              <select
                value={s.googleCalendarPhoneMode ?? "off"}
                onChange={(e) => {
                  const next = e.target.value as GoogleCalendarPhoneMode;
                  setS((prev) => {
                    const updated = { ...prev, googleCalendarPhoneMode: next };
                    if (next === "picked_times") {
                      updated.nudgeInterval = "picked_times";
                    }
                    return updated;
                  });
                }}
                style={{ marginTop: 10 }}
              >
                {(Object.keys(GOOGLE_CALENDAR_PHONE_LABELS) as GoogleCalendarPhoneMode[]).map(
                  (k) => (
                    <option key={k} value={k}>
                      {GOOGLE_CALENDAR_PHONE_LABELS[k]}
                    </option>
                  ),
                )}
              </select>
              {(s.googleCalendarPhoneMode ?? "off") !== "off" && (
                <div className="desc" style={{ marginTop: 8 }}>
                  Phone alerts at: {formatCheckInTimesLabel(phoneCheckInTimes(s))}
                  {(s.googleCalendarPhoneMode ?? "off") === "interval" &&
                    ` (every ${formatNudgeIntervalLabel(s)}, minus quiet hours)`}
                  <div style={{ marginTop: 8 }}>
                    <strong>On your phone (Tangent Reminders settings):</strong>
                    <ol style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                      <li>
                        Turn <strong>Sync</strong> <strong>ON</strong> (grey = off — no alerts
                        until this is on).
                      </li>
                      <li>
                        Under <strong>Default notifications</strong> → <strong>Add a
                        notification</strong> → choose <strong>At time of event</strong>.
                      </li>
                      <li>
                        Tap <strong>Save settings</strong> here in Tangent to refresh events.
                      </li>
                    </ol>
                  </div>
                </div>
              )}
            </div>
            <div className="row" style={{ marginTop: 14 }}>
              <div>
                <label>Reminders on task events</label>
                <div className="desc">
                  Popup alerts before timed thoughts added to Calendar ({calendarReminderLabel(s)}
                  ).
                </div>
              </div>
              <input
                type="checkbox"
                checked={s.googleCalendarReminders ?? true}
                onChange={(e) => set("googleCalendarReminders", e.target.checked)}
              />
            </div>
          </>
        )}
      </div>

      <div className="row" style={{ marginTop: 18, gap: 10 }}>
        <button className="btn" onClick={() => void onSave()} disabled={saving || googleBusy}>
          {saving ? "Saving…" : "Save settings"}
        </button>
        <button className="btn danger" onClick={onWipe}>
          Wipe all data
        </button>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
