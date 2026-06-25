import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import type { WorkContext } from "./types";
import { isBlocked, loadSettings } from "./settings";
import { tier0Cleanup } from "./cleanup";
import { aiCleanup } from "./aiCleanup";
import { buildContextFields, parseDueDate } from "./parse";
import { insertThought, updateBody } from "./db";

// Hold-to-talk capture driven by the global hotkey:
//   key DOWN  -> begin recording + show HUD (no focus stolen)
//   key UP    -> stop, transcribe on-device, auto-save, hide HUD
// Nothing is typed and nothing needs confirming.

let recording = false;
let ctx: WorkContext = { app_name: null, title: null };
let startedAt = 0;

// Ignore accidental taps: a hold shorter than this is treated as "nothing said".
const MIN_HOLD_MS = 350;

export function isRecording(): boolean {
  return recording;
}

export async function startVoiceCapture(): Promise<void> {
  if (recording) return; // guard against key auto-repeat
  recording = true;
  startedAt = Date.now();
  try {
    ctx = await invoke<WorkContext>("begin_voice");
  } catch {
    ctx = { app_name: null, title: null };
  }
}

export async function stopVoiceCapture(): Promise<void> {
  if (!recording) return;
  recording = false;
  const heldMs = Date.now() - startedAt;

  // Hide the HUD immediately on release — transcribe and save in the background.
  void invoke("end_voice").catch(() => {});

  const s = await loadSettings();
  let transcript = "";
  try {
    transcript = await invoke<string>("voice_stop_transcribe", { modelPath: s.modelPath });
  } catch {
    transcript = "";
  }

  const body = transcript.trim();
  if (!body || heldMs < MIN_HOLD_MS) return;

  const c = tier0Cleanup(body, s.faithfulMode);
  const finalBody = c.cleaned;
  const due = parseDueDate(finalBody);
  const blocked = isBlocked(s, ctx.app_name, ctx.title);
  const { detail, extra } = buildContextFields(
    ctx.app_name,
    ctx.title,
    ctx.process_path ?? null
  );

  const id = await insertThought({
    body: finalBody,
    raw_body: c.raw,
    cleanup_tier: c.tier,
    source: "voice",
    ctx_app: blocked ? null : ctx.app_name,
    ctx_title: blocked ? null : ctx.title,
    ctx_detail: blocked ? null : detail,
    ctx_extra: blocked ? null : extra ? JSON.stringify(extra) : null,
    due_at: due,
  });

  // Optional LLM cleanup runs after save and never blocks the flow.
  if (s.cleanupTier !== "off" && !s.faithfulMode) {
    aiCleanup(finalBody, s)
      .then((out) => {
        if (out && out !== finalBody) void updateBody(id, out).catch(() => {});
      })
      .catch(() => {});
  }

  // Broadcast so all open views refresh (Triage, Board, etc.).
  void emit("thought-added", {}).catch(() => {});
}
