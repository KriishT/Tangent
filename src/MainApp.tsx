import { useEffect, useState } from "react";

import { getCurrentWindow } from "@tauri-apps/api/window";

import { listen } from "@tauri-apps/api/event";

import { DialogProvider } from "./components/DialogProvider";
import Triage from "./windows/Triage";

import Lists from "./windows/Lists";

import Settings from "./windows/Settings";

import Stats from "./windows/Stats";

import { applyHotkey } from "./lib/hotkey";

import { ensureNotifications, maybeDailyNudge, runResurfaceTick } from "./lib/resurface";



type Tab = "triage" | "lists" | "stats" | "settings";



export default function MainApp() {

  const [tab, setTab] = useState<Tab>("triage");
  const [dataRev, setDataRev] = useState(0);



  useEffect(() => {

    // Register the global hotkey and wire up notifications + resurfacing.

    void applyHotkey().catch(() => {});



    let timer: ReturnType<typeof setInterval> | undefined;

    void (async () => {

      await ensureNotifications();

      await runResurfaceTick();

      await maybeDailyNudge();

      timer = setInterval(() => {

        void runResurfaceTick();

        void maybeDailyNudge();

      }, 60_000);

    })();



    // Keep the app alive in the tray when the window is closed.

    const win = getCurrentWindow();

    const unClose = win.onCloseRequested((e) => {

      e.preventDefault();

      void win.hide();

    });

    const unTriage = listen("go-triage", () => setTab("triage"));

    const unThought = listen("thought-added", () => setDataRev((n) => n + 1));

    return () => {

      if (timer) clearInterval(timer);

      unClose.then((f) => f());

      unTriage.then((f) => f());

      unThought.then((f) => f());

    };

  }, []);



  const tabs: { id: Tab; label: string; icon: string }[] = [

    { id: "triage", label: "Triage", icon: "◎" },

    { id: "lists", label: "Board", icon: "▦" },

    { id: "stats", label: "Stats", icon: "◫" },

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

        {tab === "stats" && <Stats />}

        {tab === "settings" && <Settings />}

      </main>

    </div>
    </DialogProvider>
  );

}

