const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

/** Modifier order used in Tauri accelerator strings. */
const MODIFIER_ORDER = ["CommandOrControl", "Control", "Alt", "Shift", "Super"] as const;

/** Well-known OS / browser shortcuts — blocked even if the user presses them. */
const BLOCKED_SHORTCUTS = new Set(
  [
    // Clipboard & editing
    "CommandOrControl+C",
    "CommandOrControl+V",
    "CommandOrControl+X",
    "CommandOrControl+Z",
    "CommandOrControl+Y",
    "CommandOrControl+A",
    // File / window / tab
    "CommandOrControl+S",
    "CommandOrControl+O",
    "CommandOrControl+N",
    "CommandOrControl+W",
    "CommandOrControl+T",
    "CommandOrControl+Shift+T",
    "CommandOrControl+Shift+N",
    "CommandOrControl+Q",
    // Find / navigation
    "CommandOrControl+F",
    "CommandOrControl+G",
    "CommandOrControl+H",
    "CommandOrControl+L",
    "CommandOrControl+R",
    "CommandOrControl+P",
    // System
    "Alt+Tab",
    "Alt+F4",
    "Alt+Enter",
    "Alt+Space",
    "Super",
    "Super+L",
    "Super+D",
    "Super+R",
    "Super+E",
    "Super+Tab",
    // Shift combos that break common UI patterns
    "Shift+Tab",
    "Shift+Enter",
    "Shift+Delete",
    "Shift+Backspace",
    "Shift+Escape",
    // Function keys often reserved
    "F1",
    "Alt+F4",
    "CommandOrControl+F4",
  ].map(normalizeAccelerator)
);

/** Map KeyboardEvent.code to Tauri accelerator key segment. */
function codeToKey(code: string): string | null {
  if (MODIFIER_CODES.has(code)) return null;
  if (code.startsWith("Key") && code.length === 4) return code.slice(3);
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
  if (/^F\d+$/.test(code)) return code;
  const named: Record<string, string> = {
    Space: "Space",
    Tab: "Tab",
    Enter: "Enter",
    Backspace: "Backspace",
    Delete: "Delete",
    Escape: "Escape",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Insert: "Insert",
    Comma: "Comma",
    Period: "Period",
    Slash: "Slash",
    Backslash: "Backslash",
    BracketLeft: "BracketLeft",
    BracketRight: "BracketRight",
    Semicolon: "Semicolon",
    Quote: "Quote",
    Backquote: "Backquote",
    Minus: "Minus",
    Equal: "Equal",
  };
  return named[code] ?? null;
}

function modifiersFromEvent(e: KeyboardEvent): string[] {
  const mods: string[] = [];
  const mac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? navigator.userAgent);

  if (e.ctrlKey) mods.push("CommandOrControl");
  else if (e.metaKey && mac) mods.push("CommandOrControl");
  else if (e.metaKey) mods.push("Super");

  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  return [...new Set(mods)];
}

/** Canonical form for comparison (sorted modifiers + key). */
export function normalizeAccelerator(accelerator: string): string {
  const parts = accelerator.split("+").filter(Boolean);
  if (parts.length === 0) return "";

  const mods: string[] = [];
  let key = "";

  for (const p of parts) {
    if (MODIFIER_ORDER.includes(p as (typeof MODIFIER_ORDER)[number]) || p === "Super") {
      if (!mods.includes(p)) mods.push(p);
    } else {
      key = p;
    }
  }

  mods.sort((a, b) => MODIFIER_ORDER.indexOf(a as (typeof MODIFIER_ORDER)[number]) - MODIFIER_ORDER.indexOf(b as (typeof MODIFIER_ORDER)[number]));

  return key ? [...mods, key].join("+") : mods.join("+");
}

/** Build a Tauri accelerator string from a keydown event, or null if incomplete. */
export function acceleratorFromKeyboardEvent(e: KeyboardEvent): string | null {
  const key = codeToKey(e.code);
  if (!key) return null;

  const mods = modifiersFromEvent(e);
  if (mods.length === 0) return null;

  return normalizeAccelerator([...mods, key].join("+"));
}

export interface HotkeyValidation {
  ok: boolean;
  reason?: string;
}

/** Validate before saving — blocks bare keys and reserved system shortcuts. */
export function validateHotkey(accelerator: string): HotkeyValidation {
  const normalized = normalizeAccelerator(accelerator);
  const parts = normalized.split("+").filter(Boolean);

  if (parts.length < 2) {
    return {
      ok: false,
      reason: "Use a modifier plus a key (e.g. Shift+D or Ctrl+Shift+Space). A single key alone isn't allowed.",
    };
  }

  if (BLOCKED_SHORTCUTS.has(normalized)) {
    return {
      ok: false,
      reason: "That shortcut is reserved by Windows or your browser (copy, paste, Alt+Tab, etc.). Try another.",
    };
  }

  // Ctrl/Cmd + letter without Shift — almost always a system or app shortcut.
  const mods = parts.slice(0, -1);
  const key = parts[parts.length - 1];
  const hasCtrl = mods.includes("CommandOrControl") || mods.includes("Control");
  const hasShift = mods.includes("Shift");
  const isLetter = /^[A-Z]$/.test(key);

  if (hasCtrl && isLetter && !hasShift && mods.length === 1) {
    return {
      ok: false,
      reason: `Ctrl+${key} is usually taken by apps (save, copy, find, etc.). Try Shift+${key} or Ctrl+Shift+${key}.`,
    };
  }

  return { ok: true };
}

const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? navigator.userAgent);

/** Human-readable label for the settings UI. */
export function formatHotkeyDisplay(accelerator: string): string {
  return accelerator
    .split("+")
    .map((part) => {
      switch (part) {
        case "CommandOrControl":
          return isMac ? "Cmd" : "Ctrl";
        case "Control":
          return "Ctrl";
        case "Alt":
          return isMac ? "Option" : "Alt";
        case "Shift":
          return "Shift";
        case "Super":
          return isMac ? "Cmd" : "Win";
        case "Space":
          return "Space";
        default:
          return part.length === 1 ? part.toUpperCase() : part;
      }
    })
    .join(" + ");
}
