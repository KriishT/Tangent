# Tangent

Catch every stray thought without leaving what you're doing - then sort it out later, by priority.

Tangent is a lightweight, local-first desktop app (Tauri v2 + React/TypeScript). A global hotkey pops a capture bar over whatever you're doing; you type or speak one line; it's saved with the context of what you were working on (active app + window/file), and you triage it later. See the product docs in [../docs](../docs).

## Status

Implements MVP milestones M0-M5:

- M0/M1 - global hotkey, capture overlay with work-context chip, save to SQLite, focus returns to your previous app, system tray, launch-on-startup.
- M2 - triage view with keyboard-driven buckets (Do Now / Do Soon / Later / Idea / Drop) and date detection (chrono-node).
- M3 - optional on-device voice (whisper.cpp via `whisper-rs`) behind a Cargo feature, plus Tier 0 rule-based cleanup (filler/self-correction) that always keeps the raw transcript.
- M4 - resurfacing notifications + daily nudge, full settings, privacy controls (context blocklist, delete-audio, export/wipe), and optional Tier 1/2 LLM cleanup (local Ollama or BYOK cloud).
- M5 - NSIS installer config + signing notes (below), stats view.

## Prerequisites (one-time)

Node is already enough to build the frontend, but the desktop app needs the Rust toolchain:

1. Install Rust: https://www.rust-lang.org/tools/install (`rustup`).
2. Windows: install the "Desktop development with C++" workload (MSVC build tools) via Visual Studio Build Tools, and ensure the WebView2 runtime is present (it ships with Windows 11 / recent Edge).
3. Install JS deps: `npm install`.
4. Generate app icons (required before the Rust build): `npx tauri icon path\to\icon.png` (any square PNG, ideally 1024x1024). This creates `src-tauri/icons/`.

## Run / build

```bash
# Dev (hot-reloads the UI; compiles Rust on first run)
npm run tauri:dev

# Production build -> Windows installer in src-tauri/target/release/bundle/
npm run tauri:build
```

The base build is intentionally light. To include on-device voice (pulls in cpal + whisper.cpp, which needs a C/C++ toolchain such as CMake/Clang):

```bash
npm run tauri:dev -- --features voice
npm run tauri:build -- --features voice
```

Then download a Whisper English model into `tangent/models/` (recommended: **ggml-small.en.bin** for accuracy vs speed; **ggml-medium.en.bin** for best accuracy):

```powershell
mkdir models -Force
Invoke-WebRequest -Uri "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin" -OutFile "models/ggml-small.en.bin"
```

Point **Settings → Whisper model path** at that file. Tangent preloads the model on startup and uses beam-search decoding with audio normalization.

## How it works (architecture)

- `src-tauri/src/lib.rs` - app builder, plugins (sql, global-shortcut, notification, autostart), tray, and the `trigger_capture` / `restore_focus` / voice commands.
- `src-tauri/src/context.rs` - reads the foreground window (app/title) and remembers its handle to restore focus (Windows via the `windows` crate; no-op elsewhere).
- `src-tauri/src/voice.rs` - optional recording thread (cpal) + transcription (whisper-rs).
- `src/windows/CaptureOverlay.tsx` - the capture bar (type or hold-to-speak).
- `src/windows/Triage.tsx` - the triage loop.
- `src/windows/Settings.tsx` / `Stats.tsx` - settings and stats.
- `src/lib/*` - SQLite access, date parsing, Tier 0 cleanup, optional AI cleanup, settings, hotkey, resurfacing.

The global hotkey is registered from the frontend (`src/lib/hotkey.ts`) so it can be rebound at runtime. Closing the main window hides it to the tray (the process keeps running so the hotkey stays live).

## Footprint goal

Target < 120 MB idle (see [../docs/04-technical-feasibility.md](../docs/04-technical-feasibility.md) section 7a). Nothing heavy loads at startup; the Whisper model and any LLM cleanup are lazy and optional. "Lite mode" in Settings disables voice/AI entirely.

## Code signing (M5, before public distribution)

Unsigned apps trigger Windows SmartScreen. For release, sign the installer (Authenticode certificate) and configure signing in `tauri.conf.json` under `bundle.windows`. See the Tauri Windows signing guide. Until then, beta testers can click through SmartScreen ("More info" -> "Run anyway").

## Notes / known follow-ups

- whisper-rs API names can shift between versions; if a voice build fails to compile, pin/adjust the `whisper-rs` version in `Cargo.toml` and the call sites in `voice.rs`.
- Overlay focus behavior (non-activating window + reliable refocus) is the main thing to verify on first run on your machine; it's implemented but worth a smoke test (the M0 acceptance check).
