-- Phase 3: публичные каналы в БД + лички (slug dm-<low>-<high>)

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

INSERT INTO channels (slug, title, kind)
SELECT 'dreamteamdauns', 'DTD', 'public'
WHERE NOT EXISTS (SELECT 1 FROM channels WHERE slug = 'dreamteamdauns');

INSERT INTO channels (slug, title, kind)
SELECT 'lobby', 'Семья', 'public'
WHERE NOT EXISTS (SELECT 1 FROM channels WHERE slug = 'lobby');
