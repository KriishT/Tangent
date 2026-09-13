import { invoke } from "@tauri-apps/api/core";
import { sendNotification } from "@tauri-apps/plugin-notification";

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? navigator.userAgent);
}

/** Show a reminder banner. macOS uses osascript so it appears even when Tangent is frontmost. */
export async function pushNotification(title: string, body: string): Promise<void> {
  if (isMacPlatform()) {
    try {
      await invoke("native_notify", { title, body });
      return;
    } catch {
      /* fall through to the plugin */
    }
  }
  sendNotification({ title, body });
}
