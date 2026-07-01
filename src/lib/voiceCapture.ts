import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import type { WorkContext } from "./types";
import { isBlocked, loadSettings } from "./settings";
import { tier0Cleanup } from "./cleanup";
import { aiCleanup } from "./aiCleanup";
import { buildContextFields, parseDueDate } from "./parse";
import { insertThought, updateBody, getThought } from "./db";
import { autoAddThoughtToGoogleCalendarIfConnected } from "./googleCalendar";

// Hold-to-talk capture driven by the global hotkey:
//   key DOWN  -> begin recording + show HUD (no focus stolen)
//   key UP    -> stop, transcribe on-device, auto-save, hide HUD

let recording = false;
let voiceReady = false;
let beginPromise: Promise<void> | null = null;
let ctx: WorkContext = { app_name: null, title: null };
let startedAt = 0;

// Ignore accidental taps: a hold shorter than this is treated as "nothing said".
const MIN_HOLD_MS = 250;
// Let the mic stream flush a few frames before we stop.
const STOP_FLUSH_MS = 300;

export type VoiceCaptureOutcome = "saved" | "too_short" | "no_audio" | "no_speech" | "error";

export function isRecording(): boolean {
  return recording;
}

async function notifyCaptureResult(outcome: VoiceCaptureOutcome, detail?: string): Promise<void> {
  void emit("voice-capture-result", { outcome, detail: detail ?? null }).catch(() => {});
}

export async function preloadVoiceModel(): Promise<void> {
  try {
    await invoke("voice_preload_model", { modelPath: "" });
  } catch {
    /* optional warm-up */
  }
}

export async function startVoiceCapture(): Promise<void> {
  if (recording) return;
  recording = true;
  voiceReady = false;
  startedAt = Date.now();

  beginPromise = (async () => {
    try {
      const s = await loadSettings();
      if (!s.voiceEnabled) {
        throw new Error("Voice capture is disabled in Settings.");
      }
      ctx = await invoke<WorkContext>("begin_voice");
      voiceReady = true;
    } catch (e) {
      recording = false;
      voiceReady = false;
      ctx = { app_name: null, title: null };
      const msg = e instanceof Error ? e.message : String(e);
      await notifyCaptureResult("error", msg || "Could not start recording.");
    }
  })();

  await beginPromise;
}

export async function stopVoiceCapture(): Promise<void> {
  if (!recording && !beginPromise) return;

  if (beginPromise) {
    await beginPromise.catch(() => {});
    beginPromise = null;
  }

  if (!recording) return;

  const heldMs = Date.now() - startedAt;
  recording = false;

  void invoke("end_voice").catch(() => {});

  if (!voiceReady) return;

  if (heldMs < MIN_HOLD_MS) {
    await notifyCaptureResult("too_short", "Hold the hotkey a little longer while you speak.");
    return;
  }

  await new Promise((r) => setTimeout(r, STOP_FLUSH_MS));

  const s = await loadSettings();
  let transcript = "";
  let transcribeError = "";
  try {
    transcript = await invoke<string>("voice_stop_transcribe", { modelPath: "" });
  } catch (e) {
    transcribeError = e instanceof Error ? e.message : String(e);
    transcript = "";
  }

  if (transcribeError) {
    await notifyCaptureResult("error", transcribeError);
    return;
  }

  const body = transcript.trim();
  if (!body) {
    await notifyCaptureResult(
      "no_speech",
      "No speech detected — try speaking a bit louder or closer to the mic."
    );
    return;
  }

  const capturedAt = new Date(startedAt);
  const c = tier0Cleanup(body, s.faithfulMode);
  const finalBody = c.cleaned.trim() || body;
  const due = parseDueDate(finalBody);
  const blocked = isBlocked(s, ctx.app_name, ctx.title);
  const { detail, extra } = buildContextFields(
    ctx.app_name,
    ctx.title,
    ctx.process_path ?? null,
    capturedAt
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

  if (due) {
    const thought = await getThought(id);
    if (thought) void autoAddThoughtToGoogleCalendarIfConnected(thought);
  }

  if (s.cleanupTier !== "off" && !s.faithfulMode) {
    aiCleanup(finalBody, s)
      .then((out) => {
        if (out && out !== finalBody) void updateBody(id, out).catch(() => {});
      })
      .catch(() => {});
  }

  void emit("thought-added", {}).catch(() => {});
  await notifyCaptureResult("saved");
}
