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
  type ThemeMode,
} from "../lib/settings";
import ThemeToggle from "../components/ThemeToggle";
import { useDialog } from "../components/DialogProvider";
import { applyTheme } from "../lib/theme";
import HotkeyCapture from "../components/HotkeyCapture";
import { applyHotkey } from "../lib/hotkey";
import { validateHotkey } from "../lib/hotkeyFormat";
import {
  connectGoogleCalendar,
  disconnectGoogleCalendar,
  isGoogleOAuthConfigured,
  applyGoogleCalendarSettings,
  wipeAllThoughtsWithCalendar,
} from "../lib/googleCalendar";
import { exportAll } from "../lib/db";
import { emit, listen } from "@tauri-apps/api/event";
import { checkForAppUpdate, installAppUpdate } from "../lib/updater";
import { getVersion } from "@tauri-apps/api/app";

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

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? navigator.userAgent);
}

export default function Settings({
  theme: themeProp,
  onThemeChange,
}: {
  theme?: ThemeMode;
  onThemeChange?: (mode: ThemeMode) => void;
} = {}) {
  const { confirm } = useDialog();
  const [s, setS] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [autostart, setAutostart] = useState(false);
  const [toast, setToast] = useState("");
  const [googleBusy, setGoogleBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [micBusy, setMicBusy] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const [updateBusy, setUpdateBusy] = useState(false);
  const onMac = isMacPlatform();

  useEffect(() => {
    void loadSettings().then(setS);
    void isEnabled()
      .then(setAutostart)
      .catch(() => {});
    void getVersion()
      .then(setAppVersion)
      .catch(() => {});
    const un = listen("google-calendar-disconnected", () => {
      void loadSettings().then(setS);
    });
    return () => {
      un.then((f) => f());
    };
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
      applyTheme(toSave.theme);
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
      await applyHotkey().then((hotkeyErr) => {
        if (hotkeyErr) flash(hotkeyErr);
      });
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
    } catch (e) {
      flash(e instanceof Error ? e.message : "Could not change startup setting");
    }
  }

  async function onCheckForUpdates() {
    if (updateBusy) return;
    setUpdateBusy(true);
    try {
      const result = await checkForAppUpdate();
      if (result.status === "up_to_date") {
        flash(appVersion ? `You're on the latest version (v${appVersion})` : "You're up to date");
        return;
      }
      if (result.status === "error") {
        flash(result.message);
        return;
      }
      const ok = await confirm({
        title: `Tangent ${result.update.version} is available`,
        message: "Download and install now? The app will restart.",
        confirmLabel: "Update now",
        cancelLabel: "Later",
      });
      if (!ok) return;
      flash("Downloading update…");
      await installAppUpdate(result.update);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Update failed");
    } finally {
      setUpdateBusy(false);
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
    setGoogleBusy(true);
    try {
      await disconnectGoogleCalendar();
      setS(await loadSettings());
      flash("Google Calendar disconnected");
    } catch {
      setS(await loadSettings());
      flash("Google Calendar disconnected");
    } finally {
      setGoogleBusy(false);
    }
  }

  async function onWipe() {
    const ok = await confirm({
      title: "Delete all thoughts?",
      message:
        "This permanently removes every captured thought and linked calendar events. Settings and Google connection are kept. It cannot be undone.",
      confirmLabel: "Delete everything",
      cancelLabel: "Cancel",
      variant: "danger",
    });
    if (ok) {
      await wipeAllThoughtsWithCalendar();
      void emit("thought-added", {}).catch(() => {});
      flash("All thoughts wiped");
    }
  }

  async function onExport() {
    try {
      const json = await exportAll();
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `tangent-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      flash("Export downloaded");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Export failed");
    }
  }

  return (
    <div>
      <div className="page-title">Settings</div>
      <div className="page-sub">Private and local by default.</div>

      <div className="setting">
        <label>Appearance</label>
        <div className="desc">Choose light, dark, or match your system preference.</div>
        <div style={{ marginTop: 12 }}>
          <ThemeToggle
            value={themeProp ?? s.theme}
            onChange={(mode) => {
              setS((prev) => ({ ...prev, theme: mode }));
              applyTheme(mode);
              onThemeChange?.(mode);
              void (async () => {
                const latest = await loadSettings();
                await saveSettings({ ...latest, theme: mode });
              })();
            }}
          />
        </div>
      </div>

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
              Wait for <strong>Listening</strong> in the chip before you start talking.
              The mic stays warm in the background for faster capture. On-device model included.
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
              {onMac ? (
                <>
                  macOS: System Settings → Privacy &amp; Security → Microphone — allow Tangent.
                  Then check System Settings → Sound → Input for the selected microphone.
                </>
              ) : (
                <>
                  Windows: Settings → Privacy &amp; security → Microphone — turn on access and
                  allow <strong>desktop apps</strong>. Set your mic as the default input in Sound
                  settings.
                </>
              )}
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
            <label>App updates</label>
            <div className="desc">
              {appVersion ? `Current version v${appVersion}. ` : ""}
              Check GitHub for a newer build and install it in-app.
            </div>
          </div>
          <button
            type="button"
            className="btn"
            disabled={updateBusy}
            onClick={() => void onCheckForUpdates()}
          >
            {updateBusy ? "Checking…" : "Check for updates"}
          </button>
        </div>
      </div>

      <div className="setting">
        <div className="row">
          <div>
            <label>Faithful transcripts</label>
            <div className="desc">Skip automatic filler-word cleanup on voice capture.</div>
            <div className="desc" style={{ marginTop: 4 }}>
              Turn on for word-for-word transcripts — best when accuracy matters more than polish.
            </div>
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
        <label>Triage reminders (this computer)</label>
        <div className="desc">
          Desktop popup on this cadence saying &quot;Check Tangent now&quot; — even when
          triage is empty. Tangent must stay running in the tray. Quiet hours pause these
          pings (including chosen check-in times).
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
        <label>Calendar reminders</label>
        <div className="desc">
          <strong>Recommended:</strong> set a due time on any thought (press <strong>t</strong> in
          Triage), then press <strong>i</strong> to download a <code>.ics</code> file. Import it
          into Google Calendar, Outlook, or Apple Calendar — phone alerts work with zero sign-in.
          Desktop notifications still fire when Tangent is running.
        </div>
      </div>

      <div className="setting">
        <label>Google Calendar (optional)</label>
        <div className="desc">
          Advanced: connect once for automatic event creation. Google may show verification warnings
          for new apps — if that feels risky, use <code>.ics</code> export instead (above). When
          connected, <strong>Set due</strong> / <strong>t</strong> auto-creates events. Day-only
          phrases like &quot;tonight&quot; get a tentative evening time you can adjust.
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
                  {googleBusy ? "Disconnecting…" : "Disconnect"}
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
              <label>Phone check-in reminders (Google Calendar)</label>
              <div className="desc">
                Separate from desktop triage pings above. Uses a <strong>Tangent Reminders</strong>{" "}
                calendar so your main calendar stays clean. Saving replaces the old schedule.
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
                <label>Alerts on task calendar events</label>
                <div className="desc">
                  Google Calendar popup before timed thoughts ({calendarReminderLabel(s)}). This is
                  separate from desktop triage nudges.
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

      <div className="row" style={{ marginTop: 18, gap: 10, flexWrap: "wrap" }}>
        <button className="btn" onClick={() => void onSave()} disabled={saving || googleBusy}>
          {saving ? "Saving…" : "Save settings"}
        </button>
        <button className="btn secondary" type="button" onClick={() => void onExport()}>
          Export thoughts
        </button>
        <button className="btn danger" type="button" onClick={() => void onWipe()}>
          Delete all thoughts
        </button>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
