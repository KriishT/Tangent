import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { getSettingRaw, setSettingRaw } from "./db";
import { isMacPlatform, pushNotification } from "./notify";

const INTRO_KEY = "macPermissionsIntroSeen";

export type PermState = "unknown" | "allowed" | "needs_access";

export type MacPermissionStatus = {
  microphone: PermState;
  accessibility: PermState;
  notifications: PermState;
};

export function shouldOfferMacPermissions(): boolean {
  return isMacPlatform();
}

export async function hasSeenMacPermissionsIntro(): Promise<boolean> {
  return (await getSettingRaw(INTRO_KEY)) === "1";
}

export async function markMacPermissionsIntroSeen(): Promise<void> {
  await setSettingRaw(INTRO_KEY, "1");
}

export async function readMacPermissionStatus(): Promise<MacPermissionStatus> {
  let accessibility: PermState = "unknown";
  let notifications: PermState = "unknown";
  try {
    accessibility = (await invoke<boolean>("accessibility_trusted")) ? "allowed" : "needs_access";
  } catch {
    accessibility = "unknown";
  }
  try {
    notifications = (await isPermissionGranted()) ? "allowed" : "needs_access";
  } catch {
    notifications = "unknown";
  }
  return { microphone: "unknown", accessibility, notifications };
}

export async function requestMicrophoneAccess(): Promise<PermState> {
  try {
    await invoke<{ device: string; samples: number }>("voice_test_microphone");
    return "allowed";
  } catch {
    return "needs_access";
  }
}

export async function requestAccessibilityAccess(): Promise<PermState> {
  try {
    const trusted = await invoke<boolean>("request_accessibility_prompt");
    return trusted ? "allowed" : "needs_access";
  } catch {
    return "needs_access";
  }
}

export async function requestNotificationAccess(): Promise<PermState> {
  try {
    let ok = await isPermissionGranted();
    if (!ok) ok = (await requestPermission()) === "granted";
    await pushNotification("Tangent", "Notifications are on. Reminders will look like this.");
    return ok || isMacPlatform() ? "allowed" : "needs_access";
  } catch {
    return "needs_access";
  }
}

export async function openMacPrivacyPane(
  pane: "microphone" | "accessibility" | "notifications",
): Promise<void> {
  await invoke("open_mac_privacy_pane", { pane });
}

/** True when we should skip the first-run overlay (already seen, or already fully granted). */
export async function shouldShowMacPermissionsIntro(): Promise<boolean> {
  if (!isMacPlatform()) return false;
  if (await hasSeenMacPermissionsIntro()) return false;
  const s = await readMacPermissionStatus();
  if (s.accessibility === "allowed" && s.notifications === "allowed") {
    // Mic cannot be probed without prompting; if the other two are done, don't block.
    await markMacPermissionsIntroSeen();
    return false;
  }
  return true;
}
