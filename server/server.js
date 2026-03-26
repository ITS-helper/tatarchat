/**
 * TatarChat: Express + Socket.io + PostgreSQL.
 * Вход по аккаунту (JWT). Групповые комнаты; часть комнат с паролем.
 */
require("dotenv").config();
const http = require("http");
const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT) || 3001;
const MAX_MESSAGE_LEN = 2000;
const MAX_NICK_LEN = 64;
const MIN_PASSWORD_LEN = 6;
const MAX_PASSWORD_LEN = 128;
const MESSAGES_PER_MINUTE = 30;
const BCRYPT_ROUNDS = 10;
const JWT_EXPIRES = "7d";

/** slug → отображаемое имя и пароль комнаты (null = без пароля) */
const GROUP_ROOMS = {
  dreamteamdauns: {
    title: "DreamTeamDauns",
    roomPassword: null,
  },
  family: {
    title: "Family",
    roomPassword: process.env.FAMILY_ROOM_PASSWORD || "777",
  },
};

const JWT_SECRET =
  process.env.JWT_SECRET ||
  (process.env.NODE_ENV === "production" ? null : "dev-tatarchat-jwt-secret-do-not-use-in-prod");

if (!JWT_SECRET) {
  console.error("Задайте JWT_SECRET в переменных окружения (обязательно в production).");
  process.exit(1);
}

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://postgres:password@localhost:5432/tatarchat-db";

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 20,
});

const EXTRA_ORIGINS = (process.env.CLIENT_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function corsOrigin(origin, callback) {
  if (!origin) {
    return callback(null, true);
  }
  try {
    const u = new URL(origin);
    if (
      (u.hostname === "localhost" || u.hostname === "127.0.0.1") &&
      (u.protocol === "http:" || u.protocol === "https:")
    ) {
      return callback(null, true);
    }
    if (u.protocol === "https:" && u.hostname.endsWith(".onrender.com")) {
      return callback(null, true);
    }
    if (EXTRA_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    return callback(null, false);
  } catch {
    return callback(null, false);
  }
}

const app = express();
app.set("trust proxy", 1);
app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);
app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
  })
);
app.use(express.json({ limit: "64kb" }));

function sanitizeText(input) {
  const s = String(input ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/<[^>]*>/g, "")
    .slice(0, MAX_MESSAGE_LEN)
    .trim();
  return s;
}

function sanitizeNickname(input) {
  const raw = String(input ?? "").trim().slice(0, MAX_NICK_LEN);
  if (!raw) return "";
  if (!/^[\p{L}\p{N}\s._-]+$/u.test(raw)) return "";
  return raw;
}

function sanitizePassword(input) {
  const s = String(input ?? "");
  if (s.length < MIN_PASSWORD_LEN || s.length > MAX_PASSWORD_LEN) return null;
  return s;
}

function normalizeRoomSlug(input) {
  const s = String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "");
  return GROUP_ROOMS[s] ? s : "";
}

function roomAllowsAccess(slug, roomPasswordFromClient) {
  const conf = GROUP_ROOMS[slug];
  if (!conf) return false;
  if (conf.roomPassword == null) return true;
  return conf.roomPassword === String(roomPasswordFromClient ?? "");
}

const presenceByUserId = new Map();
function incPresence(userId) {
  presenceByUserId.set(userId, (presenceByUserId.get(userId) || 0) + 1);
}
function decPresence(userId) {
  const cur = presenceByUserId.get(userId) || 0;
  if (cur <= 0) return false;
  const next = cur - 1;
  if (next <= 0) {
    presenceByUserId.delete(userId);
    return true;
  }
  presenceByUserId.set(userId, next);
  return false;
}

const rateBuckets = new Map();
function checkRateLimit(userId) {
  const now = Date.now();
  const windowMs = 60_000;
  let b = rateBuckets.get(userId);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(userId, b);
  }
  b.count += 1;
  if (b.count > MESSAGES_PER_MINUTE) {
    return false;
  }
  return true;
}

const regBuckets = new Map();
function checkRegRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60_000;
  let b = regBuckets.get(ip);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    regBuckets.set(ip, b);
  }
  b.count += 1;
  return b.count <= 5;
}

async function setUserOffline(userId) {
  await pool.query("UPDATE users SET online = FALSE WHERE id = $1", [userId]);
}

/** Кэш полей таблицы messages (created_at vs legacy timestamp). */
let messagesSchemaCache = null;

function invalidateMessagesSchemaCache() {
  messagesSchemaCache = null;
}

/**
 * Старая БД (колонка "user" text вместо user_id): приводим к init.sql без ручного psql.
 * Идемпотентно; при успехе сбрасывает кэш схемы сообщений.
 */
async function ensureMessagesUserIdSchema() {
  const { rows } = await pool.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages'
    `
  );
  if (rows.length === 0) {
    console.warn("[schema] Таблица messages не найдена — пропуск автомиграции user_id.");
    return;
  }
  const cols = new Set(rows.map((r) => r.column_name));
  const hasUser = cols.has("user");
  const hasUserId = cols.has("user_id");

  if (hasUserId && !hasUser) {
    return;
  }

  console.warn("[schema] messages: автомиграция user_id (старая схема или колонка user)…");

  if (!hasUserId) {
    await pool.query("ALTER TABLE messages ADD COLUMN user_id INTEGER");
  }

  if (hasUser) {
    await pool.query(`
      UPDATE messages m
      SET user_id = u.id
      FROM users u
      WHERE m.user_id IS NULL AND lower(trim(u.nickname)) = lower(trim(m."user"))
    `);
  }
  if (cols.has("user_nick")) {
    await pool.query(`
      UPDATE messages m
      SET user_id = u.id
      FROM users u
      WHERE m.user_id IS NULL AND u.nickname = m.user_nick
    `);
  }
  if (cols.has("nickname")) {
    await pool.query(`
      UPDATE messages m
      SET user_id = u.id
      FROM users u
      WHERE m.user_id IS NULL AND u.nickname = m.nickname
    `);
  }
  if (cols.has("author")) {
    await pool.query(`
      UPDATE messages m
      SET user_id = u.id
      FROM users u
      WHERE m.user_id IS NULL AND u.nickname = m.author
    `);
  }

  await pool.query("DELETE FROM messages WHERE user_id IS NULL");
  await pool.query("ALTER TABLE messages ALTER COLUMN user_id SET NOT NULL");

  try {
    await pool.query(`
      ALTER TABLE messages
      ADD CONSTRAINT messages_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    `);
  } catch (e) {
    if (e.code !== "42710" && e.code !== "42P16") {
      throw e;
    }
  }

  await pool.query("CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages (user_id)");

  if (hasUser) {
    await pool.query('ALTER TABLE messages DROP COLUMN IF EXISTS "user"');
  }

  invalidateMessagesSchemaCache();
  console.warn("[schema] messages: готово (user_id, лишняя колонка user удалена при наличии).");
}

async function loadMessagesSchema() {
  const { rows } = await pool.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages'
    `
  );
  if (rows.length === 0) {
    const e = new Error(
      "Таблица public.messages не найдена. Выполните init.sql или создайте БД по README."
    );
    e.code = "SCHEMA_MESSAGES";
    throw e;
  }
  const cols = new Set(rows.map((r) => r.column_name));
  const need = ["room", "user_id", "text"];
  const missing = need.filter((c) => !cols.has(c));
  if (missing.length) {
    let hint = " Сверьте схему с init.sql.";
    if (missing.includes("user_id")) {
      hint =
        " Перезапустите сервер — при старте выполняется автомиграция; либо migrations/003_messages_user_id.sql вручную.";
    }
    const e = new Error(`В messages не хватает колонок: ${missing.join(", ")}.${hint}`);
    e.code = "SCHEMA_MESSAGES";
    throw e;
  }

  let timeSelect;
  let timeReturning;
  if (cols.has("created_at")) {
    timeSelect = "m.created_at";
    timeReturning = "created_at";
  } else {
    const ts = rows.find((r) => r.column_name.toLowerCase() === "timestamp");
    if (!ts) {
      const e = new Error(
        "В messages нет колонки времени (created_at или timestamp). Выполните migrations/001_rename_messages_timestamp.sql или пересоздайте таблицу по init.sql."
      );
      e.code = "SCHEMA_MESSAGES_TIME";
      throw e;
    }
    const id = ts.column_name.replace(/"/g, '""');
    timeSelect = `m."${id}"`;
    timeReturning = `"${id}" AS created_at`;
  }

  return { timeSelect, timeReturning };
}

async function getMessagesSchema() {
  if (!messagesSchemaCache) {
    messagesSchemaCache = await loadMessagesSchema();
  }
  return messagesSchemaCache;
}

async function getLastMessages(room, limit = 50) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { timeSelect } = await getMessagesSchema();
      const q = `
        SELECT
          m.id,
          m.room,
          m.text,
          ${timeSelect} AS time,
          u.nickname AS user_nick
        FROM messages m
        JOIN users u ON u.id = m.user_id
        WHERE m.room = $1
        ORDER BY ${timeSelect} DESC
        LIMIT $2
      `;
      const { rows } = await pool.query(q, [room, limit]);
      return rows.reverse();
    } catch (err) {
      if (attempt === 0 && (err.code === "42703" || err.code === "42P01")) {
        invalidateMessagesSchemaCache();
        continue;
      }
      throw err;
    }
  }
  throw new Error("getLastMessages: запрос не выполнен");
}

async function insertMessage(room, userId, text) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { timeReturning } = await getMessagesSchema();
      const q = `
        INSERT INTO messages (room, user_id, text)
        VALUES ($1, $2, $3)
        RETURNING id, ${timeReturning}
      `;
      const { rows } = await pool.query(q, [room, userId, text]);
      return rows[0];
    } catch (err) {
      if (attempt === 0 && err.code === "42703") {
        invalidateMessagesSchemaCache();
        continue;
      }
      throw err;
    }
  }
  throw new Error("insertMessage: не удалось записать сообщение");
}

async function findUserByNickname(nickname) {
  const { rows } = await pool.query(
    `SELECT id, nickname, password_hash FROM users WHERE nickname = $1`,
    [nickname]
  );
  return rows[0] || null;
}

function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

async function requireAuth(req, res, next) {
  try {
    const h = req.headers.authorization;
    if (!h || !h.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Требуется вход" });
    }
    const token = h.slice(7);
    const payload = jwt.verify(token, JWT_SECRET);
    const { rows } = await pool.query(
      `SELECT id, nickname, password_hash FROM users WHERE id = $1`,
      [payload.userId]
    );
    const user = rows[0];
    if (!user?.password_hash) {
      return res.status(401).json({ error: "Требуется вход" });
    }
    req.user = { userId: user.id, nickname: user.nickname };
    next();
  } catch {
    return res.status(401).json({ error: "Сессия устарела, войдите снова" });
  }
}

/** Пароль закрытой комнаты: заголовок X-Room-Password или query roomPassword */
function getRoomPasswordFromRequest(req) {
  const h = req.headers["x-room-password"];
  if (h != null && h !== "") return String(h);
  const q = req.query?.roomPassword;
  if (q != null && q !== "") return String(q);
  return "";
}

// --- REST ---

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/rooms", (_req, res) => {
  const rooms = Object.entries(GROUP_ROOMS).map(([slug, c]) => ({
    slug,
    title: c.title,
    requiresPassword: c.roomPassword != null,
  }));
  res.json({ rooms });
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const ip = req.ip || "unknown";
    if (!checkRegRateLimit(ip)) {
      return res.status(429).json({ error: "Слишком много попыток регистрации" });
    }

    const name = sanitizeNickname(req.body?.name ?? req.body?.nickname);
    const password = sanitizePassword(req.body?.password);
    if (!name) {
      return res.status(400).json({ error: "Некорректное имя (буквы, цифры, до 64 символов)" });
    }
    if (!password) {
      return res.status(400).json({
        error: `Пароль: от ${MIN_PASSWORD_LEN} до ${MAX_PASSWORD_LEN} символов`,
      });
    }

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const { rows } = await pool.query(
      `INSERT INTO users (nickname, password_hash, online) VALUES ($1, $2, FALSE) RETURNING id, nickname`,
      [name, hash]
    );
    const user = rows[0];
    const token = signToken(user.id);
    res.status(201).json({ token, user: { id: user.id, nickname: user.nickname } });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Такое имя уже занято" });
    }
    if (err.code === "42703") {
      return res.status(500).json({
        error:
          "В таблице users нет колонки password_hash. Выполните миграцию: migrations/002_users_password_hash.sql",
      });
    }
    console.error("POST /api/auth/register", err);
    res.status(500).json({
      error: "Не удалось зарегистрироваться. Проверьте лог сервера и подключение к БД.",
    });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const name = sanitizeNickname(req.body?.name ?? req.body?.nickname);
    const password = String(req.body?.password ?? "");
    if (!name || !password) {
      return res.status(400).json({ error: "Укажите имя и пароль" });
    }

    const user = await findUserByNickname(name);
    if (!user?.password_hash) {
      return res.status(401).json({ error: "Неверное имя или пароль" });
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: "Неверное имя или пароль" });
    }

    const token = signToken(user.id);
    res.json({ token, user: { id: user.id, nickname: user.nickname } });
  } catch (err) {
    console.error("POST /api/auth/login", err);
    res.status(500).json({ error: "Ошибка входа" });
  }
});

app.get("/api/messages/:roomSlug", requireAuth, async (req, res) => {
  try {
    const slug = normalizeRoomSlug(req.params.roomSlug);
    if (!slug) {
      return res.status(404).json({ error: "Комната не найдена" });
    }
    const rp = getRoomPasswordFromRequest(req);
    if (!roomAllowsAccess(slug, rp)) {
      return res.status(403).json({ error: "Нужен пароль комнаты" });
    }
    const messages = await getLastMessages(slug, 50);
    res.json({ room: slug, title: GROUP_ROOMS[slug].title, messages });
  } catch (err) {
    console.error("GET /api/messages/:roomSlug", err?.message || err, err?.code || "");
    if (err.code === "SCHEMA_MESSAGES" || err.code === "SCHEMA_MESSAGES_TIME") {
      return res.status(500).json({ error: err.message });
    }
    res.status(500).json({
      error: err.message || "Не удалось загрузить сообщения",
    });
  }
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: corsOrigin,
    credentials: true,
  },
  transports: ["websocket", "polling"],
});

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token || typeof token !== "string") {
      return next(new Error("Требуется вход"));
    }
    const payload = jwt.verify(token, JWT_SECRET);
    const { rows } = await pool.query(
      `SELECT id, nickname, password_hash FROM users WHERE id = $1`,
      [payload.userId]
    );
    const user = rows[0];
    if (!user?.password_hash) {
      return next(new Error("Пользователь не найден"));
    }
    socket.data.userId = user.id;
    socket.data.nickname = user.nickname;
    next();
  } catch {
    next(new Error("Недействительный токен"));
  }
});

app.post("/api/messages", requireAuth, async (req, res) => {
  try {
    const slug = normalizeRoomSlug(req.body?.room);
    if (!slug) {
      return res.status(400).json({ error: "Неизвестная комната" });
    }
    const rp = getRoomPasswordFromRequest(req);
    if (!roomAllowsAccess(slug, rp)) {
      return res.status(403).json({ error: "Нужен пароль комнаты" });
    }
    const body = sanitizeText(req.body?.text);
    if (!body) {
      return res.status(400).json({ error: "Пустое сообщение" });
    }

    const userId = req.user.userId;
    if (!checkRateLimit(userId)) {
      return res.status(429).json({ error: "Слишком много сообщений в минуту" });
    }

    const row = await insertMessage(slug, userId, body);
    const payload = {
      room: slug,
      user_nick: req.user.nickname,
      text: body,
      time: row.created_at,
    };
    io.to(slug).emit("message", payload);
    res.status(201).json({ ok: true, message: payload });
  } catch (err) {
    console.error("POST /api/messages", err);
    res.status(500).json({ error: "Не удалось сохранить сообщение" });
  }
});

if (process.env.NODE_ENV === "production") {
  const staticDir = path.join(__dirname, "..", "client", "dist");
  app.use(express.static(staticDir));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(staticDir, "index.html"));
  });
}

async function processJoinRoom(socket, payload, ack) {
  try {
    const slug = normalizeRoomSlug(payload?.room);
    if (!slug) {
      const e = { ok: false, error: "Неизвестная комната" };
      if (typeof ack === "function") ack(e);
      socket.emit("error-toast", e);
      return;
    }
    if (!roomAllowsAccess(slug, payload?.roomPassword)) {
      const e = { ok: false, error: "Неверный пароль комнаты" };
      if (typeof ack === "function") ack(e);
      socket.emit("error-toast", e);
      return;
    }

    const prev = socket.data.currentRoom;
    if (prev && prev !== slug) {
      await socket.leave(prev);
    }
    socket.data.currentRoom = slug;
    await socket.join(slug);

    if (!socket.data.appOnlineSet) {
      try {
        await pool.query("UPDATE users SET online = TRUE WHERE id = $1", [socket.data.userId]);
      } catch (updErr) {
        if (updErr.code !== "42703") {
          throw updErr;
        }
        console.warn("join-room: колонка users.online отсутствует, пропускаем presence");
      }
      socket.data.appOnlineSet = true;
      incPresence(socket.data.userId);
    }

    const history = await getLastMessages(slug, 50);
    socket.emit("room-changed", { room: slug });
    socket.emit("history", { room: slug, messages: history });
    if (typeof ack === "function") {
      ack({ ok: true, room: slug });
    }
  } catch (err) {
    console.error("join-room", err?.message || err, err?.code || "");
    const e = { ok: false, error: "Ошибка входа в комнату" };
    if (typeof ack === "function") ack(e);
    socket.emit("error-toast", e);
  }
}

io.on("connection", (socket) => {
  /** Несколько join-room подряд без await дают параллельные async-обработчики — гонка и падения в БД/socket */
  socket.on("join-room", (payload, ack) => {
    socket.data._joinQueue = (socket.data._joinQueue || Promise.resolve())
      .catch(() => {})
      .then(() => processJoinRoom(socket, payload, ack));
  });

  socket.on("message", async (payload, ack) => {
    try {
      const uid = socket.data.userId;
      const slug = socket.data.currentRoom;
      if (!uid) {
        const e = { ok: false, error: "Нет авторизации" };
        if (typeof ack === "function") ack(e);
        return;
      }
      if (!slug) {
        const e = { ok: false, error: "Выберите комнату" };
        if (typeof ack === "function") ack(e);
        return;
      }

      const raw = typeof payload === "string" ? payload : payload?.text ?? "";
      const body = sanitizeText(raw);
      if (!body) {
        const e = { ok: false, error: "Пустое сообщение" };
        if (typeof ack === "function") ack(e);
        return;
      }

      if (!checkRateLimit(uid)) {
        const e = { ok: false, error: "Слишком много сообщений в минуту" };
        if (typeof ack === "function") ack(e);
        return socket.emit("error-toast", e);
      }

      const row = await insertMessage(slug, uid, body);
      const out = {
        room: slug,
        user_nick: socket.data.nickname,
        text: body,
        time: row.created_at,
      };
      io.to(slug).emit("message", out);
      if (typeof ack === "function") ack({ ok: true });
    } catch (err) {
      console.error("message", err);
      const e = { ok: false, error: "Не удалось отправить сообщение" };
      if (typeof ack === "function") ack(e);
    }
  });

  socket.on("leave", async () => {
    try {
      const uid = socket.data.userId;
      const prev = socket.data.currentRoom;
      if (prev) {
        await socket.leave(prev);
      }
      socket.data.currentRoom = undefined;
      if (!uid) return;
      if (decPresence(uid)) {
        await setUserOffline(uid);
      }
      socket.data.userId = undefined;
      socket.data.nickname = undefined;
      socket.data.appOnlineSet = false;
    } catch (err) {
      console.error("leave", err);
    }
  });

  socket.on("disconnect", async () => {
    try {
      const uid = socket.data.userId;
      if (!uid) return;
      if (decPresence(uid)) {
        await setUserOffline(uid);
      }
    } catch (err) {
      console.error("disconnect", err);
    }
  });
});

async function start() {
  await ensureMessagesUserIdSchema();
  server.listen(PORT, () => {
    console.log(`Сервер: http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Не удалось запустить сервер:", err);
  process.exit(1);
});
