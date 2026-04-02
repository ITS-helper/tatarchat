import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const LS_AI_WEB = "tatarchat_ai_web_search";
const LS_AI_MODEL = "tatarchat_ai_model";

export default function PersonalAiChat({ getApiBase, token, nickname, onError }) {
  const [messages, setMessages] = useState([]);
  const [model, setModel] = useState("");
  const [availableModels, setAvailableModels] = useState([]);
  const [webSearchAvailable, setWebSearchAvailable] = useState(false);
  const [webSearchOn, setWebSearchOn] = useState(() => localStorage.getItem(LS_AI_WEB) === "1");
  const [webImages, setWebImages] = useState([]);
  const [searching, setSearching] = useState(false);
  const [facts, setFacts] = useState([]);
  const [factInput, setFactInput] = useState("");
  const [factsOpen, setFactsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const listRef = useRef(null);

  const base = getApiBase();

  const scrollBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    scrollBottom();
  }, [messages, sending, scrollBottom]);

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
          onError?.(data.error || "Не удалось загрузить чат с ассистентом");
          return;
        }
        if (!cancelled) {
          setMessages(Array.isArray(data.messages) ? data.messages : []);
          if (data.model) setModel(data.model);
          if (Array.isArray(data.availableModels)) setAvailableModels(data.availableModels);
          if (typeof data.webSearchAvailable === "boolean") setWebSearchAvailable(data.webSearchAvailable);
          if (Array.isArray(data.facts)) setFacts(data.facts);
          const savedModel = localStorage.getItem(LS_AI_MODEL);
          if (savedModel && Array.isArray(data.availableModels) && data.availableModels.includes(savedModel) && savedModel !== data.model) {
            // best effort: sync UI preference back to server
            fetch(`${base}/api/ai/chat`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify({ setModel: savedModel }),
            })
              .then((r) => r.json().catch(() => ({})))
              .then((d) => {
                if (d?.model) setModel(d.model);
              })
              .catch(() => {});
          }
        }
      } catch (e) {
        console.error(e);
        onError?.("Сеть: ассистент");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base, token, onError]);

  const send = async (e) => {
    e?.preventDefault?.();
    const t = input.trim();
    if (!t || sending || !token) return;
    setInput("");
    setSending(true);
    setSearching(webSearchOn && webSearchAvailable);
    setWebImages([]);
    onError?.(null);
    try {
      const res = await fetch(`${base}/api/ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: t, search: webSearchOn && webSearchAvailable }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError?.(data.error || `Ошибка ${res.status}`);
        return;
      }
      onError?.(null);
      if (data.model) setModel(data.model);
      if (Array.isArray(data.messages)) setMessages(data.messages);
      const imgs = data?.web?.images;
      if (Array.isArray(imgs)) setWebImages(imgs.slice(0, 8));
      if (Array.isArray(data.facts)) setFacts(data.facts);
    } catch (err) {
      console.error(err);
      onError?.("Сеть: не удалось отправить");
    } finally {
      setSending(false);
      setSearching(false);
    }
  };

  const clearChat = async () => {
    if (!token || sending) return;
    if (!window.confirm("Очистить историю с ассистентом?")) return;
    onError?.(null);
    setSending(true);
    setWebImages([]);
    try {
      const res = await fetch(`${base}/api/ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ clear: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError?.(data.error || "Не удалось очистить");
        return;
      }
      onError?.(null);
      setMessages([]);
    } catch (e) {
      console.error(e);
      onError?.("Сеть");
    } finally {
      setSending(false);
    }
  };

  const reloadFacts = async () => {
    if (!token) return;
    try {
      const res = await fetch(`${base}/api/ai/facts`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.facts)) setFacts(data.facts);
    } catch (_) {}
  };

  const addFact = async () => {
    const f = factInput.trim();
    if (!f || !token) return;
    setFactInput("");
    onError?.(null);
    try {
      const res = await fetch(`${base}/api/ai/facts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ fact: f }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError?.(data.error || `Ошибка ${res.status}`);
        return;
      }
      await reloadFacts();
    } catch (e) {
      console.error(e);
      onError?.("Сеть: факт");
    }
  };

  const deleteFact = async (id) => {
    if (!token) return;
    onError?.(null);
    try {
      const res = await fetch(`${base}/api/ai/facts/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError?.(data.error || `Ошибка ${res.status}`);
        return;
      }
      await reloadFacts();
    } catch (e) {
      console.error(e);
      onError?.("Сеть: факт");
    }
  };

  const modelLabel = (m) => {
    if (m === "qwen3-vl:8b") return "qwen3-vl:8b · картинки";
    if (m === "qwen3:5.4b") return "qwen3:5.4b · текст";
    return m;
  };

  const switchModel = async (next) => {
    const m = String(next || "").trim();
    if (!m || !token) return;
    localStorage.setItem(LS_AI_MODEL, m);
    setModel(m);
    onError?.(null);
    try {
      const res = await fetch(`${base}/api/ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ setModel: m }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError?.(data.error || `Ошибка ${res.status}`);
        return;
      }
      if (data.model) setModel(data.model);
      if (Array.isArray(data.availableModels)) setAvailableModels(data.availableModels);
    } catch (e) {
      console.error(e);
      onError?.("Сеть: модель");
    }
  };

  return (
    <div className="relative flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden">
      <div className="chat-bg-parallax pointer-events-none z-0" aria-hidden />
      <div
        ref={listRef}
        className="messages-scroll relative z-10 w-full min-w-0 flex-1 overflow-y-auto bg-transparent px-4 py-3"
      >
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-tc-text-muted">Загрузка…</p>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-2 text-center">
            <p className="text-sm text-tc-text-muted">Личный чат с моделью на сервере (Ollama).</p>
            {model ? <p className="text-xs text-tc-text-muted/90">Модель: {modelLabel(model)}</p> : null}
          </div>
        ) : (
          <div className="space-y-3">
            {model ? <p className="text-center text-[10px] text-tc-text-muted">Модель: {modelLabel(model)}</p> : null}
            {messages.map((m, i) => {
              const mine = m.role === "user";
              return (
                <div key={i} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[min(100%,36rem)] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap break-words ${
                      mine ? "rounded-br-sm bg-tc-msg-own text-tc-text" : "rounded-bl-sm bg-tc-msg text-tc-text"
                    }`}
                  >
                    {!mine ? (
                      <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-tc-accent/90">
                        Ассистент
                      </p>
                    ) : (
                      <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-tc-text-muted">
                        {nickname || "Вы"}
                      </p>
                    )}
                    {m.content}
                  </div>
                </div>
              );
            })}
            {sending ? (
              <div className="flex justify-start">
                <div className="max-w-[min(100%,36rem)] rounded-xl rounded-bl-sm bg-tc-msg px-3 py-2 text-sm text-tc-text">
                  <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-tc-accent/90">Ассистент</p>
                  <div className="flex items-center gap-2">
                    <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-tc-border border-t-tc-accent" aria-hidden />
                    <span className="text-tc-text-sec">{searching ? "Ищу и думаю…" : "Думаю…"}</span>
                  </div>
                </div>
              </div>
            ) : null}
            {webImages.length ? (
              <div className="mt-1">
                <p className="mb-2 text-center text-[10px] text-tc-text-muted">Картинки по теме поиска</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {webImages.map((it, idx) => {
                    const url = typeof it === "string" ? it : it?.url;
                    const desc = typeof it === "object" ? it?.description : "";
                    if (!url) return null;
                    return (
                      <a
                        key={idx}
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block overflow-hidden rounded-lg border border-tc-border/60 bg-tc-panel/30 hover:opacity-95"
                        title={desc || "Открыть картинку"}
                      >
                        <img src={url} alt={desc || "image"} className="h-24 w-full object-cover" loading="lazy" />
                      </a>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div className="tc-composer-bar relative z-10 flex flex-col gap-2 border-t border-tc-border bg-tc-header px-2 py-2 sm:px-3">
        <div className="flex flex-wrap items-center justify-between gap-2 px-1">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-tc-text-sec">
              <span className="text-tc-text-muted">Модель</span>
              <select
                value={model}
                disabled={sending || loading}
                onChange={(e) => switchModel(e.target.value)}
                className="rounded-lg border border-tc-border bg-tc-panel/40 px-2 py-1 text-xs text-tc-text outline-none focus:ring-2 focus:ring-tc-accent/50 disabled:opacity-40"
              >
                {(availableModels.length ? availableModels : ["qwen3:5.4b", "qwen3-vl:8b"]).map((m) => (
                  <option key={m} value={m}>
                    {modelLabel(m)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => { setFactsOpen((v) => !v); void reloadFacts(); }}
              disabled={sending || loading}
              className="text-xs text-tc-text-sec underline decoration-tc-border underline-offset-2 hover:text-tc-accent disabled:opacity-40"
              title="Память фактов (учитывается в ответах)"
            >
              Факты ({facts.length})
            </button>
            <button
              type="button"
              disabled={sending || loading}
              onClick={clearChat}
              className="text-xs text-tc-text-muted underline decoration-tc-border underline-offset-2 hover:text-tc-accent disabled:opacity-40"
            >
              Очистить историю
            </button>
            {webSearchAvailable ? (
              <label className="flex cursor-pointer items-center gap-2 text-xs text-tc-text-sec select-none">
                <input
                  type="checkbox"
                  className="tc-msg-input rounded border-tc-border text-tc-accent focus:ring-tc-accent"
                  checked={webSearchOn}
                  disabled={sending || loading}
                  onChange={(e) => {
                    const v = e.target.checked;
                    setWebSearchOn(v);
                    localStorage.setItem(LS_AI_WEB, v ? "1" : "0");
                  }}
                />
                <span title="Перед ответом модели — поиск через Tavily (расход API-кредитов по тарифу).">
                  Искать в интернете
                </span>
              </label>
            ) : (
              <span className="text-[10px] text-tc-text-muted" title="На сервере не задан TAVILY_API_KEY">
                Поиск: не настроен
              </span>
            )}
          </div>
        </div>

        {factsOpen ? (
          <div className="rounded-xl border border-tc-border/60 bg-tc-panel/20 p-3">
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold text-tc-text-sec">Память фактов</p>
                <button
                  type="button"
                  className="text-xs text-tc-text-muted hover:text-tc-accent"
                  onClick={() => setFactsOpen(false)}
                >
                  Закрыть
                </button>
              </div>
              <div className="flex gap-2">
                <input
                  className="tc-msg-input flex-1 rounded-lg border border-tc-border bg-tc-input px-3 py-2 text-sm text-tc-text outline-none placeholder:text-tc-text-muted focus:ring-2 focus:ring-tc-accent/50"
                  value={factInput}
                  onChange={(e) => setFactInput(e.target.value)}
                  placeholder="Добавить факт (например: Люблю кофе без сахара)"
                  maxLength={280}
                  disabled={sending || loading}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void addFact();
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => void addFact()}
                  disabled={sending || loading || !factInput.trim()}
                  className="rounded-lg bg-tc-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-40"
                >
                  Запомнить
                </button>
              </div>
              {facts.length ? (
                <div className="max-h-40 overflow-y-auto rounded-lg border border-tc-border/50">
                  {facts.map((f) => (
                    <div key={f.id} className="flex items-start gap-2 border-b border-tc-border/50 px-3 py-2 last:border-b-0">
                      <p className="flex-1 text-sm text-tc-text">{f.fact}</p>
                      <button
                        type="button"
                        className="shrink-0 text-xs text-tc-danger hover:underline"
                        onClick={() => { if (window.confirm("Удалить факт?")) void deleteFact(f.id); }}
                      >
                        Удалить
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-tc-text-muted">Пока нет фактов. Добавь пару заметок — ассистент будет учитывать их в ответах.</p>
              )}
            </div>
          </div>
        ) : null}

        <form onSubmit={send} className="flex min-h-[44px] min-w-0 items-center gap-0.5 rounded-xl bg-tc-input pl-3 pr-1 sm:pl-4">
          <textarea
            className="tc-msg-input min-h-[44px] max-h-40 min-w-0 flex-1 resize-y border-0 bg-transparent py-2.5 text-base text-tc-text outline-none ring-0 placeholder:text-tc-text-muted focus:ring-0 sm:text-sm"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={sending ? (searching ? "Ищу и думаю…" : "Думаю…") : "Сообщение ассистенту"}
            disabled={sending || loading}
            rows={1}
            maxLength={8000}
            enterKeyHint="send"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button
            type="submit"
            disabled={sending || loading || !input.trim()}
            className="flex h-10 min-w-[2.5rem] shrink-0 items-center justify-center rounded-full bg-tc-accent px-3 text-sm font-semibold text-white transition hover:opacity-95 disabled:opacity-40"
          >
            {sending ? "…" : "→"}
          </button>
        </form>
      </div>
    </div>
  );
}
