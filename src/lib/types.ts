export type Bucket = "do_now" | "do_soon" | "later" | "idea" | "dropped";

export interface WorkContext {
  app_name: string | null;
  title: string | null;
  process_path?: string | null;
}

export interface Thought {
  id: number;
  body: string;
  raw_body: string | null;
  cleanup_tier: string | null;
  created_at: string;
  source: "voice" | "type";
  audio_path: string | null;
  ctx_app: string | null;
  ctx_title: string | null;
  ctx_detail: string | null;
  ctx_extra: string | null;
  bucket: Bucket | null;
  due_at: string | null;
  /** Google Calendar event id when this thought was added to Calendar. */
  calendar_event_id: string | null;
  priority: number | null;
  resurface_at: string | null;
  notified_at: string | null;
  triaged_at: string | null;
  completed_at: string | null;
}

export const BUCKET_LABELS: Record<Bucket, string> = {
  do_now: "Do Now",
  do_soon: "Do Soon",
  later: "Later",
  idea: "Idea",
  dropped: "Drop",
};

// Order shown in the triage view; index + 1 is the keyboard shortcut (1-5).
export const BUCKET_ORDER: Bucket[] = ["do_now", "do_soon", "later", "idea", "dropped"];
