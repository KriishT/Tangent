# Tangent

**Catch every stray thought without leaving what you're doing.**

Tangent is a local-first desktop app for Windows and macOS. Hold a global hotkey, speak (or type) one line, and keep working — your thought is parked with the app and file you were in, ready to triage later.

[Website](https://usetangent.vercel.app/) · [Releases](https://github.com/KriishT/Tangent/releases) · [v1.0.11](https://github.com/KriishT/Tangent/releases/tag/v1.0.11)

```
Capture (<2s)  →  Park (with work context)  →  Triage  →  Resurface
```

---

## Why it exists

You're deep in a problem. A tangential thought fires — submit the assignment, buy the cable, email someone back. You either:

1. **Stop and write it down** — context switch, lose the thread, hunt for where you were, or
2. **Tell yourself you'll remember** — and you don't.

Notes apps and Siri force you out of flow. Dictation tools paste into whatever is focused — they don't park, sort, or bring the thought back. Scratchpads capture fast but never close the loop.

Tangent is built for the full loop:

| Moment | What happens |
| --- | --- |
| **Capture** | Global hotkey. Speak or type. Focus stays in your editor. |
| **Park** | Saved locally with automatic work context (app + window/file). |
| **Triage** | Keyboard-driven buckets: Do Now / Do Soon / Later / Idea / Drop. |
| **Resurface** | Native notifications, calendar sync, or `.ics` export when it's due. |

The differentiator isn't speed alone — fast capture is table stakes. **The product is that parked thoughts come back with the context you had when you had them.**

When developers are interrupted, they hunt for context before resuming — only **10%** of programming sessions return to coding in under a minute ([Parnin & Rugaber](https://blog.acolyer.org/2016/04/04/programmer-interrupted/)). Tangent records that context at capture time.

---

## Features

### Capture
- **Global hotkey** — default `Ctrl+Shift+Space` (Windows) / `Cmd+Shift+Space` (macOS); rebindable
- **Hold to speak, release to save** — on-device Whisper transcription; no cloud required
- **Typed quick-add** in Triage for when you don't want the mic
- **Non-activating overlay** — your previous app keeps focus; the cursor never moves
- **Automatic work context** — active app name + parsed window/file/workspace detail
- **Tier 0 cleanup** — strips fillers (`um`, `uh`), resolves simple self-corrections; raw transcript kept; optional faithful mode

### Triage
- Keyboard-first inbox: `j`/`k` navigate, `1`–`5` sort into buckets
- Buckets: **Do Now · Do Soon · Later · Idea · Drop**
- Auto date detection (`tomorrow`, `Friday 3pm`, …) via chrono-node
- Due chips with urgency styling (soon / overdue)
- Search across all thoughts (`/`)
- Edit, copy, delete; expandable context details panel

### Priority board
- Five columns matching the triage buckets (+ Done)
- Drag cards between columns
- Same context chips and due metadata as Triage

### Resurfacing
- Native OS notifications when a due item arrives (`Tangent reminder`)
- Configurable triage nudges (hourly, daily, chosen times, quiet hours)
- **Do Soon** items resurface at your morning hour

### Calendar
- **Google Calendar** — OAuth connect; one-click add from Triage (`i`)
- **Apple Calendar** and **Outlook** — same connect pattern where supported
- **`.ics` download** — works with any calendar app, no account required
- Optional phone check-in events (`Check Tangent`) so reminders reach your pocket

### Privacy & settings
- **Local-first** — SQLite on disk; no account required to start
- Context capture toggle + per-app blocklist (e.g. password managers)
- Light / Dark / Match system
- Launch on startup; lives in the system tray so the hotkey stays live
- Export thoughts / wipe all data
- Optional in-app updates

### Stats
- Triage rate (the health metric — capture is easy; sorting is the product)
- Caught · Triaged · Parked · Never triaged

---

## Tech stack

| Layer | Choice |
| --- | --- |
| Shell | [Tauri v2](https://tauri.app/) |
| Backend | Rust |
| Frontend | React 18 + TypeScript + Vite |
| Storage | SQLite (`tauri-plugin-sql`) |
| Hotkey | `tauri-plugin-global-shortcut` |
| Window context | `active-win-pos-rs` (+ Win32 / macOS focus restore) |
| Voice (optional) | `cpal` + [whisper.cpp](https://github.com/ggerganov/whisper.cpp) via `whisper-rs` |
| Date parsing | `chrono-node` |
| Notifications | `tauri-plugin-notification` |
| Autostart | `tauri-plugin-autostart` |
| Updates | `tauri-plugin-updater` |

**Footprint target:** under ~120 MB idle. Voice and any LLM cleanup are optional and lazy-loaded — a type-only user barely notices the process running.

---

## How it works

```
┌─────────────────────────────────────────────────────────────┐
│  You're in Cursor / VS Code / Chrome / …                    │
│                                                             │
│  Hold Ctrl+Shift+Space                                      │
│       ↓                                                     │
│  Rust reads foreground window (context)                     │
│  Tiny "Listening" HUD appears (non-activating)              │
│  Speak → release → HUD hides, focus restored                │
│       ↓                                                     │
│  On-device Whisper → Tier 0 cleanup → SQLite                 │
│  Thought parked with: body + app + file/workspace + due?    │
│       ↓                                                     │
│  Later: Triage (1–5) → Board / calendar / notification      │
└─────────────────────────────────────────────────────────────┘
```

### Architecture (repo map)

```
tangent/
├── src/                      # React UI
│   ├── windows/              # Triage, Board, Stats, Settings, Capture HUD
│   ├── components/           # Logo, dialogs, calendar actions, …
│   └── lib/                  # DB, hotkey, resurfacing, calendars, cleanup
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs            # App builder, plugins, tray, commands
│   │   ├── context.rs        # Foreground window + focus restore
│   │   ├── voice.rs          # Recording + Whisper (feature-gated)
│   │   ├── notify.rs         # Native notification helpers
│   │   ├── google_calendar.rs
│   │   ├── apple_calendar.rs
│   │   └── outlook_calendar.rs
│   └── tauri.conf.json
└── models/                   # Whisper ggml models (dev / bundled)
```

The global hotkey is registered from the frontend so it can be rebound at runtime. Closing the main window **hides to tray** — the process stays alive so capture never stops.

---

## Install (end users)

Download the latest installer from **[Releases](https://github.com/KriishT/Tangent/releases)**.

| Platform | Artifact |
| --- | --- |
| Windows | `.exe` / NSIS installer |
| macOS | `.dmg` |

Unsigned beta builds may trigger SmartScreen (Windows) or Gatekeeper (macOS) once — use **More info → Run anyway** / right-click → Open. See [docs/releasing.md](docs/releasing.md).

---

## Develop

### Prerequisites

1. [Node.js](https://nodejs.org/) (LTS)
2. [Rust](https://www.rust-lang.org/tools/install) via `rustup`
3. **Windows:** Visual Studio Build Tools — "Desktop development with C++"; WebView2 (ships with Windows 11 / recent Edge)
4. **macOS:** Xcode Command Line Tools
5. For voice builds: a C/C++ toolchain (CMake / Clang) for whisper.cpp

### Run

```bash
cd tangent
npm install
npm run tauri:dev          # includes --features voice + Whisper model fetch
```

Production build:

```bash
npm run tauri:build        # installer under src-tauri/target/release/bundle/
```

Voice is enabled by default in the npm scripts. A base build without voice is possible via Cargo without the `voice` feature if you need a lighter compile.

Whisper model (English base, bundled on release; fetched in dev):

```bash
npm run ensure-model
```

Optional higher-accuracy model for local testing: `ggml-small.en.bin` from [Hugging Face / whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp).

### Google Calendar (optional)

Copy `.env.example` → `.env` and set OAuth client credentials for local builds. Without them, the rest of the app works; only Connect Google Calendar is disabled. Details: [docs/google-calendar-oauth.md](docs/google-calendar-oauth.md).

---

## Privacy

- Thoughts live in local SQLite — not on our servers
- Voice transcription runs **on-device** (whisper.cpp)
- Work context can be disabled or blocked per app
- No account required for core capture → triage → resurface
- Export or delete everything from Settings

---

## Product principles

1. Capture takes **under two seconds** and requires **zero decisions**
2. The app **never interrupts** you during capture
3. **Work context is automatic** — the wedge
4. **Capture first, organize later**
5. **Local-first & private** by default
6. The inbox is a **pipeline, not a graveyard** — resurfacing keeps it moving
7. **Lightweight** — heavy pieces (voice, AI) are optional and lazy

---

## Docs

| Doc | What it covers |
| --- | --- |
| [docs/releasing.md](docs/releasing.md) | Shipping unsigned Windows + Mac builds |
| [docs/google-calendar-oauth.md](docs/google-calendar-oauth.md) | Google Calendar OAuth setup |
| [docs/platform-support.md](docs/platform-support.md) | Platform notes |
| [docs/10-feature-strategy.md](docs/10-feature-strategy.md) | Feature strategy |

Broader product research and strategy live in the parent monorepo `docs/` (user research, competitor teardown, MVP spec, [strategic assessment](../docs/11-strategic-assessment-2026.md)).

---

## Status

MVP milestones **M0–M5** are implemented: capture, triage, board, voice, resurfacing, settings, stats, calendar integrations, `.ics` export, tray, autostart, updater.

**Current version:** `1.0.11`

---

## Contributing

Issues and PRs are welcome. For large changes, open an issue first so we can align on direction.

Useful smoke checks after a change:

- Hotkey → Listening HUD → release → focus restored to the previous app
- Thought appears in Triage with a sensible context chip
- Sort with `1`–`5`; drag on the Priority board
- Due time + notification / calendar path

---

## License

Source available for now; license TBD. If you need clarity for redistribution, open an issue.

---

<p align="center">
  <sub>Catch every stray thought without leaving what you're doing.</sub>
</p>
