import { useCallback, useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Bucket, Thought } from "../lib/types";
import { BUCKET_LABELS, BUCKET_ORDER } from "../lib/types";
import {
  getThought,
  insertThought,
  listUntriaged,
  search as searchDb,
  setBucket,
  updateBody,
} from "../lib/db";
import {
  parseDueDateInfo,
  buildContextFields,
  parseContextExtra,
  resolvedDueAt,
  isTentativeDue,
  formatDueTimeLabel,
  dueClassName,
} from "../lib/parse";
import { loadSettings, isBlocked } from "../lib/settings";
import { useDialog } from "../components/DialogProvider";
import ThoughtContextPanel from "../components/ThoughtContextPanel";
import { formatHotkeyDisplay } from "../lib/hotkeyFormat";
import {
  scheduleThoughtDueTime,
  messageForCalendarOutcome,
  deleteThoughtWithCalendar,
  removeThoughtCalendarEvent,
  autoAddThoughtToGoogleCalendarIfConnected,
  addThoughtToGoogleCalendar,
} from "../lib/googleCalendar";
import { exportIcsForThought } from "../lib/calendar";

type TriageProps = {
  /** Bumped by MainApp when thoughts change elsewhere (e.g. voice capture). */
  dataRev?: number;
};

function statusLabel(t: Thought): string | null {
  if (t.completed_at) {
    return t.bucket === "dropped" ? "Dropped" : "Done";
  }
  if (t.bucket) return BUCKET_LABELS[t.bucket];
  return null;
}

export default function Triage({ dataRev = 0 }: TriageProps) {
  const { confirm, prompt } = useDialog();
  const [items, setItems] = useState<Thought[]>([]);
  const [selected, setSelected] = useState(0);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [hotkey, setHotkey] = useState("CommandOrControl+Shift+Space");
  const [draft, setDraft] = useState("");
  const [toast, setToast] = useState("");
  const [transcribing, setTranscribing] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const flash = useCallback((msg: string, ms = 2200) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), ms);
  }, []);

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

  useEffect(() => {
    const un = listen("thought-added", () => void reload());
    return () => {
      un.then((f) => f());
    };
  }, [reload]);

  useEffect(() => {
    const un = listen<{ active: boolean }>("voice-transcribing", (e) => {
      setTranscribing(e.payload.active);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const un = listen<{ outcome: string; detail?: string | null }>("voice-capture-result", (e) => {
      const { outcome, detail } = e.payload;
      if (outcome === "saved") {
        flash(detail?.trim() ? detail : "Voice note saved");
        void reload();
        return;
      }
      if (detail) flash(detail, 3200);
    });
    return () => {
      un.then((f) => f());
    };
  }, [reload, flash]);

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
    const capturedAt = new Date();
    const s = await loadSettings();
    let ctxApp: string | null = null;
    let ctxTitle: string | null = null;
    let ctxDetail: string | null = null;
    let ctxExtra: string | null = null;

    if (s.contextEnabled) {
      try {
        const ctx = await invoke<{ app_name: string | null; title: string | null; process_path?: string | null }>(
          "get_work_context"
        );
        const blocked = isBlocked(s, ctx.app_name, ctx.title);
        if (!blocked) {
          const { detail, extra } = buildContextFields(
            ctx.app_name,
            ctx.title,
            ctx.process_path ?? null,
            capturedAt
          );
          ctxApp = ctx.app_name;
          ctxTitle = ctx.title;
          ctxDetail = detail;
          ctxExtra = extra ? JSON.stringify(extra) : null;
        }
      } catch {
        /* context is optional */
      }
    }

    const dueInfo = parseDueDateInfo(body);
    const dueAt = resolvedDueAt(dueInfo);

    const id = await insertThought({
      body,
      source: "type",
      due_at: dueAt,
      ctx_app: ctxApp,
      ctx_title: ctxTitle,
      ctx_detail: ctxDetail,
      ctx_extra: ctxExtra,
    });
    setDraft("");

    if (dueAt) {
      const thought = await getThought(id);
      if (thought) {
        const cal = await autoAddThoughtToGoogleCalendarIfConnected(thought);
        if (cal && cal.outcome === "auth_disconnected") {
          flash(messageForCalendarOutcome(cal), 4000);
        }
      }
    }

    await reload();
    if (dueAt && isTentativeDue(dueInfo)) {
      flash(`Due ${formatDueTimeLabel(dueAt)} — tap Change due to adjust`);
    }
    void emit("thought-added", {}).catch(() => {});
  }, [draft, reload, flash]);

  const sort = useCallback(
    async (id: number, bucket: Bucket) => {
      const t = items.find((x) => x.id === id) ?? (await getThought(id));
      if (t && (bucket === "dropped" || t.calendar_event_id)) {
        if (bucket === "dropped") {
          await removeThoughtCalendarEvent(t);
        }
      }
      await setBucket(id, bucket);
      await reload();
    },
    [reload, items]
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
        await deleteThoughtWithCalendar(t);
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
  }, [flash]);

  const manageDueTime = useCallback(
    async (t: Thought) => {
      const result = await scheduleThoughtDueTime(t, ({ hasDue, currentDueLabel }) =>
        prompt({
          title: hasDue ? "Change due time" : "Set due time",
          message: hasDue
            ? `Current: ${currentDueLabel}\n\nExamples: tomorrow 7:30 PM, Friday 3 PM.\nLeave blank to clear.`
            : "When is this due? Examples: tomorrow 6 PM, Friday 3 PM, Jun 26 7:30 PM",
          defaultValue: "",
          confirmLabel: hasDue ? "Update" : "Set due time",
          allowEmpty: hasDue,
        }),
      );
      if (result.outcome === "cancelled") return;
      const msg = messageForCalendarOutcome(result);
      if (msg) flash(msg, result.outcome === "auth_disconnected" ? 4000 : 2200);
      if (
        result.outcome === "created" ||
        result.outcome === "opened" ||
        result.outcome === "updated" ||
        result.outcome === "cleared" ||
        result.outcome === "auth_disconnected" ||
        result.outcome === "bad_due" ||
        result.outcome === "failed"
      ) {
        await reload();
      }
    },
    [prompt, reload, flash],
  );

  const addToGoogleCalendar = useCallback(
    async (t: Thought) => {
      if (!t.due_at) {
        const result = await scheduleThoughtDueTime(t, ({ hasDue, currentDueLabel }) =>
          prompt({
            title: "Add to Google Calendar",
            message: hasDue
              ? `Current: ${currentDueLabel}\n\nWhen should this appear on your calendar?\nLeave blank to clear.`
              : "When should this appear on your calendar?\n\nExamples: tomorrow 7 PM, Friday 3 PM, Jun 26 7:30 PM",
            defaultValue: "",
            confirmLabel: "Add to calendar",
            allowEmpty: hasDue,
          }),
        );
        if (result.outcome === "cancelled") return;
        const msg = messageForCalendarOutcome(result);
        if (msg) flash(msg, result.outcome === "auth_disconnected" ? 4000 : 2200);
        if (
          result.outcome === "created" ||
          result.outcome === "opened" ||
          result.outcome === "updated" ||
          result.outcome === "cleared" ||
          result.outcome === "auth_disconnected" ||
          result.outcome === "bad_due" ||
          result.outcome === "failed"
        ) {
          await reload();
        }
        return;
      }

      const result = await addThoughtToGoogleCalendar(t);
      const msg = messageForCalendarOutcome(result);
      if (msg) flash(msg, result.outcome === "auth_disconnected" ? 4000 : 2200);
      if (
        result.outcome === "created" ||
        result.outcome === "opened" ||
        result.outcome === "auth_disconnected" ||
        result.outcome === "failed"
      ) {
        await reload();
      }
    },
    [prompt, reload, flash],
  );

  const exportIcs = useCallback(
    async (t: Thought) => {
      if (!t.due_at) {
        flash("Set a due time first (press t)");
        return;
      }
      const result = await exportIcsForThought(t);
      if (result === "saved") flash("Calendar file downloaded — import into your calendar app");
      else if (result === "no_due") flash("No due time on this thought");
    },
    [flash],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (document.querySelector(".dialog-backdrop")) return;

      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
          return;
        }
      }

      if (searching) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        setSelected((s) => Math.min(s + 1, items.length - 1));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        setSelected((s) => Math.max(s - 1, 0));
      } else if (e.key >= "1" && e.key <= "5") {
        const t = items[selected];
        if (t && !t.completed_at) void sort(t.id, BUCKET_ORDER[Number(e.key) - 1]);
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
      } else if (e.key === "i") {
        const t = items[selected];
        if (t && !t.completed_at) {
          e.preventDefault();
          void addToGoogleCalendar(t);
        }
      } else if (e.key === "t" || e.key === "g") {
        const t = items[selected];
        if (t && !t.completed_at) {
          e.preventDefault();
          void manageDueTime(t);
        }
      } else if (e.key === "/") {
        e.preventDefault();
        setSearching(true);
        setTimeout(() => searchRef.current?.focus(), 0);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, selected, searching, sort, edit, remove, copy, manageDueTime, addToGoogleCalendar]);

  const inSearch = Boolean(query.trim());

  return (
    <div>
      <div className="row">
        <div>
          <div className="page-title">Triage</div>
          <div className="page-sub">
            {items.length} {inSearch ? "result" : "parked"}
            {items.length === 1 ? "" : "s"} · hold{" "}
            <strong>{formatHotkeyDisplay(hotkey)}</strong> to speak · j/k · 1-5 · e · t due · i Google Calendar · d · /
          </div>
        </div>
      </div>

      {transcribing && (
        <div className="voice-status" role="status" aria-live="polite">
          <span className="voice-status-spinner" aria-hidden />
          Transcribing voice note…
        </div>
      )}

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
          placeholder="Search all thoughts…"
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
          {inSearch ? (
            <>No matches for that search.</>
          ) : (
            <>
              Inbox at zero. Nice.
              <br />
              Hold <strong>{formatHotkeyDisplay(hotkey)}</strong> anywhere and speak —
              release to save, without leaving what you&apos;re doing.
            </>
          )}
        </div>
      ) : (
        items.map((t, i) => {
          const status = inSearch ? statusLabel(t) : null;
          const parked = !t.bucket && !t.completed_at;
          return (
            <div
              key={t.id}
              className={`thought${i === selected ? " selected" : ""}`}
              onClick={() => setSelected(i)}
              role="option"
              aria-selected={i === selected}
            >
              <div className="thought-body">{t.body}</div>
              <div className="thought-meta">
                <span>
                  {parseContextExtra(t.ctx_extra)?.captured_at_local ??
                    new Date(t.created_at).toLocaleString()}
                </span>
                {status && <span className="tag-status">{status}</span>}
                {inSearch && parked && <span className="tag-status">Parked</span>}
                {t.ctx_detail && (
                  <span title={t.ctx_title ?? undefined}>
                    in {t.ctx_app ?? "app"} · {t.ctx_detail}
                  </span>
                )}
                {t.due_at && !t.completed_at && (
                  <span className={dueClassName(t.due_at)}>
                    due{" "}
                    {new Date(t.due_at).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </span>
                )}
                {t.source === "voice" && <span>voice</span>}
                {t.calendar_event_id && <span className="tag-calendar">Google Calendar</span>}
              </div>
              {(t.ctx_extra || t.ctx_title) && <ThoughtContextPanel thought={t} />}
              {!t.completed_at && (
                <div className="bucket-row">
                  {BUCKET_ORDER.map((b, idx) => (
                    <button
                      key={b}
                      type="button"
                      onClick={() => void sort(t.id, b)}
                      title={b === "dropped" ? "Drop — moves to Done history" : undefined}
                    >
                      [{idx + 1}] {BUCKET_LABELS[b]}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => void manageDueTime(t)}
                    title={
                      t.due_at
                        ? "Change due time (also updates Google Calendar when connected)"
                        : "Set a due time (adds to Google Calendar when connected)"
                    }
                  >
                    [t] {t.due_at ? "Change due" : "Set due"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void addToGoogleCalendar(t)}
                    title={
                      t.calendar_event_id
                        ? "Synced to Google Calendar — click to update"
                        : t.due_at
                          ? "Add or update on Google Calendar"
                          : "Set a time and add to Google Calendar"
                    }
                  >
                    [i] Google Calendar
                  </button>
                  {t.due_at && (
                    <button
                      type="button"
                      onClick={() => void exportIcs(t)}
                      title="Download .ics for Outlook, Apple Calendar, etc."
                    >
                      Download .ics
                    </button>
                  )}
                  <button type="button" onClick={() => void copy(t)}>
                    [c] Copy
                  </button>
                  <button type="button" onClick={() => void edit(t)}>
                    [e] Edit
                  </button>
                  <button type="button" className="del" onClick={() => void remove(t)}>
                    [d] Delete
                  </button>
                </div>
              )}
              {t.completed_at && (
                <div className="bucket-row">
                  <button type="button" onClick={() => void copy(t)}>
                    [c] Copy
                  </button>
                  <button type="button" className="del" onClick={() => void remove(t)}>
                    [d] Delete
                  </button>
                </div>
              )}
            </div>
          );
        })
      )}
      {toast && (
        <div className="toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </div>
  );
}
