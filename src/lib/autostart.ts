import { enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { getSettingRaw, setSettingRaw } from "./db";

const AUTOSTART_DEFAULT_KEY = "autostartDefaultApplied";

/**
 * On first launch after install, turn on launch-at-startup once.
 * Users can still disable it in Settings afterward.
 */
export async function ensureDefaultAutostart(): Promise<void> {
  try {
    const primed = await getSettingRaw(AUTOSTART_DEFAULT_KEY);
    if (primed === "1") return;

    if (!(await isEnabled())) {
      await enable();
    }
    await setSettingRaw(AUTOSTART_DEFAULT_KEY, "1");
  } catch {
    /* autostart unavailable (permissions / platform) — ignore */
  }
}
