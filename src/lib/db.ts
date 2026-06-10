import Database from "@tauri-apps/plugin-sql";
import type { Bucket, Thought } from "./types";
import { getSettingNumber } from "./settings";

let _db: Database | null = null;

export async function db(): Promise<Database> {
  if (!_db) {
    _db = await Database.load("sqlite:tangent.db");
  }
  return _db;
}

export interface NewThought {
  body: string;
  raw_body?: string | null;
  cleanup_tier?: string | null;
  source: "voice" | "type";
  ctx_app?: string | null;
  ctx_title?: string | null;
  ctx_detail?: string | null;
  ctx_extra?: string | null;
  due_at?: string | null;
}

export async function insertThought(t: NewThought): Promise<number> {
  const d = await db();
  const res = await d.execute(
    `INSERT INTO thoughts
       (body, raw_body, cleanup_tier, created_at, source, ctx_app, ctx_title, ctx_detail, ctx_extra, due_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      t.body,
      t.raw_body ?? null,
      t.cleanup_tier ?? null,
      new Date().toISOString(),
      t.source,
      t.ctx_app ?? null,
      t.ctx_title ?? null,
      t.ctx_detail ?? null,
      t.ctx_extra ?? null,
      t.due_at ?? null,
    ]
  );
  return Number(res.lastInsertId);
}

export async function listUntriaged(): Promise<Thought[]> {
  const d = await db();
  return d.select<Thought[]>(
    `SELECT * FROM thoughts
     WHERE bucket IS NULL AND completed_at IS NULL
     ORDER BY created_at DESC`
  );
}

export async function listByBucket(bucket: Bucket): Promise<Thought[]> {
  const d = await db();
  return d.select<Thought[]>(
    `SELECT * FROM thoughts
     WHERE bucket = $1 AND completed_at IS NULL
     ORDER BY COALESCE(due_at, created_at) ASC`,
    [bucket]
  );
}

export async function search(q: string): Promise<Thought[]> {
  const d = await db();
  return d.select<Thought[]>(
    `SELECT * FROM thoughts WHERE body LIKE $1 ORDER BY created_at DESC LIMIT 200`,
    [`%${q}%`]
  );
}

/** Sort a thought into a bucket and compute when (if ever) it should resurface. */
export async function setBucket(id: number, bucket: Bucket): Promise<void> {
  const d = await db();
  const now = new Date().toISOString();
  const morningHour = await getSettingNumber("resurfaceHour", 9);

  let resurfaceAt: string | null = null;
  let completedAt: string | null = null;

  if (bucket === "do_soon") {
    resurfaceAt = nextMorningISO(morningHour);
  } else if (bucket === "dropped") {
    completedAt = now;
  }

  await d.execute(
    `UPDATE thoughts
       SET bucket = $1, triaged_at = $2, resurface_at = $3, completed_at = $4
     WHERE id = $5`,
    [bucket, now, resurfaceAt, completedAt, id]
  );
}

export async function completeThought(id: number): Promise<void> {
  const d = await db();
  await d.execute(`UPDATE thoughts SET completed_at = $1 WHERE id = $2`, [
    new Date().toISOString(),
    id,
  ]);
}

/** Recently completed or dropped thoughts (for the "Done" column / history). */
export async function listCompleted(): Promise<Thought[]> {
  const d = await db();
  return d.select<Thought[]>(
    `SELECT * FROM thoughts
     WHERE completed_at IS NOT NULL
     ORDER BY completed_at DESC
     LIMIT 100`
  );
}

/** Un-complete a thought and send it back to the inbox for re-triage. */
export async function reopenThought(id: number): Promise<void> {
  const d = await db();
  await d.execute(
    `UPDATE thoughts
       SET completed_at = NULL, bucket = NULL, triaged_at = NULL, resurface_at = NULL, notified_at = NULL
     WHERE id = $1`,
    [id]
  );
}

export async function updateBody(id: number, body: string): Promise<void> {
  const d = await db();
  await d.execute(`UPDATE thoughts SET body = $1 WHERE id = $2`, [body, id]);
}

/** Permanently remove a thought. */
export async function deleteThought(id: number): Promise<void> {
  const d = await db();
  await d.execute(`DELETE FROM thoughts WHERE id = $1`, [id]);
}

/** Revert a thought to its original (pre-cleanup) transcript. */
export async function revertToRaw(id: number): Promise<void> {
  const d = await db();
  await d.execute(
    `UPDATE thoughts SET body = COALESCE(raw_body, body), cleanup_tier = NULL WHERE id = $1`,
    [id]
  );
}

/** Items whose due/resurface time has arrived and that we haven't notified about yet. */
export async function dueForResurface(): Promise<Thought[]> {
  const d = await db();
  const now = new Date().toISOString();
  return d.select<Thought[]>(
    `SELECT * FROM thoughts
     WHERE completed_at IS NULL
       AND notified_at IS NULL
       AND (
         (due_at IS NOT NULL AND due_at <= $1)
         OR (resurface_at IS NOT NULL AND resurface_at <= $1)
       )
     ORDER BY COALESCE(due_at, resurface_at) ASC`,
    [now]
  );
}

export async function markNotified(id: number): Promise<void> {
  const d = await db();
  await d.execute(`UPDATE thoughts SET notified_at = $1 WHERE id = $2`, [
    new Date().toISOString(),
    id,
  ]);
}

export interface Stats {
  caught: number;
  triaged: number;
  parked: number;
}

export async function stats(): Promise<Stats> {
  const d = await db();
  const rows = await d.select<{ caught: number; triaged: number; parked: number }[]>(
    `SELECT
       (SELECT COUNT(*) FROM thoughts) AS caught,
       (SELECT COUNT(*) FROM thoughts WHERE triaged_at IS NOT NULL) AS triaged,
       (SELECT COUNT(*) FROM thoughts WHERE bucket IS NULL AND completed_at IS NULL) AS parked`
  );
  return rows[0] ?? { caught: 0, triaged: 0, parked: 0 };
}

export async function exportAll(): Promise<string> {
  const d = await db();
  const rows = await d.select<Thought[]>(`SELECT * FROM thoughts ORDER BY created_at ASC`);
  return JSON.stringify(rows, null, 2);
}

export async function wipeAll(): Promise<void> {
  const d = await db();
  await d.execute(`DELETE FROM thoughts`);
}

// --- settings key/value helpers (used by lib/settings.ts) ---
export async function getSettingRaw(key: string): Promise<string | null> {
  const d = await db();
  const rows = await d.select<{ value: string }[]>(
    `SELECT value FROM settings WHERE key = $1`,
    [key]
  );
  return rows.length ? rows[0].value : null;
}

export async function setSettingRaw(key: string, value: string): Promise<void> {
  const d = await db();
  await d.execute(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value]
  );
}

function nextMorningISO(hour: number): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}
