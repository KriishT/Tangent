import { getSettingRaw, setSettingRaw } from "./db";

export const DEFAULT_HOTKEY = "CommandOrControl+Shift+Space";

// Dev default for the on-device Whisper model. For distribution this should be
// replaced by a bundled resource path resolved at runtime.
export const DEFAULT_MODEL_PATH =
  "C:\\Users\\kriis\\OneDrive\\Desktop\\MemRemem\\tangent\\models\\ggml-base.en.bin";

export interface AppSettings {
  hotkey: string;
  voiceEnabled: boolean;
  modelPath: string;
  faithfulMode: boolean;
  contextEnabled: boolean;
  blocklist: string; // newline-separated app-name fragments
  resurfaceHour: number;
  liteMode: boolean;
  deleteAudioAfter: boolean;
  // Tier 1/2 cleanup (optional)
  cleanupTier: "off" | "local" | "cloud";
  localEndpoint: string; // e.g. http://localhost:11434/api/generate (Ollama)
  localModel: string; // e.g. qwen2.5:1.5b
  byokProvider: "openai" | "anthropic";
  byokKey: string;
  // internal bookkeeping
  lastNudge?: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  hotkey: DEFAULT_HOTKEY,
  voiceEnabled: true,
  modelPath: DEFAULT_MODEL_PATH,
  faithfulMode: false,
  contextEnabled: true,
  blocklist: "",
  resurfaceHour: 9,
  liteMode: false,
  deleteAudioAfter: true,
  cleanupTier: "off",
  localEndpoint: "http://localhost:11434/api/generate",
  localModel: "qwen2.5:1.5b",
  byokProvider: "openai",
  byokKey: "",
};

export async function loadSettings(): Promise<AppSettings> {
  const raw = await getSettingRaw("app");
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const merged = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    // Fall back to the default model path if a previously-saved blank slipped in.
    if (!merged.modelPath) merged.modelPath = DEFAULT_MODEL_PATH;
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(s: AppSettings): Promise<void> {
  await setSettingRaw("app", JSON.stringify(s));
}

export async function getSettingNumber(_key: "resurfaceHour", fallback: number): Promise<number> {
  const s = await loadSettings();
  const v = s[_key];
  return typeof v === "number" && !Number.isNaN(v) ? v : fallback;
}

/** True if the given active-window app/title should NOT have its context stored. */
export function isBlocked(s: AppSettings, app: string | null, title: string | null): boolean {
  if (!s.contextEnabled) return true;
  const list = s.blocklist
    .split(/\r?\n/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) return false;
  const hay = `${app ?? ""} ${title ?? ""}`.toLowerCase();
  return list.some((frag) => hay.includes(frag));
}
