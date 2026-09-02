import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut";
import { emit } from "@tauri-apps/api/event";
import { validateHotkey } from "./hotkeyFormat";
import { loadSettings } from "./settings";
import { isVoiceBusy, startVoiceCapture, stopVoiceCapture } from "./voiceCapture";

/**
 * Registers the global hold-to-talk hotkey. Returns an error message on failure.
 */
export async function applyHotkey(): Promise<string | null> {
  const s = await loadSettings();
  await unregisterAll();
  const check = validateHotkey(s.hotkey);
  if (!check.ok) {
    return check.reason ?? "Invalid capture hotkey — choose another in Settings.";
  }
  try {
    await register(s.hotkey, (event) => {
      if (event.state === "Pressed") {
        void loadSettings().then((settings) => {
          if (settings.voiceEnabled) {
            void startVoiceCapture();
          } else {
            void emit("voice-capture-result", {
              outcome: "error",
              detail: "Voice capture is off — enable it in Settings to use the hotkey.",
            });
          }
        });
      } else if (event.state === "Released") {
        if (!isVoiceBusy()) return;
        void stopVoiceCapture();
      }
    });
  } catch (e) {
    const msg =
      e instanceof Error
        ? e.message
        : "Could not register the capture hotkey — it may be in use by another app.";
    return msg;
  }
  return null;
}

/** Unregister while the user is rebinding in Settings. */
export async function pauseHotkey(): Promise<void> {
  await unregisterAll();
}
