import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut";
import { validateHotkey } from "./hotkeyFormat";
import { loadSettings } from "./settings";
import { startVoiceCapture, stopVoiceCapture } from "./voiceCapture";

/**
 * Registers the global hold-to-talk hotkey. Pressing the hotkey starts
 * recording and shows the HUD; releasing it stops, transcribes on-device, and
 * auto-saves. Registered from the frontend so it can be rebound from Settings.
 */
export async function applyHotkey(): Promise<void> {
  const s = await loadSettings();
  await unregisterAll();
  const check = validateHotkey(s.hotkey);
  if (!check.ok) return;
  await register(s.hotkey, (event) => {
    if (event.state === "Pressed") {
      void loadSettings().then((settings) => {
        if (settings.voiceEnabled) void startVoiceCapture();
      });
    } else if (event.state === "Released") {
      void stopVoiceCapture();
    }
  });
}

/** Unregister while the user is rebinding in Settings. */
export async function pauseHotkey(): Promise<void> {
  await unregisterAll();
}
