-- События календаря по каналу (room_slug). Схема поднимается также через ensureCalendarSchema в server.js.

CREATE TABLE IF NOT EXISTS channel_calendar_events (
  id SERIAL PRIMARY KEY,
  room_slug VARCHAR(80) NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(240) NOT NULL,
  notes TEXT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calendar_room_starts ON channel_calendar_events (room_slug, starts_at);
