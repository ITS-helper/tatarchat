import { useCallback, useEffect, useState } from "react";

export default function PersonalSdImage({ getApiBase, token, onError }) {
  const [loading, setLoading] = useState(true);
  const [imageGenAvailable, setImageGenAvailable] = useState(false);
  const [sdPrompt, setSdPrompt] = useState("");
  const [sdNegative, setSdNegative] = useState("");
  const [sdSteps, setSdSteps] = useState(25);
  const [sdSize, setSdSize] = useState(512);
  const [sdGenerating, setSdGenerating] = useState(false);
  const [sdResult, setSdResult] = useState(null);
  const [imageLightbox, setImageLightbox] = useState(null);

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

  const generateSdImage = useCallback(async () => {
    const p = sdPrompt.trim();
    if (!p || sdGenerating || !token || !imageGenAvailable) return;
    setSdGenerating(true);
    setSdResult(null);
    onError?.(null);
    try {
      const res = await fetch(`${base}/api/ai/image`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          prompt: p,
          negative_prompt: sdNegative.trim() || undefined,
          steps: sdSteps,
          width: sdSize,
          height: sdSize,
        }),
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
      setSdResult({ dataUrl: `data:${mime};base64,${b64}`, prompt: p });
      onError?.(null);
    } catch (e) {
      console.error(e);
      onError?.("Сеть: генерация картинки");
    } finally {
      setSdGenerating(false);
    }
  }, [base, token, imageGenAvailable, sdPrompt, sdNegative, sdSteps, sdSize, sdGenerating, onError]);

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
            <p className="font-medium text-tc-text">Stable Diffusion недоступен</p>
            <p className="mt-2 text-xs leading-relaxed text-tc-text-muted">
              На сервере задайте <code className="rounded bg-tc-input px-1">SD_WEBUI_BASE_URL</code> (например{" "}
              <code className="rounded bg-tc-input px-1">http://127.0.0.1:7860</code>) и запустите Automatic1111 с{" "}
              <code className="rounded bg-tc-input px-1">--api</code>, затем перезапустите Node.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-center text-xs text-tc-text-muted">
              txt2img через Automatic1111. Обычные модели лучше понимают{" "}
              <span className="font-medium text-tc-text-sec">английские теги</span>, а не фразы вроде «нарисуй
              собаку» — иначе картинка может «плавать». На 8 ГБ VRAM при OOM уменьши размер или шаги.
            </p>
            {sdGenerating ? (
              <div className="flex justify-center">
                <div className="max-w-md rounded-xl border border-tc-border/50 bg-tc-msg px-4 py-3 text-sm">
                  <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-tc-accent/90">
                    Stable Diffusion
                  </p>
                  <div className="flex items-center gap-2 text-tc-text-sec">
                    <span
                      className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-tc-border border-t-tc-accent"
                      aria-hidden
                    />
                    <span className="text-xs">Рисую… (до пары минут)</span>
                  </div>
                </div>
              </div>
            ) : null}
            {sdResult ? (
              <div className="mx-auto max-w-lg rounded-xl border border-tc-border/50 bg-tc-msg px-4 py-3 text-sm text-tc-text">
                <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-tc-accent/90">
                  Stable Diffusion
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
                  {[512, 576, 640, 704, 768].map((n) => (
                    <option key={n} value={n}>
                      {n}×{n}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => void generateSdImage()}
                disabled={sdGenerating || !sdPrompt.trim()}
                className="rounded-lg bg-tc-accent px-3 py-2 text-xs font-semibold text-white transition hover:opacity-95 disabled:opacity-40"
              >
                {sdGenerating ? "…" : "Сгенерировать"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
