# Releasing Tangent (unsigned beta)

This guide is for shipping **Windows + Mac installers without a code-signing certificate**.
Users will see SmartScreen (Windows) or Gatekeeper (Mac) warnings once — that is normal for indie apps.

## Phase 1 — One-time setup

### 1. Put the project on GitHub

From the `tangent` folder:

```powershell
git init
git add .
git commit -m "Initial Tangent release prep"
```

Create a new repo on GitHub (e.g. `yourname/tangent`), then:

```powershell
git remote add origin https://github.com/YOURNAME/tangent.git
git branch -M main
git push -u origin main
```

### 2. Google Calendar (optional, for release builds)

Copy `.env.example` → `.env` and set your OAuth client ID for local builds.

For GitHub Actions, add repository **secrets** (Settings → Secrets and variables → Actions):

- `GOOGLE_OAUTH_CLIENT_ID` — your `*.apps.googleusercontent.com` client ID
- `GOOGLE_OAUTH_CLIENT_SECRET` — required for Web-application OAuth clients (same as local `.env`)

Without these, the app still works — only **Connect Google Calendar** is disabled.

### 3. Icons

If `src-tauri/icons/` is missing assets:

```powershell
npx tauri icon path\to\1024x1024.png
```

---

## Phase 2 — Build locally (smoke test)

### Windows (your machine)

```powershell
cd tangent
npm install
npm run tauri:build:voice
```

Installer:

```
src-tauri\target\release\bundle\nsis\Tangent_0.1.0_x64-setup.exe
```

Checksum:

```powershell
Get-FileHash "src-tauri\target\release\bundle\nsis\Tangent_0.1.0_x64-setup.exe" -Algorithm SHA256
```

Install on a **second PC** (or VM), run through: hotkey → voice → triage → settings save.

### Mac (needs a Mac)

```bash
cd tangent
npm install
npm run tauri:build:voice
```

Output:

```
src-tauri/target/release/bundle/dmg/Tangent_0.1.0_aarch64.dmg
```

First install (ad-hoc signed — no Apple Developer ID yet):

1. Open the `.dmg`.
2. Drag **Tangent** into **Applications**.
3. **Eject the disk image** (do not launch from the DMG).
4. Open Tangent. If macOS blocks it: **System Settings → Privacy & Security → Open Anyway**,
   or right-click → **Open**.

`signingIdentity: "-"` seals the `.app` so Apple Silicon / Sequoia do not show the false
“damaged and can’t be opened” dialog (that happens with an incomplete signature).

Fallback if an older build still says “damaged”:

```bash
xattr -cr /Applications/Tangent.app
codesign --force --deep --sign - /Applications/Tangent.app
open /Applications/Tangent.app
```

---

## Phase 3 — Ship via GitHub Releases (recommended)

### Option A — Automatic (CI)

1. Bump version in **three places** (keep in sync):
   - `package.json` → `"version"`
   - `src-tauri/tauri.conf.json` → `"version"`
   - `src-tauri/Cargo.toml` → `version`

2. Commit and tag:

```powershell
git add .
git commit -m "Release v0.1.0"
git tag v0.1.0
git push origin main --tags
```

3. GitHub Actions (`.github/workflows/release.yml`) builds Windows `.exe` + Mac `.dmg` and creates a **draft** release.

4. Open the draft on GitHub → paste SHA-256 hashes into the release notes → publish.

### Option B — Manual upload

1. Build Windows + Mac installers locally (or on two machines).
2. GitHub → Releases → **Draft a new release** → tag `v0.1.0`.
3. Upload both files.
4. Add install notes (below) + SHA-256 hashes.
5. Publish.

---

## Release notes template (paste into GitHub)

```markdown
## Install (Windows)

1. Download `Tangent_*_x64-setup.exe` below.
2. If SmartScreen warns → **More info** → **Run anyway**.
3. Run the installer, then open Tangent from the tray.

Voice is included — no extra downloads. Turn on **Voice capture** in Settings.

**Google Calendar (optional):** Settings → Connect Google Calendar.

---

## Install (Mac)

1. Download the `.dmg` below and open it.
2. Drag **Tangent** into **Applications**.
3. **Eject the disk image** — do not run the app from the DMG.
4. Open Tangent. If blocked: System Settings → Privacy & Security → **Open Anyway**.

Older builds may show a false “damaged” dialog on Apple Silicon. Repair with:

```bash
xattr -cr /Applications/Tangent.app
codesign --force --deep --sign - /Applications/Tangent.app
open /Applications/Tangent.app
```

---

<details>
<summary>Optional: verify download (for the curious)</summary>

If you want to double-check the file wasn’t corrupted in transit, compare its SHA-256 hash to:

`PASTE_HASH_HERE`

In PowerShell: `Get-FileHash .\\Tangent_*_x64-setup.exe -Algorithm SHA256`

</details>
```

---

## Phase 4 — Tell beta users

Share the **GitHub Releases** link only (not random file hosts).

Explain briefly:

- Data stays on their machine (local SQLite).
- Mic is used only while the hotkey is held.
- Google Calendar is optional OAuth.
- Unsigned = OS warning, not malware.

---

## When to pay for signing

| Stage | Signing needed? |
|-------|-----------------|
| Friends / beta testers | No — GitHub + instructions is enough |
| Public marketing / strangers | Consider Windows cert (~$200/yr) + Apple Developer ($99/yr) |
| App Store | Yes — different path entirely |

---

## Troubleshooting builds

| Problem | Fix |
|---------|-----|
| Voice build fails on Windows | Install Visual Studio **Desktop development with C++** + [CMake](https://cmake.org/download/) |
| Voice build fails on Mac | `xcode-select --install` and `brew install cmake` |
| SmartScreen every time | Expected until cert + reputation |
| Mac “damaged” / won’t open | Incomplete signature. Use a build with `signingIdentity: "-"`, or repair: `xattr -cr /Applications/Tangent.app && codesign --force --deep --sign - /Applications/Tangent.app` |
