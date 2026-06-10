import { useState } from "react";
import type { Thought } from "../lib/types";
import { buildContextFields, parseContextExtra } from "../lib/parse";

interface Props {
  thought: Thought;
}

function resolveExtra(t: Thought) {
  const parsed = parseContextExtra(t.ctx_extra);
  if (parsed) return parsed;
  if (t.ctx_title) {
    return buildContextFields(t.ctx_app, t.ctx_title).extra;
  }
  return null;
}

export default function ThoughtContextPanel({ thought }: Props) {
  const [open, setOpen] = useState(false);
  const extra = resolveExtra(thought);

  if (!extra && !thought.ctx_detail) return null;

  const rows: { label: string; value: string }[] = [];
  if (extra?.location) rows.push({ label: "Location", value: extra.location });
  if (extra?.workspace) rows.push({ label: "Workspace / folder", value: extra.workspace });
  if (extra?.file) rows.push({ label: "File", value: extra.file });
  if (extra?.window_title) rows.push({ label: "Window title", value: extra.window_title });
  if (extra?.app) rows.push({ label: "Application", value: extra.app });
  if (extra?.process_path) rows.push({ label: "App path", value: extra.process_path });

  return (
    <div className="ctx-panel">
      <button
        type="button"
        className="ctx-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {open ? "▾" : "▸"} Context details
        {!open && extra?.location && (
          <span className="ctx-toggle-hint">{extra.location}</span>
        )}
      </button>
      {open && (
        <dl className="ctx-details">
          {rows.length === 0 ? (
            <div className="ctx-row">
              <dt>Summary</dt>
              <dd>{thought.ctx_detail}</dd>
            </div>
          ) : (
            rows.map((r) => (
              <div className="ctx-row" key={r.label}>
                <dt>{r.label}</dt>
                <dd>{r.value}</dd>
              </div>
            ))
          )}
        </dl>
      )}
    </div>
  );
}
