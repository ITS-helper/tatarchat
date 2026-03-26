/**
 * TatarChat: Express + Socket.io + PostgreSQL.
 * Порт по умолчанию 3001.
 */
require("dotenv").config();
const http = require("http");
const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { Pool } = require("pg");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT) || 3001;
const ROOM_FAMILY = "family";
const MAX_MESSAGE_LEN = 2000;
const MAX_NICK_LEN = 64;
const MESSAGES_PER_MINUTE = 30;

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://postgres:password@localhost:5432/tatarchat";

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 20,
});

/** Разрешённые origins: localhost, Render (*.onrender.com), плюс CLIENT_ORIGIN через env */
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

/** Убираем опасные символы из текста сообщения */
function sanitizeText(input) {
  const s = String(input ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/<[^>]*>/g, "")
    .slice(0, MAX_MESSAGE_LEN)
    .trim();
  return s;
}

/** Ник: буквы/цифры/пробелы/дефис/подчёркивание */
function sanitizeNickname(input) {
  const raw = String(input ?? "").trim().slice(0, MAX_NICK_LEN);
  if (!raw) return "";
  if (!/^[\p{L}\p{N}\s._-]+$/u.test(raw)) return "";
  return raw;
}

/**
 * Сколько активных сокетов на пользователя (несколько вкладок).
 * В БД online=false только когда счётчик обнуляется.
 */
const presenceByUserId = new Map();
function incPresence(userId) {
  presenceByUserId.set(userId, (presenceByUserId.get(userId) || 0) + 1);
}
/** @returns {boolean} true — последний сокет, нужно выставить offline в БД */
function decPresence(userId) {
  const next = (presenceByUserId.get(userId) || 0) - 1;
  if (next <= 0) {
    presenceByUserId.delete(userId);
    return true;
  }
  presenceByUserId.set(userId, next);
  return false;
}

/** Простой in-memory rate limit по userId */
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

async function upsertUserOnline(nickname) {
  const q = `
    INSERT INTO users (nickname, online)
    VALUES ($1, TRUE)
    ON CONFLICT (nickname) DO UPDATE SET online = TRUE
    RETURNING id, nickname, created_at
  `;
  const { rows } = await pool.query(q, [nickname]);
  return rows[0];
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
    `SELECT id, nickname FROM users WHERE nickname = $1`,
    [nickname]
  );
  return rows[0] || null;
}

// --- REST ---

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
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

app.post("/api/messages", async (req, res) => {
  try {
    const { room = ROOM_FAMILY, text, nickname } = req.body || {};
    if (room !== ROOM_FAMILY) {
      return res.status(400).json({ error: "Неподдерживаемая комната" });
    }
    const nick = sanitizeNickname(nickname);
    if (!nick) {
      return res.status(400).json({ error: "Некорректный nickname" });
    }
    const body = sanitizeText(text);
    if (!body) {
      return res.status(400).json({ error: "Пустое сообщение" });
    }

    let user = await findUserByNickname(nick);
    if (!user) {
      user = await upsertUserOnline(nick);
    }
    if (!checkRateLimit(user.id)) {
      return res.status(429).json({ error: "Слишком много сообщений в минуту" });
    }

    const row = await insertMessage(ROOM_FAMILY, user.id, body);
    const payload = {
      user_nick: user.nickname,
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

// Статика: production — client/dist рядом с server (../client/dist)
if (process.env.NODE_ENV === "production") {
  const staticDir = path.join(__dirname, "..", "client", "dist");
  app.use(express.static(staticDir));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(staticDir, "index.html"));
  });
}

io.on("connection", (socket) => {
  socket.on("join-family", async (payload, ack) => {
    try {
      const nick = sanitizeNickname(
        typeof payload === "string" ? payload : payload?.nickname
      );
      if (!nick) {
        const err = { ok: false, error: "Укажите корректный ник" };
        if (typeof ack === "function") ack(err);
        return socket.emit("error-toast", err);
      }

      /** Повторный join на том же сокете — не увеличиваем presence */
      if (socket.data.userId) {
        const history = await getLastMessages(ROOM_FAMILY, 50);
        const online = await getOnlineUsers();
        socket.emit("history", history);
        socket.emit("online-users", online);
        if (typeof ack === "function") {
          ack({
            ok: true,
            userId: socket.data.userId,
            nickname: socket.data.nickname,
            history,
            online,
          });
        }
        return;
      }

      const user = await upsertUserOnline(nick);
      socket.data.userId = user.id;
      socket.data.nickname = user.nickname;
      incPresence(user.id);
      await socket.join(ROOM_FAMILY);

      const history = await getLastMessages(ROOM_FAMILY, 50);
      const online = await getOnlineUsers();

      io.to(ROOM_FAMILY).emit("online-users", online);

      const ok = {
        ok: true,
        userId: user.id,
        nickname: user.nickname,
        history,
        online,
      };
      socket.emit("history", history);
      socket.emit("online-users", online);
      if (typeof ack === "function") ack(ok);
    } catch (err) {
      console.error("join-family", err);
      const e = { ok: false, error: "Ошибка входа в комнату" };
      if (typeof ack === "function") ack(e);
      socket.emit("error-toast", e);
    }
  });

  socket.on("message", async (payload, ack) => {
    try {
      const uid = socket.data.userId;
      if (!uid) {
        const e = { ok: false, error: "Сначала войдите в комнату (join-family)" };
        if (typeof ack === "function") ack(e);
        return;
      }

      const raw =
        typeof payload === "string" ? payload : payload?.text ?? "";
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
