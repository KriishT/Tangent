import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Bucket, Thought } from "../lib/types";
import { BUCKET_LABELS } from "../lib/types";
import { useDialog } from "../components/DialogProvider";
import ThoughtContextPanel from "../components/ThoughtContextPanel";
import {
  completeThought,
  listByBucket,
  listCompleted,
  moveToBoardColumn,
  reopenThought,
  updateBody,
} from "../lib/db";
import { dueClassName } from "../lib/parse";
import {
  scheduleThoughtDueTime,
  messageForCalendarOutcome,
  deleteThoughtWithCalendar,
  removeThoughtCalendarEvent,
  addThoughtToGoogleCalendar,
} from "../lib/googleCalendar";

const ACTIVE: Bucket[] = ["do_now", "do_soon", "later", "idea"];
const COLUMN_META: Record<string, { label: string; accent: string }> = {
  do_now: { label: "Do Now", accent: "var(--c-now)" },
  do_soon: { label: "Do Soon", accent: "var(--c-soon)" },
  later: { label: "Later", accent: "var(--c-later)" },
  idea: { label: "Idea", accent: "var(--c-idea)" },
  done: { label: "Done", accent: "var(--c-done)" },
};

type DropTarget = Bucket | "done";

function parseDropTarget(el: HTMLElement | null): DropTarget | null {
  const col = el?.closest("[data-drop]") as HTMLElement | null;
  const v = col?.dataset.drop;
  if (!v) return null;
  if (v === "done") return "done";
  if (ACTIVE.includes(v as Bucket)) return v as Bucket;
  return null;
}

export default function Lists() {
  const { confirm, prompt } = useDialog();
  const [cols, setCols] = useState<Record<string, Thought[]>>({});
  const [done, setDone] = useState<Thought[]>([]);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [overDrop, setOverDrop] = useState<DropTarget | null>(null);
  const [toast, setToast] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = (msg: string, ms = 2200) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), ms);
  };

  const reload = useCallback(async () => {
    const entries = await Promise.all(
      ACTIVE.map(async (b) => [b, await listByBucket(b)] as const)
    );
    setCols(Object.fromEntries(entries));
    setDone(await listCompleted());
  }, []);

  useEffect(() => {
    void reload();
    const un = listen("thought-added", () => void reload());
    const t = setInterval(() => void reload(), 5000);
    return () => {
      un.then((f) => f());
      clearInterval(t);
    };
  }, [reload]);

  const dropOn = async (id: number, target: DropTarget) => {
    const all = [...ACTIVE.flatMap((b) => cols[b] ?? []), ...done];
    const t = all.find((x) => x.id === id);
    if (t && target === "done") {
      await removeThoughtCalendarEvent(t);
    }
    await moveToBoardColumn(id, target);
    await reload();
  };

  const finish = async (t: Thought) => {
    await removeThoughtCalendarEvent(t);
    await completeThought(t.id);
    await reload();
  };
  const reopen = async (id: number) => {
    await reopenThought(id);
    await reload();
  };
  const remove = async (t: Thought) => {
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
  };

  const edit = async (t: Thought) => {
    const next = await prompt({
      title: "Edit thought",
      defaultValue: t.body,
      confirmLabel: "Save",
    });
    if (next != null && next.trim() && next !== t.body) {
      await updateBody(t.id, next.trim());
      await reload();
    }
  };

  const copy = async (t: Thought) => {
    try {
      await navigator.clipboard.writeText(t.body);
      flash("Copied");
    } catch {
      flash("Could not copy");
    }
  };

  const manageDueTime = async (t: Thought) => {
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
  };

  const addToGoogleCalendar = async (t: Thought) => {
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
  };

  const onDragStart = (e: React.DragEvent, id: number) => {
    setDraggingId(id);
    e.dataTransfer.setData("text/plain", String(id));
    e.dataTransfer.effectAllowed = "move";
  };

  const onDragEnd = () => {
    setDraggingId(null);
    setOverDrop(null);
  };

  const onDragOverCol = (e: React.DragEvent, target: DropTarget) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setOverDrop(target);
  };

  const onDropCol = async (e: React.DragEvent, target: DropTarget) => {
    e.preventDefault();
    const id = Number(e.dataTransfer.getData("text/plain")) || draggingId;
    setOverDrop(null);
    setDraggingId(null);
    if (id) await dropOn(id, target);
  };

  const renderCard = (t: Thought, fromDone = false) => (
    <div
      className={`card${draggingId === t.id ? " dragging" : ""}`}
      key={t.id}
      draggable
      onDragStart={(e) => onDragStart(e, t.id)}
      onDragEnd={onDragEnd}
    >
      <div className="card-body">{t.body}</div>
      <div className="card-meta">
        {fromDone && (
          <span className="tag-status">{t.bucket === "dropped" ? "Dropped" : "Done"}</span>
        )}
        {!fromDone && t.due_at && (
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
        {!fromDone && t.ctx_detail && (
          <span title={t.ctx_title ?? undefined}>
            {t.ctx_app ? `${t.ctx_app} · ` : ""}
            {t.ctx_detail}
          </span>
        )}
        {!fromDone && t.source === "voice" && <span className="tag-voice">voice</span>}
        {t.calendar_event_id && <span className="tag-calendar">Google Calendar</span>}
      </div>
      {!fromDone && (t.ctx_extra || t.ctx_title) && <ThoughtContextPanel thought={t} />}
      <div className="card-actions">
        {!fromDone &&
          ACTIVE.filter((x) => x !== t.bucket).map((x) => (
            <button
              key={x}
              type="button"
              title={`Move to ${BUCKET_LABELS[x]}`}
              onClick={() => void dropOn(t.id, x)}
            >
              {COLUMN_META[x].label}
            </button>
          ))}
        {fromDone ? (
          <button type="button" onClick={() => void reopen(t.id)}>
            Reopen
          </button>
        ) : (
          <button type="button" className="ok" title="Mark done" onClick={() => void finish(t)}>
            Done
          </button>
        )}
        {!fromDone && (
          <>
            <button
              type="button"
              title={
                t.due_at
                  ? "Change due time (also updates Google Calendar when connected)"
                  : "Set a due time (adds to Google Calendar when connected)"
              }
              onClick={() => void manageDueTime(t)}
            >
              {t.due_at ? "Change due" : "Set due"}
            </button>
            <button
              type="button"
              title={
                t.calendar_event_id
                  ? "Synced to Google Calendar — click to update"
                  : t.due_at
                    ? "Add or update on Google Calendar"
                    : "Set a time and add to Google Calendar"
              }
              onClick={() => void addToGoogleCalendar(t)}
            >
              Google Calendar
            </button>
            <button type="button" title="Edit" onClick={() => void edit(t)}>
              Edit
            </button>
          </>
        )}
        <button type="button" title="Copy" onClick={() => void copy(t)}>
          Copy
        </button>
        <button type="button" className="del" title="Delete" onClick={() => void remove(t)}>
          Delete
        </button>
      </div>
    </div>
  );

  const total = ACTIVE.reduce((n, b) => n + (cols[b]?.length ?? 0), 0);

  return (
    <div>
      <div className="page-title">Priority board</div>
      <div className="page-sub">
        {total} active · {done.length} done — drag cards between columns. Drop from Triage lands
        here as Dropped.
      </div>

      <div className="board">
        {ACTIVE.map((b) => (
          <div
            className="board-col"
            key={b}
            data-bucket={b}
            style={{ ["--col" as string]: COLUMN_META[b].accent }}
          >
            <div className="board-col-head">
              <span className="dot" />
              {COLUMN_META[b].label}
              <span className="count">{cols[b]?.length ?? 0}</span>
            </div>
            <div
              className={`board-col-body${overDrop === b ? " drag-over" : ""}`}
              data-drop={b}
              onDragOver={(e) => onDragOverCol(e, b)}
              onDragLeave={(e) => {
                if (parseDropTarget(e.relatedTarget as HTMLElement) !== b) {
                  setOverDrop((cur) => (cur === b ? null : cur));
                }
              }}
              onDrop={(e) => void onDropCol(e, b)}
            >
              {(cols[b] ?? []).length === 0 ? (
                <div className="board-empty">Drop here</div>
              ) : (
                (cols[b] ?? []).map((t) => renderCard(t))
              )}
            </div>
          </div>
        ))}

        <div
          className="board-col"
          data-bucket="done"
          style={{ ["--col" as string]: COLUMN_META.done.accent }}
        >
          <div className="board-col-head">
            <span className="dot" />
            Done
            <span className="count">{done.length}</span>
          </div>
          <div
            className={`board-col-body${overDrop === "done" ? " drag-over" : ""}`}
            data-drop="done"
            onDragOver={(e) => onDragOverCol(e, "done")}
            onDragLeave={(e) => {
              if (parseDropTarget(e.relatedTarget as HTMLElement) !== "done") {
                setOverDrop((cur) => (cur === "done" ? null : cur));
              }
            }}
            onDrop={(e) => void onDropCol(e, "done")}
          >
            {done.length === 0 ? (
              <div className="board-empty">Drop here</div>
            ) : (
              done.map((t) => renderCard(t, true))
            )}
          </div>
        </div>
      </div>
      {toast && (
        <div className="toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </div>
  );
}
