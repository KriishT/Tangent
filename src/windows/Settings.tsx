import { useEffect, useState } from "react";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type AppSettings } from "../lib/settings";
import { useDialog } from "../components/DialogProvider";
import { applyHotkey } from "../lib/hotkey";
import { exportAll, wipeAll } from "../lib/db";

export default function Settings() {
  const { confirm } = useDialog();
  const [s, setS] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [autostart, setAutostart] = useState(false);
  const [toast, setToast] = useState("");

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

  async function onSave() {
    await saveSettings(s);
    await applyHotkey().catch(() => {});
    flash("Settings saved");
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

  async function onExport() {
    const json = await exportAll();
    try {
      await navigator.clipboard.writeText(json);
      flash("Exported JSON copied to clipboard");
    } catch {
      flash("Could not access clipboard");
    }
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
      flash("All data wiped");
    }
  }

  return (
    <div>
      <div className="page-title">Settings</div>
      <div className="page-sub">Private and local by default. Heavy features are opt-in.</div>

      <div className="setting">
        <label>Capture hotkey</label>
        <div className="desc">
          Global shortcut to open the capture bar. Uses Tauri accelerator syntax, e.g.
          CommandOrControl+Shift+Space.
        </div>
        <input type="text" value={s.hotkey} onChange={(e) => set("hotkey", e.target.value)} />
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
            <label>Lite mode (type-only)</label>
            <div className="desc">Disable all voice/AI components for the smallest footprint.</div>
          </div>
          <input
            type="checkbox"
            checked={s.liteMode}
            onChange={(e) => set("liteMode", e.target.checked)}
          />
        </div>
      </div>

      {!s.liteMode && (
        <>
          <div className="setting">
            <div className="row">
              <div>
                <label>Voice capture</label>
                <div className="desc">
                  Hold to speak; transcription runs on-device (requires a build with the voice
                  feature and a Whisper model).
                </div>
              </div>
              <input
                type="checkbox"
                checked={s.voiceEnabled}
                onChange={(e) => set("voiceEnabled", e.target.checked)}
              />
            </div>
            {s.voiceEnabled && (
              <input
                type="text"
                placeholder="Path to ggml-base.en.bin"
                value={s.modelPath}
                onChange={(e) => set("modelPath", e.target.value)}
              />
            )}
          </div>

          <div className="setting">
            <div className="row">
              <div>
                <label>Faithful mode</label>
                <div className="desc">Keep transcripts verbatim (skip filler/self-correction cleanup).</div>
              </div>
              <input
                type="checkbox"
                checked={s.faithfulMode}
                onChange={(e) => set("faithfulMode", e.target.checked)}
              />
            </div>
          </div>

          <div className="setting">
            <label>Smart cleanup (optional)</label>
            <div className="desc">
              Resolve self-corrections and tidy phrasing with an LLM. Off keeps only the free
              on-device rules. Local uses an Ollama-compatible endpoint; Cloud uses your own API
              key (text leaves your device).
            </div>
            <select
              value={s.cleanupTier}
              onChange={(e) => set("cleanupTier", e.target.value as AppSettings["cleanupTier"])}
            >
              <option value="off">Off (rules only)</option>
              <option value="local">Local LLM (on-device)</option>
              <option value="cloud">Cloud (BYOK)</option>
            </select>
            {s.cleanupTier === "local" && (
              <>
                <input
                  type="text"
                  value={s.localEndpoint}
                  onChange={(e) => set("localEndpoint", e.target.value)}
                  placeholder="http://localhost:11434/api/generate"
                />
                <input
                  type="text"
                  value={s.localModel}
                  onChange={(e) => set("localModel", e.target.value)}
                  placeholder="qwen2.5:1.5b"
                />
              </>
            )}
            {s.cleanupTier === "cloud" && (
              <>
                <select
                  value={s.byokProvider}
                  onChange={(e) =>
                    set("byokProvider", e.target.value as AppSettings["byokProvider"])
                  }
                >
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                </select>
                <input
                  type="password"
                  value={s.byokKey}
                  onChange={(e) => set("byokKey", e.target.value)}
                  placeholder="API key"
                />
              </>
            )}
          </div>
        </>
      )}

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
              Blocklist (one fragment per line) - never store context from matching apps/titles
              (e.g. a password manager or incognito window).
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
        <label>Resurface time</label>
        <div className="desc">Hour of the morning that "Do Soon" items come back (0-23).</div>
        <input
          type="number"
          min={0}
          max={23}
          value={s.resurfaceHour}
          onChange={(e) => set("resurfaceHour", Number(e.target.value))}
        />
      </div>

      {!s.liteMode && s.voiceEnabled && (
        <div className="setting">
          <div className="row">
            <div>
              <label>Delete audio after transcription</label>
              <div className="desc">Don't keep raw audio once it's been turned into text.</div>
            </div>
            <input
              type="checkbox"
              checked={s.deleteAudioAfter}
              onChange={(e) => set("deleteAudioAfter", e.target.checked)}
            />
          </div>
        </div>
      )}

      <div className="row" style={{ marginTop: 18, gap: 10 }}>
        <button className="btn" onClick={onSave}>
          Save settings
        </button>
        <button className="btn secondary" onClick={onExport}>
          Export data
        </button>
        <button className="btn danger" onClick={onWipe}>
          Wipe all data
        </button>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
