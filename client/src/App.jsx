import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const LS_TOKEN = "tatarchat_token";
const LS_NICKNAME = "tatarchat_nickname";

const PRODUCTION_API_ORIGIN = "https://tatarchat-server.onrender.com";

function getApiBase() {
  const fromEnv = import.meta.env.VITE_API_URL;
  if (fromEnv) return String(fromEnv).replace(/\/$/, "");
  if (import.meta.env.DEV) return "";
  return PRODUCTION_API_ORIGIN;
}

function getSocketUrl() {
  const fromEnv = import.meta.env.VITE_SOCKET_URL;
  if (fromEnv) return fromEnv;
  if (import.meta.env.DEV) return "http://127.0.0.1:3001";
  return PRODUCTION_API_ORIGIN;
}

function getStoredToken() {
  return localStorage.getItem(LS_TOKEN) || "";
}

function formatTime(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "short",
    });
  } catch {
    return "";
  }
}

export default function App() {
  const [token, setToken] = useState(() => getStoredToken());
  const [nickname, setNickname] = useState(() => localStorage.getItem(LS_NICKNAME) || "");
  const [authMode, setAuthMode] = useState("login");
  const [nameInput, setNameInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [online, setOnline] = useState([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("offline");
  const [roomJoined, setRoomJoined] = useState(false);
  const [banner, setBanner] = useState(null);
  const listRef = useRef(null);
  const socketRef = useRef(null);
  const roomJoinedRef = useRef(false);

  const scrollToBottom = useCallback(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const loadHistory = useCallback(async () => {
    try {
      const base = getApiBase();
      const res = await fetch(`${base}/api/messages/family`);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      setMessages(data.messages || []);
    } catch (e) {
      console.error(e);
      setBanner("Не удалось загрузить историю. Проверьте, что сервер запущен.");
    }
  }, []);

  useEffect(() => {
    if (!token.trim()) return;

    const socketUrl = getSocketUrl();
    const socket = io(socketUrl, {
      path: "/socket.io",
      transports: ["websocket", "polling"],
      auth: { token },
      withCredentials: import.meta.env.PROD,
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setStatus("online");
      setRoomJoined(false);
      roomJoinedRef.current = false;
      setBanner(null);
    });

    socket.on("disconnect", () => {
      setStatus("offline");
      setRoomJoined(false);
      roomJoinedRef.current = false;
    });

    socket.on("connect_error", (err) => {
      console.error(err);
      const msg = err?.message || "";
      if (/токен|вход|Unauthorized|invalid/i.test(msg)) {
        setBanner("Сессия недействительна. Войдите снова.");
        localStorage.removeItem(LS_TOKEN);
        setToken("");
      } else {
        setBanner("Нет соединения с сервером (Socket.io).");
      }
    });

    socket.on("history", (rows) => {
      if (Array.isArray(rows)) setMessages(rows);
      setRoomJoined(true);
      roomJoinedRef.current = true;
    });

    socket.on("online-users", (rows) => {
      if (Array.isArray(rows)) setOnline(rows);
    });

    socket.on("message", (msg) => {
      setMessages((prev) => [...prev, msg]);
    });

    socket.on("error-toast", (payload) => {
      if (payload?.error) setBanner(payload.error);
    });

    loadHistory();

    return () => {
      socket.emit("leave");
      socket.disconnect();
      socketRef.current = null;
    };
  }, [token, loadHistory]);

  const submitAuth = async (e) => {
    e.preventDefault();
    setBanner(null);
    const name = nameInput.trim();
    const password = passwordInput;
    if (!name || !password) {
      setBanner("Введите имя и пароль");
      return;
    }

    const base = getApiBase();
    const path = authMode === "register" ? "/api/auth/register" : "/api/auth/login";
    try {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, password }),
      });
      const raw = await res.text();
      let data = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        data = {};
      }
      if (!res.ok) {
        const msg =
          data.error ||
          data.message ||
          (raw && !raw.startsWith("<") && raw.length < 300 ? raw.trim() : "") ||
          `Сервер ответил ${res.status} ${res.statusText || ""}`.trim();
        setBanner(msg || "Неизвестная ошибка");
        return;
      }
      if (!data.token) {
        setBanner("Неверный ответ сервера (нет token)");
        return;
      }
      localStorage.setItem(LS_TOKEN, data.token);
      localStorage.setItem(LS_NICKNAME, data.user?.nickname || name);
      setNickname(data.user?.nickname || name);
      setToken(data.token);
      setPasswordInput("");
      setBanner(null);
    } catch (err) {
      console.error(err);
      setBanner("Сеть: не удалось связаться с сервером");
    }
  };

  const handleLogout = () => {
    const s = socketRef.current;
    if (s) {
      s.emit("leave");
      s.disconnect();
    }
    localStorage.removeItem(LS_TOKEN);
    localStorage.removeItem(LS_NICKNAME);
    setToken("");
    setNickname("");
    setNameInput("");
    setPasswordInput("");
    setMessages([]);
    setOnline([]);
    setStatus("offline");
    setRoomJoined(false);
    roomJoinedRef.current = false;
  };

  const sendMessage = async (e) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;

    const socket = socketRef.current;
    if (socket && socket.connected) {
      if (!roomJoinedRef.current) {
        setBanner("Подождите секунду — выполняется вход в комнату…");
        return;
      }
      socket.emit("message", { text }, (ack) => {
        if (ack && !ack.ok && ack.error) setBanner(ack.error);
      });
      setInput("");
      return;
    }

    try {
      const base = getApiBase();
      const res = await fetch(`${base}/api/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ room: "family", text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setBanner(data.error || "Ошибка отправки");
        return;
      }
      setInput("");
      if (data.message) {
        setMessages((prev) => [...prev, data.message]);
      }
    } catch (err) {
      console.error(err);
      setBanner("Не удалось отправить сообщение");
    }
  };

  if (!token) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center p-4">
        <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-xl backdrop-blur">
          <h1 className="mb-1 text-center text-2xl font-semibold text-white">TatarChat</h1>
          <p className="mb-4 text-center text-sm text-slate-400">
            Вход по имени и паролю. Новый пользователь — сначала регистрация.
          </p>

          <div className="mb-4 flex rounded-lg border border-slate-700 p-0.5">
            <button
              type="button"
              onClick={() => {
                setAuthMode("login");
                setBanner(null);
              }}
              className={`flex-1 rounded-md py-2 text-sm font-medium transition ${
                authMode === "login" ? "bg-emerald-600 text-white" : "text-slate-400"
              }`}
            >
              Вход
            </button>
            <button
              type="button"
              onClick={() => {
                setAuthMode("register");
                setBanner(null);
              }}
              className={`flex-1 rounded-md py-2 text-sm font-medium transition ${
                authMode === "register" ? "bg-emerald-600 text-white" : "text-slate-400"
              }`}
            >
              Регистрация
            </button>
          </div>

          <form onSubmit={submitAuth} className="space-y-4">
            <label className="block text-sm text-slate-300">
              Имя
              <input
                type="text"
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white outline-none ring-emerald-500/40 focus:ring-2"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                placeholder="Ваше имя в чате"
                maxLength={64}
                autoComplete="username"
                autoFocus
              />
            </label>
            <label className="block text-sm text-slate-300">
              Пароль
              <input
                type="password"
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white outline-none ring-emerald-500/40 focus:ring-2"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                placeholder={authMode === "register" ? "Не короче 6 символов" : "••••••"}
                maxLength={128}
                autoComplete={authMode === "register" ? "new-password" : "current-password"}
              />
            </label>
            {banner && (
              <p className="rounded-lg bg-amber-500/15 px-3 py-2 text-sm text-amber-200">{banner}</p>
            )}
            <button
              type="submit"
              className="w-full rounded-lg bg-emerald-600 py-2.5 font-medium text-white transition hover:bg-emerald-500"
            >
              {authMode === "register" ? "Зарегистрироваться" : "Войти"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex flex-shrink-0 flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/90 px-4 py-3 backdrop-blur">
        <div>
          <h1 className="text-lg font-semibold text-white">TatarChat</h1>
          <p className="text-xs text-slate-400">
            Вы: <span className="text-emerald-400">{nickname}</span>
            {" · "}
            <span className={status === "online" ? "text-emerald-400" : "text-amber-400"}>
              {status === "online" ? "в сети" : "нет связи"}
            </span>
          </p>
        </div>
        <button
          type="button"
          onClick={handleLogout}
          className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
        >
          Выйти
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 md:flex-row md:p-4">
        <aside className="order-2 w-full flex-shrink-0 rounded-xl border border-slate-800 bg-slate-900/60 p-3 md:order-1 md:w-56">
          <h2 className="mb-2 text-sm font-medium text-slate-300">Онлайн ({online.length})</h2>
          <ul className="max-h-32 space-y-1 overflow-y-auto text-sm md:max-h-none">
            {online.length === 0 ? (
              <li className="text-slate-500">Пока никого…</li>
            ) : (
              online.map((u) => (
                <li key={u.id} className="truncate text-slate-200">
                  <span className="mr-1 inline-block h-2 w-2 rounded-full bg-emerald-500 align-middle" />
                  {u.nickname}
                </li>
              ))
            )}
          </ul>
        </aside>

        <section className="order-1 flex min-h-0 flex-1 flex-col rounded-xl border border-slate-800 bg-slate-900/40 md:order-2">
          {banner && (
            <div className="border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">{banner}</div>
          )}
          <div
            ref={listRef}
            className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 md:p-4"
            style={{ maxHeight: "min(60vh, 520px)" }}
          >
            {messages.length === 0 ? (
              <p className="text-center text-sm text-slate-500">Пока нет сообщений — напишите первым.</p>
            ) : (
              messages.map((m, i) => (
                <div
                  key={`${m.time}-${i}-${m.user_nick}`}
                  className="rounded-lg border border-slate-800/80 bg-slate-950/50 px-3 py-2"
                >
                  <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium text-emerald-400">{m.user_nick}</span>
                    <span className="text-xs text-slate-500">{formatTime(m.time)}</span>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-slate-100">{m.text}</p>
                </div>
              ))
            )}
          </div>

          <form onSubmit={sendMessage} className="flex flex-shrink-0 gap-2 border-t border-slate-800 p-3">
            <input
              className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white outline-none ring-emerald-500/30 focus:ring-2"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Сообщение…"
              maxLength={2000}
              autoComplete="off"
            />
            <button
              type="submit"
              disabled={status === "online" && !roomJoined}
              className="rounded-lg bg-emerald-600 px-4 py-2 font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {status === "online" && !roomJoined ? "Вход…" : "Отправить"}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
