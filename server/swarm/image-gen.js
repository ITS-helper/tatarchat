/**
 * Генерация через локальный SwarmUI (HTTP API: /API/GetNewSession, /API/GenerateText2Image, /API/ListT2IParams).
 * SwarmUI сам может поднимать ComfyUI/Self-Start, но для сайта мы общаемся только со SwarmUI.
 */
/* eslint-disable no-console */
"use strict";

const crypto = require("crypto");

function normalizeSwarmBaseUrl(raw) {
  const s = String(raw || "")
    .trim()
    .replace(/\/$/, "");
  if (!s) return "";
  try {
    const u = new URL(s);
    if (u.hostname === "localhost") u.hostname = "127.0.0.1";
    return u.toString().replace(/\/$/, "");
  } catch {
    return s;
  }
}

const SWARMUI_BASE_URL = normalizeSwarmBaseUrl(process.env.SWARMUI_BASE_URL || process.env.SWARM_BASE_URL || "");

function swarmApiUrl(route) {
  const base = SWARMUI_BASE_URL.replace(/\/$/, "");
  const rel = String(route || "").replace(/^\//, "");
  return `${base}/${rel}`;
}

const SWARMUI_TIMEOUT_MS = Math.min(Math.max(Number(process.env.SWARMUI_TIMEOUT_MS) || 240_000, 30_000), 900_000);

const MAX_SWARM_PROMPT_CHARS = Math.min(Math.max(Number(process.env.MAX_SWARM_PROMPT_CHARS) || 1500, 200), 4000);
const SWARM_MAX_STEPS = Math.min(Math.max(Number(process.env.SWARM_MAX_STEPS) || 35, 8), 80);
const SWARM_MAX_SIDE = Math.min(Math.max(Number(process.env.SWARM_MAX_SIDE) || 1024, 256), 4096);

const SWARM_CFG_RAW = Number(process.env.SWARM_CFG_SCALE);
const SWARM_CFG_SCALE = Number.isFinite(SWARM_CFG_RAW) ? Math.max(1, Math.min(30, SWARM_CFG_RAW)) : 7;

const SWARM_DEFAULT_MODEL = String(process.env.SWARM_DEFAULT_MODEL || "").trim();
const SWARM_PRESET_TXT2IMG = String(process.env.SWARM_PRESET_TXT2IMG || "").trim();
const SWARM_PRESET_IMG2IMG = String(process.env.SWARM_PRESET_IMG2IMG || "").trim();

function isSwarmConfigured() {
  return Boolean(SWARMUI_BASE_URL);
}

function sanitizePrompt(s, maxLen = MAX_SWARM_PROMPT_CHARS) {
  return String(s ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, maxLen);
}

function sanitizeModel(raw) {
  const s = String(raw ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, 384);
  if (!s) return "";
  return s;
}

function maybePresetForMode(mode) {
  if (mode === "img2img") return SWARM_PRESET_IMG2IMG || "";
  if (mode === "txt2img") return SWARM_PRESET_TXT2IMG || "";
  return "";
}

function withPreset(body, mode) {
  const p = maybePresetForMode(mode);
  if (!p) return body;
  return { ...(body || {}), presets: [p] };
}

function snapSide(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 512;
  const clamped = Math.max(256, Math.min(SWARM_MAX_SIDE, Math.floor(x)));
  // Swarm/SD обычно ждёт кратность 8
  return Math.floor(clamped / 8) * 8;
}

let cachedSession = "";
let cachedSessionAt = 0;

async function postJson(url, body, { timeoutMs = SWARMUI_TIMEOUT_MS } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body || {}),
      signal: ac.signal,
    });
    const txt = await res.text();
    let data = {};
    try {
      data = txt ? JSON.parse(txt) : {};
    } catch {
      data = {};
    }
    return { ok: res.ok, status: res.status, data, text: txt };
  } finally {
    clearTimeout(timer);
  }
}

async function ensureSession() {
  if (!isSwarmConfigured()) return "";
  // простая защита: обновлять раз в ~12 часов
  if (cachedSession && Date.now() - cachedSessionAt < 12 * 60 * 60 * 1000) return cachedSession;
  const r = await postJson(swarmApiUrl("API/GetNewSession"), {});
  const sid = String(r.data?.session_id || "").trim();
  if (!sid) throw new Error("swarm_no_session");
  cachedSession = sid;
  cachedSessionAt = Date.now();
  return cachedSession;
}

function isInvalidSessionReply(obj) {
  const eid = String(obj?.error_id || "").trim();
  return eid === "invalid_session_id";
}

function swarmErrorToException(obj, fallbackMsg = "SwarmUI error") {
  const msg = String(obj?.error || fallbackMsg).trim() || fallbackMsg;
  const err = new Error("swarm_api_error");
  err.detail = msg.slice(0, 900);
  err.error_id = String(obj?.error_id || "").trim();
  return err;
}

async function callSwarm(route, body, { retryInvalidSession = true } = {}) {
  const url = swarmApiUrl(route);
  const r = await postJson(url, body);
  if (r.ok && r.data && !r.data.error && !r.data.error_id) return r.data;
  if (retryInvalidSession && isInvalidSessionReply(r.data)) {
    cachedSession = "";
    cachedSessionAt = 0;
    const sid = await ensureSession();
    const r2 = await postJson(url, { ...(body || {}), session_id: sid });
    if (r2.ok && r2.data && !r2.data.error && !r2.data.error_id) return r2.data;
    throw swarmErrorToException(r2.data, `HTTP ${r2.status}`);
  }
  if (r.data && (r.data.error || r.data.error_id)) throw swarmErrorToException(r.data, `HTTP ${r.status}`);
  const err = new Error(`swarm_http_${r.status}`);
  err.detail = String(r.text || "").slice(0, 800);
  throw err;
}

async function fetchT2IParams() {
  const sid = await ensureSession();
  return callSwarm("API/ListT2IParams", { session_id: sid });
}

async function fetchModelTitles() {
  const p = await fetchT2IParams();
  const models = p?.models;
  const sd = models?.["Stable-Diffusion"];
  const list = Array.isArray(sd) ? sd.map((x) => String(x || "").trim()).filter(Boolean) : [];
  const uniq = [...new Set(list)];
  uniq.sort((a, b) => a.localeCompare(b, "en"));
  return uniq;
}

async function fetchFirstImageAsBase64(imagePathOrDataUrl) {
  const s = String(imagePathOrDataUrl || "").trim();
  if (!s) throw new Error("swarm_empty_image");
  if (s.startsWith("data:")) {
    const m = /^data:([^;]+);base64,(.*)$/i.exec(s);
    if (!m) throw new Error("swarm_bad_data_url");
    const mimeType = m[1] || "image/png";
    const b64 = m[2] || "";
    if (!b64) throw new Error("swarm_empty_data_url");
    return { base64: b64, mimeType };
  }
  const url = swarmApiUrl(s.replace(/^\//, ""));
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SWARMUI_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) {
      const err = new Error(`swarm_view_http_${res.status}`);
      err.detail = `Не удалось скачать картинку: ${s}`.slice(0, 400);
      throw err;
    }
    const mimeType = String(res.headers.get("content-type") || "").split(";")[0].trim() || "image/png";
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error("swarm_empty_image_buffer");
    return { base64: buf.toString("base64"), mimeType };
  } finally {
    clearTimeout(timer);
  }
}

async function runTxt2img({ prompt, negativePrompt, steps, width, height, model }) {
  if (!isSwarmConfigured()) throw new Error("swarm_not_configured");
  const sid = await ensureSession();
  const p = sanitizePrompt(prompt);
  if (!p) throw new Error("swarm_empty_prompt");
  const neg = sanitizePrompt(negativePrompt || "");
  const mRaw = sanitizeModel(model) || SWARM_DEFAULT_MODEL || "";
  const preset = maybePresetForMode("txt2img");
  if (!mRaw && !preset) {
    const err = new Error("swarm_model_required");
    err.detail = "Нужна модель или preset: выбери модель в UI, либо задай SWARM_DEFAULT_MODEL или SWARM_PRESET_TXT2IMG в .env.";
    throw err;
  }

  const body0 = {
    session_id: sid,
    images: 1,
    prompt: p,
    negativeprompt: neg,
    width: snapSide(width),
    height: snapSide(height),
    steps: Math.max(8, Math.min(SWARM_MAX_STEPS, Math.floor(Number(steps) || 25))),
    cfgscale: SWARM_CFG_SCALE,
    seed: -1,
    request_id: crypto.randomUUID(),
  };
  // Если модель содержит запятую (например ",z-image"), это часто означает не стандартный SD checkpoint.
  // В таких случаях лучше полагаться на preset/workflow в SwarmUI, иначе API может отклонить значение.
  const useModel = mRaw && !mRaw.includes(",");
  const body = withPreset(useModel ? { ...body0, model: mRaw } : body0, "txt2img");
  const out = await callSwarm("API/GenerateText2Image", body);
  const first = Array.isArray(out?.images) ? out.images[0] : "";
  return fetchFirstImageAsBase64(first);
}

function bufferToDataUrl(buf, mimeType) {
  const b64 = Buffer.from(buf).toString("base64");
  return `data:${mimeType || "image/png"};base64,${b64}`;
}

async function runImg2imgOrInpaint({ prompt, negativePrompt, steps, width, height, initImageBuffer, initImageMime, maskBuffer, maskMime, denoisingStrength, model }) {
  if (!isSwarmConfigured()) throw new Error("swarm_not_configured");
  const sid = await ensureSession();
  const p = sanitizePrompt(prompt);
  if (!p) throw new Error("swarm_empty_prompt");
  const neg = sanitizePrompt(negativePrompt || "");
  const mRaw = sanitizeModel(model) || SWARM_DEFAULT_MODEL || "";
  const preset = maybePresetForMode("img2img");
  if (!mRaw && !preset) {
    const err = new Error("swarm_model_required");
    err.detail = "Нужна модель или preset: выбери модель в UI, либо задай SWARM_DEFAULT_MODEL или SWARM_PRESET_IMG2IMG в .env.";
    throw err;
  }
  const initUrl = bufferToDataUrl(initImageBuffer, initImageMime || "image/png");
  const hasMask = typeof maskBuffer?.length === "number" && maskBuffer.length > 0;
  const maskUrl = hasMask ? bufferToDataUrl(maskBuffer, maskMime || "image/png") : null;
  const dn = Number(denoisingStrength);
  const den = Number.isFinite(dn) ? Math.max(0.05, Math.min(0.95, dn)) : 0.55;

  const body0 = {
    session_id: sid,
    images: 1,
    prompt: p,
    negativeprompt: neg,
    width: snapSide(width),
    height: snapSide(height),
    steps: Math.max(8, Math.min(SWARM_MAX_STEPS, Math.floor(Number(steps) || 25))),
    cfgscale: SWARM_CFG_SCALE,
    seed: -1,
    request_id: crypto.randomUUID(),
    // Swarm common parameter ids (unrecognized will be ignored by Swarm; we send the expected ones)
    initimage: initUrl,
    denoise_strength: den,
    denoising_strength: den,
    denoise: den,
  };
  if (maskUrl) {
    body.maskimage = maskUrl;
    body.mask_image = maskUrl;
  }

  const useModel = mRaw && !mRaw.includes(",");
  const body = withPreset(useModel ? { ...body0, model: mRaw } : body0, "img2img");
  const out = await callSwarm("API/GenerateText2Image", body);
  const first = Array.isArray(out?.images) ? out.images[0] : "";
  return fetchFirstImageAsBase64(first);
}

function handleSwarmError(e, res, logLabel) {
  if (e?.name === "AbortError") return res.status(504).json({ error: "Генерация слишком долгая (таймаут SwarmUI)" });
  if (String(e?.message) === "swarm_not_configured") {
    return res.status(503).json({
      error: "Генерация не настроена: задайте SWARMUI_BASE_URL в .env на сервере и перезапустите Node.",
    });
  }
  if (String(e?.message) === "swarm_empty_prompt") return res.status(400).json({ error: "Пустой промпт" });
  if (String(e?.message) === "swarm_model_required") {
    return res.status(400).json({ error: "Нужна модель (model) или SWARM_DEFAULT_MODEL в .env.", detail: e?.detail });
  }
  if (String(e?.message) === "swarm_api_error") {
    console.error(`[swarm] ${logLabel}:`, e?.error_id || "", e?.detail || "");
    return res.status(502).json({ error: "SwarmUI вернул ошибку.", detail: String(e?.detail || "").slice(0, 600) });
  }
  if (String(e?.message || "").startsWith("swarm_http_") || String(e?.message || "").startsWith("swarm_view_http_")) {
    console.error(`[swarm] ${logLabel} http:`, e?.detail || e?.message);
    return res.status(502).json({ error: "SwarmUI недоступен по HTTP.", detail: String(e?.detail || "").slice(0, 240) || undefined });
  }
  const causeMsg = String(e?.cause?.message || e?.cause || "");
  const topMsg = String(e?.message || "");
  const connHint =
    e?.cause?.code === "ECONNREFUSED" ||
    e?.code === "ECONNREFUSED" ||
    /ECONNREFUSED|fetch failed|getaddrinfo|ENOTFOUND|ConnectTimeoutError/i.test(topMsg + causeMsg);
  if (connHint) {
    console.error("[swarm] connect:", topMsg || causeMsg, e?.cause?.code || "");
    return res.status(502).json({
      error: "Не удаётся подключиться к SwarmUI. Запусти SwarmUI и проверь SWARMUI_BASE_URL (обычно http://127.0.0.1:7801).",
      detail: (topMsg || causeMsg).trim().slice(0, 240) || undefined,
    });
  }
  console.error(`POST /api/ai/image (${logLabel})`, e);
  return res.status(500).json({ error: "Ошибка генерации", detail: topMsg.trim().slice(0, 240) || undefined });
}

function logStartupInfo() {
  if (!SWARMUI_BASE_URL) {
    console.log("[swarm] Нет SWARMUI_BASE_URL — генерация картинок выключена.");
    return;
  }
  console.log(`[swarm] SWARMUI_BASE_URL=${SWARMUI_BASE_URL}`);
  if (SWARM_DEFAULT_MODEL) console.log(`[swarm] SWARM_DEFAULT_MODEL=${SWARM_DEFAULT_MODEL}`);
  if (SWARM_PRESET_TXT2IMG) console.log(`[swarm] SWARM_PRESET_TXT2IMG=${SWARM_PRESET_TXT2IMG}`);
  if (SWARM_PRESET_IMG2IMG) console.log(`[swarm] SWARM_PRESET_IMG2IMG=${SWARM_PRESET_IMG2IMG}`);
  console.log(`[swarm] cfg_scale=${SWARM_CFG_SCALE} timeout_ms=${SWARMUI_TIMEOUT_MS}`);
}

module.exports = {
  SWARMUI_BASE_URL,
  isSwarmConfigured,
  MAX_SWARM_PROMPT_CHARS,
  SWARM_MAX_STEPS,
  SWARM_MAX_SIDE,
  SWARM_CFG_SCALE,
  sanitizePrompt,
  sanitizeModel,
  snapSide,
  fetchModelTitles,
  runTxt2img,
  runImg2imgOrInpaint,
  handleSwarmError,
  logStartupInfo,
};

