import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { sendNotification } from "@tauri-apps/plugin-notification";
import type { Update } from "@tauri-apps/plugin-updater";
import { DialogProvider, useDialog } from "./components/DialogProvider";
import Logo from "./components/Logo";
import ThemeToggle from "./components/ThemeToggle";
import Triage from "./windows/Triage";
import Lists from "./windows/Lists";
import Settings from "./windows/Settings";
import Stats from "./windows/Stats";
import { applyHotkey } from "./lib/hotkey";
import { ensureDefaultAutostart } from "./lib/autostart";
import { preloadVoiceModel } from "./lib/voiceCapture";
import { ensureNotifications, maybeTriageNudge, runResurfaceTick } from "./lib/resurface";
import { loadSettings, saveSettings, type ThemeMode } from "./lib/settings";
import { applyTheme, watchSystemTheme } from "./lib/theme";
import { checkForAppUpdate, installAppUpdate } from "./lib/updater";

type Tab = "triage" | "lists" | "stats" | "settings";

function AppShell() {
  const { confirm } = useDialog();
  const [tab, setTab] = useState<Tab>("triage");
  const [dataRev, setDataRev] = useState(0);
  const [theme, setTheme] = useState<ThemeMode>("system");
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);
  const [updating, setUpdating] = useState(false);

  const onThemeChange = useCallback(async (next: ThemeMode) => {
    setTheme(next);
    applyTheme(next);
    const s = await loadSettings();
    await saveSettings({ ...s, theme: next });
  }, []);

  const applyUpdate = useCallback(
    async (update: Update) => {
      const ok = await confirm({
        title: `Install Tangent ${update.version}?`,
        message: "The app will download the update and restart.",
        confirmLabel: "Update now",
        cancelLabel: "Later",
      });
      if (!ok) return;
      setUpdating(true);
      try {
        await installAppUpdate(update);
      } catch (e) {
        setUpdating(false);
        void sendNotification({
          title: "Tangent — update failed",
          body: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [confirm],
  );

  useEffect(() => {
    void loadSettings().then((s) => {
      setTheme(s.theme);
      applyTheme(s.theme);
    });
    const unwatch = watchSystemTheme(() => {
      void loadSettings().then((s) => {
        if (s.theme === "system") applyTheme("system");
      });
    });
    return unwatch;
  }, []);

  useEffect(() => {
    void applyHotkey().then((err) => {
      if (err) {
        void sendNotification({ title: "Tangent — hotkey", body: err });
      }
    });
    void ensureDefaultAutostart();
    void preloadVoiceModel();
    void checkForAppUpdate().then((result) => {
      if (result.status === "available") {
        setPendingUpdate(result.update);
      }
    });

    let timer: ReturnType<typeof setInterval> | undefined;
    void (async () => {
      await ensureNotifications();
      await runResurfaceTick();
      await maybeTriageNudge();
      timer = setInterval(() => {
        void runResurfaceTick();
        void maybeTriageNudge();
      }, 30_000);
    })();

    const win = getCurrentWindow();
    const unClose = win.onCloseRequested((e) => {
      e.preventDefault();
      void win.hide();
    });
    const unTriage = listen("go-triage", () => setTab("triage"));
    const unThought = listen("thought-added", () => setDataRev((n) => n + 1));
    const unTranscribing = listen<{ active: boolean }>("voice-transcribing", (e) => {
      if (e.payload.active) setTab("triage");
    });
    const unVoice = listen<{ outcome: string; detail?: string | null }>(
      "voice-capture-result",
      (e) => {
        const { outcome, detail } = e.payload;
        if (outcome === "saved") {
          setTab("triage");
          setDataRev((n) => n + 1);
          if (detail?.trim()) {
            void sendNotification({ title: "Tangent", body: detail });
          }
          return;
        }
        if (detail) {
          void sendNotification({
            title: outcome === "error" ? "Tangent — voice capture" : "Tangent",
            body: detail,
          });
        }
      },
    );

    return () => {
      if (timer) clearInterval(timer);
      unClose.then((f) => f());
      unTriage.then((f) => f());
      unThought.then((f) => f());
      unTranscribing.then((f) => f());
      unVoice.then((f) => f());
    };
  }, []);

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: "triage", label: "Triage", icon: "◎" },
    { id: "lists", label: "Board", icon: "▦" },
    { id: "stats", label: "Stats", icon: "◈" },
    { id: "settings", label: "Settings", icon: "⚙" },
  ];

  return (
    <div className="app">
      <aside className="sidebar" aria-label="Main navigation">
        <Logo />
        <nav className="sidebar-nav">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={tab === t.id ? "active" : ""}
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? "page" : undefined}
            >
              <span className="nav-icon" aria-hidden>
                {t.icon}
              </span>
              <span className="nav-label">{t.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <ThemeToggle value={theme} onChange={(m) => void onThemeChange(m)} compact />
        </div>
      </aside>
      <main className="content">
        {pendingUpdate && (
          <div className="update-banner" role="status">
            <span>
              Tangent {pendingUpdate.version} is available
              {updating ? " — installing…" : ""}
            </span>
            <div className="update-banner-actions">
              <button
                type="button"
                className="btn"
                disabled={updating}
                onClick={() => void applyUpdate(pendingUpdate)}
              >
                {updating ? "Updating…" : "Update now"}
              </button>
              <button
                type="button"
                className="btn ghost"
                disabled={updating}
                onClick={() => setPendingUpdate(null)}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
        {tab === "triage" && <Triage dataRev={dataRev} />}
        {tab === "lists" && <Lists />}
        {tab === "stats" && <Stats />}
        {tab === "settings" && (
          <Settings theme={theme} onThemeChange={(m) => void onThemeChange(m)} />
        )}
      </main>
    </div>
  );
}

export default function MainApp() {
  return (
    <DialogProvider>
      <AppShell />
    </DialogProvider>
  );
}
