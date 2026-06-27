import { useCallback, useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Bucket, Thought } from "../lib/types";
import { BUCKET_LABELS, BUCKET_ORDER } from "../lib/types";
import {
  deleteThought,
  insertThought,
  listUntriaged,
  search as searchDb,
  setBucket,
  updateBody,
} from "../lib/db";
import { parseDueDate } from "../lib/parse";
import { loadSettings } from "../lib/settings";
import { useDialog } from "../components/DialogProvider";
import ThoughtContextPanel from "../components/ThoughtContextPanel";
import { addThoughtToGoogleCalendar, messageForCalendarOutcome } from "../lib/googleCalendar";

type TriageProps = {
  /** Bumped by MainApp when thoughts change elsewhere (e.g. voice capture). */
  dataRev?: number;
};

export default function Triage({ dataRev = 0 }: TriageProps) {
  const { confirm, prompt } = useDialog();
  const [items, setItems] = useState<Thought[]>([]);
  const [selected, setSelected] = useState(0);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [hotkey, setHotkey] = useState("CommandOrControl+Shift+Space");
  const [draft, setDraft] = useState("");
  const [toast, setToast] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 1800);
  };

  useEffect(() => {
    void loadSettings().then((s) => setHotkey(s.hotkey));
  }, []);

  const reload = useCallback(async () => {
    const rows = query.trim() ? await searchDb(query.trim()) : await listUntriaged();
    setItems(rows);
    setSelected((s) => Math.min(s, Math.max(0, rows.length - 1)));
  }, [query]);

  useEffect(() => {
    void reload();
  }, [reload, dataRev]);

  // Refresh when a voice capture adds a thought (broadcast event).
  useEffect(() => {
    const un = listen("thought-added", () => void reload());
    return () => {
      un.then((f) => f());
    };
  }, [reload]);

  // Refresh when the main window is shown/focused (e.g. after tray capture).
  useEffect(() => {
    const win = getCurrentWindow();
    const unFocus = win.onFocusChanged(({ payload: focused }) => {
      if (focused) void reload();
    });
    return () => {
      unFocus.then((f) => f());
    };
  }, [reload]);

  const quickAdd = useCallback(async () => {
    const body = draft.trim();
    if (!body) return;
    await insertThought({ body, source: "type", due_at: parseDueDate(body) });
    setDraft("");
    await reload();
    void emit("thought-added", {}).catch(() => {});
  }, [draft, reload]);

  const sort = useCallback(
    async (id: number, bucket: Bucket) => {
      await setBucket(id, bucket);
      await reload();
    },
    [reload]
  );

  const edit = useCallback(
    async (t: Thought) => {
      const next = await prompt({
        title: "Edit thought",
        defaultValue: t.body,
        confirmLabel: "Save",
      });
      if (next != null && next.trim() && next !== t.body) {
        await updateBody(t.id, next.trim());
        await reload();
      }
    },
    [reload, prompt]
  );

  const remove = useCallback(
    async (t: Thought) => {
      const ok = await confirm({
        title: "Delete this thought?",
        message: `"${t.body}"`,
        confirmLabel: "Delete",
        cancelLabel: "Cancel",
        variant: "danger",
      });
      if (ok) {
        await deleteThought(t.id);
        await reload();
      }
    },
    [reload, confirm]
  );

  const copy = useCallback(async (t: Thought) => {
    try {
      await navigator.clipboard.writeText(t.body);
      flash("Copied");
    } catch {
      flash("Could not copy");
    }
  }, []);

  const calendar = useCallback(async (t: Thought) => {
    const result = await addThoughtToGoogleCalendar(t);
    flash(messageForCalendarOutcome(result));
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (searching) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        setSelected((s) => Math.min(s + 1, items.length - 1));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        setSelected((s) => Math.max(s - 1, 0));
      } else if (e.key >= "1" && e.key <= "5") {
        const t = items[selected];
        if (t) void sort(t.id, BUCKET_ORDER[Number(e.key) - 1]);
      } else if (e.key === "e") {
        const t = items[selected];
        if (t) {
          e.preventDefault();
          void edit(t);
        }
      } else if (e.key === "d" || e.key === "Delete" || e.key === "Backspace") {
        const t = items[selected];
        if (t) {
          e.preventDefault();
          void remove(t);
        }
      } else if (e.key === "c") {
        const t = items[selected];
        if (t) {
          e.preventDefault();
          void copy(t);
        }
      } else if (e.key === "g") {
        const t = items[selected];
        if (t?.due_at) {
          e.preventDefault();
          void calendar(t);
        }
      } else if (e.key === "/") {
        e.preventDefault();
        setSearching(true);
        setTimeout(() => searchRef.current?.focus(), 0);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, selected, searching, sort, edit, remove, copy, calendar]);

  return (
    <div>
      <div className="row">
        <div>
          <div className="page-title">Triage</div>
          <div className="page-sub">
            {items.length} {query ? "result" : "parked"}
            {items.length === 1 ? "" : "s"} · hold{" "}
            <strong>{hotkey.replace("CommandOrControl", "Ctrl")}</strong> to speak · j/k move · 1-5
            sort · e edit · d delete · g calendar · / search
          </div>
        </div>
      </div>

      <div className="quick-add quick-add-hero">
        <input
          className="capture-input"
          placeholder="Jot a quick thought and press Enter…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void quickAdd();
            }
          }}
        />
        <button className="btn" onClick={() => void quickAdd()}>
          Add
        </button>
      </div>

      {(searching || query) && (
        <input
          ref={searchRef}
          className="capture-input"
          style={{ marginBottom: 16 }}
          placeholder="Search thoughts..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onBlur={() => setSearching(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setQuery("");
              setSearching(false);
            }
          }}
        />
      )}

      {items.length === 0 ? (
        <div className="empty">
          Inbox at zero. Nice.
          <br />
          Hold <strong>{hotkey.replace("CommandOrControl", "Ctrl")}</strong> anywhere and speak —
          release to save, without leaving what you're doing.
        </div>
      ) : (
        items.map((t, i) => (
          <div key={t.id} className={`thought${i === selected ? " selected" : ""}`}>
            <div className="thought-body">{t.body}</div>
            <div className="thought-meta">
              <span>{new Date(t.created_at).toLocaleString()}</span>
              {t.ctx_detail && (
                <span title={t.ctx_title ?? undefined}>
                  in {t.ctx_app ?? "app"} · {t.ctx_detail}
                </span>
              )}
              {t.due_at && <span className="due">due {new Date(t.due_at).toLocaleDateString()}</span>}
              {t.source === "voice" && <span>voice</span>}
            </div>
            {(t.ctx_extra || t.ctx_title) && <ThoughtContextPanel thought={t} />}
            <div className="bucket-row">
              {BUCKET_ORDER.map((b, idx) => (
                <button key={b} onClick={() => sort(t.id, b)}>
                  [{idx + 1}] {BUCKET_LABELS[b]}
                </button>
              ))}
              {t.due_at && (
                <button onClick={() => void calendar(t)}>[g] Calendar</button>
              )}
              <button onClick={() => void copy(t)}>[c] Copy</button>
              <button onClick={() => edit(t)}>[e] Edit</button>
              <button className="del" onClick={() => remove(t)}>
                [d] Delete
              </button>
            </div>
          </div>
        ))
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
