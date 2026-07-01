import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { DialogProvider } from "./components/DialogProvider";
import Triage from "./windows/Triage";
import Lists from "./windows/Lists";
import Settings from "./windows/Settings";
import { applyHotkey } from "./lib/hotkey";
import { preloadVoiceModel } from "./lib/voiceCapture";
import { ensureNotifications, maybeTriageNudge, runResurfaceTick } from "./lib/resurface";

type Tab = "triage" | "lists" | "settings";

export default function MainApp() {
  const [tab, setTab] = useState<Tab>("triage");
  const [dataRev, setDataRev] = useState(0);

  useEffect(() => {
    void applyHotkey().catch(() => {});
    void preloadVoiceModel();

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
    const unVoice = listen<{ outcome: string; detail?: string | null }>(
      "voice-capture-result",
      (e) => {
        const { outcome, detail } = e.payload;
        if (outcome === "saved") {
          setTab("triage");
          return;
        }
        if (outcome === "error" && detail) {
          void sendNotification({ title: "Tangent — voice capture", body: detail });
        }
      }
    );

    return () => {
      if (timer) clearInterval(timer);
      unClose.then((f) => f());
      unTriage.then((f) => f());
      unThought.then((f) => f());
      unVoice.then((f) => f());
    };
  }, []);

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: "triage", label: "Triage", icon: "◎" },
    { id: "lists", label: "Board", icon: "▦" },
    { id: "settings", label: "Settings", icon: "⚙" },
  ];

  return (
    <DialogProvider>
      <div className="app">
        <aside className="sidebar" aria-label="Main navigation">
          <div className="logo">
            Tan<span>gent</span>
          </div>
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
        </aside>
        <main className="content">
          {tab === "triage" && <Triage dataRev={dataRev} />}
          {tab === "lists" && <Lists />}
          {tab === "settings" && <Settings />}
        </main>
      </div>
    </DialogProvider>
  );
}
