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
  "like",
  "you know",
  "i mean",
  "basically",
  "literally",
  "sort of",
  "kind of",
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

  // 5) Capitalize first letter; add a period if it reads like a sentence.
  if (t.length > 0) {
    t = t[0].toUpperCase() + t.slice(1);
    if (!/[.!?]$/.test(t) && t.split(/\s+/).length > 2) {
      t += ".";
    }
  }

  if (t.length === 0) t = original.trim();
  return { cleaned: t, raw: original, tier: "rules" };
}

function resolveCorrections(text: string): string {
  let t = text;
  for (const marker of CORRECTION_MARKERS) {
    const re = new RegExp(`.*\\b${escapeRegExp(marker)}\\b[\\s,:-]*`, "i");
    if (re.test(t)) {
      // Only treat as a correction if there is meaningful content after it.
      const after = t.replace(re, "").trim();
      if (after.split(/\s+/).length >= 1 && after.length >= 2) {
        t = " " + after + " ";
      }
    }
  }
  return t;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
