import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut";
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
  await register(s.hotkey, (event) => {
    if (event.state === "Pressed") {
      void startVoiceCapture();
    } else if (event.state === "Released") {
      void stopVoiceCapture();
    }
  });
}
