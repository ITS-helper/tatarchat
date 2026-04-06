/**
 * Генерация через локальный ComfyUI (HTTP API: POST /prompt, poll /history, GET /view).
 * Шаблоны workflow — JSON из ComfyUI «Save (API Format)» с плейсхолдерами <<<TC_*>>> (см. README в workflows/).
 */
"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

function normalizeComfyBaseUrl(raw) {
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

const COMFYUI_BASE_URL = normalizeComfyBaseUrl(
  process.env.COMFYUI_BASE_URL ||
    process.env.SD_COMFYUI_BASE_URL ||
    process.env.COMFY_BASE_URL ||
    ""
);

function comfyUrl(relPath) {
  const base = COMFYUI_BASE_URL.replace(/\/$/, "");
  const rel = String(relPath || "").replace(/^\//, "");
  return `${base}/${rel}`;
}

const COMFYUI_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.COMFYUI_TIMEOUT_MS || process.env.SD_WEBUI_TIMEOUT_MS) || 240_000, 45_000),
  900_000
);
const COMFY_POLL_MS = Math.min(Math.max(Number(process.env.COMFY_POLL_MS) || 400, 100), 2000);

const MAX_COMFY_PROMPT_CHARS = Math.min(
  Math.max(Number(process.env.MAX_COMFY_PROMPT_CHARS || process.env.MAX_SD_PROMPT_CHARS) || 1500, 200),
  4000
);
const COMFY_MAX_STEPS = Math.min(Math.max(Number(process.env.COMFY_MAX_STEPS || process.env.SD_MAX_STEPS) || 35, 8), 60);
const COMFY_MAX_SIDE = Math.min(Math.max(Number(process.env.COMFY_MAX_SIDE || process.env.SD_MAX_SIDE) || 1024, 320), 2048);

const COMFY_CFG_RAW = Number(process.env.COMFY_CFG_SCALE ?? process.env.SD_CFG_SCALE);
const COMFY_CFG_SCALE = Number.isFinite(COMFY_CFG_RAW) ? Math.max(1, Math.min(30, COMFY_CFG_RAW)) : 1;

const COMFY_DEFAULT_CHECKPOINT = String(process.env.COMFY_DEFAULT_CHECKPOINT || "").trim();

const SD_CHECKPOINT_VALUE_MAX = 384;

function resolveWorkflowPath(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (path.isAbsolute(s)) return s;
  return path.resolve(__dirname, "..", s);
}

const COMFY_TXT2IMG_WORKFLOW = resolveWorkflowPath(process.env.COMFY_TXT2IMG_WORKFLOW);
const COMFY_IMG2IMG_WORKFLOW = resolveWorkflowPath(process.env.COMFY_IMG2IMG_WORKFLOW || "");
const COMFY_INPAINT_WORKFLOW = resolveWorkflowPath(process.env.COMFY_INPAINT_WORKFLOW || "");

function fileExists(p) {
  try {
    return p && fs.existsSync(p);
  } catch {
    return false;
  }
}

function isComfyConfigured() {
  return Boolean(COMFYUI_BASE_URL && COMFY_TXT2IMG_WORKFLOW && fileExists(COMFY_TXT2IMG_WORKFLOW));
}

function isComfyImg2imgConfigured() {
  return isComfyConfigured() && COMFY_IMG2IMG_WORKFLOW && fileExists(COMFY_IMG2IMG_WORKFLOW);
}

function isComfyInpaintConfigured() {
  if (!isComfyConfigured()) return false;
  if (COMFY_INPAINT_WORKFLOW && fileExists(COMFY_INPAINT_WORKFLOW)) return true;
  return isComfyImg2imgConfigured();
}

function sanitizePrompt(s, maxLen = MAX_COMFY_PROMPT_CHARS) {
  return String(s ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, maxLen);
}

function sanitizeCheckpoint(raw) {
  return String(raw ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, SD_CHECKPOINT_VALUE_MAX);
}

function escapeJsonString(s) {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function parseCheckpointTitlesFromEnv() {
  const raw = String(process.env.COMFY_CHECKPOINT_TITLES || process.env.SD_CHECKPOINT_TITLES || "").trim();
  if (!raw) return [];
  const chunks = /[\n|]/.test(raw)
    ? raw.split(/\r?\n|[|]/).flatMap((line) => line.split(";"))
    : raw.split(",").map((s) => s.trim());
  const out = [];
  const seen = new Set();
  for (const c of chunks) {
    const t = sanitizeCheckpoint(c);
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
      if (out.length >= 200) break;
    }
  }
  out.sort((a, b) => a.localeCompare(b, "en"));
  return out;
}

/**
 * Подстановка плейсхолдеров в сырой JSON-строке шаблона (до JSON.parse).
 */
function buildWorkflowFromTemplateString(templateStr, params) {
  const {
    prompt,
    negative,
    steps,
    width,
    height,
    seed,
    cfg,
    denoise,
    loadImage,
    loadMask,
    checkpoint,
  } = params;
  let s = templateStr;
  s = s.replace(/<<<TC_PROMPT>>>/g, escapeJsonString(prompt));
  s = s.replace(/<<<TC_NEGATIVE>>>/g, escapeJsonString(negative));
  s = s.replace(/<<<TC_STEPS>>>/g, String(steps));
  s = s.replace(/<<<TC_WIDTH>>>/g, String(width));
  s = s.replace(/<<<TC_HEIGHT>>>/g, String(height));
  s = s.replace(/<<<TC_SEED>>>/g, String(seed));
  s = s.replace(/<<<TC_CFG>>>/g, String(cfg));
  s = s.replace(/<<<TC_DENOISE>>>/g, String(denoise));
  if (loadImage != null) s = s.replace(/<<<TC_LOAD_IMAGE>>>/g, escapeJsonString(loadImage));
  if (loadMask != null) s = s.replace(/<<<TC_LOAD_MASK>>>/g, escapeJsonString(loadMask));
  if (checkpoint != null) s = s.replace(/<<<TC_CHECKPOINT>>>/g, escapeJsonString(checkpoint));
  try {
    return JSON.parse(s);
  } catch (e) {
    const err = new Error("comfy_invalid_workflow_json");
    err.detail = String(e?.message || e).slice(0, 400);
    throw err;
  }
}

async function comfyUploadImageBuffer(buffer, filename = "upload.png") {
  const form = new FormData();
  const blob = new Blob([buffer], { type: "application/octet-stream" });
  form.append("image", blob, filename);
  form.append("type", "input");
  form.append("overwrite", "true");
  const url = comfyUrl("upload/image");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), COMFYUI_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "POST", body: form, signal: ac.signal });
    const txt = await res.text();
    let data = {};
    try {
      data = txt ? JSON.parse(txt) : {};
    } catch {
      data = {};
    }
    if (!res.ok) {
      const err = new Error(`comfy_upload_http_${res.status}`);
      err.detail = txt.slice(0, 800);
      throw err;
    }
    const name = typeof data.name === "string" ? data.name.trim() : "";
    if (!name) {
      const err = new Error("comfy_upload_no_name");
      err.detail = txt.slice(0, 400);
      throw err;
    }
    return name;
  } finally {
    clearTimeout(timer);
  }
}

async function comfyPostPrompt(workflow) {
  const client_id = crypto.randomUUID();
  const url = comfyUrl("prompt");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), COMFYUI_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id }),
      signal: ac.signal,
    });
    const txt = await res.text();
    let data = {};
    try {
      data = txt ? JSON.parse(txt) : {};
    } catch {
      data = {};
    }
    if (data.error) {
      const err = new Error("comfy_prompt_validation");
      err.detail = JSON.stringify(data.error).slice(0, 1500);
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`comfy_prompt_http_${res.status}`);
      err.detail = txt.slice(0, 1500);
      throw err;
    }
    const prompt_id = data.prompt_id;
    if (!prompt_id) {
      const err = new Error("comfy_prompt_no_id");
      err.detail = txt.slice(0, 500);
      throw err;
    }
    return { prompt_id, client_id };
  } finally {
    clearTimeout(timer);
  }
}

async function comfyFetchHistory(prompt_id) {
  const url = comfyUrl(`history/${encodeURIComponent(prompt_id)}`);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.min(60_000, COMFYUI_TIMEOUT_MS));
  try {
    const res = await fetch(url, { signal: ac.signal });
    const txt = await res.text();
    let data = {};
    try {
      data = txt ? JSON.parse(txt) : {};
    } catch {
      data = {};
    }
    if (!res.ok) return null;
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function extractFirstImageMeta(historyRoot, prompt_id) {
  const entry = historyRoot[prompt_id];
  if (!entry || !entry.outputs) return null;
  for (const nodeId of Object.keys(entry.outputs)) {
    const out = entry.outputs[nodeId];
    if (!out?.images?.length) continue;
    const img = out.images[0];
    if (typeof img.filename === "string" && img.filename) {
      return {
        filename: img.filename,
        subfolder: typeof img.subfolder === "string" ? img.subfolder : "",
        type: typeof img.type === "string" ? img.type : "output",
      };
    }
  }
  return null;
}

function historyEntryErrorMessage(entry) {
  const st = entry?.status;
  if (st?.status_str === "error" || st?.status_str === "failed") {
    return String(st?.messages?.[0] || st?.message || "execution error").slice(0, 800);
  }
  const msgs = entry?.status?.messages;
  if (Array.isArray(msgs) && msgs.length) {
    const t = msgs.map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join("; ");
    if (/error/i.test(t)) return t.slice(0, 800);
  }
  return "";
}

async function comfyFetchImageBuffer(meta) {
  const u = new URL(comfyUrl("view"));
  u.searchParams.set("filename", meta.filename);
  u.searchParams.set("subfolder", meta.subfolder || "");
  u.searchParams.set("type", meta.type || "output");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), COMFYUI_TIMEOUT_MS);
  try {
    const res = await fetch(u.toString(), { signal: ac.signal });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function runComfyUntilImage(workflow) {
  const { prompt_id } = await comfyPostPrompt(workflow);
  const deadline = Date.now() + COMFYUI_TIMEOUT_MS;
  let lastHist = null;
  while (Date.now() < deadline) {
    const hist = await comfyFetchHistory(prompt_id);
    lastHist = hist;
    if (hist && hist[prompt_id]) {
      const entry = hist[prompt_id];
      const errMsg = historyEntryErrorMessage(entry);
      if (errMsg) {
        const err = new Error("comfy_execution_error");
        err.detail = errMsg;
        throw err;
      }
      const meta = extractFirstImageMeta(hist, prompt_id);
      if (meta) {
        const buf = await comfyFetchImageBuffer(meta);
        if (buf?.length) {
          const mime =
            meta.filename.toLowerCase().endsWith(".jpg") || meta.filename.toLowerCase().endsWith(".jpeg")
              ? "image/jpeg"
              : meta.filename.toLowerCase().endsWith(".webp")
                ? "image/webp"
                : "image/png";
          return { base64: buf.toString("base64"), mimeType: mime };
        }
      }
    }
    await new Promise((r) => setTimeout(r, COMFY_POLL_MS));
  }
  const err = new Error("comfy_timeout");
  err.detail = lastHist ? JSON.stringify(lastHist).slice(0, 400) : "";
  throw err;
}

function snapSide(n) {
  return Math.max(256, Math.min(COMFY_MAX_SIDE, Math.floor(n / 8) * 8));
}

async function runTxt2img({ prompt, negativePrompt, steps, width, height, checkpoint }) {
  if (!isComfyConfigured()) {
    const err = new Error("comfy_not_configured");
    throw err;
  }
  const raw = await fsp.readFile(COMFY_TXT2IMG_WORKFLOW, "utf8");
  if (raw.includes("<<<TC_CHECKPOINT>>>")) {
    const cp = sanitizeCheckpoint(checkpoint) || COMFY_DEFAULT_CHECKPOINT;
    if (!cp) {
      const err = new Error("comfy_checkpoint_required");
      err.detail = "В шаблоне есть <<<TC_CHECKPOINT>>>, но не выбрана модель и не задан COMFY_DEFAULT_CHECKPOINT в .env.";
      throw err;
    }
  }
  const seed = Math.floor(Math.random() * 2147483647);
  const cp = sanitizeCheckpoint(checkpoint) || COMFY_DEFAULT_CHECKPOINT || "";
  const wf = buildWorkflowFromTemplateString(raw, {
    prompt,
    negative: negativePrompt || "",
    steps,
    width,
    height,
    seed,
    cfg: COMFY_CFG_SCALE,
    denoise: 0.55,
    loadImage: null,
    loadMask: null,
    checkpoint: cp || null,
  });
  return runComfyUntilImage(wf);
}

async function runImg2imgOrInpaint({
  prompt,
  negativePrompt,
  steps,
  width,
  height,
  initImageBuffer,
  maskBuffer,
  denoisingStrength,
  checkpoint,
}) {
  const hasMask = typeof maskBuffer?.length === "number" && maskBuffer.length > 0;
  let wfPath = COMFY_IMG2IMG_WORKFLOW;
  if (hasMask && COMFY_INPAINT_WORKFLOW && fileExists(COMFY_INPAINT_WORKFLOW)) {
    wfPath = COMFY_INPAINT_WORKFLOW;
  }
  if (!wfPath || !fileExists(wfPath)) {
    const err = new Error("comfy_img2img_not_configured");
    err.detail = hasMask
      ? "Задайте COMFY_IMG2IMG_WORKFLOW и при необходимости COMFY_INPAINT_WORKFLOW в .env."
      : "Задайте COMFY_IMG2IMG_WORKFLOW в .env.";
    throw err;
  }
  const raw = await fsp.readFile(wfPath, "utf8");
  if (!raw.includes("<<<TC_LOAD_IMAGE>>>")) {
    const err = new Error("comfy_template_missing_load_image");
    err.detail = "В workflow для img2img добавьте в узел Load Image значение <<<TC_LOAD_IMAGE>>> (Save API Format).";
    throw err;
  }
  if (hasMask && !raw.includes("<<<TC_LOAD_MASK>>>")) {
    const err = new Error("comfy_template_missing_load_mask");
    err.detail = "Для инпейнта в workflow нужен плейсхолдер <<<TC_LOAD_MASK>>> или отдельный COMFY_INPAINT_WORKFLOW.";
    throw err;
  }
  if (raw.includes("<<<TC_CHECKPOINT>>>")) {
    const cp = sanitizeCheckpoint(checkpoint) || COMFY_DEFAULT_CHECKPOINT;
    if (!cp) {
      const err = new Error("comfy_checkpoint_required");
      err.detail = "В шаблоне есть <<<TC_CHECKPOINT>>>, но не выбрана модель и не задан COMFY_DEFAULT_CHECKPOINT в .env.";
      throw err;
    }
  }

  const uploadName = await comfyUploadImageBuffer(initImageBuffer, "tatarchat_source.png");
  let maskName = null;
  if (hasMask) {
    maskName = await comfyUploadImageBuffer(maskBuffer, "tatarchat_mask.png");
  }
  const seed = Math.floor(Math.random() * 2147483647);
  const cp = sanitizeCheckpoint(checkpoint) || COMFY_DEFAULT_CHECKPOINT || "";
  const wf = buildWorkflowFromTemplateString(raw, {
    prompt,
    negative: negativePrompt || "",
    steps,
    width,
    height,
    seed,
    cfg: COMFY_CFG_SCALE,
    denoise: denoisingStrength,
    loadImage: uploadName,
    loadMask: maskName,
    checkpoint: cp || null,
  });
  return runComfyUntilImage(wf);
}

async function fetchCheckpointTitlesFromComfy() {
  const base = COMFYUI_BASE_URL.replace(/\/$/, "");
  const tryPaths = ["/models/checkpoints", "/models/diffusion_models", "/models/unet"];
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  try {
    for (const rel of tryPaths) {
      const url = `${base}${rel}`;
      const res = await fetch(url, { signal: ac.signal, headers: { Accept: "application/json" } });
      const txt = await res.text();
      if (!res.ok) continue;
      let data;
      try {
        data = txt ? JSON.parse(txt) : null;
      } catch {
        continue;
      }
      if (Array.isArray(data)) {
        const titles = data.map((x) => String(x || "").trim()).filter(Boolean);
        if (titles.length) return [...new Set(titles)].sort((a, b) => a.localeCompare(b, "en"));
      }
      if (data && Array.isArray(data.checkpoints)) {
        const titles = data.checkpoints.map((x) => String(x || "").trim()).filter(Boolean);
        if (titles.length) return [...new Set(titles)].sort((a, b) => a.localeCompare(b, "en"));
      }
    }
    const oi = await fetch(`${base}/object_info`, { signal: ac.signal });
    const oiTxt = await oi.text();
    if (oi.ok && oiTxt) {
      let obj;
      try {
        obj = JSON.parse(oiTxt);
      } catch {
        obj = null;
      }
      if (obj && typeof obj === "object") {
        for (const key of Object.keys(obj)) {
          if (!/checkpoint|loader|unet|model/i.test(key)) continue;
          const node = obj[key];
          const req = node?.input?.required;
          const ckpt = req?.ckpt_name || req?.model_name || req?.unet_name;
          if (Array.isArray(ckpt?.[0])) {
            const titles = ckpt[0].map((x) => String(x || "").trim()).filter(Boolean);
            if (titles.length) return [...new Set(titles)].sort((a, b) => a.localeCompare(b, "en"));
          }
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return [];
}

async function fetchCheckpointTitles() {
  const fromApi = await fetchCheckpointTitlesFromComfy();
  const fromEnv = parseCheckpointTitlesFromEnv();
  if (fromApi.length) {
    const seen = new Set(fromApi);
    const merged = [...fromApi];
    for (const t of fromEnv) {
      if (!seen.has(t)) {
        seen.add(t);
        merged.push(t);
      }
    }
    merged.sort((a, b) => a.localeCompare(b, "en"));
    return { titles: merged, listSource: "comfy", partial: false, apiFailed: false };
  }
  if (fromEnv.length) {
    return { titles: fromEnv, listSource: "env", partial: true, apiFailed: true };
  }
  return { titles: [], listSource: "none", partial: true, apiFailed: true };
}

function handleComfyError(e, res, logLabel) {
  if (e?.name === "AbortError") {
    return res.status(504).json({ error: "Генерация слишком долгая (таймаут ComfyUI)" });
  }
  if (String(e?.message) === "comfy_not_configured") {
    return res.status(503).json({
      error:
        "Генерация не настроена: задайте COMFYUI_BASE_URL и COMFY_TXT2IMG_WORKFLOW в .env на сервере и перезапустите Node.",
    });
  }
  if (String(e?.message) === "comfy_img2img_not_configured") {
    return res.status(503).json({
      error: "img2img не настроен: задайте путь COMFY_IMG2IMG_WORKFLOW в .env (JSON workflow с <<<TC_LOAD_IMAGE>>>).",
      detail: e?.detail,
    });
  }
  if (String(e?.message) === "comfy_checkpoint_required") {
    return res.status(400).json({ error: "Нужна модель (чекпоинт) или COMFY_DEFAULT_CHECKPOINT в .env.", detail: e?.detail });
  }
  if (String(e?.message) === "comfy_template_missing_load_image" || String(e?.message) === "comfy_template_missing_load_mask") {
    return res.status(500).json({ error: e?.message, detail: e?.detail });
  }
  if (String(e?.message) === "comfy_invalid_workflow_json") {
    return res.status(500).json({
      error: "Некорректный JSON workflow после подстановки параметров. Проверьте шаблон и плейсхолдеры.",
      detail: e?.detail,
    });
  }
  if (String(e?.message) === "comfy_prompt_validation") {
    console.error(`[comfy] ${logLabel} validation:`, e?.detail);
    return res.status(502).json({
      error: "ComfyUI отклонил workflow (ошибка узлов). Открой консоль ComfyUI и проверь граф.",
      detail: String(e?.detail || "").slice(0, 600),
    });
  }
  if (String(e?.message).startsWith("comfy_prompt_http_")) {
    console.error(`[comfy] ${logLabel} prompt http:`, e?.detail);
    return res.status(502).json({
      error: "ComfyUI вернул ошибку на POST /prompt. Проверь, что API включён и адрес COMFYUI_BASE_URL верный.",
      detail: String(e?.detail || "").slice(0, 480),
    });
  }
  if (String(e?.message).startsWith("comfy_upload_http_")) {
    return res.status(502).json({
      error: "Не удалось загрузить изображение в ComfyUI (POST /upload/image).",
      detail: String(e?.detail || "").slice(0, 400),
    });
  }
  if (String(e?.message) === "comfy_execution_error") {
    console.error(`[comfy] ${logLabel} execution:`, e?.detail);
    return res.status(502).json({
      error: "Ошибка выполнения workflow в ComfyUI.",
      detail: String(e?.detail || "").slice(0, 600),
    });
  }
  if (String(e?.message) === "comfy_timeout") {
    return res.status(504).json({
      error: "ComfyUI не вернул картинку за отведённое время. Увеличь COMFYUI_TIMEOUT_MS или упрости граф.",
      detail: String(e?.detail || "").slice(0, 200),
    });
  }
  const causeMsg = String(e?.cause?.message || e?.cause || "");
  const topMsg = String(e?.message || "");
  const connHint =
    e?.cause?.code === "ECONNREFUSED" ||
    e?.code === "ECONNREFUSED" ||
    /ECONNREFUSED|fetch failed|getaddrinfo|ENOTFOUND|ConnectTimeoutError/i.test(topMsg + causeMsg);
  if (connHint) {
    console.error("[comfy] connect:", topMsg || causeMsg, e?.cause?.code || "");
    return res.status(502).json({
      error:
        "Не удаётся подключиться к ComfyUI. Запусти ComfyUI на этом ПК и проверь COMFYUI_BASE_URL (порт, например :8000).",
      detail: (topMsg || causeMsg).trim().slice(0, 240) || undefined,
    });
  }
  console.error(`POST /api/ai/image (${logLabel})`, e);
  return res.status(500).json({ error: "Ошибка генерации", detail: topMsg.trim().slice(0, 240) || undefined });
}

function logStartupInfo() {
  if (!COMFYUI_BASE_URL) return;
  console.log(`[comfy] COMFYUI_BASE_URL=${COMFYUI_BASE_URL}`);
  if (COMFY_TXT2IMG_WORKFLOW) console.log(`[comfy] COMFY_TXT2IMG_WORKFLOW=${COMFY_TXT2IMG_WORKFLOW}`);
  if (COMFY_IMG2IMG_WORKFLOW) console.log(`[comfy] COMFY_IMG2IMG_WORKFLOW=${COMFY_IMG2IMG_WORKFLOW}`);
  if (COMFY_INPAINT_WORKFLOW) console.log(`[comfy] COMFY_INPAINT_WORKFLOW=${COMFY_INPAINT_WORKFLOW}`);
  console.log(`[comfy] cfg_scale=${COMFY_CFG_SCALE} timeout_ms=${COMFYUI_TIMEOUT_MS}`);
  const fb = parseCheckpointTitlesFromEnv().length;
  if (fb) console.log(`[comfy] COMFY_CHECKPOINT_TITLES (fallback): ${fb} name(s)`);
}

module.exports = {
  COMFYUI_BASE_URL,
  COMFY_TXT2IMG_WORKFLOW,
  isComfyConfigured,
  isComfyImg2imgConfigured,
  isComfyInpaintConfigured,
  MAX_COMFY_PROMPT_CHARS,
  COMFY_MAX_STEPS,
  COMFY_MAX_SIDE,
  snapSide,
  sanitizePrompt,
  sanitizeCheckpoint,
  fetchCheckpointTitles,
  runTxt2img,
  runImg2imgOrInpaint,
  handleComfyError,
  logStartupInfo,
};
