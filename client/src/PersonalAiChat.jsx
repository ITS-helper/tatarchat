import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";

const LS_AI_WEB = "tatarchat_ai_web_search";
const LS_AI_MODEL = "tatarchat_ai_model";

/** Модель часто лепит ### к предыдущему абзацу без \\n — ломает Markdown */
function normalizeAssistantMarkdown(text) {
  let s = String(text ?? "").replace(/\r\n/g, "\n");
  if (!s.trim()) return s;
  // Заголовок сразу после знака препинания / скобки
  s = s.replace(/([.!?:)])(\s*)(#{1,4}\s)/g, "$1\n\n$3");
  // ### или ## внутри строки (не для URL-служебных #)
  s = s.replace(/([^\n#\s])(#{2,4}\s+)/g, "$1\n\n$2");
  // Горизонтальная линия перед источниками
  s = s.replace(/([^\n])\n(---+\s*)$/gm, "$1\n\n$2");
  // Маркированный список после текста в одной строке: «…текст- пункт» редкий кейс
  s = s.replace(/([а-яА-Яa-zA-Z0-9])(-\s+[А-Яа-яA-Za-z])/g, "$1\n$2");
  return s.trim();
}

function trimUrl(u) {
  return String(u || "").replace(/[.,;)\]]+$/, "");
}

/** Короткая подпись для ссылки (домен + укороченный путь). */
function linkLabelForUrl(raw) {
  const u = trimUrl(raw);
  try {
    const x = new URL(u);
    let host = x.hostname.replace(/^www\./i, "");
    let path = x.pathname || "";
    if (path.length > 22) path = `${path.slice(0, 20)}…`;
    const tail = path && path !== "/" ? path : "";
    const extra = x.search ? "·…" : "";
    return `${host}${tail}${extra}` || u;
  } catch {
    return u.length > 40 ? `${u.slice(0, 38)}…` : u;
  }
}

/** Голые http(s) → [подпись](url); не трогаем `inline` / ```fence``` и уже оформленные [](url). */
function compressBareUrls(text) {
  const s = String(text ?? "");
  const fenceRe = /(```[\s\S]*?```|`[^`\n]+`)/g;
  const parts = s.split(fenceRe);
  const urlRe = /https?:\/\/[^\s)\]<>]+/gi;
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(urlRe, (url, offset, str) => {
      if (offset >= 2 && str[offset - 2] === "]" && str[offset - 1] === "(") return url;
      const t = trimUrl(url);
      return `[${linkLabelForUrl(t)}](${t})`;
    });
  }
  return parts.join("");
}

/** Разбивка по темам: каждый блок с ## в начале — отдельная «группа». */
function splitAssistantGroups(normalizedMd) {
  const s = String(normalizedMd ?? "").trim();
  if (!s) return [];
  const parts = s
    .split(/\n(?=##\s+)/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? parts : [s];
}

function parseSourcesBlock(content) {
  const raw = String(content ?? "");
  const candidates = [];
  const collect = (re) => {
    let m;
    const rg = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    while ((m = rg.exec(raw)) !== null) {
      candidates.push({ index: m.index, len: m[0].length });
    }
  };
  collect(/\n---+\s*\n\s*(?:\*\*)?Источники(?:\*\*)?:?\s*\n/i);
  collect(/\n\nИсточники:\s*\n/i);
  collect(/\n\*\*Источники\*\*:?\s*\n/i);
  const classic = "\n\nИсточники:\n";
  let pos = raw.indexOf(classic);
  while (pos !== -1) {
    candidates.push({ index: pos, len: classic.length });
    pos = raw.indexOf(classic, pos + 1);
  }
  if (!candidates.length) return { body: raw, sources: [] };
  const { index: splitIdx, len: skipLen } = candidates.reduce((a, b) => (a.index >= b.index ? a : b));
  const body = raw.slice(0, splitIdx).trimEnd();
  const block = raw.slice(splitIdx + skipLen).trim();
  const lines = block.split("\n").map((s) => s.trim()).filter(Boolean);
  const sources = [];
  for (const line of lines) {
    const mDash = /^[-*]\s*(.*?)\s+—\s+(https?:\/\/\S+)/.exec(line);
    if (mDash) {
      sources.push({ title: mDash[1].trim() || trimUrl(mDash[2]), url: trimUrl(mDash[2]) });
      continue;
    }
    const mMd = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/.exec(line);
    if (mMd) {
      sources.push({ title: mMd[1].trim() || trimUrl(mMd[2]), url: trimUrl(mMd[2]) });
      continue;
    }
    const mNum = /^\d+\.\s*(.+)$/.exec(line);
    if (mNum) {
      const rest = mNum[1].trim();
      const urlMatch = /(https?:\/\/[^\s)\]]+)/.exec(rest);
      if (urlMatch) {
        const url = trimUrl(urlMatch[1]);
        const title = rest.replace(urlMatch[0], "").replace(/^[.\s—-]+|[.\s—-]+$/g, "").trim() || url;
        sources.push({ title, url });
      }
      continue;
    }
    const urlPlain = /(https?:\/\/[^\s)\]]+)/.exec(line);
    if (urlPlain) {
      const url = trimUrl(urlPlain[1]);
      const title = line.replace(urlPlain[0], "").replace(/^[-*\d.\s]+/, "").trim() || url;
      sources.push({ title, url });
    }
  }
  return { body, sources };
}

const assistantMdComponents = {
  h1: ({ children }) => (
    <h1 className="mb-2 mt-4 border-b border-tc-border/40 pb-1 text-lg font-bold text-tc-text first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-1.5 mt-0 border-b border-tc-border/35 pb-1 text-[15px] font-bold text-tc-accent first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1.5 mt-3 text-[15px] font-semibold text-tc-accent first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => <h4 className="mb-1 mt-2 text-sm font-semibold text-tc-text">{children}</h4>,
  p: ({ children }) => <p className="mb-2.5 last:mb-0 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="mb-2.5 ml-0 list-disc space-y-1.5 py-0.5 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2.5 ml-0 list-decimal space-y-1.5 py-0.5 pl-5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed marker:text-tc-accent">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-tc-text">{children}</strong>,
  em: ({ children }) => <em className="italic text-tc-text-sec">{children}</em>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="break-words text-tc-link underline decoration-tc-border underline-offset-2 hover:text-tc-accent"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-4 border-t border-tc-border/50" />,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-[3px] border-tc-accent/40 pl-3 text-sm text-tc-text-sec">{children}</blockquote>
  ),
  code: ({ className, children }) => {
    const inline = !className;
    if (inline) {
      return <code className="rounded bg-tc-input px-1 py-0.5 font-mono text-[0.85em] text-tc-text">{children}</code>;
    }
    return (
      <pre className="mb-2.5 max-w-full overflow-x-auto rounded-lg border border-tc-border/50 bg-tc-input/60 p-2.5 font-mono text-xs leading-snug">
        <code>{children}</code>
      </pre>
    );
  },
};

function AssistantMarkdownBody({ text }) {
  const md = compressBareUrls(normalizeAssistantMarkdown(text));
  if (!md) return null;
  const groups = splitAssistantGroups(md);
  return (
    <div className="ai-assistant-md min-w-0 space-y-2 text-sm text-tc-text">
      {groups.map((chunk, gi) => (
        <div
          key={gi}
          className="rounded-lg border border-tc-border/50 bg-tc-panel/20 px-2.5 py-2 shadow-sm sm:px-3"
        >
          <ReactMarkdown remarkPlugins={[remarkBreaks]} components={assistantMdComponents}>
            {chunk}
          </ReactMarkdown>
        </div>
      ))}
    </div>
  );
}

export default function PersonalAiChat({ getApiBase, token, nickname, onError }) {
  const [messages, setMessages] = useState([]);
  const [model, setModel] = useState("");
  const [availableModels, setAvailableModels] = useState([]);
  const [webSearchAvailable, setWebSearchAvailable] = useState(false);
  const [imageGenAvailable, setImageGenAvailable] = useState(false);
  const [sdPanelOpen, setSdPanelOpen] = useState(false);
  const [sdPrompt, setSdPrompt] = useState("");
  const [sdNegative, setSdNegative] = useState("");
  const [sdSteps, setSdSteps] = useState(25);
  const [sdSize, setSdSize] = useState(512);
  const [sdGenerating, setSdGenerating] = useState(false);
  const [sdResult, setSdResult] = useState(null);
  const [webSearchOn, setWebSearchOn] = useState(() => localStorage.getItem(LS_AI_WEB) === "1");
  const [webImages, setWebImages] = useState([]);
  const [searching, setSearching] = useState(false);
  const [facts, setFacts] = useState([]);
  const [factInput, setFactInput] = useState("");
  const [factsOpen, setFactsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [pendingImage, setPendingImage] = useState(null);
  const fileRef = useRef(null);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const listRef = useRef(null);
  const [imageLightbox, setImageLightbox] = useState(null);

  const base = getApiBase();

  const scrollBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    scrollBottom();
  }, [messages, sending, sdResult, scrollBottom]);

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
          if (typeof data.imageGenAvailable === "boolean") setImageGenAvailable(data.imageGenAvailable);
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
    if ((!t && !pendingImage) || sending || !token) return;
    setInput("");
    setSending(true);
    setSearching(webSearchOn && webSearchAvailable);
    setWebImages([]);
    onError?.(null);
    try {
      let res;
      if (pendingImage) {
        const fd = new FormData();
        fd.append("message", t);
        fd.append("search", webSearchOn && webSearchAvailable ? "true" : "false");
        fd.append("image", pendingImage);
        res = await fetch(`${base}/api/ai/chat/send-with-image`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: fd,
        });
      } else {
        res = await fetch(`${base}/api/ai/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ message: t, search: webSearchOn && webSearchAvailable }),
        });
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const d = typeof data.detail === "string" && data.detail.trim() ? ` ${data.detail.trim()}` : "";
        onError?.((data.error || `Ошибка ${res.status}`) + d);
        return;
      }
      onError?.(null);
      if (data.model) setModel(data.model);
      if (Array.isArray(data.messages)) setMessages(data.messages);
      const imgs = data?.web?.images;
      if (Array.isArray(imgs)) setWebImages(imgs.slice(0, 8));
      if (Array.isArray(data.facts)) setFacts(data.facts);
      if (typeof data.imageGenAvailable === "boolean") setImageGenAvailable(data.imageGenAvailable);
      setPendingImage(null);
      if (fileRef.current) fileRef.current.value = "";
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
        const d = typeof data.detail === "string" && data.detail.trim() ? ` ${data.detail.trim()}` : "";
        onError?.((data.error || "Не удалось очистить") + d);
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
        const d = typeof data.detail === "string" && data.detail.trim() ? ` ${data.detail.trim()}` : "";
        onError?.((data.error || `Ошибка ${res.status}`) + d);
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
        const d = typeof data.detail === "string" && data.detail.trim() ? ` ${data.detail.trim()}` : "";
        onError?.((data.error || `Ошибка ${res.status}`) + d);
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
    if (m === "qwen3.5:4b") return "qwen3:5.4b · текст";
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
        const d = typeof data.detail === "string" && data.detail.trim() ? ` ${data.detail.trim()}` : "";
        onError?.((data.error || `Ошибка ${res.status}`) + d);
        return;
      }
      if (data.model) setModel(data.model);
      if (Array.isArray(data.availableModels)) setAvailableModels(data.availableModels);
    } catch (e) {
      console.error(e);
      onError?.("Сеть: модель");
    }
  };

  const generateSdImage = async () => {
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
            <p className="text-sm text-tc-text-muted">Личный чат с ассистентом на сервере.</p>
            {model ? <p className="text-xs text-tc-text-muted/90">Модель: {modelLabel(model)}</p> : null}
          </div>
        ) : (
          <div className="space-y-3">
            {model ? <p className="text-center text-[10px] text-tc-text-muted">Модель: {modelLabel(model)}</p> : null}
            {messages.map((m, i) => {
              const mine = m.role === "user";
              const parsed = !mine ? parseSourcesBlock(m.content) : { body: m.content, sources: [] };
              return (
                <div key={i} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[min(100%,36rem)] break-words rounded-xl px-3 py-2 text-sm ${
                      mine ? "whitespace-pre-wrap rounded-br-sm bg-tc-msg-own text-tc-text" : "rounded-bl-sm bg-tc-msg text-tc-text"
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
                    {mine ? (
                      <div className="whitespace-pre-wrap break-words">{parsed.body}</div>
                    ) : (
                      <AssistantMarkdownBody text={parsed.body} />
                    )}
                    {!mine && parsed.sources.length ? (
                      <details className="group mt-2 rounded-lg border border-tc-border/55 bg-black/[0.06]">
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-2 text-[11px] font-semibold text-tc-text-sec transition hover:text-tc-accent [&::-webkit-details-marker]:hidden">
                          <span>Источники · {parsed.sources.length}</span>
                          <span className="text-[10px] text-tc-text-muted transition group-open:rotate-180" aria-hidden>
                            ▼
                          </span>
                        </summary>
                        <ul className="border-t border-tc-border/40 px-2.5 py-2 space-y-1.5 text-[11px] text-tc-text-muted">
                          {parsed.sources.map((s, si) => (
                            <li key={si} className="leading-snug">
                              <a
                                href={s.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="break-words text-tc-link underline decoration-tc-border underline-offset-2 hover:text-tc-accent"
                                title={s.url}
                              >
                                {s.title || linkLabelForUrl(s.url)}
                              </a>
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
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
                      <button
                        key={idx}
                        type="button"
                        onClick={() => setImageLightbox({ url, desc })}
                        className="block overflow-hidden rounded-lg border border-tc-border/60 bg-tc-panel/30 hover:opacity-95"
                        title={desc || "Открыть картинку"}
                      >
                        <img src={url} alt={desc || "image"} className="h-24 w-full object-cover" loading="lazy" />
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
            {sdGenerating ? (
              <div className="flex justify-start">
                <div className="max-w-[min(100%,36rem)] rounded-xl rounded-bl-sm border border-tc-border/50 bg-tc-msg px-3 py-2 text-sm">
                  <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-tc-accent/90">Stable Diffusion</p>
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
              <div className="flex justify-start">
                <div className="max-w-[min(100%,36rem)] rounded-xl rounded-bl-sm border border-tc-border/50 bg-tc-msg px-3 py-2 text-sm text-tc-text">
                  <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-tc-accent/90">Stable Diffusion</p>
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
            {imageGenAvailable ? (
              <button
                type="button"
                disabled={loading}
                onClick={() => setSdPanelOpen((v) => !v)}
                className={`text-xs underline decoration-tc-border underline-offset-2 transition disabled:opacity-40 ${
                  sdPanelOpen ? "font-medium text-tc-accent" : "text-tc-text-sec hover:text-tc-accent"
                }`}
                title="txt2img через Automatic1111 на сервере"
              >
                Картинка (SD)
              </button>
            ) : (
              <span
                className="text-[10px] text-tc-text-muted"
                title="В .env сервера: SD_WEBUI_BASE_URL=http://127.0.0.1:7860 и запущен A1111 с --api"
              >
                SD: выкл
              </span>
            )}
          </div>
        </div>

        {imageGenAvailable && sdPanelOpen ? (
          <div className="rounded-xl border border-tc-border/60 bg-tc-panel/25 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-tc-text-sec">Генерация (Stable Diffusion)</p>
              <button
                type="button"
                className="text-xs text-tc-text-muted hover:text-tc-accent"
                onClick={() => setSdPanelOpen(false)}
              >
                Свернуть
              </button>
            </div>
            <textarea
              className="tc-msg-input min-h-[52px] w-full resize-y rounded-lg border border-tc-border bg-tc-input px-3 py-2 text-sm text-tc-text outline-none placeholder:text-tc-text-muted focus:ring-2 focus:ring-tc-accent/50"
              value={sdPrompt}
              onChange={(e) => setSdPrompt(e.target.value)}
              placeholder="Промпт: что нарисовать (англ. или рус. — как настроена модель)"
              maxLength={1500}
              rows={2}
              disabled={sdGenerating || loading}
            />
            <input
              type="text"
              className="tc-msg-input w-full rounded-lg border border-tc-border bg-tc-input px-3 py-2 text-xs text-tc-text outline-none placeholder:text-tc-text-muted focus:ring-2 focus:ring-tc-accent/50"
              value={sdNegative}
              onChange={(e) => setSdNegative(e.target.value)}
              placeholder="Негативный промпт (необязательно)"
              maxLength={1500}
              disabled={sdGenerating || loading}
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
                  disabled={sdGenerating || loading}
                />
              </label>
              <label className="flex flex-col gap-0.5 text-[11px] text-tc-text-muted">
                Сторона
                <select
                  value={sdSize}
                  onChange={(e) => setSdSize(parseInt(e.target.value, 10) || 512)}
                  className="rounded border border-tc-border bg-tc-input px-2 py-1 text-xs text-tc-text"
                  disabled={sdGenerating || loading}
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
                disabled={sdGenerating || loading || !sdPrompt.trim()}
                className="rounded-lg bg-tc-accent px-3 py-2 text-xs font-semibold text-white transition hover:opacity-95 disabled:opacity-40"
              >
                {sdGenerating ? "…" : "Сгенерировать"}
              </button>
            </div>
            <p className="text-[10px] leading-snug text-tc-text-muted">
              Запрос с Node на локальный A1111. На 8 ГБ VRAM при OOM уменьши размер или шаги.
            </p>
          </div>
        ) : null}

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
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp,image/*"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0] || null;
              if (!f) return;
              setPendingImage(f);
            }}
          />
          <button
            type="button"
            disabled={sending || loading}
            onClick={() => fileRef.current?.click()}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-tc-text-sec transition hover:bg-tc-hover hover:text-tc-accent disabled:opacity-40"
            title="Прикрепить картинку"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden>
              <path d="M21 19V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2zM8.5 11.5A2.5 2.5 0 1111 9a2.5 2.5 0 01-2.5 2.5zM6 19l4.5-6 3.5 4.5 2.5-3L19 19H6z" />
            </svg>
          </button>
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
            disabled={sending || loading || (!input.trim() && !pendingImage)}
            className="flex h-10 min-w-[2.5rem] shrink-0 items-center justify-center rounded-full bg-tc-accent px-3 text-sm font-semibold text-white transition hover:opacity-95 disabled:opacity-40"
          >
            {sending ? "…" : "→"}
          </button>
        </form>
        {pendingImage ? (
          <div className="flex items-center gap-2 rounded-lg bg-tc-input px-3 py-2 text-xs text-tc-text-sec">
            <span className="truncate">🖼️ {pendingImage.name}</span>
            <button
              type="button"
              className="shrink-0 text-tc-danger hover:underline"
              onClick={() => { setPendingImage(null); if (fileRef.current) fileRef.current.value = ""; }}
              title="Убрать"
            >
              ✕
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
