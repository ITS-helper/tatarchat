import { useCallback, useState } from "react";

const SIZES = [512, 576, 640, 704, 768, 832, 896, 1024];

export default function PersonalImageTest({ getApiBase, token, onError, imageTestGenAvailable }) {
  const [prompt, setPrompt] = useState("");
  const [steps, setSteps] = useState(25);
  const [size, setSize] = useState(512);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const base = getApiBase();

  const generate = useCallback(async () => {
    const p = prompt.trim();
    if (!p || generating || !token || !imageTestGenAvailable) return;
    setGenerating(true);
    setResult(null);
    onError?.(null);
    try {
      const res = await fetch(`${base}/api/ai/image/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt: p, steps, width: size, height: size }),
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
      setResult({ dataUrl: `data:${mime};base64,${b64}`, prompt: p });
      onError?.(null);
    } catch (e) {
      console.error(e);
      onError?.("Сеть: генерация");
    } finally {
      setGenerating(false);
    }
  }, [base, token, imageTestGenAvailable, prompt, steps, size, generating, onError]);

  return (
    <div className="relative flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden">
      <div className="chat-bg-parallax pointer-events-none z-0" aria-hidden />
      <div className="messages-scroll relative z-10 w-full min-w-0 flex-1 overflow-y-auto bg-transparent px-4 py-3">
        {!imageTestGenAvailable ? (
          <div className="mx-auto max-w-md rounded-xl border border-tc-border/60 bg-tc-panel/30 p-4 text-sm text-tc-text-sec">
            <p className="font-medium text-tc-text">Тестовая генерация недоступна</p>
            <p className="mt-2 text-xs leading-relaxed text-tc-text-muted">
              Нужны права в админке и файл workflow на сервере:{" "}
              <code className="rounded bg-tc-input px-1">SWARM_COMFY_TEST_TXT2IMG_WORKFLOW</code> (и{" "}
              <code className="rounded bg-tc-input px-1">SWARMUI_BASE_URL</code>), затем перезапуск Node.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-center text-xs text-tc-text-muted">
              Отдельный txt2img workflow для экспериментов. Промпт лучше на английском.
            </p>
            {generating ? (
              <div className="flex justify-center">
                <div className="max-w-md rounded-xl border border-tc-border/50 bg-tc-msg px-4 py-3 text-sm">
                  <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-tc-accent/90">Тест</p>
                  <div className="flex items-center gap-2 text-tc-text-sec">
                    <span
                      className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-tc-border border-t-tc-accent"
                      aria-hidden
                    />
                    <span className="text-xs">Comfy workflow…</span>
                  </div>
                </div>
              </div>
            ) : null}
            {result ? (
              <div className="mx-auto max-w-lg rounded-xl border border-tc-border/50 bg-tc-msg px-4 py-3 text-sm text-tc-text">
                <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-tc-accent/90">Тест</p>
                <p className="mb-2 line-clamp-3 text-xs text-tc-text-muted" title={result.prompt}>
                  {result.prompt}
                </p>
                <button
                  type="button"
                  className="block w-full overflow-hidden rounded-lg border border-tc-border/60 focus:outline-none focus:ring-2 focus:ring-tc-accent/50"
                  onClick={() => setLightbox({ url: result.dataUrl, desc: result.prompt })}
                >
                  <img src={result.dataUrl} alt="" className="max-h-80 w-full object-contain bg-black/20" />
                </button>
                <div className="mt-2 flex flex-wrap gap-2">
                  <a
                    href={result.dataUrl}
                    download="tatarchat-test.png"
                    className="rounded-lg bg-tc-accent/20 px-2 py-1 text-xs font-medium text-tc-accent transition hover:bg-tc-accent/30"
                  >
                    Скачать
                  </a>
                  <button
                    type="button"
                    className="rounded-lg px-2 py-1 text-xs text-tc-text-muted transition hover:bg-tc-hover"
                    onClick={() => setResult(null)}
                  >
                    Убрать
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {imageTestGenAvailable ? (
        <div className="tc-composer-bar relative z-10 flex flex-col gap-2 border-t border-tc-border bg-tc-header px-2 py-2 sm:px-3">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Промпт (тестовый workflow)"
            rows={2}
            disabled={generating}
            className="tc-msg-input w-full resize-none rounded-xl border border-tc-border/50 bg-tc-input px-3 py-2 text-base text-tc-text outline-none placeholder:text-tc-text-muted focus:ring-1 focus:ring-tc-accent sm:text-sm"
          />
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-tc-text-muted">
              Шаги
              <input
                type="number"
                min={8}
                max={80}
                value={steps}
                disabled={generating}
                onChange={(e) => setSteps(Number(e.target.value) || 25)}
                className="w-16 rounded-lg border border-tc-border/50 bg-tc-input px-2 py-1 text-xs text-tc-text"
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-tc-text-muted">
              Размер
              <select
                value={size}
                disabled={generating}
                onChange={(e) => setSize(Number(e.target.value))}
                className="rounded-lg border border-tc-border/50 bg-tc-input px-2 py-1 text-xs text-tc-text"
              >
                {SIZES.map((s) => (
                  <option key={s} value={s}>
                    {s}×{s}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={generating || !prompt.trim()}
              onClick={() => void generate()}
              className="ml-auto rounded-xl bg-tc-accent px-4 py-2 text-sm font-semibold text-white transition hover:opacity-95 disabled:opacity-40"
            >
              Нарисовать
            </button>
          </div>
        </div>
      ) : null}

      {lightbox && typeof document !== "undefined" ? (
        <div
          className="fixed inset-0 z-[260] flex items-center justify-center bg-black/70 p-4"
          onClick={() => setLightbox(null)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="max-h-[90vh] w-full max-w-3xl overflow-hidden rounded-xl border border-tc-border bg-tc-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-tc-border px-3 py-2">
              <p className="min-w-0 truncate text-xs text-tc-text-sec">{lightbox.desc || "Тест"}</p>
              <button
                type="button"
                className="rounded-lg px-2 py-1 text-sm text-tc-text-sec hover:bg-tc-hover"
                onClick={() => setLightbox(null)}
                title="Закрыть"
              >
                ✕
              </button>
            </div>
            <div className="flex max-h-[80vh] items-center justify-center bg-black">
              <img
                src={lightbox.url}
                alt={lightbox.desc || "image"}
                className="max-h-[80vh] w-auto max-w-full object-contain"
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
