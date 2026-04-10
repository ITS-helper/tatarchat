/**
 * Генерация через локальный SwarmUI (HTTP API: /API/GetNewSession, /API/GenerateText2Image, /API/ListT2IParams).
 * SwarmUI сам может поднимать ComfyUI/Self-Start, но для сайта мы общаемся только со SwarmUI.
 */
/* eslint-disable no-console */
"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
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

function fileExists(p) {
  try {
    return p && fs.existsSync(p);
  } catch {
    return false;
  }
}

function resolveWorkflowPath(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (path.isAbsolute(s)) return s;
  return path.resolve(__dirname, "..", s);
}

/**
 * Если в .env указано `swarm/workflows/foo` без расширения — пробуем также `foo.json`.
 */
function resolveWorkflowPathWithFallback(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const primary = resolveWorkflowPath(s);
  if (primary && fileExists(primary)) return primary;
  if (!/\.(json|JSON)$/.test(s)) {
    const withJson = resolveWorkflowPath(`${s}.json`);
    if (withJson && fileExists(withJson)) return withJson;
  }
  return primary;
}

const SWARM_COMFY_TXT2IMG_WORKFLOW = resolveWorkflowPathWithFallback(process.env.SWARM_COMFY_TXT2IMG_WORKFLOW || "");
const SWARM_COMFY_IMG2IMG_WORKFLOW = resolveWorkflowPathWithFallback(process.env.SWARM_COMFY_IMG2IMG_WORKFLOW || "");
/** Отдельный JSON workflow только для экрана «Тест» (txt2img); меняйте файл на сервере под эксперименты. */
const SWARM_COMFY_TEST_TXT2IMG_WORKFLOW = resolveWorkflowPathWithFallback(process.env.SWARM_COMFY_TEST_TXT2IMG_WORKFLOW || "");

function isSwarmConfigured() {
  return Boolean(SWARMUI_BASE_URL);
}

function isSwarmComfyWorkflowConfigured() {
  return Boolean(isSwarmConfigured() && SWARM_COMFY_TXT2IMG_WORKFLOW && fileExists(SWARM_COMFY_TXT2IMG_WORKFLOW));
}

function isSwarmComfyImg2imgWorkflowConfigured() {
  return Boolean(isSwarmConfigured() && SWARM_COMFY_IMG2IMG_WORKFLOW && fileExists(SWARM_COMFY_IMG2IMG_WORKFLOW));
}

function isSwarmComfyTestTxt2imgConfigured() {
  return Boolean(isSwarmConfigured() && SWARM_COMFY_TEST_TXT2IMG_WORKFLOW && fileExists(SWARM_COMFY_TEST_TXT2IMG_WORKFLOW));
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
  // SwarmUI может показывать модели с суффиксом через запятую (например "xxx.safetensors,qwen-image").
  // Для параметра `model` в API ожидается чистое имя модели (до запятой).
  const i = s.indexOf(",");
  return (i === -1 ? s : s.slice(0, i)).trim();
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

function sanitizePresetTitle(raw) {
  return String(raw ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, 160);
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

async function fetchPresets() {
  const sid = await ensureSession();
  const out = await callSwarm("API/GetMyUserData", { session_id: sid });
  const presets = Array.isArray(out?.presets) ? out.presets : [];
  const titles = presets
    .map((p) => sanitizePresetTitle(p?.title))
    .filter(Boolean);
  const uniq = [...new Set(titles)];
  uniq.sort((a, b) => a.localeCompare(b, "en"));
  return uniq;
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

function comfyDirectUrl(relPath) {
  const base = SWARMUI_BASE_URL.replace(/\/$/, "");
  const rel = String(relPath || "").replace(/^\//, "");
  return `${base}/ComfyBackendDirect/${rel}`;
}

async function comfyUploadImageBuffer(buffer, filename = "upload.png") {
  const form = new FormData();
  const blob = new Blob([buffer], { type: "application/octet-stream" });
  form.append("image", blob, filename);
  form.append("type", "input");
  form.append("overwrite", "true");
  const url = comfyDirectUrl("upload/image");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SWARMUI_TIMEOUT_MS);
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
      const err = new Error(`swarm_comfy_upload_http_${res.status}`);
      err.detail = txt.slice(0, 800);
      throw err;
    }
    const name = typeof data.name === "string" ? data.name.trim() : "";
    if (!name) {
      const err = new Error("swarm_comfy_upload_no_name");
      err.detail = txt.slice(0, 400);
      throw err;
    }
    return name;
  } finally {
    clearTimeout(timer);
  }
}

function escapeJsonString(s) {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function buildWorkflowFromTemplateString(templateStr, params) {
  const { prompt, steps, width, height, seed, cfg, loadImage } = params;
  let s = templateStr;
  s = s.replace(/<<<TC_PROMPT>>>/g, escapeJsonString(prompt));
  s = s.replace(/<<<TC_STEPS>>>/g, String(steps));
  s = s.replace(/<<<TC_WIDTH>>>/g, String(width));
  s = s.replace(/<<<TC_HEIGHT>>>/g, String(height));
  s = s.replace(/<<<TC_SEED>>>/g, String(seed));
  s = s.replace(/<<<TC_CFG>>>/g, String(cfg));
  if (loadImage != null) s = s.replace(/<<<TC_LOAD_IMAGE>>>/g, escapeJsonString(loadImage));
  try {
    return JSON.parse(s);
  } catch (e) {
    const err = new Error("swarm_workflow_invalid_json");
    err.detail = String(e?.message || e).slice(0, 400);
    throw err;
  }
}

function validateWorkflowTemplateString(templateStr) {
  const raw = String(templateStr || "");
  buildWorkflowFromTemplateString(raw, {
    prompt: "test",
    steps: 8,
    width: 512,
    height: 512,
    seed: 1,
    cfg: 1,
    loadImage: "test.png",
  });
  return true;
}

async function comfyPostPrompt(workflow) {
  const client_id = crypto.randomUUID();
  const url = comfyDirectUrl("prompt");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SWARMUI_TIMEOUT_MS);
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
    if (!res.ok) {
      const err = new Error(`swarm_comfy_prompt_http_${res.status}`);
      err.detail = txt.slice(0, 1500);
      throw err;
    }
    const prompt_id = data.prompt_id;
    if (!prompt_id) {
      const err = new Error("swarm_comfy_prompt_no_id");
      err.detail = txt.slice(0, 500);
      throw err;
    }
    return { prompt_id, client_id };
  } finally {
    clearTimeout(timer);
  }
}

async function comfyFetchHistory(prompt_id) {
  const url = comfyDirectUrl(`history/${encodeURIComponent(prompt_id)}`);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.min(60_000, SWARMUI_TIMEOUT_MS));
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
  const entry = historyRoot?.[prompt_id];
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

function stringifyComfyMsgPart(v) {
  if (typeof v === "string") return v;
  if (v == null) return "";
  try {
    if (typeof v === "object") {
      const type = typeof v.type === "string" ? v.type : "";
      const msg = typeof v.message === "string" ? v.message : "";
      const node = v.node_id != null ? `node=${v.node_id}` : "";
      const nodeType = typeof v.node_type === "string" ? `node_type=${v.node_type}` : "";
      const details = [type, msg, node, nodeType].filter(Boolean).join(" ");
      if (details) return details;
    }
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function historyEntryErrorMessage(entry) {
  const st = entry?.status;
  const msgs = Array.isArray(st?.messages) ? st.messages : [];

  // Comfy обычно отдаёт массивы вида ["execution_error", { message, node_id, node_type, ... }].
  const errEvent = msgs.find((m) => Array.isArray(m) && String(m[0] || "").toLowerCase().includes("error"));
  if (errEvent) {
    const parts = errEvent.slice(1).map(stringifyComfyMsgPart).filter(Boolean);
    const prefix = String(errEvent[0] || "execution_error");
    const txt = [prefix, ...parts].join(" | ");
    if (txt.trim()) return txt.slice(0, 1200);
  }

  if (st?.status_str === "error" || st?.status_str === "failed") {
    const direct = stringifyComfyMsgPart(st?.message || "");
    if (direct) return direct.slice(0, 1200);
    if (msgs.length) {
      const flat = msgs
        .map((m) => (Array.isArray(m) ? m.map(stringifyComfyMsgPart).filter(Boolean).join(" | ") : stringifyComfyMsgPart(m)))
        .filter(Boolean)
        .join("; ");
      if (flat) return flat.slice(0, 1200);
    }
    return "execution error";
  }

  return "";
}

async function comfyFetchImageBuffer(meta) {
  const u = new URL(comfyDirectUrl("view"));
  u.searchParams.set("filename", meta.filename);
  u.searchParams.set("subfolder", meta.subfolder || "");
  u.searchParams.set("type", meta.type || "output");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SWARMUI_TIMEOUT_MS);
  try {
    const res = await fetch(u.toString(), { signal: ac.signal });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function runComfyDirectUntilImage(workflow) {
  const { prompt_id } = await comfyPostPrompt(workflow);
  const deadline = Date.now() + SWARMUI_TIMEOUT_MS;
  let lastHist = null;
  while (Date.now() < deadline) {
    const hist = await comfyFetchHistory(prompt_id);
    lastHist = hist;
    if (hist && hist[prompt_id]) {
      const entry = hist[prompt_id];
      const errMsg = historyEntryErrorMessage(entry);
      if (errMsg) {
        const err = new Error("swarm_comfy_execution_error");
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
    await new Promise((r) => setTimeout(r, 400));
  }
  const err = new Error("swarm_comfy_timeout");
  err.detail = lastHist ? JSON.stringify(lastHist).slice(0, 400) : "";
  throw err;
}

async function runTxt2imgViaComfyWorkflowPath(workflowPath, { prompt, steps, width, height, cfg }) {
  if (!workflowPath || !fileExists(workflowPath)) {
    const err = new Error("swarm_workflow_not_configured");
    throw err;
  }
  const raw = await fsp.readFile(workflowPath, "utf8");
  const seed = Math.floor(Math.random() * 2147483647);
  const wf = buildWorkflowFromTemplateString(raw, {
    prompt,
    steps,
    width,
    height,
    seed,
    cfg: Number.isFinite(Number(cfg)) ? Number(cfg) : 1,
    loadImage: null,
  });
  return runComfyDirectUntilImage(wf);
}

async function runTxt2imgViaComfyTemplateString(templateStr, { prompt, steps, width, height, cfg }) {
  const raw = String(templateStr || "");
  if (!raw.trim()) {
    const err = new Error("swarm_test_workflow_not_configured");
    throw err;
  }
  const seed = Math.floor(Math.random() * 2147483647);
  const wf = buildWorkflowFromTemplateString(raw, {
    prompt,
    steps,
    width,
    height,
    seed,
    cfg: Number.isFinite(Number(cfg)) ? Number(cfg) : 1,
    loadImage: null,
  });
  return runComfyDirectUntilImage(wf);
}

async function runTxt2imgViaComfyWorkflow({ prompt, steps, width, height }) {
  if (!isSwarmComfyWorkflowConfigured()) {
    const err = new Error("swarm_workflow_not_configured");
    throw err;
  }
  return runTxt2imgViaComfyWorkflowPath(SWARM_COMFY_TXT2IMG_WORKFLOW, { prompt, steps, width, height, cfg: 1 });
}

async function runTxt2imgTestComfyWorkflow({ prompt, steps, width, height }) {
  if (!isSwarmComfyTestTxt2imgConfigured()) {
    const err = new Error("swarm_test_workflow_not_configured");
    throw err;
  }
  return runTxt2imgViaComfyWorkflowPath(SWARM_COMFY_TEST_TXT2IMG_WORKFLOW, { prompt, steps, width, height, cfg: 1 });
}

async function runImg2imgViaComfyWorkflow({ prompt, steps, cfg, initImageBuffer }) {
  if (!isSwarmComfyImg2imgWorkflowConfigured()) {
    const err = new Error("swarm_img2img_workflow_not_configured");
    throw err;
  }
  const raw = await fsp.readFile(SWARM_COMFY_IMG2IMG_WORKFLOW, "utf8");
  if (!raw.includes("<<<TC_LOAD_IMAGE>>>")) {
    const err = new Error("swarm_workflow_missing_load_image");
    err.detail = "В workflow для «Изменить» нужен плейсхолдер <<<TC_LOAD_IMAGE>>> в узле LoadImage.";
    throw err;
  }
  const uploadName = await comfyUploadImageBuffer(initImageBuffer, "tatarchat_source.png");
  const seed = Math.floor(Math.random() * 2147483647);
  // Qwen edit workflow обычно рассчитан на lightning (4 шага, cfg=1). Если дать 25 шагов из UI — будет в разы медленнее.
  const st = Math.max(1, Math.min(8, Math.floor(Number(steps) || 4)));
  const c = Math.max(1, Math.min(3, Number.isFinite(Number(cfg)) ? Number(cfg) : 1));
  const wf = buildWorkflowFromTemplateString(raw, {
    prompt,
    steps: st,
    width: 0,
    height: 0,
    seed,
    cfg: c,
    loadImage: uploadName,
  });
  return runComfyDirectUntilImage(wf);
}

async function runTxt2img({ prompt, negativePrompt, steps, width, height, model }) {
  if (!isSwarmConfigured()) throw new Error("swarm_not_configured");
  const sid = await ensureSession();
  const p = sanitizePrompt(prompt);
  if (!p) throw new Error("swarm_empty_prompt");
  if (isSwarmComfyWorkflowConfigured()) {
    const w = snapSide(width);
    const h = snapSide(height);
    const st = Math.max(1, Math.min(SWARM_MAX_STEPS, Math.floor(Number(steps) || 10)));
    return runTxt2imgViaComfyWorkflow({ prompt: p, steps: st, width: w, height: h });
  }
  const neg = sanitizePrompt(negativePrompt || "");
  const mRaw = sanitizeModel(model) || sanitizeModel(SWARM_DEFAULT_MODEL) || "";
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
  const body = withPreset(mRaw ? { ...body0, model: mRaw } : body0, "txt2img");
  const out = await callSwarm("API/GenerateText2Image", body);
  const first = Array.isArray(out?.images) ? out.images[0] : "";
  return fetchFirstImageAsBase64(first);
}

async function runTxt2imgWithRequestPreset({ prompt, negativePrompt, steps, width, height, model, preset }) {
  const sid = await ensureSession();
  const p = sanitizePrompt(prompt);
  if (!p) throw new Error("swarm_empty_prompt");
  if (isSwarmComfyWorkflowConfigured()) {
    const w = snapSide(width);
    const h = snapSide(height);
    const st = Math.max(1, Math.min(SWARM_MAX_STEPS, Math.floor(Number(steps) || 10)));
    return runTxt2imgViaComfyWorkflow({ prompt: p, steps: st, width: w, height: h });
  }
  const neg = sanitizePrompt(negativePrompt || "");
  const mRaw = sanitizeModel(model) || sanitizeModel(SWARM_DEFAULT_MODEL) || "";
  const presetTitle = sanitizePresetTitle(preset);
  const presetFromEnv = maybePresetForMode("txt2img");
  if (!mRaw && !presetTitle && !presetFromEnv) {
    const err = new Error("swarm_model_required");
    err.detail =
      "Нужна модель или preset: выбери модель в UI, либо выбери пресет, либо задай SWARM_DEFAULT_MODEL / SWARM_PRESET_TXT2IMG в .env.";
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
  let body = mRaw ? { ...body0, model: mRaw } : body0;
  body = withPreset(body, "txt2img");
  body = applyRequestPreset(body, presetTitle);
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
  if (isSwarmComfyImg2imgWorkflowConfigured()) {
    const hasMask = typeof maskBuffer?.length === "number" && maskBuffer.length > 0;
    if (hasMask) {
      const err = new Error("swarm_workflow_mask_not_supported");
      err.detail = "Текущий workflow «Изменить» не поддерживает маску (инпейнт).";
      throw err;
    }
    // Для edit workflow держим lightning-профиль по умолчанию: шаги берём из UI, но жёстко ограничиваем,
    // cfg фиксируем 1 (как в рабочем графе).
    const st = Math.max(1, Math.min(8, Math.floor(Number(steps) || 4)));
    return runImg2imgViaComfyWorkflow({ prompt: p, steps: st, cfg: 1, initImageBuffer });
  }
  const neg = sanitizePrompt(negativePrompt || "");
  const mRaw = sanitizeModel(model) || sanitizeModel(SWARM_DEFAULT_MODEL) || "";
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
    body0.maskimage = maskUrl;
    body0.mask_image = maskUrl;
  }

  const body = withPreset(mRaw ? { ...body0, model: mRaw } : body0, "img2img");
  const out = await callSwarm("API/GenerateText2Image", body);
  const first = Array.isArray(out?.images) ? out.images[0] : "";
  return fetchFirstImageAsBase64(first);
}

async function runImg2imgOrInpaintWithRequestPreset({
  prompt,
  negativePrompt,
  steps,
  width,
  height,
  initImageBuffer,
  initImageMime,
  maskBuffer,
  maskMime,
  denoisingStrength,
  model,
  preset,
}) {
  const sid = await ensureSession();
  const p = sanitizePrompt(prompt);
  if (!p) throw new Error("swarm_empty_prompt");
  if (isSwarmComfyImg2imgWorkflowConfigured()) {
    const hasMask = typeof maskBuffer?.length === "number" && maskBuffer.length > 0;
    if (hasMask) {
      const err = new Error("swarm_workflow_mask_not_supported");
      err.detail = "Текущий workflow «Изменить» не поддерживает маску (инпейнт).";
      throw err;
    }
    const st = Math.max(1, Math.min(8, Math.floor(Number(steps) || 4)));
    return runImg2imgViaComfyWorkflow({ prompt: p, steps: st, cfg: 1, initImageBuffer });
  }
  const neg = sanitizePrompt(negativePrompt || "");
  const mRaw = sanitizeModel(model) || sanitizeModel(SWARM_DEFAULT_MODEL) || "";
  const presetTitle = sanitizePresetTitle(preset);
  const presetFromEnv = maybePresetForMode("img2img");
  if (!mRaw && !presetTitle && !presetFromEnv) {
    const err = new Error("swarm_model_required");
    err.detail =
      "Нужна модель или preset: выбери модель в UI, либо выбери пресет, либо задай SWARM_DEFAULT_MODEL / SWARM_PRESET_IMG2IMG в .env.";
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
    initimage: initUrl,
    denoise_strength: den,
    denoising_strength: den,
    denoise: den,
  };
  if (maskUrl) {
    body0.maskimage = maskUrl;
    body0.mask_image = maskUrl;
  }
  let body = mRaw ? { ...body0, model: mRaw } : body0;
  body = withPreset(body, "img2img");
  body = applyRequestPreset(body, presetTitle);
  const out = await callSwarm("API/GenerateText2Image", body);
  const first = Array.isArray(out?.images) ? out.images[0] : "";
  return fetchFirstImageAsBase64(first);
}

function applyRequestPreset(body, reqPresetRaw) {
  const t = sanitizePresetTitle(reqPresetRaw);
  if (!t) return body;
  return { ...(body || {}), presets: [t] };
}

function handleSwarmError(e, res, logLabel) {
  if (e?.name === "AbortError") return res.status(504).json({ error: "Генерация слишком долгая (таймаут SwarmUI)" });
  if (String(e?.message) === "swarm_not_configured") {
    return res.status(503).json({
      error: "Генерация не настроена: задайте SWARMUI_BASE_URL в .env на сервере и перезапустите Node.",
    });
  }
  if (String(e?.message) === "swarm_workflow_not_configured") {
    return res.status(503).json({
      error:
        "Workflow не настроен: задайте SWARM_COMFY_TXT2IMG_WORKFLOW (путь к JSON workflow) в .env на сервере и перезапустите Node.",
    });
  }
  if (String(e?.message) === "swarm_test_workflow_not_configured") {
    return res.status(503).json({
      error:
        "Тест: задайте SWARM_COMFY_TEST_TXT2IMG_WORKFLOW (путь к JSON workflow для txt2img) в .env на сервере и перезапустите Node.",
    });
  }
  if (String(e?.message) === "swarm_img2img_workflow_not_configured") {
    return res.status(503).json({
      error:
        "Workflow «Изменить» не настроен: задайте SWARM_COMFY_IMG2IMG_WORKFLOW (путь к JSON workflow) в .env на сервере и перезапустите Node.",
    });
  }
  if (String(e?.message) === "swarm_workflow_missing_load_image") {
    return res.status(500).json({ error: "Workflow «Изменить»: нет <<<TC_LOAD_IMAGE>>>.", detail: e?.detail });
  }
  if (String(e?.message) === "swarm_workflow_mask_not_supported") {
    return res.status(400).json({ error: "Инпейнт недоступен для текущего workflow.", detail: e?.detail });
  }
  if (String(e?.message).startsWith("swarm_comfy_upload_http_") || String(e?.message) === "swarm_comfy_upload_no_name") {
    return res.status(502).json({ error: "Не удалось загрузить изображение в Comfy backend (через SwarmUI).", detail: String(e?.detail || "").slice(0, 400) });
  }
  if (String(e?.message) === "swarm_workflow_invalid_json") {
    return res.status(500).json({
      error: "Некорректный JSON workflow после подстановки параметров. Проверьте шаблон и плейсхолдеры.",
      detail: e?.detail,
    });
  }
  if (String(e?.message).startsWith("swarm_comfy_prompt_http_")) {
    console.error(`[swarm] ${logLabel} comfy prompt http:`, e?.detail);
    return res.status(502).json({ error: "Comfy backend (через SwarmUI) вернул ошибку на POST /prompt.", detail: String(e?.detail || "").slice(0, 480) });
  }
  if (String(e?.message) === "swarm_comfy_execution_error") {
    console.error(`[swarm] ${logLabel} comfy execution:`, e?.detail);
    return res.status(502).json({ error: "Ошибка выполнения workflow в Comfy backend (через SwarmUI).", detail: String(e?.detail || "").slice(0, 600) });
  }
  if (String(e?.message) === "swarm_comfy_timeout") {
    return res.status(504).json({ error: "Comfy backend не вернул картинку за отведённое время.", detail: String(e?.detail || "").slice(0, 200) });
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
  if (SWARM_COMFY_TXT2IMG_WORKFLOW) console.log(`[swarm] SWARM_COMFY_TXT2IMG_WORKFLOW=${SWARM_COMFY_TXT2IMG_WORKFLOW}`);
  if (SWARM_COMFY_IMG2IMG_WORKFLOW) console.log(`[swarm] SWARM_COMFY_IMG2IMG_WORKFLOW=${SWARM_COMFY_IMG2IMG_WORKFLOW}`);
  if (SWARM_COMFY_TEST_TXT2IMG_WORKFLOW) console.log(`[swarm] SWARM_COMFY_TEST_TXT2IMG_WORKFLOW=${SWARM_COMFY_TEST_TXT2IMG_WORKFLOW}`);
  if (SWARM_COMFY_TXT2IMG_WORKFLOW && !fileExists(SWARM_COMFY_TXT2IMG_WORKFLOW)) {
    console.warn("[swarm] TXT2IMG workflow file not found — will fall back to Swarm GenerateText2Image.");
  }
  if (SWARM_COMFY_IMG2IMG_WORKFLOW && !fileExists(SWARM_COMFY_IMG2IMG_WORKFLOW)) {
    console.warn("[swarm] IMG2IMG workflow file not found — will fall back to Swarm GenerateText2Image.");
  }
  if (SWARM_COMFY_TEST_TXT2IMG_WORKFLOW && !fileExists(SWARM_COMFY_TEST_TXT2IMG_WORKFLOW)) {
    console.warn("[swarm] TEST TXT2IMG workflow file not found — раздел «Тест» на сайте не сможет генерировать.");
  }
  console.log(`[swarm] cfg_scale=${SWARM_CFG_SCALE} timeout_ms=${SWARMUI_TIMEOUT_MS}`);
}

module.exports = {
  SWARMUI_BASE_URL,
  SWARM_COMFY_TXT2IMG_WORKFLOW,
  SWARM_COMFY_IMG2IMG_WORKFLOW,
  SWARM_COMFY_TEST_TXT2IMG_WORKFLOW,
  isSwarmConfigured,
  isSwarmComfyWorkflowConfigured,
  isSwarmComfyImg2imgWorkflowConfigured,
  isSwarmComfyTestTxt2imgConfigured,
  MAX_SWARM_PROMPT_CHARS,
  SWARM_MAX_STEPS,
  SWARM_MAX_SIDE,
  SWARM_CFG_SCALE,
  sanitizePrompt,
  sanitizeModel,
  sanitizePresetTitle,
  snapSide,
  fetchModelTitles,
  fetchPresets,
  runTxt2img,
  runImg2imgOrInpaint,
  runTxt2imgWithRequestPreset,
  runImg2imgOrInpaintWithRequestPreset,
  runTxt2imgTestComfyWorkflow,
  runTxt2imgViaComfyTemplateString,
  validateWorkflowTemplateString,
  applyRequestPreset,
  handleSwarmError,
  logStartupInfo,
};

