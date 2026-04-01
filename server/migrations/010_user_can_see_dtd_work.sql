-- Доступ к чату «Работа» / каналу dtd_rabota (отдельно от DTD). Поднимается также через ensureUserPermissionsSchema.

ALTER TABLE users ADD COLUMN IF NOT EXISTS can_see_dtd_work BOOLEAN NOT NULL DEFAULT TRUE;
