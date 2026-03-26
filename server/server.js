/**
 * TatarChat: Express + Socket.io + PostgreSQL.
 * Вход: регистрация (имя + пароль), JWT. Сокет только с валидным токеном.
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
const ROOM_FAMILY = "family";
const MAX_MESSAGE_LEN = 2000;
const MAX_NICK_LEN = 64;
const MIN_PASSWORD_LEN = 6;
const MAX_PASSWORD_LEN = 128;
const MESSAGES_PER_MINUTE = 30;
const BCRYPT_ROUNDS = 10;
const JWT_EXPIRES = "7d";

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

async function getLastMessages(room, limit = 50) {
  const q = `
    SELECT
      m.id,
      m.room,
      m.text,
      m.created_at AS time,
      u.nickname AS user_nick
    FROM messages m
    JOIN users u ON u.id = m.user_id
    WHERE m.room = $1
    ORDER BY m.created_at DESC
    LIMIT $2
  `;
  const { rows } = await pool.query(q, [room, limit]);
  return rows.reverse();
}

async function insertMessage(room, userId, text) {
  const q = `
    INSERT INTO messages (room, user_id, text)
    VALUES ($1, $2, $3)
    RETURNING id, created_at
  `;
  const { rows } = await pool.query(q, [room, userId, text]);
  return rows[0];
}

async function getOnlineUsers() {
  const { rows } = await pool.query(
    `SELECT id, nickname FROM users WHERE online = TRUE ORDER BY nickname ASC`
  );
  return rows;
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

// --- REST ---

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
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
    console.error("POST /api/auth/register", err);
    res.status(500).json({ error: "Не удалось зарегистрироваться" });
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

app.get("/api/messages/family", async (_req, res) => {
  try {
    const messages = await getLastMessages(ROOM_FAMILY, 50);
    res.json({ room: ROOM_FAMILY, messages });
  } catch (err) {
    console.error("GET /api/messages/family", err);
    res.status(500).json({ error: "Не удалось загрузить сообщения" });
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

async function joinFamilyRoom(socket) {
  const userId = socket.data.userId;
  const nickname = socket.data.nickname;
  if (!userId) return;

  if (socket.data.joinedFamily) {
    const history = await getLastMessages(ROOM_FAMILY, 50);
    const online = await getOnlineUsers();
    socket.emit("history", history);
    socket.emit("online-users", online);
    return;
  }

  await pool.query("UPDATE users SET online = TRUE WHERE id = $1", [userId]);
  incPresence(userId);
  socket.data.joinedFamily = true;
  await socket.join(ROOM_FAMILY);

  const history = await getLastMessages(ROOM_FAMILY, 50);
  const online = await getOnlineUsers();
  io.to(ROOM_FAMILY).emit("online-users", online);
  socket.emit("history", history);
  socket.emit("online-users", online);
}

app.post("/api/messages", requireAuth, async (req, res) => {
  try {
    const { room = ROOM_FAMILY, text } = req.body || {};
    if (room !== ROOM_FAMILY) {
      return res.status(400).json({ error: "Неподдерживаемая комната" });
    }
    const body = sanitizeText(text);
    if (!body) {
      return res.status(400).json({ error: "Пустое сообщение" });
    }

    const userId = req.user.userId;
    if (!checkRateLimit(userId)) {
      return res.status(429).json({ error: "Слишком много сообщений в минуту" });
    }

    const row = await insertMessage(ROOM_FAMILY, userId, body);
    const payload = {
      user_nick: req.user.nickname,
      text: body,
      time: row.created_at,
    };
    io.to(ROOM_FAMILY).emit("message", payload);
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

io.on("connection", async (socket) => {
  try {
    await joinFamilyRoom(socket);
  } catch (err) {
    console.error("socket join", err);
    socket.emit("error-toast", { error: "Не удалось войти в комнату" });
    socket.disconnect(true);
    return;
  }

  socket.on("message", async (payload, ack) => {
    try {
      const uid = socket.data.userId;
      if (!uid) {
        const e = { ok: false, error: "Нет авторизации" };
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

      const row = await insertMessage(ROOM_FAMILY, uid, body);
      const out = {
        user_nick: socket.data.nickname,
        text: body,
        time: row.created_at,
      };
      io.to(ROOM_FAMILY).emit("message", out);
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
      if (!uid) return;
      if (decPresence(uid)) {
        await setUserOffline(uid);
      }
      socket.data.userId = undefined;
      socket.data.nickname = undefined;
      socket.data.joinedFamily = false;
      await socket.leave(ROOM_FAMILY);
      const online = await getOnlineUsers();
      io.to(ROOM_FAMILY).emit("online-users", online);
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
      const online = await getOnlineUsers();
      io.to(ROOM_FAMILY).emit("online-users", online);
    } catch (err) {
      console.error("disconnect", err);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Сервер: http://localhost:${PORT}`);
});
