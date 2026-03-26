-- Логин по паролю: хеш в users.password_hash
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);

-- Старые строки с NULL не смогут войти, пока не зададут пароль (или удалите строку и зарегистрируйтесь снова)
