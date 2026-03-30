-- Вложения и поиск (фаза 2)

ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_kind VARCHAR(16);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_name VARCHAR(255);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_mime VARCHAR(127);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_size BIGINT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_storage_key VARCHAR(512);
