-- Старые установки: колонка времени называлась "timestamp", код ожидает created_at
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'timestamp'
  ) THEN
    ALTER TABLE messages RENAME COLUMN "timestamp" TO created_at;
  END IF;
END $$;
