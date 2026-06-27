import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Bucket, Thought } from "../lib/types";
import { BUCKET_LABELS } from "../lib/types";
import { useDialog } from "../components/DialogProvider";
import ThoughtContextPanel from "../components/ThoughtContextPanel";
import {
  completeThought,
  deleteThought,
  listByBucket,
  listCompleted,
  moveToBoardColumn,
  reopenThought,
} from "../lib/db";
import { addThoughtToGoogleCalendar, messageForCalendarOutcome } from "../lib/googleCalendar";

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
  const { confirm } = useDialog();
  const [cols, setCols] = useState<Record<string, Thought[]>>({});
  const [done, setDone] = useState<Thought[]>([]);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [overDrop, setOverDrop] = useState<DropTarget | null>(null);
  const [toast, setToast] = useState("");

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 1800);
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
    await moveToBoardColumn(id, target);
    await reload();
  };

  const finish = async (id: number) => {
    await completeThought(id);
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
      await deleteThought(t.id);
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
      {!fromDone && (
        <>
          <div className="card-meta">
            {t.due_at && (
              <span className="due">due {new Date(t.due_at).toLocaleDateString()}</span>
            )}
            {t.ctx_detail && (
              <span title={t.ctx_title ?? undefined}>
                {t.ctx_app ? `${t.ctx_app} · ` : ""}
                {t.ctx_detail}
              </span>
            )}
            {t.source === "voice" && <span className="tag-voice">voice</span>}
          </div>
          {(t.ctx_extra || t.ctx_title) && <ThoughtContextPanel thought={t} />}
        </>
      )}
      <div className="card-actions">
        {!fromDone &&
          ACTIVE.filter((x) => x !== t.bucket).map((x) => (
            <button key={x} title={`Move to ${BUCKET_LABELS[x]}`} onClick={() => dropOn(t.id, x)}>
              {COLUMN_META[x].label}
            </button>
          ))}
        {fromDone ? (
          <button onClick={() => reopen(t.id)}>↺ Reopen</button>
        ) : (
          <button className="ok" title="Mark done" onClick={() => finish(t.id)}>
            ✓ Done
          </button>
        )}
        {!fromDone && t.due_at && (
          <button
            title="Add to Google Calendar"
            onClick={() =>
              void addThoughtToGoogleCalendar(t).then((r) =>
                flash(messageForCalendarOutcome(r))
              )
            }
          >
            Calendar
          </button>
        )}
        <button title="Copy" onClick={() => void copy(t)}>
          Copy
        </button>
        <button className="del" title="Delete" onClick={() => remove(t)}>
          🗑
        </button>
      </div>
    </div>
  );

  const total = ACTIVE.reduce((n, b) => n + (cols[b]?.length ?? 0), 0);

  return (
    <div>
      <div className="page-title">Priority board</div>
      <div className="page-sub">
        {total} active · {done.length} done — drag cards between columns.
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
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
