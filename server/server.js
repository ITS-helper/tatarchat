/**
 * TatarChat: Express + Socket.io + PostgreSQL.
 * Вход по аккаунту (JWT). Комната DTD с паролем.
 */
require("dotenv").config();
const fs = require("fs");
const fsp = require("fs/promises");
const crypto = require("crypto");
const http = require("http");
const path = require("path");
const express = require("express");
const multer = require("multer");
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
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB || 16) * 1024 * 1024;
const UPLOAD_ROOT = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, "data", "uploads"));
const STAGING_DIR = path.join(UPLOAD_ROOT, "staging");
const ALLOWED_UPLOAD_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/webm",
  "video/mp4",
  "application/pdf",
  "text/plain",
]);
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
/** Короткие видеосообщения («кружки»), на клиенте в квадрате */
const VIDEO_NOTE_MIMES = new Set(["video/webm", "video/mp4"]);

/** Браузеры шлют multipart с codecs: "video/webm;codecs=vp8,opus" — без нормализации multer отклоняет. */
function normalizeContentTypeMime(m) {
  const s = String(m || "").trim().toLowerCase();
  const i = s.indexOf(";");
  return (i === -1 ? s : s.slice(0, i)).trim();
}

/** slug → отображаемое имя и пароль комнаты (null = без пароля) */
const GROUP_ROOMS = {
  dreamteamdauns: {
    title: "DTD",
    roomPassword: process.env.DTD_ROOM_PASSWORD || "1488",
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
    allowedHeaders: ["Content-Type", "Authorization", "X-Room-Password", "X-Video-Note"],
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

function normalizeMessageText(input) {
  return String(input ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/<[^>]*>/g, "")
    .slice(0, MAX_MESSAGE_LEN)
    .trim();
}

function sanitizeOriginalName(name) {
  const s = path
    .basename(String(name || "file"))
    .replace(/[\u0000-\u001F<>:"/\\|?*]/g, "_")
    .slice(0, 200);
  return s || "file";
}

function pickSafeExt(file) {
  const fromName = path.extname(file.originalname || "");
  if (/^\.[a-zA-Z0-9]{1,8}$/.test(fromName)) return fromName.toLowerCase();
  const map = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/webm": ".webm",
    "video/mp4": ".mp4",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
  };
  const mime = normalizeContentTypeMime(file.mimetype || "");
  return map[mime] || ".bin";
}

function isVideoNoteFlag(body) {
  const v = body?.videoNote ?? body?.video_note;
  if (v == null || v === "") return false;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

/** Тело multipart иногда без videoNote до конца парсинга — дублируем заголовком (доступен с первого байта запроса). */
function isVideoNoteHeader(req) {
  const h = req.headers["x-video-note"];
  return h === "1" || String(h || "").trim().toLowerCase() === "true";
}

function isVideoNoteRequest(req) {
  return isVideoNoteFlag(req.body) || isVideoNoteHeader(req);
}

function escapeLikePattern(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
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

/** Публичный slug [a-z0-9_] или личка dm-<меньшийId>-<большийId> */
function canonicalizeChannelSlug(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const dm = raw.match(/^dm-(\d+)-(\d+)$/i);
  if (dm) {
    let a = parseInt(dm[1], 10);
    let b = parseInt(dm[2], 10);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1 || a === b) return null;
    if (a > b) [a, b] = [b, a];
    return `dm-${a}-${b}`;
  }
  const s = raw.toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (!s || s.length > 64) return null;
  return s;
}

async function ensureDmChannelRow(slug, low, high) {
  await pool.query(
    `INSERT INTO channels (slug, title, kind, user_low_id, user_high_id)
     VALUES ($1, '', 'direct', $2, $3)
     ON CONFLICT (slug) DO NOTHING`,
    [slug, low, high]
  );
}

async function userCanAccessChannel(slug, userId, roomPassword) {
  if (!slug || userId == null) return false;
  if (slug.startsWith("dm-")) {
    const m = /^dm-(\d+)-(\d+)$/.exec(slug);
    if (!m) return false;
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (userId !== a && userId !== b) return false;
    await ensureDmChannelRow(slug, a, b);
    return true;
  }
  const conf = GROUP_ROOMS[slug];
  if (conf) {
    if (conf.roomPassword == null) return true;
    return conf.roomPassword === String(roomPassword ?? "");
  }
  const { rows } = await pool.query(`SELECT 1 FROM channels WHERE slug = $1 AND kind = 'public'`, [slug]);
  return rows.length > 0;
}

async function getChannelTitleForUser(slug, viewerUserId) {
  const conf = GROUP_ROOMS[slug];
  if (conf) return conf.title;
  if (slug.startsWith("dm-")) {
    const m = /^dm-(\d+)-(\d+)$/.exec(slug);
    if (!m) return "ЛС";
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    const peerId = viewerUserId === a ? b : viewerUserId === b ? a : null;
    if (peerId == null) return "ЛС";
    const { rows } = await pool.query(`SELECT nickname FROM users WHERE id = $1`, [peerId]);
    const nick = rows[0]?.nickname;
    return nick ? `ЛС: ${nick}` : "ЛС";
  }
  const { rows } = await pool.query(`SELECT title FROM channels WHERE slug = $1 AND kind = 'public'`, [slug]);
  if (rows[0]?.title) return rows[0].title;
  return slug;
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

async function ensurePhase1Schema() {
  try {
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id INTEGER`);
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = 'public' AND table_name = 'messages' AND constraint_name = 'messages_reply_to_id_fkey'
        ) THEN
          ALTER TABLE messages
            ADD CONSTRAINT messages_reply_to_id_fkey
            FOREIGN KEY (reply_to_id) REFERENCES messages (id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS message_reactions (
        message_id INTEGER NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        emoji VARCHAR(32) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (message_id, user_id)
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_message_reactions_message_id ON message_reactions (message_id)`
    );
  } catch (err) {
    console.error("[schema] phase1:", err?.message || err);
    throw err;
  }
}

async function ensurePhase2Schema() {
  try {
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_kind VARCHAR(16)`);
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_name VARCHAR(255)`);
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_mime VARCHAR(127)`);
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_size BIGINT`);
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_storage_key VARCHAR(512)`);
  } catch (err) {
    console.error("[schema] phase2:", err?.message || err);
    throw err;
  }
}

async function ensurePhase3Schema() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS channels (
        id SERIAL PRIMARY KEY,
        slug VARCHAR(64) NOT NULL UNIQUE,
        title VARCHAR(128) NOT NULL DEFAULT '',
        kind VARCHAR(16) NOT NULL CHECK (kind IN ('public', 'direct')),
        user_low_id INTEGER REFERENCES users (id) ON DELETE CASCADE,
        user_high_id INTEGER REFERENCES users (id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (
          (kind = 'public' AND user_low_id IS NULL AND user_high_id IS NULL)
          OR (kind = 'direct' AND user_low_id IS NOT NULL AND user_high_id IS NOT NULL AND user_low_id < user_high_id)
        )
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_channels_dm_users ON channels (user_low_id, user_high_id) WHERE kind = 'direct'`
    );
    for (const [slug, conf] of Object.entries(GROUP_ROOMS)) {
      await pool.query(
        `INSERT INTO channels (slug, title, kind) VALUES ($1, $2, 'public')
         ON CONFLICT (slug) DO NOTHING`,
        [slug, conf.title]
      );
    }
    await pool.query(`
      INSERT INTO channels (slug, title, kind)
      SELECT 'lobby', 'Лобби', 'public'
      WHERE NOT EXISTS (SELECT 1 FROM channels WHERE slug = 'lobby')
    `);
  } catch (err) {
    console.error("[schema] phase3:", err?.message || err);
    throw err;
  }
}

function ensureUploadDirs() {
  fs.mkdirSync(STAGING_DIR, { recursive: true });
  fs.mkdirSync(path.join(UPLOAD_ROOT, "rooms"), { recursive: true });
}

const upload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) {
      cb(null, STAGING_DIR);
    },
    filename(req, file, cb) {
      const ext = path.extname(file.originalname || "") || "";
      cb(null, `${req.user.userId}_${Date.now()}_${crypto.randomBytes(8).toString("hex")}${ext}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter(req, file, cb) {
    const mime = normalizeContentTypeMime(file.mimetype || "");
    if (ALLOWED_UPLOAD_MIMES.has(mime)) return cb(null, true);
    const name = String(file.originalname || "").toLowerCase();
    if (
      isVideoNoteHeader(req) &&
      /^videonote\.(webm|mp4)$/.test(name) &&
      (mime === "application/octet-stream" || mime === "")
    ) {
      return cb(null, true);
    }
    cb(new Error("UNSUPPORTED_MIME"));
  },
});

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

function sanitizeEmoji(input) {
  const s = String(input ?? "").trim().slice(0, 32);
  if (!s || /[\u0000-\u001F<>'"&]/.test(s)) return "";
  return s;
}

async function fetchReactionAggregates(messageIds) {
  if (!messageIds.length) return new Map();
  const { rows } = await pool.query(
    `SELECT message_id, emoji,
            array_agg(user_id ORDER BY user_id)::int[] AS user_ids,
            COUNT(*)::int AS cnt
     FROM message_reactions
     WHERE message_id = ANY($1::int[])
     GROUP BY message_id, emoji`,
    [messageIds]
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.message_id)) map.set(r.message_id, []);
    map.get(r.message_id).push({
      emoji: r.emoji,
      count: r.cnt,
      user_ids: r.user_ids || [],
    });
  }
  return map;
}

function formatApiMessage(row, reactionList) {
  const deleted = !!row.deleted_at;
  const reply =
    row.reply_to_id != null
      ? {
          id: row.reply_to_id,
          user_nick: row.reply_user_nick || "?",
          deleted: !!row.reply_deleted_at,
          preview: row.reply_deleted_at
            ? ""
            : String(row.reply_text ?? "").slice(0, 160),
        }
      : null;
  let attachment = null;
  if (row.attachment_storage_key && row.attachment_kind) {
    attachment = {
      kind: row.attachment_kind,
      name: row.attachment_name || "файл",
      mime: row.attachment_mime || "application/octet-stream",
      size: row.attachment_size != null ? Number(row.attachment_size) : null,
    };
  }
  return {
    id: row.id,
    room: row.room,
    user_id: row.user_id,
    user_nick: row.user_nick,
    text: deleted ? null : row.text,
    deleted,
    time: row.time,
    edited_at: row.edited_at || null,
    reply_to_id: row.reply_to_id || null,
    reply_to: reply,
    reactions: reactionList || [],
    attachment,
  };
}

async function getLastMessages(room, limit = 50) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { timeSelect } = await getMessagesSchema();
      const q = `
        SELECT
          m.id,
          m.room,
          m.user_id,
          m.text,
          m.reply_to_id,
          m.edited_at,
          m.deleted_at,
          m.attachment_kind,
          m.attachment_name,
          m.attachment_mime,
          m.attachment_size,
          m.attachment_storage_key,
          ${timeSelect} AS time,
          u.nickname AS user_nick,
          ru.nickname AS reply_user_nick,
          rm.text AS reply_text,
          rm.deleted_at AS reply_deleted_at
        FROM messages m
        JOIN users u ON u.id = m.user_id
        LEFT JOIN messages rm ON rm.id = m.reply_to_id
        LEFT JOIN users ru ON ru.id = rm.user_id
        WHERE m.room = $1
        ORDER BY ${timeSelect} DESC
        LIMIT $2
      `;
      const { rows } = await pool.query(q, [room, limit]);
      const ordered = rows.reverse();
      const ids = ordered.map((r) => r.id);
      const reactMap = await fetchReactionAggregates(ids);
      return ordered.map((r) => formatApiMessage(r, reactMap.get(r.id) || []));
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

async function searchMessagesInRoom(room, query, limit = 40) {
  const raw = String(query ?? "").trim().slice(0, 200);
  if (!raw) return [];
  const { timeSelect } = await getMessagesSchema();
  const pattern = `%${escapeLikePattern(raw)}%`;
  const q = `
    SELECT
      m.id,
      m.room,
      m.user_id,
      m.text,
      m.reply_to_id,
      m.edited_at,
      m.deleted_at,
      m.attachment_kind,
      m.attachment_name,
      m.attachment_mime,
      m.attachment_size,
      m.attachment_storage_key,
      ${timeSelect} AS time,
      u.nickname AS user_nick,
      ru.nickname AS reply_user_nick,
      rm.text AS reply_text,
      rm.deleted_at AS reply_deleted_at
    FROM messages m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN messages rm ON rm.id = m.reply_to_id
    LEFT JOIN users ru ON ru.id = rm.user_id
    WHERE m.room = $1 AND m.deleted_at IS NULL
      AND (m.text ILIKE $2 ESCAPE '\\' OR COALESCE(m.attachment_name, '') ILIKE $2 ESCAPE '\\')
    ORDER BY ${timeSelect} DESC
    LIMIT $3
  `;
  const { rows } = await pool.query(q, [room, pattern, limit]);
  const ids = rows.map((r) => r.id);
  const reactMap = await fetchReactionAggregates(ids);
  return rows.map((r) => formatApiMessage(r, reactMap.get(r.id) || []));
}

async function getMessageRowById(id) {
  const { timeSelect } = await getMessagesSchema();
  const q = `
    SELECT
      m.id,
      m.room,
      m.user_id,
      m.text,
      m.reply_to_id,
      m.edited_at,
      m.deleted_at,
      m.attachment_kind,
      m.attachment_name,
      m.attachment_mime,
      m.attachment_size,
      m.attachment_storage_key,
      ${timeSelect} AS time,
      u.nickname AS user_nick,
      ru.nickname AS reply_user_nick,
      rm.text AS reply_text,
      rm.deleted_at AS reply_deleted_at
    FROM messages m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN messages rm ON rm.id = m.reply_to_id
    LEFT JOIN users ru ON ru.id = rm.user_id
    WHERE m.id = $1
  `;
  const { rows } = await pool.query(q, [id]);
  return rows[0] || null;
}

async function formatMessageById(id) {
  const row = await getMessageRowById(id);
  if (!row) return null;
  const reactMap = await fetchReactionAggregates([id]);
  return formatApiMessage(row, reactMap.get(id) || []);
}

async function validateReplyInRoom(replyToId, room) {
  if (replyToId == null) return true;
  const n = Number(replyToId);
  if (!Number.isInteger(n) || n < 1) return false;
  const { rows } = await pool.query(`SELECT id FROM messages WHERE id = $1 AND room = $2`, [n, room]);
  return rows.length > 0;
}

async function insertMessage(room, userId, text, replyToId = null) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { timeReturning } = await getMessagesSchema();
      const q = `
        INSERT INTO messages (
          room, user_id, text, reply_to_id,
          attachment_kind, attachment_name, attachment_mime, attachment_size, attachment_storage_key
        )
        VALUES ($1, $2, $3, $4, NULL, NULL, NULL, NULL, NULL)
        RETURNING id, ${timeReturning}
      `;
      const { rows } = await pool.query(q, [room, userId, text, replyToId]);
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

async function unlinkAttachmentForMessage(id) {
  const { rows } = await pool.query(`SELECT attachment_storage_key FROM messages WHERE id = $1`, [id]);
  const key = rows[0]?.attachment_storage_key;
  if (!key) return;
  const full = path.join(UPLOAD_ROOT, key);
  try {
    await fsp.unlink(full);
  } catch (_) {}
}

async function saveNewMessageWithOptionalFile({ room, userId, text, replyToId, multerFile, videoNote = false }) {
  const normalizedText = normalizeMessageText(text);
  if (!normalizedText && !multerFile) {
    const e = new Error("Пустое сообщение");
    e.code = "EMPTY_MSG";
    throw e;
  }
  let attKind = null;
  let attName = null;
  let attMime = null;
  let attSize = null;
  let effectiveUploadMime = null;
  if (multerFile) {
    let fileMime = normalizeContentTypeMime(multerFile.mimetype || "");
    const lowName = String(multerFile.originalname || "").toLowerCase();
    if (
      videoNote &&
      /^videonote\.(webm|mp4)$/.test(lowName) &&
      (fileMime === "application/octet-stream" || fileMime === "")
    ) {
      fileMime = lowName.endsWith(".mp4") ? "video/mp4" : "video/webm";
    }
    if (!ALLOWED_UPLOAD_MIMES.has(fileMime)) {
      await fsp.unlink(multerFile.path).catch(() => {});
      const e = new Error("Тип файла не разрешён");
      e.code = "BAD_MIME";
      throw e;
    }
    if (IMAGE_MIMES.has(fileMime)) {
      attKind = "image";
    } else if (videoNote && VIDEO_NOTE_MIMES.has(fileMime)) {
      attKind = "video_note";
    } else {
      attKind = "file";
    }
    attName = sanitizeOriginalName(multerFile.originalname);
    attMime = fileMime;
    attSize = multerFile.size;
    effectiveUploadMime = fileMime;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { timeReturning } = await getMessagesSchema();
    const ins = `
      INSERT INTO messages (
        room, user_id, text, reply_to_id,
        attachment_kind, attachment_name, attachment_mime, attachment_size, attachment_storage_key
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL)
      RETURNING id, ${timeReturning}
    `;
    const { rows } = await client.query(ins, [
      room,
      userId,
      normalizedText,
      replyToId,
      attKind,
      attName,
      attMime,
      attSize,
    ]);
    const mid = rows[0].id;
    if (multerFile) {
      const ext = pickSafeExt({ ...multerFile, mimetype: effectiveUploadMime || multerFile.mimetype });
      const storageKey = `rooms/${room}/${mid}${ext}`;
      const dest = path.join(UPLOAD_ROOT, storageKey);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.rename(multerFile.path, dest);
      await client.query(`UPDATE messages SET attachment_storage_key = $1 WHERE id = $2`, [storageKey, mid]);
    }
    await client.query("COMMIT");
    return await formatMessageById(mid);
  } catch (err) {
    await client.query("ROLLBACK");
    if (multerFile?.path) await fsp.unlink(multerFile.path).catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function toggleReactionDb(messageId, userId, emoji) {
  const { rows: cur } = await pool.query(
    `SELECT emoji FROM message_reactions WHERE message_id = $1 AND user_id = $2`,
    [messageId, userId]
  );
  if (cur.length && cur[0].emoji === emoji) {
    await pool.query(`DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2`, [
      messageId,
      userId,
    ]);
  } else if (cur.length) {
    await pool.query(
      `UPDATE message_reactions SET emoji = $3 WHERE message_id = $1 AND user_id = $2`,
      [messageId, userId, emoji]
    );
  } else {
    await pool.query(
      `INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)`,
      [messageId, userId, emoji]
    );
  }
  const reactMap = await fetchReactionAggregates([messageId]);
  return reactMap.get(messageId) || [];
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

app.get("/api/rooms", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT slug, title FROM channels WHERE kind = 'public' ORDER BY slug`
    );
    const rooms = rows.map((r) => ({
      slug: r.slug,
      title: r.title || GROUP_ROOMS[r.slug]?.title || r.slug,
      requiresPassword: !!(GROUP_ROOMS[r.slug]?.roomPassword != null),
    }));
    res.json({ rooms });
  } catch (err) {
    console.error("GET /api/rooms", err);
    res.status(500).json({ error: "Не удалось загрузить комнаты" });
  }
});

app.get("/api/channels", requireAuth, async (req, res) => {
  try {
    const me = req.user.userId;
    const { rows: pubRows } = await pool.query(
      `SELECT slug, title FROM channels WHERE kind = 'public' ORDER BY slug`
    );
    const publicChannels = pubRows.map((r) => ({
      slug: r.slug,
      title: r.title || GROUP_ROOMS[r.slug]?.title || r.slug,
      kind: "public",
      requiresPassword: GROUP_ROOMS[r.slug]?.roomPassword != null,
    }));
    const { rows: dmRows } = await pool.query(
      `SELECT slug, user_low_id, user_high_id FROM channels WHERE kind = 'direct' AND (user_low_id = $1 OR user_high_id = $1) ORDER BY slug`,
      [me]
    );
    const directChannels = [];
    for (const r of dmRows) {
      const peerId = r.user_low_id === me ? r.user_high_id : r.user_low_id;
      const nickRows = await pool.query(`SELECT nickname FROM users WHERE id = $1`, [peerId]);
      const nick = nickRows.rows[0]?.nickname || "?";
      directChannels.push({
        slug: r.slug,
        title: `ЛС: ${nick}`,
        kind: "direct",
        peer: { id: peerId, nickname: nick },
      });
    }
    res.json({ publicChannels, directChannels });
  } catch (err) {
    console.error("GET /api/channels", err);
    res.status(500).json({ error: "Не удалось загрузить каналы" });
  }
});

app.get("/api/users/for-dm", requireAuth, async (req, res) => {
  try {
    const me = req.user.userId;
    const { rows } = await pool.query(
      `SELECT id, nickname FROM users WHERE id <> $1 ORDER BY nickname ASC LIMIT 500`,
      [me]
    );
    res.json({ users: rows });
  } catch (err) {
    console.error("GET /api/users/for-dm", err);
    res.status(500).json({ error: "Не удалось загрузить пользователей" });
  }
});

app.post("/api/channels/open-dm", requireAuth, async (req, res) => {
  try {
    const peerId = parseInt(req.body?.peerId ?? req.body?.userId, 10);
    const me = req.user.userId;
    if (!Number.isInteger(peerId) || peerId < 1 || peerId === me) {
      return res.status(400).json({ error: "Некорректный пользователь" });
    }
    const { rows: urows } = await pool.query(`SELECT id, nickname FROM users WHERE id = $1`, [peerId]);
    if (!urows[0]) {
      return res.status(404).json({ error: "Пользователь не найден" });
    }
    const low = Math.min(me, peerId);
    const high = Math.max(me, peerId);
    const slug = `dm-${low}-${high}`;
    await ensureDmChannelRow(slug, low, high);
    const peerNick = urows[0].nickname;
    res.status(201).json({
      slug,
      title: `ЛС: ${peerNick}`,
      kind: "direct",
      peer: { id: peerId, nickname: peerNick },
    });
  } catch (err) {
    console.error("POST /api/channels/open-dm", err);
    res.status(500).json({ error: "Не удалось открыть личку" });
  }
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

function handleUpload(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "Файл слишком большой" });
    }
    if (err.message === "UNSUPPORTED_MIME") {
      return res.status(400).json({ error: "Тип файла не разрешён" });
    }
    console.error("upload", err);
    return res.status(400).json({ error: "Ошибка загрузки файла" });
  });
}

app.get("/api/messages/:roomSlug/search", requireAuth, async (req, res) => {
  try {
    const slug = canonicalizeChannelSlug(req.params.roomSlug);
    if (!slug) {
      return res.status(404).json({ error: "Канал не найден" });
    }
    const rp = getRoomPasswordFromRequest(req);
    if (!(await userCanAccessChannel(slug, req.user.userId, rp))) {
      return res.status(403).json({ error: "Нет доступа к каналу" });
    }
    const q = req.query?.q;
    if (q == null || String(q).trim().length < 1) {
      return res.status(400).json({ error: "Укажите строку поиска" });
    }
    const results = await searchMessagesInRoom(slug, q, 40);
    const title = await getChannelTitleForUser(slug, req.user.userId);
    res.json({ room: slug, title, results });
  } catch (err) {
    console.error("GET search", err?.message || err, err?.code || "");
    res.status(500).json({ error: err.message || "Ошибка поиска" });
  }
});

app.get("/api/messages/:roomSlug", requireAuth, async (req, res) => {
  try {
    const slug = canonicalizeChannelSlug(req.params.roomSlug);
    if (!slug) {
      return res.status(404).json({ error: "Канал не найден" });
    }
    const rp = getRoomPasswordFromRequest(req);
    if (!(await userCanAccessChannel(slug, req.user.userId, rp))) {
      return res.status(403).json({ error: "Нет доступа к каналу" });
    }
    const messages = await getLastMessages(slug, 50);
    const title = await getChannelTitleForUser(slug, req.user.userId);
    res.json({ room: slug, title, messages });
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

app.get("/api/files/:messageId", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.messageId, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Некорректный id" });
    }
    const row = await getMessageRowById(id);
    if (!row?.attachment_storage_key) {
      return res.status(404).json({ error: "Нет вложения" });
    }
    const rp = getRoomPasswordFromRequest(req);
    if (!(await userCanAccessChannel(row.room, req.user.userId, rp))) {
      return res.status(403).json({ error: "Нет доступа к каналу" });
    }
    const full = path.join(UPLOAD_ROOT, row.attachment_storage_key);
    if (!fs.existsSync(full)) {
      return res.status(404).json({ error: "Файл не найден" });
    }
    res.setHeader("Content-Type", row.attachment_mime || "application/octet-stream");
    const disp =
      IMAGE_MIMES.has(row.attachment_mime) || VIDEO_NOTE_MIMES.has(row.attachment_mime)
        ? "inline"
        : "attachment";
    res.setHeader(
      "Content-Disposition",
      `${disp}; filename*=UTF-8''${encodeURIComponent(row.attachment_name || "file")}`
    );
    res.sendFile(full);
  } catch (err) {
    console.error("GET /api/files/:messageId", err);
    res.status(500).json({ error: "Не удалось отдать файл" });
  }
});

app.post("/api/messages/send-with-file", requireAuth, handleUpload, async (req, res) => {
  try {
    const slug = canonicalizeChannelSlug(req.body?.room);
    if (!slug) {
      return res.status(400).json({ error: "Неизвестный канал" });
    }
    const rp = getRoomPasswordFromRequest(req);
    if (!(await userCanAccessChannel(slug, req.user.userId, rp))) {
      return res.status(403).json({ error: "Нет доступа к каналу" });
    }
    const normalizedText = normalizeMessageText(req.body?.text);
    if (!normalizedText && !req.file) {
      return res.status(400).json({ error: "Нужен текст или файл" });
    }

    const rawReply = req.body?.replyToId ?? req.body?.reply_to_id;
    let replyToId = null;
    if (rawReply != null && rawReply !== "") {
      replyToId = parseInt(rawReply, 10);
      if (!Number.isInteger(replyToId)) {
        return res.status(400).json({ error: "Некорректный ответ" });
      }
      if (!(await validateReplyInRoom(replyToId, slug))) {
        return res.status(400).json({ error: "Сообщение для ответа не найдено в этой комнате" });
      }
    }

    const userId = req.user.userId;
    if (!checkRateLimit(userId)) {
      return res.status(429).json({ error: "Слишком много сообщений в минуту" });
    }

    const formatted = await saveNewMessageWithOptionalFile({
      room: slug,
      userId,
      text: req.body?.text,
      replyToId,
      multerFile: req.file || null,
      videoNote: isVideoNoteRequest(req),
    });
    io.to(slug).emit("message", formatted);
    res.status(201).json({ ok: true, message: formatted });
  } catch (err) {
    if (err.code === "EMPTY_MSG" || err.code === "BAD_MIME") {
      return res.status(400).json({ error: err.message });
    }
    console.error("POST send-with-file", err);
    res.status(500).json({ error: "Не удалось сохранить сообщение" });
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
    const slug = canonicalizeChannelSlug(req.body?.room);
    if (!slug) {
      return res.status(400).json({ error: "Неизвестный канал" });
    }
    const rp = getRoomPasswordFromRequest(req);
    if (!(await userCanAccessChannel(slug, req.user.userId, rp))) {
      return res.status(403).json({ error: "Нет доступа к каналу" });
    }
    const body = sanitizeText(req.body?.text);
    if (!body) {
      return res.status(400).json({ error: "Пустое сообщение" });
    }

    const rawReply = req.body?.replyToId ?? req.body?.reply_to_id;
    let replyToId = null;
    if (rawReply != null && rawReply !== "") {
      replyToId = parseInt(rawReply, 10);
      if (!Number.isInteger(replyToId)) {
        return res.status(400).json({ error: "Некорректный ответ" });
      }
      if (!(await validateReplyInRoom(replyToId, slug))) {
        return res.status(400).json({ error: "Сообщение для ответа не найдено в этой комнате" });
      }
    }

    const userId = req.user.userId;
    if (!checkRateLimit(userId)) {
      return res.status(429).json({ error: "Слишком много сообщений в минуту" });
    }

    const row = await insertMessage(slug, userId, body, replyToId);
    const formatted = await formatMessageById(row.id);
    if (formatted) {
      io.to(slug).emit("message", formatted);
    }
    res.status(201).json({ ok: true, message: formatted });
  } catch (err) {
    console.error("POST /api/messages", err);
    res.status(500).json({ error: "Не удалось сохранить сообщение" });
  }
});

app.patch("/api/messages/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Некорректный id" });
    }
    const body = sanitizeText(req.body?.text);
    if (!body) {
      return res.status(400).json({ error: "Пустой текст" });
    }
    const rp = getRoomPasswordFromRequest(req);
    const { rows } = await pool.query(
      `SELECT id, room FROM messages WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [id, req.user.userId]
    );
    if (!rows[0]) {
      return res.status(404).json({ error: "Сообщение не найдено" });
    }
    const slug = rows[0].room;
    if (!(await userCanAccessChannel(slug, req.user.userId, rp))) {
      return res.status(403).json({ error: "Нет доступа к каналу" });
    }
    await pool.query(`UPDATE messages SET text = $1, edited_at = NOW() WHERE id = $2`, [body, id]);
    const formatted = await formatMessageById(id);
    io.to(slug).emit("message-edited", formatted);
    res.json({ ok: true, message: formatted });
  } catch (err) {
    console.error("PATCH /api/messages/:id", err);
    res.status(500).json({ error: "Не удалось изменить сообщение" });
  }
});

app.delete("/api/messages/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Некорректный id" });
    }
    const rp = getRoomPasswordFromRequest(req);
    const { rows } = await pool.query(
      `SELECT id, room FROM messages WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [id, req.user.userId]
    );
    if (!rows[0]) {
      return res.status(404).json({ error: "Сообщение не найдено" });
    }
    const slug = rows[0].room;
    if (!(await userCanAccessChannel(slug, req.user.userId, rp))) {
      return res.status(403).json({ error: "Нет доступа к каналу" });
    }
    await unlinkAttachmentForMessage(id);
    await pool.query(`UPDATE messages SET deleted_at = NOW(), text = '' WHERE id = $1`, [id]);
    const formatted = await formatMessageById(id);
    io.to(slug).emit("message-deleted", { id, room: slug, message: formatted });
    res.json({ ok: true, message: formatted });
  } catch (err) {
    console.error("DELETE /api/messages/:id", err);
    res.status(500).json({ error: "Не удалось удалить сообщение" });
  }
});

app.post("/api/messages/:id/reaction", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Некорректный id" });
    }
    const emoji = sanitizeEmoji(req.body?.emoji);
    if (!emoji) {
      return res.status(400).json({ error: "Некорректная реакция" });
    }
    const rp = getRoomPasswordFromRequest(req);
    const { rows } = await pool.query(`SELECT id, room FROM messages WHERE id = $1`, [id]);
    if (!rows[0]) {
      return res.status(404).json({ error: "Сообщение не найдено" });
    }
    const slug = rows[0].room;
    if (!(await userCanAccessChannel(slug, req.user.userId, rp))) {
      return res.status(403).json({ error: "Нет доступа к каналу" });
    }
    const reactions = await toggleReactionDb(id, req.user.userId, emoji);
    io.to(slug).emit("message-reactions", { id, room: slug, reactions });
    res.json({ ok: true, reactions });
  } catch (err) {
    console.error("POST /api/messages/:id/reaction", err);
    res.status(500).json({ error: "Не удалось сохранить реакцию" });
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
    const slug = canonicalizeChannelSlug(payload?.room);
    if (!slug) {
      const e = { ok: false, error: "Неизвестный канал" };
      if (typeof ack === "function") ack(e);
      socket.emit("error-toast", e);
      return;
    }
    const uid = socket.data.userId;
    if (!(await userCanAccessChannel(slug, uid, payload?.roomPassword))) {
      const e = { ok: false, error: "Нет доступа к каналу" };
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
    const title = await getChannelTitleForUser(slug, uid);
    socket.emit("room-changed", { room: slug, title });
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

      let replyToId = null;
      if (payload && typeof payload === "object" && payload.replyToId != null && payload.replyToId !== "") {
        replyToId = parseInt(payload.replyToId, 10);
        if (!Number.isInteger(replyToId)) {
          const e = { ok: false, error: "Некорректный ответ" };
          if (typeof ack === "function") ack(e);
          return;
        }
        if (!(await validateReplyInRoom(replyToId, slug))) {
          const e = { ok: false, error: "Сообщение для ответа не найдено" };
          if (typeof ack === "function") ack(e);
          return;
        }
      }

      if (!checkRateLimit(uid)) {
        const e = { ok: false, error: "Слишком много сообщений в минуту" };
        if (typeof ack === "function") ack(e);
        return socket.emit("error-toast", e);
      }

      const row = await insertMessage(slug, uid, body, replyToId);
      const formatted = await formatMessageById(row.id);
      if (formatted) {
        io.to(slug).emit("message", formatted);
      }
      if (typeof ack === "function") ack({ ok: true });
    } catch (err) {
      console.error("message", err);
      const e = { ok: false, error: "Не удалось отправить сообщение" };
      if (typeof ack === "function") ack(e);
    }
  });

  socket.on("edit-message", async (payload, ack) => {
    try {
      const uid = socket.data.userId;
      const slug = socket.data.currentRoom;
      if (!uid || !slug) {
        const e = { ok: false, error: "Нет контекста" };
        if (typeof ack === "function") ack(e);
        return;
      }
      const id = parseInt(payload?.id, 10);
      if (!Number.isInteger(id)) {
        const e = { ok: false, error: "Некорректный id" };
        if (typeof ack === "function") ack(e);
        return;
      }
      const body = sanitizeText(payload?.text);
      if (!body) {
        const e = { ok: false, error: "Пустой текст" };
        if (typeof ack === "function") ack(e);
        return;
      }
      const { rows } = await pool.query(
        `SELECT id, room FROM messages WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [id, uid]
      );
      if (!rows[0] || rows[0].room !== slug) {
        const e = { ok: false, error: "Сообщение не найдено" };
        if (typeof ack === "function") ack(e);
        return;
      }
      await pool.query(`UPDATE messages SET text = $1, edited_at = NOW() WHERE id = $2`, [body, id]);
      const formatted = await formatMessageById(id);
      io.to(slug).emit("message-edited", formatted);
      if (typeof ack === "function") ack({ ok: true });
    } catch (err) {
      console.error("edit-message", err);
      const e = { ok: false, error: "Не удалось изменить" };
      if (typeof ack === "function") ack(e);
    }
  });

  socket.on("delete-message", async (payload, ack) => {
    try {
      const uid = socket.data.userId;
      const slug = socket.data.currentRoom;
      if (!uid || !slug) {
        const e = { ok: false, error: "Нет контекста" };
        if (typeof ack === "function") ack(e);
        return;
      }
      const id = parseInt(payload?.id, 10);
      if (!Number.isInteger(id)) {
        const e = { ok: false, error: "Некорректный id" };
        if (typeof ack === "function") ack(e);
        return;
      }
      const { rows } = await pool.query(
        `SELECT id, room FROM messages WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [id, uid]
      );
      if (!rows[0] || rows[0].room !== slug) {
        const e = { ok: false, error: "Сообщение не найдено" };
        if (typeof ack === "function") ack(e);
        return;
      }
      await unlinkAttachmentForMessage(id);
      await pool.query(`UPDATE messages SET deleted_at = NOW(), text = '' WHERE id = $1`, [id]);
      const formatted = await formatMessageById(id);
      io.to(slug).emit("message-deleted", { id, room: slug, message: formatted });
      if (typeof ack === "function") ack({ ok: true });
    } catch (err) {
      console.error("delete-message", err);
      const e = { ok: false, error: "Не удалось удалить" };
      if (typeof ack === "function") ack(e);
    }
  });

  socket.on("toggle-reaction", async (payload, ack) => {
    try {
      const uid = socket.data.userId;
      const slug = socket.data.currentRoom;
      if (!uid || !slug) {
        const e = { ok: false, error: "Нет контекста" };
        if (typeof ack === "function") ack(e);
        return;
      }
      const id = parseInt(payload?.messageId ?? payload?.id, 10);
      if (!Number.isInteger(id)) {
        const e = { ok: false, error: "Некорректный id" };
        if (typeof ack === "function") ack(e);
        return;
      }
      const emoji = sanitizeEmoji(payload?.emoji);
      if (!emoji) {
        const e = { ok: false, error: "Некорректная реакция" };
        if (typeof ack === "function") ack(e);
        return;
      }
      const { rows } = await pool.query(`SELECT id, room FROM messages WHERE id = $1`, [id]);
      if (!rows[0] || rows[0].room !== slug) {
        const e = { ok: false, error: "Сообщение не найдено" };
        if (typeof ack === "function") ack(e);
        return;
      }
      const reactions = await toggleReactionDb(id, uid, emoji);
      io.to(slug).emit("message-reactions", { id, room: slug, reactions });
      if (typeof ack === "function") ack({ ok: true, reactions });
    } catch (err) {
      console.error("toggle-reaction", err);
      const e = { ok: false, error: "Не удалось сохранить реакцию" };
      if (typeof ack === "function") ack(e);
    }
  });

  socket.on("typing", (payload) => {
    const slug = socket.data.currentRoom;
    if (!slug) return;
    socket.to(slug).emit("typing", {
      room: slug,
      nickname: socket.data.nickname,
      typing: !!payload?.typing,
    });
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
  await ensurePhase1Schema();
  await ensurePhase2Schema();
  await ensurePhase3Schema();
  ensureUploadDirs();
  server.listen(PORT, () => {
    console.log(`Сервер: http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Не удалось запустить сервер:", err);
  process.exit(1);
});
