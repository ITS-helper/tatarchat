/**
 * Применяет init.sql к БД (кроссплатформенно, без psql в PATH).
 * Запуск из корня репозитория: npm run db:init (после docker compose up -d).
 * init.sql лежит в корне проекта (на уровень выше каталога server/).
 */
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const sqlPath = path.join(__dirname, "..", "..", "init.sql");

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

  const sql = fs.readFileSync(sqlPath, "utf8");
  const client = await connectWithRetry(url);
  try {
    await client.query(sql);
    console.log("init.sql применён успешно.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
