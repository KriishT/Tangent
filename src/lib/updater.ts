import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateCheckResult =
  | { status: "up_to_date" }
  | { status: "available"; update: Update }
  | { status: "error"; message: string };

/** Check GitHub Releases for a newer signed build. */
export async function checkForAppUpdate(): Promise<UpdateCheckResult> {
  try {
    const update = await check();
    if (!update) return { status: "up_to_date" };
    return { status: "available", update };
  } catch (e) {
    return {
      status: "error",
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Download, install, and relaunch into the new version. */
export async function installAppUpdate(update: Update): Promise<void> {
  await update.downloadAndInstall();
  await relaunch();
}
