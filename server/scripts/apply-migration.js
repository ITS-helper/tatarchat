/**
 * Применяет один .sql файл миграции к БД из DATABASE_URL (server/.env).
 * По умолчанию: server/migrations/006_phase3_channels_dm.sql
 *
 * Запуск из каталога server:
 *   node scripts/apply-migration.js
 *   node scripts/apply-migration.js migrations/006_phase3_channels_dm.sql
 */
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function connectWithRetry(url, attempts = 40, delayMs = 1000) {
  let last;
  for (let i = 0; i < attempts; i++) {
    const client = new Client({ connectionString: url });
    try {
      await client.connect();
      return client;
    } catch (e) {
      last = e;
      await client.end().catch(() => {});
      console.log(`Ожидание PostgreSQL… (${i + 1}/${attempts})`);
      await sleep(delayMs);
    }
  }
  throw last;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL не задан. Скопируйте server/.env.example в server/.env");
    process.exit(1);
  }

  const sqlPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(__dirname, "..", "migrations", "006_phase3_channels_dm.sql");

  if (!fs.existsSync(sqlPath)) {
    console.error("Файл не найден:", sqlPath);
    process.exit(1);
  }

  const sql = fs.readFileSync(sqlPath, "utf8");
  const client = await connectWithRetry(url, 25, 1000);
  try {
    await client.query(sql);
    console.log("Миграция применена:", path.basename(sqlPath));
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
