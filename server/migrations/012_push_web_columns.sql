-- Web Push (VAPID): endpoint в token, ключи в отдельных колонках
ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS web_auth TEXT;
ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS web_p256dh TEXT;
