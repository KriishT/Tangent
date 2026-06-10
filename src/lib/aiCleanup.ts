import type { AppSettings } from "./settings";

/**
 * Optional Tier 1 (local LLM via an Ollama-compatible endpoint) or Tier 2
 * (BYOK cloud) cleanup. Best-effort: returns null on any failure so the caller
 * can fall back to the Tier 0 rule-based result. Never blocks capture - call
 * this asynchronously after the raw/Tier-0 text is already saved.
 */
const SYSTEM_PROMPT =
  "You clean up spoken dictation into a single short, written line. " +
  "Remove filler words, fix punctuation and capitalization, and resolve " +
  "self-corrections (keep only what the speaker finally meant). " +
  "Do NOT add information, do NOT answer questions, do NOT change meaning. " +
  "Return only the cleaned line, nothing else.";

export async function aiCleanup(text: string, s: AppSettings): Promise<string | null> {
  const input = text.trim();
  if (!input) return null;
  try {
    if (s.cleanupTier === "local") return await ollamaCleanup(input, s);
    if (s.cleanupTier === "cloud") return await cloudCleanup(input, s);
  } catch {
    return null;
  }
  return null;
}

async function ollamaCleanup(text: string, s: AppSettings): Promise<string | null> {
  const res = await fetch(s.localEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: s.localModel,
      prompt: `${SYSTEM_PROMPT}\n\nInput: ${text}\nCleaned:`,
      stream: false,
      options: { temperature: 0.1, num_ctx: 1024 },
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const out = (data.response ?? "").toString().trim();
  return sanitize(out, text);
}

async function cloudCleanup(text: string, s: AppSettings): Promise<string | null> {
  if (!s.byokKey) return null;

  if (s.byokProvider === "openai") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${s.byokKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.1,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return sanitize(data.choices?.[0]?.message?.content ?? "", text);
  }

  // anthropic
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": s.byokKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-3-5-haiku-latest",
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: text }],
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return sanitize(data.content?.[0]?.text ?? "", text);
}

// Guard against a model that rambles or wraps the answer in quotes.
function sanitize(out: string, fallback: string): string | null {
  let t = out.trim().replace(/^["'`]+|["'`]+$/g, "").trim();
  if (!t) return null;
  // If the model returned something absurdly long, distrust it.
  if (t.length > fallback.length * 4 + 80) return null;
  return t;
}
