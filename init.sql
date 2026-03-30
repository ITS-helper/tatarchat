-- TatarChat: схема под server.js (JOIN users + messages.user_id).
-- Если раньше были другие таблицы: DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS users CASCADE;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  nickname VARCHAR(64) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  online BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  room VARCHAR(64) NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  reply_to_id INTEGER REFERENCES messages (id) ON DELETE SET NULL,
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  attachment_kind VARCHAR(16),
  attachment_name VARCHAR(255),
  attachment_mime VARCHAR(127),
  attachment_size BIGINT,
  attachment_storage_key VARCHAR(512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_room_created_at ON messages (room, created_at DESC);

CREATE TABLE IF NOT EXISTS channels (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(64) NOT NULL UNIQUE,
  title VARCHAR(128) NOT NULL DEFAULT '',
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('public', 'direct')),
  user_low_id INTEGER REFERENCES users (id) ON DELETE CASCADE,
  user_high_id INTEGER REFERENCES users (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (kind = 'public' AND user_low_id IS NULL AND user_high_id IS NULL)
    OR (kind = 'direct' AND user_low_id IS NOT NULL AND user_high_id IS NOT NULL AND user_low_id < user_high_id)
  )
);

CREATE INDEX IF NOT EXISTS idx_channels_dm_users ON channels (user_low_id, user_high_id) WHERE kind = 'direct';

INSERT INTO channels (slug, title, kind) VALUES
  ('dreamteamdauns', 'DTD', 'public'),
  ('lobby', 'Лобби', 'public')
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id INTEGER NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  emoji VARCHAR(32) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_message_reactions_message_id ON message_reactions (message_id);
