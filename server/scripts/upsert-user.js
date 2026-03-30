/**
 * Создаёт пользователя или обновляет password_hash при совпадении nickname.
 * Запуск из каталога server: node scripts/upsert-user.js "Саня" "12345678"
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const bcrypt = require("bcrypt");
const { Pool } = require("pg");

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS) || 10;
const MIN_LEN = 6;
const MAX_LEN = 128;

async function main() {
  const nick = process.argv[2];
  const password = process.argv[3];
  if (!nick || !password) {
    console.error('Использование: node scripts/upsert-user.js "<ник>" "<пароль>"');
    process.exit(1);
  }
  if (password.length < MIN_LEN || password.length > MAX_LEN) {
    console.error(`Пароль: от ${MIN_LEN} до ${MAX_LEN} символов`);
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("Задайте DATABASE_URL в server/.env");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url });
  try {
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const { rows } = await pool.query(
      `INSERT INTO users (nickname, password_hash, online) VALUES ($1, $2, FALSE)
       ON CONFLICT (nickname) DO UPDATE SET password_hash = EXCLUDED.password_hash
       RETURNING id, nickname`,
      [nick.trim(), hash]
    );
    console.log("Готово:", rows[0]);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
