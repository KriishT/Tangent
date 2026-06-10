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
  reopenThought,
  setBucket,
} from "../lib/db";

const ACTIVE: Bucket[] = ["do_now", "do_soon", "later", "idea"];
const COLUMN_META: Record<string, { label: string; accent: string }> = {
  do_now: { label: "Do Now", accent: "var(--c-now)" },
  do_soon: { label: "Do Soon", accent: "var(--c-soon)" },
  later: { label: "Later", accent: "var(--c-later)" },
  idea: { label: "Idea", accent: "var(--c-idea)" },
  done: { label: "Done", accent: "var(--c-done)" },
};

export default function Lists() {
  const { confirm } = useDialog();
  const [cols, setCols] = useState<Record<string, Thought[]>>({});
  const [done, setDone] = useState<Thought[]>([]);

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

  const move = async (id: number, b: Bucket) => {
    await setBucket(id, b);
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

  const total = ACTIVE.reduce((n, b) => n + (cols[b]?.length ?? 0), 0);

  return (
    <div>
      <div className="page-title">Priority board</div>
      <div className="page-sub">
        {total} active · {done.length} done — where every thought lives after triage.
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
            <div className="board-col-body">
              {(cols[b] ?? []).length === 0 ? (
                <div className="board-empty">—</div>
              ) : (
                (cols[b] ?? []).map((t) => (
                  <div className="card" key={t.id}>
                    <div className="card-body">{t.body}</div>
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
                    <div className="card-actions">
                      {ACTIVE.filter((x) => x !== b).map((x) => (
                        <button key={x} title={`Move to ${BUCKET_LABELS[x]}`} onClick={() => move(t.id, x)}>
                          {COLUMN_META[x].label}
                        </button>
                      ))}
                      <button className="ok" title="Mark done" onClick={() => finish(t.id)}>
                        ✓ Done
                      </button>
                      <button className="del" title="Delete" onClick={() => remove(t)}>
                        🗑
                      </button>
                    </div>
                  </div>
                ))
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
          <div className="board-col-body">
            {done.length === 0 ? (
              <div className="board-empty">—</div>
            ) : (
              done.map((t) => (
                <div className="card done" key={t.id}>
                  <div className="card-body">{t.body}</div>
                  <div className="card-actions">
                    <button onClick={() => reopen(t.id)}>↺ Reopen</button>
                    <button className="del" title="Delete" onClick={() => remove(t)}>
                      🗑
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
