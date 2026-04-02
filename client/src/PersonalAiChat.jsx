import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const LS_AI_WEB = "tatarchat_ai_web_search";

export default function PersonalAiChat({ getApiBase, token, nickname, onError }) {
  const [messages, setMessages] = useState([]);
  const [model, setModel] = useState("");
  const [webSearchAvailable, setWebSearchAvailable] = useState(false);
  const [webSearchOn, setWebSearchOn] = useState(() => localStorage.getItem(LS_AI_WEB) === "1");
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
          if (typeof data.webSearchAvailable === "boolean") setWebSearchAvailable(data.webSearchAvailable);
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
      if (Array.isArray(data.messages)) setMessages(data.messages);
    } catch (err) {
      console.error(err);
      onError?.("Сеть: не удалось отправить");
    } finally {
      setSending(false);
    }
  };

  const clearChat = async () => {
    if (!token || sending) return;
    if (!window.confirm("Очистить историю с ассистентом?")) return;
    onError?.(null);
    setSending(true);
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
            {model ? <p className="text-xs text-tc-text-muted/90">Модель: {model}</p> : null}
          </div>
        ) : (
          <div className="space-y-3">
            {model ? <p className="text-center text-[10px] text-tc-text-muted">Модель: {model}</p> : null}
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
          </div>
        )}
      </div>

      <div className="tc-composer-bar relative z-10 flex flex-col gap-2 border-t border-tc-border bg-tc-header px-2 py-2 sm:px-3">
        <div className="flex flex-wrap items-center justify-between gap-2 px-1">
          <div className="flex flex-wrap items-center gap-3">
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
                <span title="Перед ответом модели запрос к Google (Programmable Search). Расходует квоту API.">
                  Искать в интернете
                </span>
              </label>
            ) : (
              <span className="text-[10px] text-tc-text-muted" title="На сервере не заданы GOOGLE_CSE_API_KEY и GOOGLE_CSE_CX">
                Поиск: не настроен
              </span>
            )}
          </div>
        </div>
        <form onSubmit={send} className="flex min-h-[44px] min-w-0 items-center gap-0.5 rounded-xl bg-tc-input pl-3 pr-1 sm:pl-4">
          <textarea
            className="tc-msg-input min-h-[44px] max-h-40 min-w-0 flex-1 resize-y border-0 bg-transparent py-2.5 text-base text-tc-text outline-none ring-0 placeholder:text-tc-text-muted focus:ring-0 sm:text-sm"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={sending ? "Ответ…" : "Сообщение ассистенту"}
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
