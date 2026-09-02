import type { ThemeMode } from "../lib/settings";
import { THEME_MODE_LABELS } from "../lib/settings";

type Props = {
  value: ThemeMode;
  onChange: (mode: ThemeMode) => void;
  compact?: boolean;
};

const ICONS: Record<ThemeMode, string> = {
  light: "☀",
  dark: "☾",
  system: "◐",
};

export default function ThemeToggle({ value, onChange, compact = false }: Props) {
  const cycle = () => {
    const order: ThemeMode[] = ["light", "dark", "system"];
    const i = order.indexOf(value);
    onChange(order[(i + 1) % order.length]!);
  };

  if (compact) {
    return (
      <button
        type="button"
        className="theme-toggle-compact"
        onClick={cycle}
        title={`Theme: ${THEME_MODE_LABELS[value]} — click to change`}
        aria-label={`Theme: ${THEME_MODE_LABELS[value]}. Click to change.`}
      >
        <span className="theme-toggle-icon" aria-hidden>
          {ICONS[value]}
        </span>
        <span className="theme-toggle-label">{THEME_MODE_LABELS[value]}</span>
      </button>
    );
  }

  return (
    <div className="theme-toggle-row">
      {(Object.keys(THEME_MODE_LABELS) as ThemeMode[]).map((mode) => (
        <button
          key={mode}
          type="button"
          className={`theme-chip${value === mode ? " active" : ""}`}
          onClick={() => onChange(mode)}
          aria-pressed={value === mode}
        >
          <span aria-hidden>{ICONS[mode]}</span> {THEME_MODE_LABELS[mode]}
        </button>
      ))}
    </div>
  );
}
