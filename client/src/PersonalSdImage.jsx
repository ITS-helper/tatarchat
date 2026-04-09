import { useCallback, useEffect, useRef, useState } from "react";

const SD_MODES = { txt2img: "txt2img", img2img: "img2img", inpaint: "inpaint" };

const SIZE_TXT = [512, 576, 640, 704, 768];
const SIZE_IMG = [512, 576, 640, 704, 768, 832, 896, 1024];

const LS_MODEL_KEY = "tatarchat_swarm_model";
const LS_PRESET_KEY = "tatarchat_swarm_preset";
const LS_COMFY_CHECKPOINT_KEY = "tatarchat_comfy_checkpoint";
const LS_COMFY_CHECKPOINT_LEGACY = "tatarchat_sd_checkpoint";

export default function PersonalSdImage({ getApiBase, token, onError }) {
  const [loading, setLoading] = useState(true);
  const [imageGenAvailable, setImageGenAvailable] = useState(false);
  const [sdCheckpointOptions, setSdCheckpointOptions] = useState([]);
  const [sdCheckpoint, setSdCheckpoint] = useState("");
  const [sdPresetOptions, setSdPresetOptions] = useState([]);
  const [sdPreset, setSdPreset] = useState("");
  const [sdModelsLoading, setSdModelsLoading] = useState(false);
  const [sdModelsError, setSdModelsError] = useState(null);
  const [sdModelsNote, setSdModelsNote] = useState(null);
  const [sdMode, setSdMode] = useState(SD_MODES.txt2img);
  const [useInpaint, setUseInpaint] = useState(false);
  const [sdPrompt, setSdPrompt] = useState("");
  const [sdNegative, setSdNegative] = useState("");
  const [sdSteps, setSdSteps] = useState(25);
  const [sdSize, setSdSize] = useState(512);
  const [sdDenoise, setSdDenoise] = useState(0.55);
  const [sdGenerating, setSdGenerating] = useState(false);
  const [sdResult, setSdResult] = useState(null);
  const [imageLightbox, setImageLightbox] = useState(null);

  const [sourceFile, setSourceFile] = useState(null);
  const [maskFile, setMaskFile] = useState(null);
  const [srcPreview, setSrcPreview] = useState(null);
  const [maskPreview, setMaskPreview] = useState(null);

  const sourceRef = useRef(null);
  const maskRef = useRef(null);
  const base = getApiBase();

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`${base}/api/ai/chat`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          onError?.(data.error || "Не удалось проверить настройки");
          return;
        }
        if (!cancelled && typeof data.imageGenAvailable === "boolean") {
          setImageGenAvailable(data.imageGenAvailable);
        }
      } catch (e) {
        console.error(e);
        onError?.("Сеть");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base, token, onError]);

  const loadSdModels = useCallback(async () => {
    if (!token || !imageGenAvailable) return;
    setSdModelsLoading(true);
    setSdModelsError(null);
    setSdModelsNote(null);
    try {
      const res = await fetch(`${base}/api/ai/image/models`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const d = typeof data.detail === "string" && data.detail.trim() ? ` ${data.detail.trim()}` : "";
        const tried =
          typeof data.triedPaths === "string" && data.triedPaths.trim() ? ` Пробовали пути: ${data.triedPaths}.` : "";
        throw new Error((data.error || `HTTP ${res.status}`) + d + tried);
      }
      const list = Array.isArray(data.models)
        ? data.models.map((m) => (typeof m?.title === "string" ? m.title.trim() : "")).filter(Boolean)
        : [];
      let saved = "";
      try {
        saved = String(
          window.localStorage.getItem(LS_MODEL_KEY) ||
            window.localStorage.getItem(LS_COMFY_CHECKPOINT_KEY) ||
            window.localStorage.getItem(LS_COMFY_CHECKPOINT_LEGACY) ||
            "",
        ).trim();
      } catch {
        /* ignore */
      }
      const merged = saved && !list.includes(saved) ? [saved, ...list] : list;
      setSdCheckpointOptions(merged);
      setSdCheckpoint((prev) => {
        if (saved && merged.includes(saved)) return saved;
        if (prev && merged.includes(prev)) return prev;
        return "";
      });
      if (data.partial) {
        setSdModelsNote(
          "Список из резерва на сервере. Админ: проверьте SwarmUI и его модели.",
        );
      } else if (data.listSource === "env") {
        setSdModelsNote("Список из резерва на сервере.");
      }
    } catch (e) {
      console.error(e);
      setSdModelsError(typeof e?.message === "string" ? e.message : "Список моделей");
    } finally {
      setSdModelsLoading(false);
    }
  }, [base, token, imageGenAvailable]);

  const loadSdPresets = useCallback(async () => {
    if (!token || !imageGenAvailable) return;
    try {
      const res = await fetch(`${base}/api/ai/image/presets`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return;
      const list = Array.isArray(data.presets)
        ? data.presets.map((p) => (typeof p?.title === "string" ? p.title.trim() : "")).filter(Boolean)
        : [];
      let saved = "";
      try {
        saved = String(window.localStorage.getItem(LS_PRESET_KEY) || "").trim();
      } catch {
        /* ignore */
      }
      const merged = saved && !list.includes(saved) ? [saved, ...list] : list;
      setSdPresetOptions(merged);
      setSdPreset((prev) => {
        if (saved && merged.includes(saved)) return saved;
        if (prev && merged.includes(prev)) return prev;
        return "";
      });
    } catch {
      /* ignore presets */
    }
  }, [base, token, imageGenAvailable]);

  useEffect(() => {
    if (!imageGenAvailable || !token) return;
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await loadSdModels();
      await loadSdPresets();
    })();
    return () => {
      cancelled = true;
    };
  }, [imageGenAvailable, token, loadSdModels, loadSdPresets]);

  useEffect(() => {
    if (!sourceFile) {
      setSrcPreview(null);
      return;
    }
    const u = URL.createObjectURL(sourceFile);
    setSrcPreview(u);
    return () => URL.revokeObjectURL(u);
  }, [sourceFile]);

  useEffect(() => {
    if (!maskFile) {
      setMaskPreview(null);
      return;
    }
    const u = URL.createObjectURL(maskFile);
    setMaskPreview(u);
    return () => URL.revokeObjectURL(u);
  }, [maskFile]);

  useEffect(() => {
    const sizes = sdMode === SD_MODES.txt2img ? SIZE_TXT : SIZE_IMG;
    setSdSize((prev) => (sizes.includes(prev) ? prev : 512));
  }, [sdMode]);

  useEffect(() => {
    if (sdMode === SD_MODES.txt2img) {
      setSourceFile(null);
      setMaskFile(null);
      setUseInpaint(false);
      if (sourceRef.current) sourceRef.current.value = "";
      if (maskRef.current) maskRef.current.value = "";
    }
    if (sdMode === SD_MODES.img2img) {
      setMaskFile(null);
      if (maskRef.current) maskRef.current.value = "";
    }
  }, [sdMode]);

  const generateSdImage = useCallback(async () => {
    const p = sdPrompt.trim();
    if (!p || sdGenerating || !token || !imageGenAvailable) return;

    const effectiveMode = sdMode === SD_MODES.img2img && useInpaint ? SD_MODES.inpaint : sdMode;

    if (effectiveMode === SD_MODES.img2img || effectiveMode === SD_MODES.inpaint) {
      if (!sourceFile) {
        onError?.("Выбери исходное изображение");
        return;
      }
      if (effectiveMode === SD_MODES.inpaint && !maskFile) {
        onError?.("Для инпейнта нужна маска (PNG: белое = зона перерисовки)");
        return;
      }
    }

    setSdGenerating(true);
    setSdResult(null);
    onError?.(null);
    try {
      if (effectiveMode === SD_MODES.txt2img) {
        const body = {
          prompt: p,
          negative_prompt: sdNegative.trim() || undefined,
          steps: sdSteps,
          width: sdSize,
          height: sdSize,
        };
        if (sdCheckpoint.trim()) body.checkpoint = sdCheckpoint.trim();
        if (sdPreset.trim()) body.preset = sdPreset.trim();
        const res = await fetch(`${base}/api/ai/image`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const d = typeof data.detail === "string" && data.detail.trim() ? ` ${data.detail.trim()}` : "";
          onError?.((data.error || `Ошибка ${res.status}`) + d);
          return;
        }
        const mime = typeof data.mimeType === "string" && data.mimeType ? data.mimeType : "image/png";
        const b64 = data.imageBase64;
        if (typeof b64 !== "string" || !b64) {
          onError?.("Пустой ответ картинки");
          return;
        }
        setSdResult({ dataUrl: `data:${mime};base64,${b64}`, prompt: p, mode: effectiveMode });
        onError?.(null);
        return;
      }

      const fd = new FormData();
      fd.append("source", sourceFile);
      if (effectiveMode === SD_MODES.inpaint && maskFile) fd.append("mask", maskFile);
      fd.append("prompt", p);
      fd.append("negative_prompt", sdNegative.trim());
      fd.append("steps", String(sdSteps));
      fd.append("width", String(sdSize));
      fd.append("height", String(sdSize));
      fd.append("denoising_strength", String(sdDenoise));
      if (sdCheckpoint.trim()) fd.append("checkpoint", sdCheckpoint.trim());
      if (sdPreset.trim()) fd.append("preset", sdPreset.trim());

      const res = await fetch(`${base}/api/ai/image/img2img`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const d = typeof data.detail === "string" && data.detail.trim() ? ` ${data.detail.trim()}` : "";
        onError?.((data.error || `Ошибка ${res.status}`) + d);
        return;
      }
      const mime = typeof data.mimeType === "string" && data.mimeType ? data.mimeType : "image/png";
      const b64 = data.imageBase64;
      if (typeof b64 !== "string" || !b64) {
        onError?.("Пустой ответ картинки");
        return;
      }
      setSdResult({ dataUrl: `data:${mime};base64,${b64}`, prompt: p, mode: effectiveMode });
      onError?.(null);
    } catch (e) {
      console.error(e);
      onError?.("Сеть: генерация картинки");
    } finally {
      setSdGenerating(false);
    }
  }, [
    base,
    token,
    imageGenAvailable,
    sdPrompt,
    sdNegative,
    sdSteps,
    sdSize,
    sdDenoise,
    sdMode,
    useInpaint,
    sourceFile,
    maskFile,
    sdCheckpoint,
    sdPreset,
    sdGenerating,
    onError,
  ]);

  const sizeOptions = sdMode === SD_MODES.txt2img ? SIZE_TXT : SIZE_IMG;

  const modeHint =
    sdMode === SD_MODES.txt2img
      ? "Текст → картинка (txt2img). Промпт лучше на английском."
      : useInpaint
        ? "Инпейнт: исходник + маска (белое = перерисовать). Размеры маски лучше совпадать с картинкой."
        : "Изменить: исходник + промпт. Сила перерисовки — «Шум» (denoising).";

  const canSubmit =
    sdPrompt.trim() &&
    (sdMode === SD_MODES.txt2img ||
      (sourceFile && sdMode === SD_MODES.img2img && (!useInpaint || (useInpaint && maskFile))));

  return (
    <div className="relative flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden">
      <div className="chat-bg-parallax pointer-events-none z-0" aria-hidden />
      <div className="messages-scroll relative z-10 w-full min-w-0 flex-1 overflow-y-auto bg-transparent px-4 py-3">
        {loading ? (
          <div className="flex h-full min-h-[12rem] items-center justify-center">
            <p className="text-sm text-tc-text-muted">Загрузка…</p>
          </div>
        ) : !imageGenAvailable ? (
          <div className="mx-auto max-w-md rounded-xl border border-tc-border/60 bg-tc-panel/30 p-4 text-sm text-tc-text-sec">
            <p className="font-medium text-tc-text">Генерация картинок недоступна</p>
            <p className="mt-2 text-xs leading-relaxed text-tc-text-muted">
              На сервере в .env задайте <code className="rounded bg-tc-input px-1">SWARMUI_BASE_URL</code> (например{" "}
              <code className="rounded bg-tc-input px-1">http://127.0.0.1:7801</code>), затем перезапустите Node.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-center text-xs text-tc-text-muted">{modeHint} На 8 ГБ VRAM при OOM уменьши размер.</p>
            {sdGenerating ? (
              <div className="flex justify-center">
                <div className="max-w-md rounded-xl border border-tc-border/50 bg-tc-msg px-4 py-3 text-sm">
                  <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-tc-accent/90">
                    Картинка
                  </p>
                  <div className="flex items-center gap-2 text-tc-text-sec">
                    <span
                      className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-tc-border border-t-tc-accent"
                      aria-hidden
                    />
                    <span className="text-xs">Рисую в SwarmUI… (до ~4 минут)</span>
                  </div>
                </div>
              </div>
            ) : null}
            {sdResult ? (
              <div className="mx-auto max-w-lg rounded-xl border border-tc-border/50 bg-tc-msg px-4 py-3 text-sm text-tc-text">
                <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-tc-accent/90">
                  Картинка
                  {sdResult.mode && sdResult.mode !== SD_MODES.txt2img ? (
                    <span className="ml-1 font-normal text-tc-text-muted">
                      · {sdResult.mode === SD_MODES.inpaint ? "inpaint" : "img2img"}
                    </span>
                  ) : null}
                </p>
                <p className="mb-2 line-clamp-3 text-xs text-tc-text-muted" title={sdResult.prompt}>
                  {sdResult.prompt}
                </p>
                <button
                  type="button"
                  className="block w-full overflow-hidden rounded-lg border border-tc-border/60 focus:outline-none focus:ring-2 focus:ring-tc-accent/50"
                  onClick={() => setImageLightbox({ url: sdResult.dataUrl, desc: sdResult.prompt })}
                >
                  <img src={sdResult.dataUrl} alt="" className="max-h-80 w-full object-contain bg-black/20" />
                </button>
                <div className="mt-2 flex flex-wrap gap-2">
                  <a
                    href={sdResult.dataUrl}
                    download="tatarchat-sd.png"
                    className="rounded-lg bg-tc-accent/20 px-2 py-1 text-xs font-medium text-tc-accent transition hover:bg-tc-accent/30"
                  >
                    Скачать PNG
                  </a>
                  <button
                    type="button"
                    className="rounded-lg px-2 py-1 text-xs text-tc-text-muted transition hover:bg-tc-hover"
                    onClick={() => setSdResult(null)}
                  >
                    Убрать
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {imageLightbox && typeof document !== "undefined" ? (
        <div
          className="fixed inset-0 z-[260] flex items-center justify-center bg-black/70 p-4"
          onClick={() => setImageLightbox(null)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="max-h-[90vh] w-full max-w-3xl overflow-hidden rounded-xl border border-tc-border bg-tc-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-tc-border px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-xs text-tc-text-sec">{imageLightbox.desc || "Картинка"}</p>
                <a
                  href={imageLightbox.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate text-[10px] text-tc-text-muted underline decoration-tc-border underline-offset-2 hover:text-tc-accent"
                >
                  Открыть в новой вкладке
                </a>
              </div>
              <button
                type="button"
                className="rounded-lg px-2 py-1 text-sm text-tc-text-sec hover:bg-tc-hover"
                onClick={() => setImageLightbox(null)}
                title="Закрыть"
              >
                ✕
              </button>
            </div>
            <div className="flex max-h-[80vh] items-center justify-center bg-black">
              <img
                src={imageLightbox.url}
                alt={imageLightbox.desc || "image"}
                className="max-h-[80vh] w-auto max-w-full object-contain"
                onError={() => {
                  onError?.("Картинка не загрузилась (источник удалён или 404)");
                  setImageLightbox(null);
                }}
              />
            </div>
          </div>
        </div>
      ) : null}

      {imageGenAvailable && !loading ? (
        <div className="tc-composer-bar relative z-10 flex flex-col gap-2 border-t border-tc-border bg-tc-header px-2 py-2 sm:px-3">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={sdGenerating}
              onClick={() => setSdMode(SD_MODES.img2img)}
              className={`rounded-lg px-3 py-2 text-xs font-semibold transition ${
                sdMode === SD_MODES.img2img ? "bg-tc-accent text-white" : "bg-tc-input text-tc-text hover:bg-tc-hover"
              } disabled:opacity-40`}
              title="img2img / inpaint"
            >
              Изменить
            </button>
            <button
              type="button"
              disabled={sdGenerating}
              onClick={() => setSdMode(SD_MODES.txt2img)}
              className={`rounded-lg px-3 py-2 text-xs font-semibold transition ${
                sdMode === SD_MODES.txt2img ? "bg-tc-accent text-white" : "bg-tc-input text-tc-text hover:bg-tc-hover"
              } disabled:opacity-40`}
              title="txt2img"
            >
              Нарисовать
            </button>
            {sdMode === SD_MODES.img2img ? (
              <label className="ml-auto flex items-center gap-2 rounded-lg border border-tc-border/60 bg-tc-panel/25 px-3 py-2 text-[11px] text-tc-text-sec">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={useInpaint}
                  onChange={(e) => setUseInpaint(e.target.checked)}
                  disabled={sdGenerating}
                />
                Инпейнт (с маской)
              </label>
            ) : null}
          </div>

          <div className="rounded-xl border border-tc-border/60 bg-tc-panel/25 px-3 py-2 space-y-1">
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex min-w-0 flex-1 flex-col gap-0.5 text-[11px] text-tc-text-muted sm:min-w-[12rem]">
                Модель
                <select
                  value={sdCheckpoint}
                  onChange={(e) => {
                    const v = e.target.value;
                    setSdCheckpoint(v);
                    try {
                      if (v) window.localStorage.setItem(LS_MODEL_KEY, v);
                      else window.localStorage.removeItem(LS_MODEL_KEY);
                    } catch {
                      /* ignore */
                    }
                  }}
                  disabled={sdGenerating || sdModelsLoading}
                  className="tc-msg-input max-w-full truncate rounded-lg border border-tc-border bg-tc-input px-2 py-1.5 text-xs text-tc-text outline-none focus:ring-2 focus:ring-tc-accent/50"
                >
                  <option value="">По умолчанию (SWARM_DEFAULT_MODEL)</option>
                  {sdCheckpointOptions.map((t) => (
                    <option key={t} value={t} title={t}>
                      {t.length > 72 ? `${t.slice(0, 70)}…` : t}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex min-w-0 flex-1 flex-col gap-0.5 text-[11px] text-tc-text-muted sm:min-w-[12rem]">
                Пресет (SwarmUI)
                <select
                  value={sdPreset}
                  onChange={(e) => {
                    const v = e.target.value;
                    setSdPreset(v);
                    try {
                      if (v) window.localStorage.setItem(LS_PRESET_KEY, v);
                      else window.localStorage.removeItem(LS_PRESET_KEY);
                    } catch {
                      /* ignore */
                    }
                  }}
                  disabled={sdGenerating}
                  className="tc-msg-input max-w-full truncate rounded-lg border border-tc-border bg-tc-input px-2 py-1.5 text-xs text-tc-text outline-none focus:ring-2 focus:ring-tc-accent/50"
                >
                  <option value="">(не использовать)</option>
                  {sdPresetOptions.map((t) => (
                    <option key={t} value={t} title={t}>
                      {t.length > 72 ? `${t.slice(0, 70)}…` : t}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={sdGenerating || sdModelsLoading}
                onClick={() => void loadSdModels()}
                className="shrink-0 rounded-lg border border-tc-border/70 bg-tc-input/50 px-2 py-1.5 text-[11px] text-tc-text-sec hover:bg-tc-hover disabled:opacity-40"
              >
                {sdModelsLoading ? "…" : "Обновить список"}
              </button>
            </div>
            {sdModelsError ? <p className="text-[11px] text-tc-danger">{sdModelsError}</p> : null}
            {sdModelsNote ? <p className="text-[11px] text-amber-600 dark:text-amber-400/90">{sdModelsNote}</p> : null}
            <p className="text-[10px] leading-snug text-tc-text-muted">
              Список моделей через SwarmUI API. Длинные имена сокращены; полный текст — в подсказке при наведении.
            </p>
          </div>

          {sdMode === SD_MODES.img2img && (
            <div className="rounded-xl border border-tc-border/60 bg-tc-panel/25 p-3 space-y-2">
              <p className="text-xs font-semibold text-tc-text-sec">Исходник и маска</p>
              <div className="flex flex-wrap gap-2">
                <input
                  ref={sourceRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  disabled={sdGenerating}
                  onChange={(e) => {
                    const f = e.target.files?.[0] || null;
                    setSourceFile(f);
                  }}
                />
                <button
                  type="button"
                  disabled={sdGenerating}
                  onClick={() => sourceRef.current?.click()}
                  className="rounded-lg border border-tc-border bg-tc-input px-2 py-1.5 text-xs text-tc-text transition hover:bg-tc-hover disabled:opacity-40"
                >
                  Картинка…
                </button>
                {useInpaint && (
                  <>
                    <input
                      ref={maskRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      disabled={sdGenerating}
                      onChange={(e) => {
                        const f = e.target.files?.[0] || null;
                        setMaskFile(f);
                      }}
                    />
                    <button
                      type="button"
                      disabled={sdGenerating}
                      onClick={() => maskRef.current?.click()}
                      className="rounded-lg border border-tc-border bg-tc-input px-2 py-1.5 text-xs text-tc-text transition hover:bg-tc-hover disabled:opacity-40"
                    >
                      Маска…
                    </button>
                  </>
                )}
              </div>
              {useInpaint ? (
                <p className="text-[10px] leading-snug text-tc-text-muted">
                  Маска: белое = перерисовать, чёрное = оставить. Лучше PNG и тот же размер, что у исходника.
                </p>
              ) : null}
              {(srcPreview || maskPreview) && (
                <div className="flex flex-wrap gap-2">
                  {srcPreview ? (
                    <img src={srcPreview} alt="" className="h-16 w-16 rounded border border-tc-border object-cover" />
                  ) : null}
                  {maskPreview ? (
                    <img src={maskPreview} alt="" className="h-16 w-16 rounded border border-tc-border object-cover" />
                  ) : null}
                </div>
              )}
            </div>
          )}

          <div className="rounded-xl border border-tc-border/60 bg-tc-panel/25 p-3 space-y-2">
            <p className="text-xs font-semibold text-tc-text-sec">Промпт и параметры</p>
            <textarea
              className="tc-msg-input min-h-[52px] w-full resize-y rounded-lg border border-tc-border bg-tc-input px-3 py-2 text-sm text-tc-text outline-none placeholder:text-tc-text-muted focus:ring-2 focus:ring-tc-accent/50"
              value={sdPrompt}
              onChange={(e) => setSdPrompt(e.target.value)}
              placeholder="Например: a cute dog, fluffy fur, sitting, outdoor, soft light, detailed"
              maxLength={1500}
              rows={2}
              disabled={sdGenerating}
            />
            <input
              type="text"
              className="tc-msg-input w-full rounded-lg border border-tc-border bg-tc-input px-3 py-2 text-xs text-tc-text outline-none placeholder:text-tc-text-muted focus:ring-2 focus:ring-tc-accent/50"
              value={sdNegative}
              onChange={(e) => setSdNegative(e.target.value)}
              placeholder="Негативный промпт (необязательно)"
              maxLength={1500}
              disabled={sdGenerating}
            />
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-0.5 text-[11px] text-tc-text-muted">
                Шаги
                <input
                  type="number"
                  min={8}
                  max={40}
                  value={sdSteps}
                  onChange={(e) => setSdSteps(Math.min(40, Math.max(8, parseInt(e.target.value, 10) || 25)))}
                  className="w-16 rounded border border-tc-border bg-tc-input px-2 py-1 text-xs text-tc-text"
                  disabled={sdGenerating}
                />
              </label>
              <label className="flex flex-col gap-0.5 text-[11px] text-tc-text-muted">
                Сторона
                <select
                  value={sdSize}
                  onChange={(e) => setSdSize(parseInt(e.target.value, 10) || 512)}
                  className="rounded border border-tc-border bg-tc-input px-2 py-1 text-xs text-tc-text"
                  disabled={sdGenerating}
                >
                  {sizeOptions.map((n) => (
                    <option key={n} value={n}>
                      {n}×{n}
                    </option>
                  ))}
                </select>
              </label>
              {sdMode === SD_MODES.img2img && (
                <label className="flex min-w-[8rem] flex-col gap-0.5 text-[11px] text-tc-text-muted">
                  Шум (denoise)
                  <input
                    type="range"
                    min={0.05}
                    max={0.95}
                    step={0.05}
                    value={sdDenoise}
                    onChange={(e) => setSdDenoise(parseFloat(e.target.value) || 0.55)}
                    disabled={sdGenerating}
                    className="w-full"
                  />
                  <span className="text-[10px]">{sdDenoise.toFixed(2)}</span>
                </label>
              )}
              <button
                type="button"
                onClick={() => void generateSdImage()}
                disabled={sdGenerating || !canSubmit}
                className="rounded-lg bg-tc-accent px-3 py-2 text-xs font-semibold text-white transition hover:opacity-95 disabled:opacity-40"
              >
                {sdGenerating ? "…" : sdMode === SD_MODES.txt2img ? "Нарисовать" : useInpaint ? "Изменить (инпейнт)" : "Изменить"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
