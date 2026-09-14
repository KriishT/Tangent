import type { Thought } from "../lib/types";

export function ThoughtCalendarChips({ thought }: { thought: Thought }) {
  return (
    <>
      {thought.calendar_event_id && (
        <span className="tag-calendar" title="On Google Calendar">
          Google
        </span>
      )}
      {thought.apple_event_id && (
        <span className="tag-calendar" title="On Apple Calendar">
          Apple
        </span>
      )}
      {thought.outlook_event_id && (
        <span className="tag-calendar" title="On Outlook">
          Outlook
        </span>
      )}
    </>
  );
}

type Props = {
  thought: Thought;
  googleConnected: boolean;
  appleConnected: boolean;
  onDue: () => void;
  onGoogle: () => void;
  onApple: () => void;
  onIcs?: () => void;
};

/** Set due, plus Google / Apple only when that calendar is connected. */
export default function ThoughtCalendarActions({
  thought,
  googleConnected,
  appleConnected,
  onDue,
  onGoogle,
  onApple,
  onIcs,
}: Props) {
  const showIcs = Boolean(thought.due_at && onIcs && !googleConnected && !appleConnected);

  return (
    <>
      <button
        type="button"
        title={thought.due_at ? "Change due time" : "Set a due time"}
        onClick={onDue}
      >
        {thought.due_at ? "Change due" : "Set due"}
      </button>
      {googleConnected && (
        <button
          type="button"
          className={thought.calendar_event_id ? "cal-on" : undefined}
          title={
            thought.calendar_event_id ? "Update on Google Calendar" : "Add to Google Calendar"
          }
          onClick={onGoogle}
        >
          Google
        </button>
      )}
      {appleConnected && (
        <button
          type="button"
          className={thought.apple_event_id ? "cal-on" : undefined}
          title={thought.apple_event_id ? "Update on Apple Calendar" : "Add to Apple Calendar"}
          onClick={onApple}
        >
          Apple
        </button>
      )}
      {showIcs && (
        <button type="button" title="Download a calendar file" onClick={onIcs}>
          Download .ics
        </button>
      )}
    </>
  );
}
