-- Сообщения должны ссылаться на users.id (как в init.sql).
-- Старая таблица без user_id: добавляем колонку, переносим по нику, удаляем строки без сопоставления.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'user_id'
  ) THEN
    RAISE NOTICE 'messages.user_id уже есть — пропуск добавления колонки';
  ELSE
    ALTER TABLE messages ADD COLUMN user_id INTEGER;
  END IF;
END $$;

-- Старая схема Render: колонка "user" (зарезервированное слово — в кавычках)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'user'
  ) THEN
    UPDATE messages m
    SET user_id = u.id
    FROM users u
    WHERE m.user_id IS NULL AND lower(trim(u.nickname)) = lower(trim(m."user"));
  END IF;
END $$;

-- Подстановка из текстового поля автора (если было в старой схеме)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'user_nick'
  ) THEN
    UPDATE messages m
    SET user_id = u.id
    FROM users u
    WHERE m.user_id IS NULL AND u.nickname = m.user_nick;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'nickname'
  ) THEN
    UPDATE messages m
    SET user_id = u.id
    FROM users u
    WHERE m.user_id IS NULL AND u.nickname = m.nickname;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'author'
  ) THEN
    UPDATE messages m
    SET user_id = u.id
    FROM users u
    WHERE m.user_id IS NULL AND u.nickname = m.author;
  END IF;
END $$;

-- Строки, для которых не нашёлся пользователь, удаляются (иначе NOT NULL не задать)
DELETE FROM messages WHERE user_id IS NULL;

ALTER TABLE messages ALTER COLUMN user_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'messages_user_id_fkey'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages (user_id);

-- Иначе INSERT из приложения (room, user_id, text) падает: колонка user NOT NULL без значения
ALTER TABLE messages DROP COLUMN IF EXISTS "user";
