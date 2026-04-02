/**
 * TatarChat: Express + Socket.io + PostgreSQL.
 * Вход по аккаунту (JWT).
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
const admin = require("firebase-admin");
const webpush = require("web-push");

const PORT = Number(process.env.PORT) || 3001;
/** Локальный Ollama (не открывать наружу). */
const OLLAMA_BASE_URL = String(process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "deepseek-r1:8b";
const OLLAMA_MODELS = Array.from(
  new Set(
    String(process.env.OLLAMA_MODELS || OLLAMA_MODEL)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  )
);
const MAX_AI_USER_MESSAGE_CHARS = Math.min(Math.max(Number(process.env.MAX_AI_USER_MESSAGE_CHARS) || 6000, 500), 32000);
const OLLAMA_HTTP_TIMEOUT_MS = Math.min(Math.max(Number(process.env.OLLAMA_HTTP_TIMEOUT_MS) || 300000, 10000), 600000);
/** Tavily Search API (ключ в заголовке Authorization: Bearer) */
const TAVILY_API_KEY = String(process.env.TAVILY_API_KEY || "").trim();
const TAVILY_TIMEOUT_MS = Math.min(Math.max(Number(process.env.TAVILY_TIMEOUT_MS) || 25_000, 5000), 120_000);
const MAX_MESSAGE_LEN = 2000;
const MAX_NICK_LEN = 64;
const MIN_PASSWORD_LEN = 6;
const MAX_PASSWORD_LEN = 128;
const MESSAGES_PER_MINUTE = 30;
const BCRYPT_ROUNDS = 10;
const JWT_EXPIRES = "7d";
// Сообщения/вложения: 16MB слишком мало (например, .apk). По умолчанию даём запас.
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB || 128) * 1024 * 1024;
const UPLOAD_ROOT = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, "data", "uploads"));
const STAGING_DIR = path.join(UPLOAD_ROOT, "staging");
const ALLOWED_UPLOAD_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/webm",
  "video/mp4",
  "audio/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "application/pdf",
  "application/vnd.android.package-archive",
  "text/plain",
]);
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
/** Короткие видеосообщения («кружки»), на клиенте в квадрате */
const VIDEO_NOTE_MIMES = new Set(["video/webm", "video/mp4"]);
const VOICE_MIMES = new Set(["audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4"]);
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

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
    roomPassword: null,
  },
  /** DTD: внутренний чат «Работа» (не отдельной строкой канала на клиенте) */
  dtd_work: {
    title: "DTD · Работа",
    roomPassword: null,
  },
  /** Подгруппа DTD: отдельный чат «Работа» (только [a-z0-9_]: дефисы в join-room срезает canonicalizeChannelSlug) */
  dtd_rabota: {
    title: "Рабочка",
    roomPassword: null,
  },
};

const ADMIN_NICKNAMES = (process.env.ADMIN_NICKNAMES || "Макс").split(",").map((s) => s.trim().toLowerCase());

function isAdmin(nickname) {
  return ADMIN_NICKNAMES.includes(String(nickname || "").trim().toLowerCase());
}

/** Виртуальная «комната» в сайдбаре — не чат, только клиент + отдельный UI */
const GALLERY_ROOM_SLUG = "__gallery";

/** Канал lobby («Семья») в списке и доступ — только эти ники */
const LOBBY_VISIBLE_NICKNAMES = (process.env.LOBBY_VISIBLE_NICKNAMES || "макс,рена")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/** DTD в списке и вход для всех, кроме перечисленных ников */
const DTD_HIDDEN_NICKNAMES = (process.env.DTD_HIDDEN_NICKNAMES || "рена")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function canUserSeeLobby(nickname) {
  return LOBBY_VISIBLE_NICKNAMES.includes(String(nickname || "").trim().toLowerCase());
}

function canUserSeeDtd(nickname) {
  return !DTD_HIDDEN_NICKNAMES.includes(String(nickname || "").trim().toLowerCase());
}

const MAX_GALLERY_BYTES = Number(process.env.MAX_GALLERY_FILE_MB || 20) * 1024 * 1024;

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

/** Доступ с телефона в той же Wi‑Fi: Origin вида http://192.168.x.x:3001 */
function isPrivateLanHostname(host) {
  if (!host || typeof host !== "string") return false;
  const h = host.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1") return false;
  if (h.endsWith(".local")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function corsOrigin(origin, callback) {
  if (!origin) {
    return callback(null, true);
  }
  // Capacitor/ionic webview origins (Android/iOS)
  // e.g. capacitor://localhost, ionic://localhost
  if (typeof origin === "string") {
    const o = origin.toLowerCase();
    if (o === "capacitor://localhost" || o === "ionic://localhost") {
      return callback(null, true);
    }
  }
  try {
    const u = new URL(origin);
    if (
      (u.hostname === "localhost" || u.hostname === "127.0.0.1") &&
      (u.protocol === "http:" || u.protocol === "https:")
    ) {
      return callback(null, true);
    }
    if (isPrivateLanHostname(u.hostname) && (u.protocol === "http:" || u.protocol === "https:")) {
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
// set after Socket.IO is created (used for server-side broadcasts from HTTP handlers)
let ioInstance = null;
app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);
app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "X-Room-Password", "X-Video-Note", "X-Voice-Message"],
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
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
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

function isVoiceFlag(body) {
  const v = body?.voiceMessage ?? body?.voice_message;
  if (v == null || v === "") return false;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

function isVoiceHeader(req) {
  const h = req.headers["x-voice-message"];
  return h === "1" || String(h || "").trim().toLowerCase() === "true";
}

function isVoiceMessageRequest(req) {
  return isVoiceFlag(req.body) || isVoiceHeader(req);
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

function sanitizeGalleryFolderName(input) {
  return String(input ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, 128);
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
  const saved = raw.match(/^saved-(\d+)$/i);
  if (saved) {
    const id = parseInt(saved[1], 10);
    if (!Number.isInteger(id) || id < 1) return null;
    return `saved-${id}`;
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

async function ensureSavedChannelRow(userId) {
  const slug = `saved-${userId}`;
  await pool.query(
    `INSERT INTO channels (slug, title, kind) VALUES ($1, $2, 'public')
     ON CONFLICT (slug) DO NOTHING`,
    [slug, "Избранное"]
  );
}

async function getUserPerms(userId) {
  const { rows } = await pool.query(
    `SELECT is_admin, can_see_lobby, can_see_dtd, can_see_dtd_work FROM users WHERE id = $1`,
    [userId]
  );
  return (
    rows[0] || {
      is_admin: false,
      can_see_lobby: false,
      can_see_dtd: true,
      can_see_dtd_work: true,
    }
  );
}

async function userCanAccessChannel(slug, userId, roomPassword) {
  if (!slug || userId == null) return false;
  const perms = await getUserPerms(userId);
  // Legacy виртуальная комната: те же правила, что у «Семья» (lobby).
  if (slug === GALLERY_ROOM_SLUG) return !!perms.can_see_lobby;
  const savedM = /^saved-(\d+)$/i.exec(slug);
  if (savedM) {
    const ownerId = parseInt(savedM[1], 10);
    if (!Number.isInteger(ownerId) || ownerId !== userId) return false;
    await ensureSavedChannelRow(userId);
    return true;
  }
  if (slug.startsWith("dm-")) {
    const m = /^dm-(\d+)-(\d+)$/.exec(slug);
    if (!m) return false;
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (userId !== a && userId !== b) return false;
    await ensureDmChannelRow(slug, a, b);
    return true;
  }
  if (slug === "lobby") return !!perms.can_see_lobby;
  const conf = GROUP_ROOMS[slug];
  if (conf) {
    if (slug === "dreamteamdauns" && !perms.can_see_dtd) return false;
    if (slug === "dtd_work" && (!perms.can_see_dtd || !perms.can_see_dtd_work)) return false;
    if (slug === "dtd_rabota" && (!perms.can_see_dtd || !perms.can_see_dtd_work)) return false;
    if (conf.roomPassword == null) return true;
    return conf.roomPassword === String(roomPassword ?? "");
  }
  const { rows } = await pool.query(`SELECT 1 FROM channels WHERE slug = $1 AND kind = 'public'`, [slug]);
  return rows.length > 0;
}

async function getChannelTitleForUser(slug, viewerUserId) {
  if (slug === GALLERY_ROOM_SLUG) return "Галерея";
  if (/^saved-\d+$/i.test(slug)) return "Избранное";
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

/** Упоминания @ник: кому слать уведомление (без проверки пароля комнаты — по правам доступа к каналу). */
async function userEligibleForMentionNotify(slug, userId) {
  if (!slug || userId == null) return false;
  const perms = await getUserPerms(userId);
  if (slug === GALLERY_ROOM_SLUG) return false;
  const savedM = /^saved-(\d+)$/i.exec(slug);
  if (savedM) {
    const ownerId = parseInt(savedM[1], 10);
    return Number.isInteger(ownerId) && ownerId === userId;
  }
  if (slug.startsWith("dm-")) {
    const m = /^dm-(\d+)-(\d+)$/.exec(slug);
    if (!m) return false;
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    return userId === a || userId === b;
  }
  if (slug === "lobby") return !!perms.can_see_lobby;
  const conf = GROUP_ROOMS[slug];
  if (conf) {
    if (slug === "dreamteamdauns" && !perms.can_see_dtd) return false;
    if (slug === "dtd_work" && (!perms.can_see_dtd || !perms.can_see_dtd_work)) return false;
    if (slug === "dtd_rabota" && (!perms.can_see_dtd || !perms.can_see_dtd_work)) return false;
    return true;
  }
  const { rows } = await pool.query(`SELECT 1 FROM channels WHERE slug = $1 AND kind = 'public'`, [slug]);
  return rows.length > 0;
}

function extractMentionNicks(text) {
  if (!text || typeof text !== "string") return [];
  const re = /@([^\s@]+)/g;
  const seen = new Set();
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    let raw = m[1].replace(/[.,;:!?)\]}>]+$/, "").trim();
    if (!raw) continue;
    if (raw.length > 64) raw = raw.slice(0, 64);
    const low = raw.toLowerCase();
    if (seen.has(low)) continue;
    seen.add(low);
    out.push(low);
  }
  return out;
}

function parseServiceAccountFromEnv() {
  const rawJson = process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (rawJson) {
    try {
      const obj = JSON.parse(rawJson);
      if (obj?.private_key && typeof obj.private_key === "string") {
        obj.private_key = obj.private_key.replace(/\\n/g, "\n");
      }
      return obj;
    } catch (e) {
      console.warn("[push] bad FCM_SERVICE_ACCOUNT_JSON:", e?.message || e);
      return null;
    }
  }

  const project_id = process.env.FCM_PROJECT_ID;
  const client_email = process.env.FCM_CLIENT_EMAIL;
  let private_key = process.env.FCM_PRIVATE_KEY;
  if (private_key && typeof private_key === "string") private_key = private_key.replace(/\\n/g, "\n");

  if (project_id && client_email && private_key) {
    return { project_id, client_email, private_key };
  }
  return null;
}

let fcmReady = false;
function initFcmIfPossible() {
  if (fcmReady) return true;
  try {
    if (admin.apps && admin.apps.length > 0) {
      fcmReady = true;
      return true;
    }
    const cred = parseServiceAccountFromEnv();
    if (!cred) return false;
    admin.initializeApp({ credential: admin.credential.cert(cred) });
    fcmReady = true;
    console.log("[push] FCM ready");
    return true;
  } catch (e) {
    console.warn("[push] FCM init failed:", e?.message || e);
    return false;
  }
}

let webPushReady = false;
function initWebPushIfPossible() {
  if (webPushReady) return true;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:admin@localhost";
  if (!pub || !priv) return false;
  try {
    webpush.setVapidDetails(subject, pub, priv);
    webPushReady = true;
    console.log("[push] Web Push (VAPID) ready");
    return true;
  } catch (e) {
    console.warn("[push] Web Push init failed:", e?.message || e);
    return false;
  }
}

function defaultPushModeForRoom(room) {
  const slug = String(room || "").toLowerCase();
  if (slug.startsWith("dm-")) return "all";
  if (slug === "lobby") return "all";
  return "off";
}

async function ensureUserOllamaChatSchema() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_ollama_chats (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        messages JSONB NOT NULL DEFAULT '[]'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  } catch (err) {
    console.error("[schema] user_ollama_chats:", err?.message || err);
    throw err;
  }
}

async function ensureUserOllamaPrefsSchema() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_ollama_prefs (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  } catch (err) {
    console.error("[schema] user_ollama_prefs:", err?.message || err);
    throw err;
  }
}

async function getUserAiModel(userId) {
  await ensureUserOllamaPrefsSchema();
  const { rows } = await pool.query(`SELECT model FROM user_ollama_prefs WHERE user_id = $1`, [userId]);
  const m = String(rows[0]?.model || "").trim();
  if (m && OLLAMA_MODELS.includes(m)) return m;
  return OLLAMA_MODEL;
}

async function setUserAiModel(userId, model) {
  await ensureUserOllamaPrefsSchema();
  const m = String(model || "").trim();
  if (!m || !OLLAMA_MODELS.includes(m)) return { ok: false, error: "Недоступная модель" };
  await pool.query(
    `INSERT INTO user_ollama_prefs (user_id, model, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET model = $2, updated_at = NOW()`,
    [userId, m]
  );
  return { ok: true, model: m };
}

async function ensureUserAiFactsSchema() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_ai_facts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        fact TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_ai_facts_user_id ON user_ai_facts (user_id)`);
  } catch (err) {
    console.error("[schema] user_ai_facts:", err?.message || err);
    throw err;
  }
}

function sanitizeAiFact(input) {
  return String(input ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
}

async function getUserAiFacts(userId) {
  await ensureUserAiFactsSchema();
  const { rows } = await pool.query(
    `SELECT id, fact, created_at, updated_at
     FROM user_ai_facts
     WHERE user_id = $1
     ORDER BY updated_at DESC, id DESC
     LIMIT 50`,
    [userId]
  );
  return rows.map((r) => ({
    id: r.id,
    fact: String(r.fact || ""),
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

function factsToPromptBlock(facts) {
  const list = Array.isArray(facts) ? facts : [];
  if (!list.length) return "";
  const lines = list
    .map((f, i) => {
      const t = sanitizeAiFact(f?.fact);
      if (!t) return null;
      return `${i + 1}. ${t}`;
    })
    .filter(Boolean);
  if (!lines.length) return "";
  return (
    "Постоянные факты о пользователе (это заметки, их нужно учитывать во всех ответах):\n" +
    lines.join("\n")
  );
}

function sanitizeAiUserMessage(input) {
  return String(input ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/<[^>]*>/g, "")
    .trim()
    .slice(0, MAX_AI_USER_MESSAGE_CHARS);
}

function stripAssistantNoise(text) {
  let s = String(text ?? "");
  s = s.replace(/<redacted_thinking>[\s\S]*?<\/redacted_thinking>/gi, "");
  s = s.replace(/<think>[\s\S]*?<\/redacted_thinking>/gi, "");
  return s.trim();
}

function normalizeStoredAiMessages(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const role = m.role === "assistant" ? "assistant" : m.role === "user" ? "user" : null;
    if (!role) continue;
    let content = typeof m.content === "string" ? m.content : m.content != null ? String(m.content) : "";
    content = content.replace(/[\u0000-\u001F\u007F]/g, "").slice(0, 200000);
    if (!content) continue;
    out.push({ role, content });
  }
  return out;
}

function trimMessagesForOllama(list, maxPairs = 28) {
  const n = maxPairs * 2;
  if (list.length <= n) return list;
  return list.slice(list.length - n);
}

function isTavilyConfigured() {
  return Boolean(TAVILY_API_KEY);
}

function normalizeTavilySearchDepth() {
  const d = String(process.env.TAVILY_SEARCH_DEPTH || "basic").toLowerCase();
  if (d === "advanced" || d === "basic" || d === "fast" || d === "ultra-fast") return d;
  return "basic";
}

/** Выдержки Tavily для одного запроса к Ollama (не сохраняются в БД отдельно). */
async function runTavilySearch(searchQuery) {
  const q = String(searchQuery ?? "")
    .trim()
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .slice(0, 400);
  if (!q) return { ok: false, error: "Пустой поисковый запрос" };

  const maxResults = Math.min(Math.max(Number(process.env.TAVILY_MAX_RESULTS) || 5, 1), 20);
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), TAVILY_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TAVILY_API_KEY}`,
      },
      body: JSON.stringify({
        query: q,
        search_depth: normalizeTavilySearchDepth(),
        max_results: maxResults,
        topic: "general",
        include_images: true,
        include_image_descriptions: true,
      }),
      signal: ac.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        data?.detail?.error || data?.error || data?.message || `HTTP ${res.status}`;
      return { ok: false, error: typeof msg === "string" ? msg : JSON.stringify(msg) };
    }
    const results = Array.isArray(data.results) ? data.results : [];
    if (!results.length) {
      return {
        ok: true,
        block:
          "По этому запросу Tavily не вернул результатов. Сообщи пользователю и ответь из своих знаний, если уместно.",
        images: [],
      };
    }
    const images = [];
    const topImages = Array.isArray(data.images) ? data.images : [];
    for (const it of topImages) {
      if (images.length >= 10) break;
      if (typeof it === "string" && it.trim()) {
        images.push({ url: it.trim(), description: "" });
      } else if (it && typeof it === "object") {
        const url = String(it.url || "").trim();
        const description = String(it.description || "").trim();
        if (url) images.push({ url, description });
      }
    }
    if (images.length < 10) {
      for (const r of results) {
        if (images.length >= 10) break;
        const ri = Array.isArray(r?.images) ? r.images : [];
        for (const it of ri) {
          if (images.length >= 10) break;
          if (typeof it === "string" && it.trim()) {
            images.push({ url: it.trim(), description: "" });
          } else if (it && typeof it === "object") {
            const url = String(it.url || "").trim();
            const description = String(it.description || "").trim();
            if (url) images.push({ url, description });
          }
        }
      }
    }
    let block =
      "Ниже выдержки из веб-поиска (Tavily). Опирайся на них; укажи номер источника [1], [2]. Не выдумывай URL и факты вне текста.\n\n";
    const ans = data.answer;
    if (typeof ans === "string" && ans.trim()) {
      block += `Краткий конспект Tavily: ${ans.trim().replace(/\s+/g, " ")}\n\n`;
    }
    const parts = results.map((it, i) => {
      const title = String(it.title || "").replace(/\s+/g, " ").trim();
      const url = String(it.url || "").trim();
      const content = String(it.content || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 4000);
      return `[${i + 1}] ${title}\nURL: ${url}\n${content}`;
    });
    return { ok: true, block: `${block}${parts.join("\n\n")}`.trim(), images };
  } catch (e) {
    if (e?.name === "AbortError") return { ok: false, error: "Таймаут Tavily" };
    return { ok: false, error: e?.message || "Ошибка Tavily" };
  } finally {
    clearTimeout(to);
  }
}

const DEFAULT_OLLAMA_SYSTEM_PROMPT = `You are a helpful assistant in the TatarChat messenger. The conversation history is in the following messages — use it, including the user's name and facts they already stated. Reply in Russian unless the user writes in another language. Be concise unless asked for detail.`;

function buildAiSystemPrompt(nickname, webSearchBlock, factsBlock) {
  const base = (process.env.OLLAMA_SYSTEM_PROMPT || "").trim() || DEFAULT_OLLAMA_SYSTEM_PROMPT;
  let s = base;
  const nick = String(nickname || "").trim();
  if (nick) s += `\n\nПользователь в приложении подписан как: ${nick}.`;
  if (factsBlock) s += `\n\n${factsBlock}`;
  if (webSearchBlock) s += `\n\n${webSearchBlock}`;
  return s.slice(0, 120_000);
}

async function callOllamaChat(model, messages) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), OLLAMA_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model || OLLAMA_MODEL,
        messages,
        stream: false,
      }),
      signal: ac.signal,
    });
    const txt = await res.text();
    let data = {};
    try {
      data = txt ? JSON.parse(txt) : {};
    } catch {
      data = {};
    }
    if (!res.ok) {
      const err = new Error(`ollama_http_${res.status}`);
      err.detail = (txt || "").slice(0, 800);
      throw err;
    }
    let reply = data?.message?.content;
    if (typeof reply !== "string") reply = "";
    reply = stripAssistantNoise(reply);
    return reply;
  } finally {
    clearTimeout(to);
  }
}

async function ensurePushSchema() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS push_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        token TEXT NOT NULL UNIQUE,
        platform VARCHAR(16) NOT NULL DEFAULT 'android',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_at TIMESTAMPTZ
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_push_tokens_user_id ON push_tokens (user_id)`);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_push_tokens_active_user_id ON push_tokens (user_id) WHERE revoked_at IS NULL`
    );

    await pool.query(`
      CREATE TABLE IF NOT EXISTS push_settings (
        user_id INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS push_prefs (
        user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        room_slug VARCHAR(64) NOT NULL,
        mode VARCHAR(16) NOT NULL CHECK (mode IN ('all','mentions','off')),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, room_slug)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_push_prefs_user_id ON push_prefs (user_id)`);
    await pool.query(`ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS web_auth TEXT`);
    await pool.query(`ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS web_p256dh TEXT`);
  } catch (err) {
    console.error("[schema] push:", err?.message || err);
    throw err;
  }
}

async function getPushEnabled(userId) {
  const { rows } = await pool.query(`SELECT enabled FROM push_settings WHERE user_id = $1`, [userId]);
  if (!rows.length) return true;
  return rows[0].enabled !== false;
}

async function getPushMode(userId, room) {
  const slug = canonicalizeChannelSlug(room);
  if (!slug) return "off";
  const { rows } = await pool.query(`SELECT mode FROM push_prefs WHERE user_id = $1 AND room_slug = $2`, [
    userId,
    slug,
  ]);
  if (!rows.length) return defaultPushModeForRoom(slug);
  const m = String(rows[0].mode || "").toLowerCase();
  if (m === "all" || m === "mentions" || m === "off") return m;
  return defaultPushModeForRoom(slug);
}

async function revokePushTokens(tokens) {
  if (!tokens?.length) return;
  await pool.query(`UPDATE push_tokens SET revoked_at = NOW() WHERE token = ANY($1::text[])`, [tokens]);
}

function getDmPeerIdFromSlug(roomSlug, senderUserId) {
  const slug = String(roomSlug || "");
  const m = /^dm-(\d+)-(\d+)$/.exec(slug);
  if (!m) return null;
  const a = parseInt(m[1], 10);
  const b = parseInt(m[2], 10);
  if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
  if (senderUserId === a) return b;
  if (senderUserId === b) return a;
  return null;
}

function buildPushPreviewText(text) {
  const t = typeof text === "string" ? text : "";
  const s = t.replace(/\s+/g, " ").trim();
  if (s) return s.slice(0, 200);
  return "Новое сообщение";
}

async function dispatchNewMessagePush({ room, formatted, senderUserId, text }) {
  try {
    if (!formatted || senderUserId == null) return;
    const slug = String(room || "");
    if (!slug || slug === GALLERY_ROOM_SLUG) return;

    const preview = buildPushPreviewText(text ?? formatted.text ?? "");
    const fromNick = formatted.user_nick || "Кто-то";

    if (slug.startsWith("dm-")) {
      const peerId = getDmPeerIdFromSlug(slug, senderUserId);
      if (!peerId) return;
      let title = "ЛС";
      try {
        title = `${fromNick} · ${await getChannelTitleForUser(slug, peerId)}`;
      } catch {
        title = `${fromNick} · ЛС`;
      }
      void sendPushToUser(peerId, {
        kind: "message",
        room: slug,
        title,
        body: preview,
        messageId: formatted.id,
        senderUserId,
      });
      return;
    }

    await ensurePushSchema();
    let rows;
    if (slug === "lobby") {
      ({ rows } = await pool.query(
        `SELECT id AS user_id FROM users WHERE can_see_lobby IS TRUE AND id <> $1`,
        [senderUserId]
      ));
    } else {
      ({ rows } = await pool.query(
        `SELECT user_id FROM push_prefs WHERE room_slug = $1 AND mode = 'all' AND user_id <> $2`,
        [slug, senderUserId]
      ));
    }
    if (!rows.length) return;

    let roomTitle = slug;
    try {
      roomTitle = await getChannelTitleForUser(slug, senderUserId);
    } catch {
      roomTitle = slug;
    }

    for (const r of rows) {
      const uid = r.user_id;
      if (uid == null) continue;
      if (!(await userEligibleForMentionNotify(slug, uid))) continue;
      void sendPushToUser(uid, {
        kind: "message",
        room: slug,
        title: `${fromNick} · ${roomTitle}`,
        body: preview,
        messageId: formatted.id,
        senderUserId,
      });
    }
  } catch (e) {
    console.warn("[push] dispatchNewMessagePush failed:", e?.message || e);
  }
}

async function dispatchMentionNotifications(io, { room, formatted, senderUserId, text }) {
  if (!io || !formatted || senderUserId == null) return;
  const body = typeof text === "string" ? text : "";
  const nicks = extractMentionNicks(body);
  if (nicks.length === 0) return;
  let rows;
  try {
    ({ rows } = await pool.query(`SELECT id, nickname FROM users WHERE LOWER(nickname) = ANY($1::text[])`, [nicks]));
  } catch (err) {
    console.error("dispatchMentionNotifications lookup", err?.message || err);
    return;
  }
  const seenIds = new Set();
  for (const row of rows) {
    const targetId = row.id;
    if (targetId === senderUserId || seenIds.has(targetId)) continue;
    seenIds.add(targetId);
    if (!(await userEligibleForMentionNotify(room, targetId))) continue;
    let channelTitle;
    try {
      channelTitle = await getChannelTitleForUser(room, targetId);
    } catch {
      channelTitle = room;
    }
    const preview = body.replace(/\s+/g, " ").trim().slice(0, 160);
    io.to(`user:${targetId}`).emit("mention", {
      room,
      channelTitle,
      from: formatted.user_nick || "Кто-то",
      messageId: formatted.id,
      preview,
      message: formatted,
    });
    void sendPushToUser(targetId, {
      kind: "mention",
      room,
      title: `${formatted.user_nick || "Кто-то"} · ${channelTitle || room}`,
      body: preview || "Вас упомянули",
      messageId: formatted.id,
      senderUserId,
    });
  }
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

function userSocketPresenceCount(userId) {
  return presenceByUserId.get(userId) || 0;
}

/** FCM (Android/iOS) + Web Push (PWA/браузер, VAPID). */
async function sendPushToUser(userId, { kind, room, title, body, messageId, senderUserId }) {
  try {
    await ensurePushSchema();

    const enabled = await getPushEnabled(userId);
    if (!enabled) return;

    const mode = await getPushMode(userId, room);
    if (kind === "message") {
      if (mode !== "all") return;
    } else if (kind === "mention") {
      if (mode === "off") return;
    }

    const { rows } = await pool.query(
      `SELECT token, platform, web_auth, web_p256dh FROM push_tokens WHERE user_id = $1 AND revoked_at IS NULL ORDER BY last_seen_at DESC`,
      [userId]
    );
    if (!rows.length) return;

    const titleS = String(title || "TatarChat").slice(0, 120);
    const bodyS = String(body || "").slice(0, 240);
    const payloadData = {
      kind: String(kind || ""),
      room: String(room || ""),
      messageId: messageId != null ? String(messageId) : "",
      senderUserId: senderUserId != null ? String(senderUserId) : "",
    };
    const tag = `tatarchat-${kind}-${room}-${messageId ?? Date.now()}`;

    const fcmTokens = [];
    const webSubs = [];
    for (const r of rows) {
      const p = String(r.platform || "android").toLowerCase();
      if (p === "web" && r.web_auth && r.web_p256dh && r.token) {
        webSubs.push(r);
      } else if (p !== "web") {
        fcmTokens.push(r.token);
      }
    }

    if (fcmTokens.length && initFcmIfPossible()) {
      const response = await admin.messaging().sendEachForMulticast({
        tokens: fcmTokens,
        notification: {
          title: titleS,
          body: bodyS,
        },
        data: payloadData,
        android: {
          priority: "high",
        },
      });

      const bad = [];
      response.responses.forEach((r, idx) => {
        if (r.success) return;
        const code = r.error?.code || "";
        if (
          code.includes("registration-token-not-registered") ||
          code.includes("invalid-registration-token") ||
          code.includes("invalid-argument")
        ) {
          bad.push(fcmTokens[idx]);
        }
      });
      if (bad.length) await revokePushTokens(bad);
    }

    if (webSubs.length && initWebPushIfPossible()) {
      const skipWebBecauseSocket = kind === "mention" && userSocketPresenceCount(userId) > 0;
      if (!skipWebBecauseSocket) {
        const payload = JSON.stringify({
          title: titleS,
          body: bodyS,
          room: payloadData.room,
          kind: payloadData.kind,
          messageId: payloadData.messageId,
          tag,
        });
        for (const r of webSubs) {
          try {
            await webpush.sendNotification(
              {
                endpoint: r.token,
                keys: { auth: r.web_auth, p256dh: r.web_p256dh },
              },
              payload,
              { TTL: 86_400 }
            );
          } catch (e) {
            const st = Number(e?.statusCode);
            if (st === 404 || st === 410) {
              await revokePushTokens([r.token]);
            } else {
              console.warn("[push] web push failed:", e?.message || e);
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn("[push] send failed:", e?.message || e);
  }
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

/** Канал lobby («Семья») и групповые комнаты из GROUP_ROOMS — гарантируем строки в БД (в т.ч. после удаления). */
async function ensureCorePublicChannelRows() {
  for (const [slug, conf] of Object.entries(GROUP_ROOMS)) {
    await pool.query(
      `INSERT INTO channels (slug, title, kind)
       SELECT $1::varchar, $2::varchar, 'public'::varchar
       WHERE NOT EXISTS (SELECT 1 FROM channels WHERE slug = $1::varchar)`,
      [slug, conf.title]
    );
  }
  await pool.query(`
    INSERT INTO channels (slug, title, kind)
    SELECT 'lobby', 'Семья', 'public'
    WHERE NOT EXISTS (SELECT 1 FROM channels WHERE slug = 'lobby')
  `);
  await pool.query(
    `UPDATE channels SET title = $1 WHERE slug = 'lobby' AND kind = 'public'`,
    ["Семья"]
  );
  await pool.query(
    `UPDATE channels SET title = $1 WHERE slug = 'dtd_rabota' AND kind = 'public'`,
    ["Рабочка"]
  );
  /* Старый slug с дефисом давал дубликат в списке и не совпадал с canonicalize */
  await pool.query(`DELETE FROM channels WHERE slug = 'dtd-rabota' AND kind = 'public'`);
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
    await ensureCorePublicChannelRows();
  } catch (err) {
    console.error("[schema] phase3:", err?.message || err);
    throw err;
  }
}

function mergeMissingCorePublicRows(rows) {
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  for (const [slug, conf] of Object.entries(GROUP_ROOMS)) {
    if (!bySlug.has(slug)) {
      bySlug.set(slug, { slug, title: conf.title, avatar_storage_key: null });
    }
  }
  if (!bySlug.has("lobby")) {
    bySlug.set("lobby", { slug: "lobby", title: "Семья", avatar_storage_key: null });
  }
  return Array.from(bySlug.values()).sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
}

async function ensureAvatarSchema() {
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_storage_key VARCHAR(512)`);
    await pool.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS avatar_storage_key VARCHAR(512)`);
  } catch (err) {
    console.error("[schema] avatars:", err?.message || err);
    throw err;
  }
}

async function ensureUserPermissionsSchema() {
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin        BOOLEAN NOT NULL DEFAULT FALSE`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS can_see_lobby   BOOLEAN NOT NULL DEFAULT FALSE`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS can_see_dtd     BOOLEAN NOT NULL DEFAULT TRUE`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS can_use_gallery BOOLEAN NOT NULL DEFAULT FALSE`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS can_see_dtd_work BOOLEAN NOT NULL DEFAULT TRUE`);

    // Инициализируем из env-переменных для уже существующих пользователей (только если is_admin ещё не проставлен)
    const adminNicks = ADMIN_NICKNAMES;
    const lobbyNicks = LOBBY_VISIBLE_NICKNAMES;
    const dtdHidden = DTD_HIDDEN_NICKNAMES;

    if (adminNicks.length) {
      await pool.query(
        `UPDATE users SET is_admin = TRUE WHERE LOWER(nickname) = ANY($1::text[]) AND is_admin = FALSE`,
        [adminNicks]
      );
    }
    if (lobbyNicks.length) {
      await pool.query(
        `UPDATE users SET can_see_lobby = TRUE WHERE LOWER(nickname) = ANY($1::text[]) AND can_see_lobby = FALSE`,
        [lobbyNicks]
      );
    }
    if (dtdHidden.length) {
      await pool.query(
        `UPDATE users SET can_see_dtd = FALSE, can_see_dtd_work = FALSE WHERE LOWER(nickname) = ANY($1::text[])`,
        [dtdHidden]
      );
    }
  } catch (err) {
    console.error("[schema] user_permissions:", err?.message || err);
    throw err;
  }
}

async function ensureGallerySchema() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gallery_folders (
        id SERIAL PRIMARY KEY,
        room_slug VARCHAR(80) NOT NULL DEFAULT 'lobby',
        parent_id INTEGER REFERENCES gallery_folders (id) ON DELETE CASCADE,
        name VARCHAR(128) NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`ALTER TABLE gallery_folders ADD COLUMN IF NOT EXISTS room_slug VARCHAR(80) NOT NULL DEFAULT 'lobby'`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_gallery_folders_parent ON gallery_folders (parent_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_gallery_folders_room_parent ON gallery_folders (room_slug, parent_id)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gallery_items (
        id SERIAL PRIMARY KEY,
        room_slug VARCHAR(80) NOT NULL DEFAULT 'lobby',
        folder_id INTEGER REFERENCES gallery_folders (id) ON DELETE CASCADE,
        storage_key VARCHAR(512) NOT NULL UNIQUE,
        original_name VARCHAR(200) NOT NULL DEFAULT '',
        mime VARCHAR(80) NOT NULL DEFAULT 'image/jpeg',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`ALTER TABLE gallery_items ADD COLUMN IF NOT EXISTS room_slug VARCHAR(80) NOT NULL DEFAULT 'lobby'`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_gallery_items_folder ON gallery_items (folder_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_gallery_items_room_folder ON gallery_items (room_slug, folder_id)`);
    // Backfill existing rows (old global gallery) into lobby by default
    await pool.query(`UPDATE gallery_folders SET room_slug = 'lobby' WHERE room_slug IS NULL OR room_slug = ''`);
    await pool.query(`UPDATE gallery_items SET room_slug = 'lobby' WHERE room_slug IS NULL OR room_slug = ''`);
  } catch (err) {
    console.error("[schema] gallery:", err?.message || err);
    throw err;
  }
}

async function ensureCalendarSchema() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS channel_calendar_events (
        id SERIAL PRIMARY KEY,
        room_slug VARCHAR(80) NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(240) NOT NULL,
        notes TEXT,
        starts_at TIMESTAMPTZ NOT NULL,
        ends_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_calendar_room_starts ON channel_calendar_events (room_slug, starts_at)`
    );
  } catch (err) {
    console.error("[schema] calendar:", err?.message || err);
    throw err;
  }
}

function parseGalleryRoom(req) {
  const raw = req.query?.room;
  const room = String(raw || "").trim().toLowerCase();
  return room || "lobby";
}

async function requireGalleryRoom(req, res, next) {
  try {
    const room = parseGalleryRoom(req);
    req.galleryRoom = room;
    const pw = getRoomPasswordFromRequest(req);
    const ok = await userCanAccessChannel(room, req.user.userId, pw);
    if (!ok) return res.status(403).json({ error: "Нет доступа к каналу" });
    next();
  } catch (err) {
    console.error("requireGalleryRoom", err);
    return res.status(500).json({ error: "Ошибка" });
  }
}

function ensureUploadDirs() {
  fs.mkdirSync(STAGING_DIR, { recursive: true });
  fs.mkdirSync(path.join(UPLOAD_ROOT, "rooms"), { recursive: true });
  fs.mkdirSync(path.join(UPLOAD_ROOT, "avatars"), { recursive: true });
  fs.mkdirSync(path.join(UPLOAD_ROOT, "gallery"), { recursive: true });
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
    // APK: некоторые браузеры/OS отдают application/octet-stream
    if (/\.apk$/.test(name) && (mime === "application/octet-stream" || mime === "")) {
      return cb(null, true);
    }
    if (
      isVideoNoteHeader(req) &&
      /^videonote\.(webm|mp4)$/.test(name) &&
      (mime === "application/octet-stream" || mime === "")
    ) {
      return cb(null, true);
    }
    if (
      isVoiceHeader(req) &&
      /^voicemessage\.(webm|ogg|mp3|m4a)$/.test(name) &&
      (mime === "application/octet-stream" || mime === "")
    ) {
      return cb(null, true);
    }
    cb(new Error("UNSUPPORTED_MIME"));
  },
});

const uploadAvatar = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) {
      cb(null, STAGING_DIR);
    },
    filename(req, file, cb) {
      cb(null, `avatar_${req.user.userId}_${Date.now()}${path.extname(file.originalname || "") || ".jpg"}`);
    },
  }),
  limits: { fileSize: MAX_AVATAR_BYTES },
  fileFilter(req, file, cb) {
    const mime = normalizeContentTypeMime(file.mimetype || "");
    if (IMAGE_MIMES.has(mime)) return cb(null, true);
    cb(new Error("UNSUPPORTED_MIME"));
  },
});

const uploadChannelAvatar = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) {
      cb(null, STAGING_DIR);
    },
    filename(req, file, cb) {
      cb(null, `ch_av_${Date.now()}_${crypto.randomBytes(6).toString("hex")}${path.extname(file.originalname || "") || ".jpg"}`);
    },
  }),
  limits: { fileSize: MAX_AVATAR_BYTES },
  fileFilter(req, file, cb) {
    const mime = normalizeContentTypeMime(file.mimetype || "");
    if (IMAGE_MIMES.has(mime)) return cb(null, true);
    cb(new Error("UNSUPPORTED_MIME"));
  },
});

const uploadGalleryImage = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) {
      cb(null, STAGING_DIR);
    },
    filename(req, file, cb) {
      cb(null, `gal_${Date.now()}_${crypto.randomBytes(8).toString("hex")}${path.extname(file.originalname || "") || ".jpg"}`);
    },
  }),
  limits: { fileSize: MAX_GALLERY_BYTES },
  fileFilter(req, file, cb) {
    const mime = normalizeContentTypeMime(file.mimetype || "");
    if (IMAGE_MIMES.has(mime)) return cb(null, true);
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
    user_has_avatar: !!row.user_has_avatar,
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
          (u.avatar_storage_key IS NOT NULL AND TRIM(u.avatar_storage_key) <> '') AS user_has_avatar,
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
      (u.avatar_storage_key IS NOT NULL AND TRIM(u.avatar_storage_key) <> '') AS user_has_avatar,
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
      (u.avatar_storage_key IS NOT NULL AND TRIM(u.avatar_storage_key) <> '') AS user_has_avatar,
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

async function saveNewMessageWithOptionalFile({ room, userId, text, replyToId, multerFile, videoNote = false, voiceMessage = false }) {
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
    if (
      voiceMessage &&
      !videoNote &&
      /^voicemessage\.(webm|ogg|mp3|m4a)$/.test(lowName) &&
      (fileMime === "application/octet-stream" || fileMime === "")
    ) {
      if (lowName.endsWith(".mp3")) fileMime = "audio/mpeg";
      else if (lowName.endsWith(".m4a")) fileMime = "audio/mp4";
      else if (lowName.endsWith(".ogg")) fileMime = "audio/ogg";
      else fileMime = "audio/webm";
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
    } else if (voiceMessage && !videoNote && VOICE_MIMES.has(fileMime)) {
      attKind = "voice";
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
      `SELECT id, nickname, password_hash, is_admin FROM users WHERE id = $1`,
      [payload.userId]
    );
    const user = rows[0];
    if (!user?.password_hash) {
      return res.status(401).json({ error: "Требуется вход" });
    }
    req.user = { userId: user.id, nickname: user.nickname, isAdmin: !!user.is_admin };
    next();
  } catch {
    return res.status(401).json({ error: "Сессия устарела, войдите снова" });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ error: "Нет прав администратора" });
  next();
}

function parseGalleryParentQuery(val) {
  if (val == null || val === "") return { ok: true, id: null };
  const n = parseInt(val, 10);
  if (!Number.isInteger(n) || n < 1) return { ok: false };
  return { ok: true, id: n };
}

function galleryItemsOrderSql(sort) {
  switch (String(sort || "").toLowerCase()) {
    case "created_asc":
      return "i.created_at ASC, i.id ASC";
    case "name_asc":
      return "LOWER(i.original_name) ASC NULLS LAST, i.id ASC";
    case "name_desc":
      return "LOWER(i.original_name) DESC NULLS LAST, i.id DESC";
    case "manual":
      return "i.sort_order ASC, i.id ASC";
    case "created_desc":
    default:
      return "i.created_at DESC, i.id DESC";
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

app.get("/api/health", async (_req, res) => {
  let dbOk = false;
  let dbErr = null;
  try {
    await Promise.race([
      pool.query("SELECT 1"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("DB_TIMEOUT")), 1500)),
    ]);
    dbOk = true;
  } catch (e) {
    dbOk = false;
    dbErr = e?.message || String(e);
  }
  res.json({
    ok: true,
    dbOk,
    dbErr,
    maxUploadMb: Math.round(MAX_UPLOAD_BYTES / (1024 * 1024)),
  });
});

app.get("/api/push/web-vapid-key", (req, res) => {
  try {
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    if (!publicKey || !process.env.VAPID_PRIVATE_KEY) {
      return res.status(503).json({ ok: false, error: "Web push не настроен" });
    }
    res.json({ ok: true, publicKey });
  } catch (err) {
    console.error("GET /api/push/web-vapid-key", err?.message || err);
    res.status(500).json({ ok: false, error: "Ошибка" });
  }
});

app.post("/api/push/register", requireAuth, async (req, res) => {
  try {
    await ensurePushSchema();
    const userId = req.user.userId;
    const platformRaw = String(req.body?.platform || "android").trim().toLowerCase() || "android";

    if (platformRaw === "web") {
      if (!initWebPushIfPossible()) {
        return res.status(503).json({ error: "Web push не настроен на сервере" });
      }
      const sub = req.body?.subscription;
      const endpoint = String(sub?.endpoint || "").trim();
      const auth = String(sub?.keys?.auth || "").trim();
      const p256dh = String(sub?.keys?.p256dh || "").trim();
      if (!endpoint || endpoint.length < 16 || !auth || !p256dh) {
        return res.status(400).json({ error: "Некорректная web-подписка" });
      }
      await pool.query(
        `
        INSERT INTO push_tokens (user_id, token, platform, web_auth, web_p256dh, created_at, last_seen_at, revoked_at)
        VALUES ($1, $2, 'web', $3, $4, NOW(), NOW(), NULL)
        ON CONFLICT (token) DO UPDATE SET
          user_id = EXCLUDED.user_id,
          platform = 'web',
          web_auth = EXCLUDED.web_auth,
          web_p256dh = EXCLUDED.web_p256dh,
          last_seen_at = NOW(),
          revoked_at = NULL
        `,
        [userId, endpoint, auth, p256dh]
      );
      return res.json({ ok: true });
    }

    const token = String(req.body?.token || "").trim();
    const platform = platformRaw || "android";
    if (!token || token.length < 12) return res.status(400).json({ error: "Некорректный token" });

    await pool.query(
      `
      INSERT INTO push_tokens (user_id, token, platform, web_auth, web_p256dh, created_at, last_seen_at, revoked_at)
      VALUES ($1, $2, $3, NULL, NULL, NOW(), NOW(), NULL)
      ON CONFLICT (token) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        platform = EXCLUDED.platform,
        web_auth = NULL,
        web_p256dh = NULL,
        last_seen_at = NOW(),
        revoked_at = NULL
      `,
      [userId, token, platform]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/push/register", err?.message || err);
    res.status(500).json({ error: "Не удалось сохранить токен" });
  }
});

app.post("/api/push/unregister", requireAuth, async (req, res) => {
  try {
    await ensurePushSchema();
    const userId = req.user.userId;
    const token = String(req.body?.token || "").trim();
    if (!token) return res.status(400).json({ error: "Некорректный token" });
    await pool.query(`UPDATE push_tokens SET revoked_at = NOW() WHERE user_id = $1 AND token = $2`, [
      userId,
      token,
    ]);
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/push/unregister", err?.message || err);
    res.status(500).json({ error: "Не удалось удалить токен" });
  }
});

app.get("/api/push/prefs", requireAuth, async (req, res) => {
  try {
    await ensurePushSchema();
    const userId = req.user.userId;
    const { rows: srows } = await pool.query(`SELECT enabled FROM push_settings WHERE user_id = $1`, [userId]);
    const enabled = srows.length ? srows[0].enabled !== false : true;
    const { rows } = await pool.query(`SELECT room_slug, mode FROM push_prefs WHERE user_id = $1`, [userId]);
    res.json({
      ok: true,
      enabled,
      rooms: rows.map((r) => ({ roomSlug: r.room_slug, mode: r.mode })),
    });
  } catch (err) {
    console.error("GET /api/push/prefs", err?.message || err);
    res.status(500).json({ error: "Не удалось загрузить настройки" });
  }
});

app.put("/api/push/prefs", requireAuth, async (req, res) => {
  try {
    await ensurePushSchema();
    const userId = req.user.userId;
    const enabled = req.body?.enabled;
    const rooms = Array.isArray(req.body?.rooms) ? req.body.rooms : [];

    if (enabled != null) {
      await pool.query(
        `
        INSERT INTO push_settings (user_id, enabled, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()
        `,
        [userId, enabled !== false]
      );
    }

    for (const r of rooms) {
      const roomSlug = canonicalizeChannelSlug(r?.roomSlug ?? r?.room ?? r?.slug);
      if (!roomSlug) continue;
      const mode = String(r?.mode || "").toLowerCase();
      if (mode !== "all" && mode !== "mentions" && mode !== "off") continue;
      await pool.query(
        `
        INSERT INTO push_prefs (user_id, room_slug, mode, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (user_id, room_slug) DO UPDATE SET mode = EXCLUDED.mode, updated_at = NOW()
        `,
        [userId, roomSlug, mode]
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("PUT /api/push/prefs", err?.message || err);
    res.status(500).json({ error: "Не удалось сохранить настройки" });
  }
});

app.get("/api/rooms", requireAuth, async (req, res) => {
  try {
    await ensureCorePublicChannelRows();
    const nick = req.user.nickname;
    const perms = await getUserPerms(req.user.userId);
    const { rows } = await pool.query(
      `SELECT slug, title FROM channels WHERE kind = 'public' ORDER BY slug`
    );
    const merged = mergeMissingCorePublicRows(
      rows.map((r) => ({ slug: r.slug, title: r.title, avatar_storage_key: null }))
    )
      .filter((r) => r.slug !== "dtd-rabota")
      .filter((r) => {
        if (r.slug === "lobby") return canUserSeeLobby(nick);
        if (r.slug === "dreamteamdauns") return !!perms.can_see_dtd;
        if (r.slug === "dtd_rabota") return !!perms.can_see_dtd && !!perms.can_see_dtd_work;
        return true;
      });
    const rooms = merged.map((r) => ({
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

app.post("/api/rooms", requireAuth, async (req, res) => {
  try {
    if (!req.user.isAdmin) return res.status(403).json({ error: "Только для админов" });
    const slug = sanitizeNickname(req.body?.slug);
    const title = String(req.body?.title || "").trim().slice(0, 64);
    if (!slug || !title) return res.status(400).json({ error: "slug и title обязательны" });
    const slugLc = String(slug).toLowerCase();
    if (slugLc === GALLERY_ROOM_SLUG) {
      return res.status(400).json({ error: "Зарезервированный идентификатор" });
    }
    if (slugLc.startsWith("saved-") || /^saved-\d+$/.test(slugLc)) {
      return res.status(400).json({ error: "Зарезервированный идентификатор" });
    }
    await pool.query(
      `INSERT INTO channels (slug, title, kind) VALUES ($1, $2, 'public') ON CONFLICT (slug) DO NOTHING`,
      [slugLc, title]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/rooms", err);
    res.status(500).json({ error: "Не удалось создать комнату" });
  }
});

app.put("/api/rooms/:slug", requireAuth, async (req, res) => {
  try {
    if (!req.user.isAdmin) return res.status(403).json({ error: "Только для админов" });
    const slug = req.params.slug;
    const title = String(req.body?.title || "").trim().slice(0, 64);
    if (!title) return res.status(400).json({ error: "title обязателен" });
    await pool.query(`UPDATE channels SET title = $1 WHERE slug = $2 AND kind = 'public'`, [title, slug]);
    res.json({ ok: true });
  } catch (err) {
    console.error("PUT /api/rooms/:slug", err);
    res.status(500).json({ error: "Не удалось обновить комнату" });
  }
});

app.delete("/api/rooms/:slug", requireAuth, async (req, res) => {
  try {
    if (!req.user.isAdmin) return res.status(403).json({ error: "Только для админов" });
    const slug = req.params.slug;
    if (slug === "lobby") return res.status(400).json({ error: "Нельзя удалить комнату «Семья»" });
    if (/^saved-\d+$/i.test(slug)) return res.status(400).json({ error: "Нельзя удалить избранное" });
    await pool.query(`DELETE FROM channels WHERE slug = $1 AND kind = 'public'`, [slug]);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/rooms/:slug", err);
    res.status(500).json({ error: "Не удалось удалить комнату" });
  }
});

app.get("/api/channels", requireAuth, async (req, res) => {
  try {
    const me = req.user.userId;
    await ensureSavedChannelRow(me);
    await ensureCorePublicChannelRows();
    const { rows: pubRows } = await pool.query(
      `SELECT slug, title, avatar_storage_key FROM channels WHERE kind = 'public' ORDER BY slug`
    );
    const nick = req.user.nickname;
    const perms = await getUserPerms(me);
    const filtered = mergeMissingCorePublicRows(pubRows)
      // dtd_work — внутренний чат DTD, не показываем отдельной строкой канала
      .filter((r) => r.slug !== "dtd_work")
      .filter((r) => r.slug !== "dtd-rabota")
      .filter((r) => {
        const m = /^saved-(\d+)$/i.exec(r.slug);
        if (!m) return true;
        return parseInt(m[1], 10) === me;
      })
      .filter((r) => {
        if (r.slug === "lobby") return canUserSeeLobby(nick);
        if (r.slug === "dreamteamdauns") return !!perms.can_see_dtd;
        if (r.slug === "dtd_work") return !!perms.can_see_dtd && !!perms.can_see_dtd_work;
        if (r.slug === "dtd_rabota") return !!perms.can_see_dtd && !!perms.can_see_dtd_work;
        return true;
      });
    const mapChannel = (r) => ({
      slug: r.slug,
      title: r.title || GROUP_ROOMS[r.slug]?.title || r.slug,
      kind: "public",
      requiresPassword: GROUP_ROOMS[r.slug]?.roomPassword != null,
      hasChannelAvatar: !!(r.avatar_storage_key && String(r.avatar_storage_key).trim() !== ""),
    });
    const savedSlug = `saved-${me}`;
    const rest = filtered.filter((r) => r.slug !== savedSlug).map(mapChannel);
    const savedRow = filtered.find((r) => r.slug === savedSlug);
    const savedCh = savedRow
      ? { ...mapChannel(savedRow), isSaved: true }
      : {
          slug: savedSlug,
          title: "Избранное",
          kind: "public",
          requiresPassword: false,
          hasChannelAvatar: false,
          isSaved: true,
        };
    const publicChannels = [savedCh, ...rest];
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

app.get("/api/me", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nickname, is_admin, can_see_lobby, can_see_dtd, can_see_dtd_work,
        (avatar_storage_key IS NOT NULL AND TRIM(avatar_storage_key) <> '') AS has_avatar
       FROM users WHERE id = $1`,
      [req.user.userId]
    );
    const u = rows[0];
    if (!u) return res.status(404).json({ error: "Нет пользователя" });
    res.json({
      id: u.id,
      nickname: u.nickname,
      isAdmin: !!u.is_admin,
      hasAvatar: !!u.has_avatar,
      canSeeLobby: !!u.can_see_lobby,
      canSeeDtd: !!u.can_see_dtd,
      canSeeDtdWork: !!u.can_see_dtd_work,
    });
  } catch (err) {
    console.error("GET /api/me", err);
    res.status(500).json({ error: "Ошибка" });
  }
});

app.get("/api/ai/chat", requireAuth, async (req, res) => {
  try {
    await ensureUserOllamaChatSchema();
    const { rows } = await pool.query(`SELECT messages FROM user_ollama_chats WHERE user_id = $1`, [
      req.user.userId,
    ]);
    const list = rows[0] ? normalizeStoredAiMessages(rows[0].messages) : [];
    const facts = await getUserAiFacts(req.user.userId);
    res.json({
      messages: list,
      model: await getUserAiModel(req.user.userId),
      availableModels: OLLAMA_MODELS,
      webSearchAvailable: isTavilyConfigured(),
      facts,
    });
  } catch (err) {
    console.error("GET /api/ai/chat", err);
    res.status(500).json({ error: "Ошибка" });
  }
});

app.get("/api/ai/facts", requireAuth, async (req, res) => {
  try {
    const facts = await getUserAiFacts(req.user.userId);
    res.json({ facts });
  } catch (err) {
    console.error("GET /api/ai/facts", err);
    res.status(500).json({ error: "Ошибка" });
  }
});

app.post("/api/ai/facts", requireAuth, async (req, res) => {
  try {
    const fact = sanitizeAiFact(req.body?.fact);
    if (!fact) return res.status(400).json({ error: "Пустой факт" });
    await ensureUserAiFactsSchema();
    const { rows } = await pool.query(
      `INSERT INTO user_ai_facts (user_id, fact, updated_at) VALUES ($1, $2, NOW())
       RETURNING id, fact, created_at, updated_at`,
      [req.user.userId, fact]
    );
    res.status(201).json({ fact: rows[0] });
  } catch (err) {
    console.error("POST /api/ai/facts", err);
    res.status(500).json({ error: "Ошибка" });
  }
});

app.delete("/api/ai/facts/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Некорректный id" });
    await ensureUserAiFactsSchema();
    const { rows } = await pool.query(
      `DELETE FROM user_ai_facts WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, req.user.userId]
    );
    if (!rows.length) return res.status(404).json({ error: "Не найдено" });
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/ai/facts/:id", err);
    res.status(500).json({ error: "Ошибка" });
  }
});

app.post("/api/ai/chat", requireAuth, async (req, res) => {
  try {
    await ensureUserOllamaChatSchema();
    const userId = req.user.userId;

    if (req.body?.setModel) {
      const r = await setUserAiModel(userId, req.body.setModel);
      if (!r.ok) return res.status(400).json({ error: r.error || "Ошибка модели" });
      return res.json({ ok: true, model: r.model, availableModels: OLLAMA_MODELS });
    }

    if (req.body?.clear === true) {
      await pool.query(
        `INSERT INTO user_ollama_chats (user_id, messages, updated_at) VALUES ($1, '[]'::jsonb, NOW())
         ON CONFLICT (user_id) DO UPDATE SET messages = '[]'::jsonb, updated_at = NOW()`,
        [userId]
      );
      return res.json({ messages: [] });
    }

    const text = sanitizeAiUserMessage(req.body?.message);
    if (!text) return res.status(400).json({ error: "Пустое сообщение" });

    const wantSearch = req.body?.search === true || req.body?.webSearch === true;
    if (wantSearch && !isTavilyConfigured()) {
      return res.status(501).json({
        error: "Поиск не настроен: задайте TAVILY_API_KEY в .env на сервере.",
      });
    }

    let webBlock = null;
    let webImages = [];
    if (wantSearch) {
      const sr = await runTavilySearch(text);
      if (!sr.ok) {
        console.warn("[ai] Tavily:", sr.error);
        return res.status(502).json({ error: sr.error || "Поиск Tavily недоступен" });
      }
      webBlock = sr.block;
      webImages = Array.isArray(sr.images) ? sr.images.slice(0, 8) : [];
    }

    const { rows } = await pool.query(`SELECT messages FROM user_ollama_chats WHERE user_id = $1`, [userId]);
    let list = rows[0] ? normalizeStoredAiMessages(rows[0].messages) : [];
    list.push({ role: "user", content: text });

    const historyForModel = trimMessagesForOllama(list).map(({ role, content }) => ({ role, content }));
    const facts = await getUserAiFacts(userId);
    const factsBlock = factsToPromptBlock(facts);
    const systemPrompt = buildAiSystemPrompt(req.user.nickname, webBlock, factsBlock);
    const ollamaMessages = [{ role: "system", content: systemPrompt }, ...historyForModel];
    const selectedModel = await getUserAiModel(userId);

    let reply;
    try {
      reply = await callOllamaChat(selectedModel, ollamaMessages);
    } catch (e) {
      if (e?.name === "AbortError") {
        return res.status(504).json({ error: "Модель отвечает слишком долго" });
      }
      if (String(e?.message || "").startsWith("ollama_http_")) {
        console.error("[ai] Ollama:", e?.detail || e?.message);
        return res.status(503).json({ error: "Модель недоступна (Ollama). Проверьте сервер." });
      }
      throw e;
    }

    if (!reply) reply = "(пустой ответ модели)";
    list.push({ role: "assistant", content: reply.slice(0, 200000) });

    await pool.query(
      `INSERT INTO user_ollama_chats (user_id, messages, updated_at) VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (user_id) DO UPDATE SET messages = $2::jsonb, updated_at = NOW()`,
      [userId, JSON.stringify(list)]
    );

    res.json({
      messages: list,
      model: selectedModel,
      web: wantSearch ? { images: webImages } : undefined,
      facts,
    });
  } catch (err) {
    console.error("POST /api/ai/chat", err);
    res.status(500).json({ error: "Ошибка ассистента" });
  }
});

app.get("/api/gallery/folders", requireAuth, requireGalleryRoom, async (req, res) => {
  try {
    const parsed = parseGalleryParentQuery(req.query.parentId);
    if (!parsed.ok) return res.status(400).json({ error: "Некорректный parentId" });
    const { rows } = await pool.query(
      `SELECT id, parent_id, name, sort_order, created_at
       FROM gallery_folders
       WHERE room_slug = $2 AND parent_id IS NOT DISTINCT FROM $1::integer
       ORDER BY sort_order ASC, id ASC`,
      [parsed.id, req.galleryRoom]
    );
    res.json({ folders: rows });
  } catch (err) {
    console.error("GET /api/gallery/folders", err);
    res.status(500).json({ error: "Не удалось загрузить папки" });
  }
});

app.get("/api/gallery/folders-all", requireAuth, requireGalleryRoom, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, parent_id, name FROM gallery_folders WHERE room_slug = $1 ORDER BY name ASC`,
      [req.galleryRoom]
    );
    res.json({ folders: rows });
  } catch (err) {
    console.error("GET /api/gallery/folders-all", err);
    res.status(500).json({ error: "Не удалось загрузить список папок" });
  }
});

app.post("/api/gallery/folders", requireAuth, requireGalleryRoom, async (req, res) => {
  try {
    const name = sanitizeGalleryFolderName(req.body?.name);
    if (!name) return res.status(400).json({ error: "Укажите название папки" });
    let parentId = null;
    if (req.body?.parentId != null && req.body.parentId !== "") {
      parentId = parseInt(req.body.parentId, 10);
      if (!Number.isInteger(parentId) || parentId < 1) {
        return res.status(400).json({ error: "Некорректный parentId" });
      }
      const { rows: pr } = await pool.query(`SELECT id FROM gallery_folders WHERE id = $1 AND room_slug = $2`, [parentId, req.galleryRoom]);
      if (!pr[0]) return res.status(400).json({ error: "Родительская папка не найдена" });
    }
    const { rows: mx } = await pool.query(
      `SELECT COALESCE(MAX(sort_order), 0) AS m FROM gallery_folders WHERE room_slug = $2 AND parent_id IS NOT DISTINCT FROM $1::integer`,
      [parentId, req.galleryRoom]
    );
    const sortOrder = (mx[0]?.m || 0) + 1;
    const { rows } = await pool.query(
      `INSERT INTO gallery_folders (room_slug, parent_id, name, sort_order) VALUES ($1, $2, $3, $4)
       RETURNING id, parent_id, name, sort_order, created_at`,
      [req.galleryRoom, parentId, name, sortOrder]
    );
    res.status(201).json({ folder: rows[0] });
  } catch (err) {
    console.error("POST /api/gallery/folders", err);
    res.status(500).json({ error: "Не удалось создать папку" });
  }
});

app.patch("/api/gallery/folders/:id", requireAuth, requireGalleryRoom, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Некорректный id" });
    const { rows: ex } = await pool.query(`SELECT id FROM gallery_folders WHERE id = $1 AND room_slug = $2`, [id, req.galleryRoom]);
    if (!ex[0]) return res.status(404).json({ error: "Папка не найдена" });
    if (req.body?.name != null) {
      const name = sanitizeGalleryFolderName(req.body.name);
      if (!name) return res.status(400).json({ error: "Пустое название" });
      await pool.query(`UPDATE gallery_folders SET name = $1 WHERE id = $2`, [name, id]);
    }
    if (req.body?.sortOrder != null) {
      const so = parseInt(req.body.sortOrder, 10);
      if (!Number.isInteger(so)) return res.status(400).json({ error: "Некорректный sortOrder" });
      await pool.query(`UPDATE gallery_folders SET sort_order = $1 WHERE id = $2`, [so, id]);
    }
    const { rows } = await pool.query(
      `SELECT id, parent_id, name, sort_order, created_at FROM gallery_folders WHERE id = $1 AND room_slug = $2`,
      [id, req.galleryRoom]
    );
    res.json({ folder: rows[0] });
  } catch (err) {
    console.error("PATCH /api/gallery/folders/:id", err);
    res.status(500).json({ error: "Не удалось обновить папку" });
  }
});

app.delete("/api/gallery/folders/:id", requireAuth, requireGalleryRoom, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Некорректный id" });
    const { rows: keyRows } = await pool.query(
      `WITH RECURSIVE sub AS (
         SELECT id FROM gallery_folders WHERE id = $1 AND room_slug = $2
         UNION ALL
         SELECT f.id FROM gallery_folders f INNER JOIN sub ON f.parent_id = sub.id
       )
       SELECT storage_key FROM gallery_items WHERE room_slug = $2 AND folder_id IN (SELECT id FROM sub)`,
      [id, req.galleryRoom]
    );
    const { rowCount } = await pool.query(`DELETE FROM gallery_folders WHERE id = $1 AND room_slug = $2`, [id, req.galleryRoom]);
    if (!rowCount) return res.status(404).json({ error: "Папка не найдена" });
    for (const r of keyRows) {
      if (r.storage_key) await fsp.unlink(path.join(UPLOAD_ROOT, r.storage_key)).catch(() => {});
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/gallery/folders/:id", err);
    res.status(500).json({ error: "Не удалось удалить папку" });
  }
});

app.get("/api/gallery/items", requireAuth, requireGalleryRoom, async (req, res) => {
  try {
    const parsed = parseGalleryParentQuery(req.query.folderId);
    if (!parsed.ok) return res.status(400).json({ error: "Некорректный folderId" });
    const sort = galleryItemsOrderSql(req.query.sort);
    const { rows } = await pool.query(
      `SELECT id, folder_id, original_name, mime, sort_order, created_at
       FROM gallery_items i
       WHERE i.room_slug = $2 AND i.folder_id IS NOT DISTINCT FROM $1::integer
       ORDER BY ${sort}`,
      [parsed.id, req.galleryRoom]
    );
    res.json({ items: rows });
  } catch (err) {
    console.error("GET /api/gallery/items", err);
    res.status(500).json({ error: "Не удалось загрузить фото" });
  }
});

app.put("/api/gallery/items/reorder", requireAuth, requireGalleryRoom, async (req, res) => {
  try {
    const ids = req.body?.itemIds;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "Укажите itemIds — массив id в нужном порядке" });
    }
    let folderId = null;
    if (req.body?.folderId != null && req.body.folderId !== "") {
      folderId = parseInt(req.body.folderId, 10);
      if (!Number.isInteger(folderId) || folderId < 1) {
        return res.status(400).json({ error: "Некорректный folderId" });
      }
    }
    const intIds = ids.map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n) && n > 0);
    if (intIds.length !== ids.length) return res.status(400).json({ error: "Некорректные id" });
    const { rows: items } = await pool.query(
      `SELECT id, folder_id FROM gallery_items WHERE room_slug = $2 AND id = ANY($1::int[])`,
      [intIds, req.galleryRoom]
    );
    if (items.length !== intIds.length) return res.status(400).json({ error: "Не все элементы найдены" });
    for (const it of items) {
      const a = it.folder_id == null;
      const b = folderId == null;
      if (a !== b || (!a && it.folder_id !== folderId)) {
        return res.status(400).json({ error: "Элементы должны быть в одной папке" });
      }
    }
    let order = 0;
    for (const id of intIds) {
      order += 1;
      await pool.query(`UPDATE gallery_items SET sort_order = $1 WHERE id = $2 AND room_slug = $3`, [order, id, req.galleryRoom]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("PUT /api/gallery/items/reorder", err);
    res.status(500).json({ error: "Не удалось сохранить порядок" });
  }
});

app.post(
  "/api/gallery/upload",
  requireAuth,
  requireGalleryRoom,
  (req, res, next) => {
    uploadGalleryImage.single("file")(req, res, (err) => {
      if (err) return res.status(400).json({ error: "Нужно изображение (JPEG, PNG, GIF, WebP) до 20 МБ" });
      next();
    });
  },
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "Нет файла" });
      let folderId = null;
      const rawF = req.body?.folderId;
      if (rawF != null && rawF !== "") {
        folderId = parseInt(rawF, 10);
        if (!Number.isInteger(folderId) || folderId < 1) {
          await fsp.unlink(req.file.path).catch(() => {});
          return res.status(400).json({ error: "Некорректный folderId" });
        }
        const { rows: fr } = await pool.query(`SELECT id FROM gallery_folders WHERE id = $1 AND room_slug = $2`, [folderId, req.galleryRoom]);
        if (!fr[0]) {
          await fsp.unlink(req.file.path).catch(() => {});
          return res.status(400).json({ error: "Папка не найдена" });
        }
      }
      const mime = normalizeContentTypeMime(req.file.mimetype || "");
      const ext = pickSafeExt({ ...req.file, mimetype: mime });
      const token = crypto.randomBytes(18).toString("hex");
      const storageKey = `gallery/${req.galleryRoom}/${token}${ext}`;
      const dest = path.join(UPLOAD_ROOT, storageKey);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.rename(req.file.path, dest);
      const origName = sanitizeOriginalName(req.file.originalname);
      const { rows: mx } = await pool.query(
        `SELECT COALESCE(MAX(sort_order), 0) AS m FROM gallery_items WHERE room_slug = $2 AND folder_id IS NOT DISTINCT FROM $1::integer`,
        [folderId, req.galleryRoom]
      );
      const sortOrder = (mx[0]?.m || 0) + 1;
      const { rows } = await pool.query(
        `INSERT INTO gallery_items (room_slug, folder_id, storage_key, original_name, mime, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, folder_id, original_name, mime, sort_order, created_at`,
        [req.galleryRoom, folderId, storageKey, origName, mime, sortOrder]
      );
      res.status(201).json({ item: rows[0] });
    } catch (err) {
      console.error("POST /api/gallery/upload", err);
      res.status(500).json({ error: "Не удалось загрузить файл" });
    }
  }
);

app.patch("/api/gallery/items/:id", requireAuth, requireGalleryRoom, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Некорректный id" });
    const { rows: ex } = await pool.query(`SELECT id, folder_id FROM gallery_items WHERE id = $1 AND room_slug = $2`, [id, req.galleryRoom]);
    if (!ex[0]) return res.status(404).json({ error: "Не найдено" });
    if (req.body?.folderId !== undefined) {
      let newFolderId = null;
      if (req.body.folderId != null && req.body.folderId !== "") {
        newFolderId = parseInt(req.body.folderId, 10);
        if (!Number.isInteger(newFolderId) || newFolderId < 1) {
          return res.status(400).json({ error: "Некорректный folderId" });
        }
        const { rows: fr } = await pool.query(`SELECT id FROM gallery_folders WHERE id = $1 AND room_slug = $2`, [newFolderId, req.galleryRoom]);
        if (!fr[0]) return res.status(400).json({ error: "Папка не найдена" });
      }
      await pool.query(`UPDATE gallery_items SET folder_id = $1 WHERE id = $2 AND room_slug = $3`, [newFolderId, id, req.galleryRoom]);
    }
    if (req.body?.sortOrder != null) {
      const so = parseInt(req.body.sortOrder, 10);
      if (!Number.isInteger(so)) return res.status(400).json({ error: "Некорректный sortOrder" });
      await pool.query(`UPDATE gallery_items SET sort_order = $1 WHERE id = $2 AND room_slug = $3`, [so, id, req.galleryRoom]);
    }
    const { rows } = await pool.query(
      `SELECT id, folder_id, original_name, mime, sort_order, created_at FROM gallery_items WHERE id = $1 AND room_slug = $2`,
      [id, req.galleryRoom]
    );
    res.json({ item: rows[0] });
  } catch (err) {
    console.error("PATCH /api/gallery/items/:id", err);
    res.status(500).json({ error: "Не удалось обновить" });
  }
});

app.delete("/api/gallery/items/:id", requireAuth, requireGalleryRoom, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Некорректный id" });
    const { rows } = await pool.query(`SELECT storage_key FROM gallery_items WHERE id = $1 AND room_slug = $2`, [id, req.galleryRoom]);
    if (!rows[0]) return res.status(404).json({ error: "Не найдено" });
    const key = rows[0].storage_key;
    await pool.query(`DELETE FROM gallery_items WHERE id = $1 AND room_slug = $2`, [id, req.galleryRoom]);
    if (key) await fsp.unlink(path.join(UPLOAD_ROOT, key)).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/gallery/items/:id", err);
    res.status(500).json({ error: "Не удалось удалить" });
  }
});

app.get("/api/gallery/file/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Некорректный id" });
    const { rows } = await pool.query(
      `SELECT storage_key, original_name, mime, room_slug FROM gallery_items WHERE id = $1`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Нет файла" });
    const roomSlug = rows[0].room_slug;
    const pw = getRoomPasswordFromRequest(req);
    const ok = await userCanAccessChannel(roomSlug, req.user.userId, pw);
    if (!ok) return res.status(403).json({ error: "Нет доступа к файлу" });
    const { storage_key: storageKey, original_name: oname, mime } = rows[0];
    const full = path.join(UPLOAD_ROOT, storageKey);
    if (!fs.existsSync(full)) return res.status(404).json({ error: "Файл отсутствует на диске" });
    const mimeNorm = normalizeContentTypeMime(mime || "") || "image/jpeg";
    res.setHeader("Content-Type", mimeNorm);
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(oname || "photo")}`);
    res.sendFile(full);
  } catch (err) {
    console.error("GET /api/gallery/file/:id", err);
    res.status(500).json({ error: "Ошибка" });
  }
});

/** Календарь канала: события по room_slug (как галерея) */
app.get("/api/calendar/events", requireAuth, async (req, res) => {
  try {
    const room = parseGalleryRoom(req);
    const ok = await userCanAccessChannel(room, req.user.userId, getRoomPasswordFromRequest(req));
    if (!ok) return res.status(403).json({ error: "Нет доступа к каналу" });
    const fromRaw = req.query.from;
    const toRaw = req.query.to;
    if (!fromRaw || !toRaw) return res.status(400).json({ error: "Нужны from и to (ISO)" });
    const from = new Date(String(fromRaw));
    const to = new Date(String(toRaw));
    if (Number.isNaN(+from) || Number.isNaN(+to)) return res.status(400).json({ error: "Некорректный диапазон дат" });
    const { rows } = await pool.query(
      `SELECT e.id, e.user_id AS "userId", e.title, e.notes, e.starts_at AS "startsAt", e.ends_at AS "endsAt",
              e.created_at AS "createdAt", u.nickname AS "creatorNickname"
         FROM channel_calendar_events e
         LEFT JOIN users u ON u.id = e.user_id
        WHERE e.room_slug = $1
          AND e.starts_at <= $3
          AND COALESCE(e.ends_at, e.starts_at) >= $2
        ORDER BY e.starts_at ASC`,
      [room, from, to]
    );
    res.json({ events: rows });
  } catch (err) {
    console.error("GET /api/calendar/events", err);
    res.status(500).json({ error: "Ошибка" });
  }
});

app.get("/api/calendar/upcoming", requireAuth, async (req, res) => {
  try {
    const room = parseGalleryRoom(req);
    const ok = await userCanAccessChannel(room, req.user.userId, getRoomPasswordFromRequest(req));
    if (!ok) return res.status(403).json({ error: "Нет доступа к каналу" });
    const lim = Math.min(30, Math.max(1, parseInt(String(req.query.limit || "12"), 10) || 12));
    const { rows } = await pool.query(
      `SELECT e.id, e.user_id AS "userId", e.title, e.notes, e.starts_at AS "startsAt", e.ends_at AS "endsAt",
              u.nickname AS "creatorNickname"
         FROM channel_calendar_events e
         LEFT JOIN users u ON u.id = e.user_id
        WHERE e.room_slug = $1 AND e.starts_at >= NOW()
        ORDER BY e.starts_at ASC
        LIMIT $2`,
      [room, lim]
    );
    res.json({ events: rows });
  } catch (err) {
    console.error("GET /api/calendar/upcoming", err);
    res.status(500).json({ error: "Ошибка" });
  }
});

app.post("/api/calendar/events", requireAuth, async (req, res) => {
  try {
    const room = String(req.body?.room ?? "").trim().toLowerCase() || "lobby";
    const ok = await userCanAccessChannel(room, req.user.userId, getRoomPasswordFromRequest(req));
    if (!ok) return res.status(403).json({ error: "Нет доступа к каналу" });
    const title = String(req.body?.title ?? "").trim().slice(0, 240);
    if (!title) return res.status(400).json({ error: "Нужен заголовок" });
    const notes = req.body?.notes != null ? String(req.body.notes).slice(0, 4000) : null;
    const startsAt = new Date(String(req.body?.startsAt ?? ""));
    if (Number.isNaN(+startsAt)) return res.status(400).json({ error: "Некорректное время начала" });
    let endsAt = null;
    if (req.body?.endsAt != null && req.body.endsAt !== "") {
      const e = new Date(String(req.body.endsAt));
      if (!Number.isNaN(+e)) endsAt = e;
    }
    const { rows } = await pool.query(
      `INSERT INTO channel_calendar_events (room_slug, user_id, title, notes, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, user_id AS "userId", title, notes, starts_at AS "startsAt", ends_at AS "endsAt", created_at AS "createdAt"`,
      [room, req.user.userId, title, notes || null, startsAt, endsAt]
    );
    res.status(201).json({ event: rows[0] });
  } catch (err) {
    console.error("POST /api/calendar/events", err);
    res.status(500).json({ error: "Не удалось создать событие" });
  }
});

app.patch("/api/calendar/events/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Некорректный id" });
    const { rows: evRows } = await pool.query(`SELECT * FROM channel_calendar_events WHERE id = $1`, [id]);
    const ev = evRows[0];
    if (!ev) return res.status(404).json({ error: "Событие не найдено" });
    const okRoom = await userCanAccessChannel(ev.room_slug, req.user.userId, getRoomPasswordFromRequest(req));
    if (!okRoom) return res.status(403).json({ error: "Нет доступа" });
    if (ev.user_id !== req.user.userId && !req.user.isAdmin) return res.status(403).json({ error: "Нельзя редактировать чужое событие" });
    const title =
      req.body?.title !== undefined ? String(req.body.title).trim().slice(0, 240) : ev.title;
    if (!title) return res.status(400).json({ error: "Пустой заголовок" });
    const notes =
      req.body?.notes !== undefined
        ? req.body.notes === null || req.body.notes === ""
          ? null
          : String(req.body.notes).slice(0, 4000)
        : ev.notes;
    let startsAt = ev.starts_at;
    if (req.body?.startsAt !== undefined) {
      const s = new Date(String(req.body.startsAt));
      if (Number.isNaN(+s)) return res.status(400).json({ error: "Некорректное время начала" });
      startsAt = s;
    }
    let endsAt = ev.ends_at;
    if (req.body?.endsAt !== undefined) {
      if (req.body.endsAt === null || req.body.endsAt === "") endsAt = null;
      else {
        const e = new Date(String(req.body.endsAt));
        if (!Number.isNaN(+e)) endsAt = e;
      }
    }
    const { rows } = await pool.query(
      `UPDATE channel_calendar_events
          SET title = $2, notes = $3, starts_at = $4, ends_at = $5
        WHERE id = $1
        RETURNING id, user_id AS "userId", title, notes, starts_at AS "startsAt", ends_at AS "endsAt", created_at AS "createdAt"`,
      [id, title, notes, startsAt, endsAt]
    );
    res.json({ event: rows[0] });
  } catch (err) {
    console.error("PATCH /api/calendar/events/:id", err);
    res.status(500).json({ error: "Не удалось обновить" });
  }
});

app.delete("/api/calendar/events/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Некорректный id" });
    const { rows: evRows } = await pool.query(`SELECT * FROM channel_calendar_events WHERE id = $1`, [id]);
    const ev = evRows[0];
    if (!ev) return res.status(404).json({ error: "Событие не найдено" });
    const okRoom = await userCanAccessChannel(ev.room_slug, req.user.userId, getRoomPasswordFromRequest(req));
    if (!okRoom) return res.status(403).json({ error: "Нет доступа" });
    if (ev.user_id !== req.user.userId && !req.user.isAdmin) return res.status(403).json({ error: "Нельзя удалить чужое событие" });
    await pool.query(`DELETE FROM channel_calendar_events WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/calendar/events/:id", err);
    res.status(500).json({ error: "Не удалось удалить" });
  }
});

app.post("/api/me/avatar", requireAuth, (req, res, next) => {
  uploadAvatar.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ error: "Нужен файл изображения до 2 МБ" });
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Нет файла" });
    const userId = req.user.userId;
    const { rows } = await pool.query(`SELECT avatar_storage_key FROM users WHERE id = $1`, [userId]);
    const old = rows[0]?.avatar_storage_key;
    const ext = pickSafeExt({ ...req.file, mimetype: normalizeContentTypeMime(req.file.mimetype) });
    const storageKey = `avatars/user_${userId}${ext}`;
    const dest = path.join(UPLOAD_ROOT, storageKey);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    if (old) {
      const prev = path.join(UPLOAD_ROOT, old);
      await fsp.unlink(prev).catch(() => {});
    }
    await fsp.rename(req.file.path, dest);
    await pool.query(`UPDATE users SET avatar_storage_key = $1 WHERE id = $2`, [storageKey, userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/me/avatar", err);
    res.status(500).json({ error: "Не удалось сохранить аватар" });
  }
});

app.get("/api/avatar/user/:userId", requireAuth, async (req, res) => {
  try {
    const uid = parseInt(req.params.userId, 10);
    if (!Number.isInteger(uid) || uid < 1) return res.status(400).json({ error: "Некорректный id" });
    const { rows } = await pool.query(`SELECT avatar_storage_key FROM users WHERE id = $1`, [uid]);
    const key = rows[0]?.avatar_storage_key;
    if (!key || !String(key).trim()) return res.status(404).json({ error: "Нет аватара" });
    const full = path.join(UPLOAD_ROOT, key);
    if (!fs.existsSync(full)) return res.status(404).json({ error: "Файл не найден" });
    res.sendFile(full);
  } catch (err) {
    console.error("GET /api/avatar/user/:userId", err);
    res.status(500).json({ error: "Ошибка" });
  }
});

app.get("/api/avatar/channel/:slug", requireAuth, async (req, res) => {
  try {
    const slug = req.params.slug;
    const rp = getRoomPasswordFromRequest(req);
    if (!(await userCanAccessChannel(slug, req.user.userId, rp))) {
      return res.status(403).json({ error: "Нет доступа" });
    }
    const { rows } = await pool.query(`SELECT avatar_storage_key FROM channels WHERE slug = $1 AND kind = 'public'`, [slug]);
    const key = rows[0]?.avatar_storage_key;
    if (!key || !String(key).trim()) return res.status(404).json({ error: "Нет иконки" });
    const full = path.join(UPLOAD_ROOT, key);
    if (!fs.existsSync(full)) return res.status(404).json({ error: "Файл не найден" });
    res.sendFile(full);
  } catch (err) {
    console.error("GET /api/avatar/channel/:slug", err);
    res.status(500).json({ error: "Ошибка" });
  }
});

app.post(
  "/api/rooms/:slug/avatar",
  requireAuth,
  (req, res, next) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: "Только для админов" });
    uploadChannelAvatar.single("file")(req, res, (err) => {
      if (err) return res.status(400).json({ error: "Нужен файл изображения до 2 МБ" });
      next();
    });
  },
  async (req, res) => {
    try {
      const slug = req.params.slug;
      if (/^saved-\d+$/i.test(slug) || slug.startsWith("dm-")) {
        return res.status(400).json({ error: "Некорректный канал" });
      }
      if (!req.file) return res.status(400).json({ error: "Нет файла" });
      const { rows } = await pool.query(`SELECT avatar_storage_key FROM channels WHERE slug = $1 AND kind = 'public'`, [slug]);
      if (!rows[0]) return res.status(404).json({ error: "Канал не найден" });
      const old = rows[0].avatar_storage_key;
      const ext = pickSafeExt({ ...req.file, mimetype: normalizeContentTypeMime(req.file.mimetype) });
      const storageKey = `avatars/ch_${crypto.createHash("sha256").update(slug).digest("hex").slice(0, 24)}${ext}`;
      const dest = path.join(UPLOAD_ROOT, storageKey);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      if (old) await fsp.unlink(path.join(UPLOAD_ROOT, old)).catch(() => {});
      await fsp.rename(req.file.path, dest);
      await pool.query(`UPDATE channels SET avatar_storage_key = $1 WHERE slug = $2 AND kind = 'public'`, [storageKey, slug]);
      res.json({ ok: true });
    } catch (err) {
      console.error("POST /api/rooms/:slug/avatar", err);
      res.status(500).json({ error: "Не удалось сохранить иконку канала" });
    }
  }
);

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
    const perms = await getUserPerms(user.id);
    try {
      ioInstance?.to("admins").emit("admin-users-changed", {
        reason: "registered",
        user: { id: user.id, nickname: user.nickname },
      });
    } catch (_) {}
    res.status(201).json({
      token,
      user: {
        id: user.id,
        nickname: user.nickname,
        isAdmin: !!perms.is_admin,
        hasAvatar: false,
        canSeeLobby: !!perms.can_see_lobby,
        canSeeDtd: !!perms.can_see_dtd,
        canSeeDtdWork: !!perms.can_see_dtd_work,
      },
    });
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

    const { rows: avRows } = await pool.query(
      `SELECT (avatar_storage_key IS NOT NULL AND TRIM(avatar_storage_key) <> '') AS ha FROM users WHERE id = $1`,
      [user.id]
    );
    const token = signToken(user.id);
    const perms = await getUserPerms(user.id);
    res.json({
      token,
      user: {
        id: user.id,
        nickname: user.nickname,
        isAdmin: !!perms.is_admin,
        hasAvatar: !!avRows[0]?.ha,
        canSeeLobby: !!perms.can_see_lobby,
        canSeeDtd: !!perms.can_see_dtd,
        canSeeDtdWork: !!perms.can_see_dtd_work,
      },
    });
  } catch (err) {
    console.error("POST /api/auth/login", err);
    res.status(500).json({ error: "Ошибка входа" });
  }
});

// ─── Admin API ────────────────────────────────────────────────────────────────

app.get("/api/admin/users", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nickname, is_admin, can_see_lobby, can_see_dtd, can_see_dtd_work, created_at
       FROM users ORDER BY id`
    );
    res.json({ users: rows });
  } catch (err) {
    console.error("GET /api/admin/users", err);
    res.status(500).json({ error: "Ошибка" });
  }
});

app.patch("/api/admin/users/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    if (!Number.isInteger(targetId) || targetId < 1) {
      return res.status(400).json({ error: "Некорректный id" });
    }
    const allowed = ["is_admin", "can_see_lobby", "can_see_dtd", "can_see_dtd_work"];
    const updates = {};
    for (const key of allowed) {
      if (key in req.body) updates[key] = !!req.body[key];
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "Нет полей для обновления" });
    }
    const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(", ");
    const values = [targetId, ...Object.values(updates)];
    const { rows } = await pool.query(
      `UPDATE users SET ${setClauses} WHERE id = $1
       RETURNING id, nickname, is_admin, can_see_lobby, can_see_dtd, can_see_dtd_work`,
      values
    );
    if (!rows[0]) return res.status(404).json({ error: "Пользователь не найден" });
    res.json({ user: rows[0] });
  } catch (err) {
    console.error("PATCH /api/admin/users/:id", err);
    res.status(500).json({ error: "Ошибка обновления" });
  }
});

// ─── Auth ──────────────────────────────────────────────────────────────────────

app.post("/api/auth/change-password", requireAuth, async (req, res) => {
  try {
    const currentPassword = String(req.body?.currentPassword ?? "");
    const newPassword = sanitizePassword(req.body?.newPassword);
    if (!currentPassword) {
      return res.status(400).json({ error: "Укажите текущий пароль" });
    }
    if (!newPassword) {
      return res.status(400).json({
        error: `Новый пароль: от ${MIN_PASSWORD_LEN} до ${MAX_PASSWORD_LEN} символов`,
      });
    }

    const { rows } = await pool.query(
      `SELECT id, password_hash FROM users WHERE id = $1`,
      [req.user.userId]
    );
    const row = rows[0];
    if (!row?.password_hash) {
      return res.status(401).json({ error: "Нельзя сменить пароль для этого аккаунта" });
    }
    const ok = await bcrypt.compare(currentPassword, row.password_hash);
    if (!ok) {
      return res.status(400).json({ error: "Неверный текущий пароль" });
    }

    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, row.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/auth/change-password", err);
    res.status(500).json({ error: "Не удалось сменить пароль" });
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
    if (slug === GALLERY_ROOM_SLUG) {
      return res.json({ room: slug, title: "Галерея", messages: [] });
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
    const mimeNorm = normalizeContentTypeMime(row.attachment_mime || "") || "application/octet-stream";
    res.setHeader("Content-Type", mimeNorm);
    const disp =
      IMAGE_MIMES.has(mimeNorm) ||
      VIDEO_NOTE_MIMES.has(mimeNorm) ||
      VOICE_MIMES.has(mimeNorm)
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
    if (slug === GALLERY_ROOM_SLUG) {
      return res.status(400).json({ error: "Галерея — не чат" });
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

    const videoNote = isVideoNoteRequest(req);
    const formatted = await saveNewMessageWithOptionalFile({
      room: slug,
      userId,
      text: req.body?.text,
      replyToId,
      multerFile: req.file || null,
      videoNote,
      voiceMessage: !videoNote && isVoiceMessageRequest(req),
    });
    io.to(slug).emit("message", formatted);
    if (formatted) {
      void dispatchMentionNotifications(io, {
        room: slug,
        formatted,
        senderUserId: userId,
        text: normalizedText || "",
      });
      void dispatchNewMessagePush({
        room: slug,
        formatted,
        senderUserId: userId,
        text: normalizedText || (req.file ? "Вложение" : ""),
      });
    }
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
ioInstance = io;

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token || typeof token !== "string") {
      return next(new Error("Требуется вход"));
    }
    const payload = jwt.verify(token, JWT_SECRET);
    const { rows } = await pool.query(
      `SELECT id, nickname, password_hash, is_admin FROM users WHERE id = $1`,
      [payload.userId]
    );
    const user = rows[0];
    if (!user?.password_hash) {
      return next(new Error("Пользователь не найден"));
    }
    socket.data.userId = user.id;
    socket.data.nickname = user.nickname;
    socket.data.isAdmin = !!user.is_admin;
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
    if (slug === GALLERY_ROOM_SLUG) {
      return res.status(400).json({ error: "Галерея — не чат" });
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
      void dispatchMentionNotifications(io, { room: slug, formatted, senderUserId: userId, text: body });
      void dispatchNewMessagePush({ room: slug, formatted, senderUserId: userId, text: body });
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
    let rows;
    if (req.user.isAdmin) {
      ({ rows } = await pool.query(
        `SELECT id, room FROM messages WHERE id = $1 AND deleted_at IS NULL`, [id]
      ));
    } else {
      ({ rows } = await pool.query(
        `SELECT id, room FROM messages WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [id, req.user.userId]
      ));
    }
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

    const history = slug === GALLERY_ROOM_SLUG ? [] : await getLastMessages(slug, 50);
    const title =
      slug === GALLERY_ROOM_SLUG ? "Галерея" : await getChannelTitleForUser(slug, uid);
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
  const uid0 = socket.data.userId;
  if (uid0 != null) {
    socket.join(`user:${uid0}`);
  }
  if (socket.data.isAdmin) {
    socket.join("admins");
  }
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
      if (slug === GALLERY_ROOM_SLUG) {
        const e = { ok: false, error: "Галерея — не чат" };
        if (typeof ack === "function") ack(e);
        socket.emit("error-toast", e);
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
        void dispatchMentionNotifications(io, { room: slug, formatted, senderUserId: uid, text: body });
        void dispatchNewMessagePush({ room: slug, formatted, senderUserId: uid, text: body });
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
      const userIsAdmin = isAdmin(socket.data.nickname);
      let rows;
      if (userIsAdmin) {
        ({ rows } = await pool.query(
          `SELECT id, room FROM messages WHERE id = $1 AND deleted_at IS NULL`, [id]
        ));
      } else {
        ({ rows } = await pool.query(
          `SELECT id, room FROM messages WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
          [id, uid]
        ));
      }
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
  await ensureAvatarSchema();
  await ensureGallerySchema();
  await ensureCalendarSchema();
  await ensureUserPermissionsSchema();
  await ensurePushSchema();
  await ensureUserOllamaChatSchema();
  await ensureUserOllamaPrefsSchema();
  await ensureUserAiFactsSchema();
  initFcmIfPossible();
  ensureUploadDirs();
  server.listen(PORT, () => {
    console.log(`Сервер: http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Не удалось запустить сервер:", err);
  process.exit(1);
});
