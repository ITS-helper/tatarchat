-- Push уведомления (FCM): токены устройств + настройки пользователя

CREATE TABLE IF NOT EXISTS push_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  platform VARCHAR(16) NOT NULL DEFAULT 'android',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_push_tokens_user_id ON push_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_push_tokens_active_user_id ON push_tokens (user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS push_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS push_prefs (
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  room_slug VARCHAR(64) NOT NULL,
  mode VARCHAR(16) NOT NULL CHECK (mode IN ('all','mentions','off')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, room_slug)
);

CREATE INDEX IF NOT EXISTS idx_push_prefs_user_id ON push_prefs (user_id);

