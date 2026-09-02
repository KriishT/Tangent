/**
 * Tier 0 cleanup: cheap, on-device, rule-based polishing of a (usually spoken)
 * transcript. Removes fillers, collapses repeats, resolves trailing
 * self-corrections, and tidies punctuation. NEVER changes meaning aggressively;
 * the raw text is always kept by the caller for one-tap revert.
 */

export interface CleanupResult {
  cleaned: string;
  raw: string;
  tier: "rules" | null;
}

const FILLER_WORDS = [
  "um",
  "uh",
  "erm",
  "uhh",
  "umm",
  "you know",
  "i mean",
];

// Phrases that signal "ignore what I just said, here's the correction".
const CORRECTION_MARKERS = [
  "no wait",
  "wait no",
  "scratch that",
  "actually",
  "i mean",
  "no,",
  "or rather",
  "make that",
];

export function tier0Cleanup(raw: string, faithful: boolean): CleanupResult {
  const original = raw;
  if (faithful) {
    return { cleaned: raw.trim(), raw: original, tier: null };
  }

  let t = " " + raw.trim() + " ";

  // 1) Resolve trailing self-corrections: keep the clause AFTER the last marker.
  t = resolveCorrections(t);

  // 2) Remove filler words/phrases (word-boundary, case-insensitive).
  for (const f of FILLER_WORDS) {
    const re = new RegExp(`\\b${escapeRegExp(f)}\\b`, "gi");
    t = t.replace(re, " ");
  }

  // 3) Collapse immediate duplicate words ("the the" -> "the").
  t = t.replace(/\b(\w+)(\s+\1\b)+/gi, "$1");

  // 4) Tidy whitespace and stray punctuation.
  t = t.replace(/\s+([,.;:!?])/g, "$1");
  t = t.replace(/\s{2,}/g, " ").trim();
  t = t.replace(/^[,.;:\s]+/, "").trim();

  // 5) Capitalize first letter only — do not auto-add punctuation (hurts short commands).
  if (t.length > 0) {
    t = t[0].toUpperCase() + t.slice(1);
  }

  if (t.length === 0) t = original.trim();
  return { cleaned: t, raw: original, tier: "rules" };
}

function resolveCorrections(text: string): string {
  let t = text;
  const trimmedLen = t.trim().length;
  for (const marker of CORRECTION_MARKERS) {
    const re = new RegExp(`\\b${escapeRegExp(marker)}\\b[\\s,:-]*`, "i");
    const match = re.exec(t);
    if (!match || match.index === undefined) continue;
    // Only treat as a correction when the marker is past the first third of the utterance.
    if (match.index < trimmedLen * 0.33) continue;
    const after = t.slice(match.index + match[0].length).trim();
    if (after.split(/\s+/).length >= 1 && after.length >= 2) {
      t = " " + after + " ";
    }
  }
  return t;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
