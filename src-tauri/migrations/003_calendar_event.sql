-- Store Google Calendar event id so we can update/remove reminders later.
ALTER TABLE thoughts ADD COLUMN calendar_event_id TEXT;
