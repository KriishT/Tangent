# Platform support — Windows & macOS

Last verified: 2026-08-30

## Summary

| Platform | Build target | Status |
|----------|--------------|--------|
| **Windows 10/11** | `nsis` installer | **Verified** — full `tauri build` succeeded; `tangent.exe` + `Tangent_0.1.0_x64-setup.exe` produced |
| **macOS 11+** | `dmg` in `tauri.conf.json` | **Code-ready** — focus restore implemented; requires on-Mac build/test |

## Windows (verified on this machine)

```powershell
cd tangent
npm install
npm run tauri:build
```

Output: `tangent\src-tauri\target\release\bundle\nsis\Tangent_0.1.0_x64-setup.exe`

- Global hotkey via `tauri-plugin-global-shortcut`
- Focus restore via Win32 `SetForegroundWindow` + stored HWND
- Active window context via `active-win-pos-rs`
- Optional voice: `--features voice` (bundled in `npm run tauri:build`)

## macOS (static verification + required manual test)

Cannot cross-compile from Windows without the Apple toolchain. The following are in place:

| Component | macOS support |
|-----------|---------------|
| Tauri v2 | ✓ |
| `active-win-pos-rs` | ✓ cross-platform |
| Global shortcut plugin | ✓ |
| Bundle `dmg` target | ✓ in `tauri.conf.json` |
| Focus restore | ✓ `osascript` + process PID (fixed Aug 2026 — was previously no-op) |
| Icons `.icns` | ✓ in `src-tauri/icons/` |

**On a Mac, run:**

```bash
cd tangent
npm install
npm run tauri:build
```

**Manual test checklist:**

1. Hotkey opens capture overlay; previous app regains focus after Enter/Esc
2. Context chip shows correct app + window title
3. Voice capture (if enabled) transcribes and saves
4. `.ics` download works for due items (press `i` in Triage)
5. Notifications permission granted when prompted

**Known macOS notes:**

- Bundle identifier `com.tangent.app` triggers a Tauri warning (`.app` suffix); consider `com.tangent.desktop` before App Store
- `osascript` focus restore may require **Accessibility** permission for Tangent in System Settings on first use
- Microphone permission required for voice capture

## Linux

Not a release target. Focus restore is a no-op; other features may work with `cargo tauri dev` but are unsupported.
