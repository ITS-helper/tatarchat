import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const LS_TOKEN = "tatarchat_token";
const LS_NICKNAME = "tatarchat_nickname";
const LS_LAST_ROOM = "tatarchat_last_room";
/** sessionStorage: пароль комнаты Family (не путать с паролем аккаунта) */
const SS_FAMILY_ROOM_PW = "tatarchat_room_pw_family";

const PRODUCTION_API_ORIGIN = "https://tatarchat-server.onrender.com";

const DEFAULT_ROOMS = [
  { slug: "dreamteamdauns", title: "DreamTeamDauns", requiresPassword: false },
  { slug: "family", title: "Family", requiresPassword: true },
];

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

function getInitialRoom() {
  const s = localStorage.getItem(LS_LAST_ROOM);
  if (s === "dreamteamdauns" || s === "family") return s;
  return "dreamteamdauns";
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
  const [rooms] = useState(DEFAULT_ROOMS);
  const [activeRoom, setActiveRoom] = useState(getInitialRoom);
  const [roomTitle, setRoomTitle] = useState("DreamTeamDauns");
  const [showFamilyModal, setShowFamilyModal] = useState(false);
  const [familyRoomPwDraft, setFamilyRoomPwDraft] = useState("");
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("offline");
  const [roomJoined, setRoomJoined] = useState(false);
  const [banner, setBanner] = useState(null);
  const listRef = useRef(null);
  const socketRef = useRef(null);
  const roomJoinedRef = useRef(false);
  const joinGenRef = useRef(0);
  const activeRoomRef = useRef(activeRoom);

  useEffect(() => {
    activeRoomRef.current = activeRoom;
  }, [activeRoom]);

  const scrollToBottom = useCallback(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const loadHistoryForRoom = useCallback(
    async (room) => {
      if (!token) return;
      try {
        const base = getApiBase();
        const headers = { Authorization: `Bearer ${token}` };
        if (room === "family") {
          const pw = sessionStorage.getItem(SS_FAMILY_ROOM_PW);
          if (pw) headers["X-Room-Password"] = pw;
        }
        const res = await fetch(`${base}/api/messages/${room}`, { headers });
        const raw = await res.text();
        let data = {};
        try {
          data = raw ? JSON.parse(raw) : {};
        } catch {
          data = {};
        }
        if (!res.ok) {
          setBanner(data.error || `Не удалось загрузить чат (${res.status})`);
          setMessages([]);
          return;
        }
        setMessages(data.messages || []);
        if (data.title) setRoomTitle(data.title);
        setBanner(null);
      } catch (e) {
        console.error(e);
        setBanner("Не удалось загрузить историю.");
      }
    },
    [token]
  );

  useEffect(() => {
    if (!token) return;
    localStorage.setItem(LS_LAST_ROOM, activeRoom);
    loadHistoryForRoom(activeRoom);
  }, [token, activeRoom, loadHistoryForRoom]);

  const emitJoinRoom = useCallback((socket) => {
    const gen = ++joinGenRef.current;
    const r = activeRoomRef.current;
    const pw = r === "family" ? sessionStorage.getItem(SS_FAMILY_ROOM_PW) || "" : undefined;
    setRoomJoined(false);
    roomJoinedRef.current = false;
    socket.emit("join-room", { room: r, roomPassword: pw || undefined }, (ack) => {
      if (gen !== joinGenRef.current) return;
      if (ack?.ok) {
        setRoomJoined(true);
        roomJoinedRef.current = true;
        return;
      }
      if (ack && !ack.ok) {
        setBanner(ack.error || "Не удалось войти в комнату");
        setRoomJoined(false);
        roomJoinedRef.current = false;
      }
    });
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
      setBanner(null);
      emitJoinRoom(socket);
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

    socket.on("history", (payload) => {
      let rows;
      let room;
      if (payload && typeof payload === "object" && !Array.isArray(payload) && Array.isArray(payload.messages)) {
        rows = payload.messages;
        room = payload.room;
      } else if (Array.isArray(payload)) {
        rows = payload;
        room = rows[0]?.room;
      } else {
        return;
      }
      if (room && room !== activeRoomRef.current) return;
      setMessages(rows);
      setRoomJoined(true);
      roomJoinedRef.current = true;
    });

    socket.on("room-changed", ({ room }) => {
      const meta = rooms.find((x) => x.slug === room);
      if (meta) setRoomTitle(meta.title);
    });

    socket.on("message", (msg) => {
      if (msg.room && msg.room !== activeRoomRef.current) return;
      setMessages((prev) => [...prev, msg]);
    });

    socket.on("error-toast", (payload) => {
      if (payload?.error) setBanner(payload.error);
    });

    return () => {
      socket.emit("leave");
      socket.disconnect();
      socketRef.current = null;
    };
  }, [token, emitJoinRoom, rooms]);

  useEffect(() => {
    const s = socketRef.current;
    if (!token || !s?.connected) return;
    emitJoinRoom(s);
  }, [activeRoom, token, emitJoinRoom]);

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
    localStorage.removeItem(LS_LAST_ROOM);
    sessionStorage.removeItem(SS_FAMILY_ROOM_PW);
    setToken("");
    setNickname("");
    setNameInput("");
    setPasswordInput("");
    setMessages([]);
    setActiveRoom("dreamteamdauns");
    setStatus("offline");
    setRoomJoined(false);
    roomJoinedRef.current = false;
  };

  const selectRoom = (slug) => {
    setBanner(null);
    if (slug === "family") {
      if (!sessionStorage.getItem(SS_FAMILY_ROOM_PW)) {
        setFamilyRoomPwDraft("");
        setShowFamilyModal(true);
        return;
      }
    }
    setActiveRoom(slug);
  };

  const confirmFamilyPassword = (e) => {
    e.preventDefault();
    const p = familyRoomPwDraft.trim();
    if (!p) {
      setBanner("Введите пароль комнаты");
      return;
    }
    sessionStorage.setItem(SS_FAMILY_ROOM_PW, p);
    setShowFamilyModal(false);
    setActiveRoom("family");
    setBanner(null);
  };

  const sendMessage = async (e) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;

    const socket = socketRef.current;
    if (socket && socket.connected) {
      if (!roomJoinedRef.current) {
        setBanner("Подождите — подключение к комнате…");
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
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };
      if (activeRoom === "family") {
        const pw = sessionStorage.getItem(SS_FAMILY_ROOM_PW);
        if (pw) headers["X-Room-Password"] = pw;
      }
      const res = await fetch(`${base}/api/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ room: activeRoom, text }),
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
      <div className="relative min-h-full">
        <div className="cyber-vignette" aria-hidden />
        <div className="cyber-scanlines" aria-hidden />
        <div className="relative z-10 flex min-h-full flex-col items-center justify-center p-4">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-neon-purple/10 via-transparent to-neon-hot/5" />
        <div className="cyber-panel relative w-full max-w-md p-6 shadow-neon-cyan">
          <p className="mb-2 text-center font-mono text-[10px] uppercase tracking-[0.35em] text-neon-cyan/60">
            // secure uplink
          </p>
          <h1 className="font-display mb-1 text-center text-2xl font-bold tracking-wide text-neon-bright text-glow-cyan">
            TatarChat
          </h1>
          <p className="mb-4 text-center text-sm text-cyan-600/90">
            Вход по имени и паролю. Новый пользователь — сначала регистрация.
          </p>

          <div className="mb-4 flex border border-neon-cyan/35 bg-black/60 p-px">
            <button
              type="button"
              onClick={() => {
                setAuthMode("login");
                setBanner(null);
              }}
              className={`flex-1 py-2.5 text-sm font-medium transition ${
                authMode === "login"
                  ? "bg-neon-cyan/25 text-neon-bright shadow-neon-cyan"
                  : "text-cyan-800 hover:text-neon-cyan"
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
              className={`flex-1 py-2.5 text-sm font-medium transition ${
                authMode === "register"
                  ? "bg-neon-hot/20 text-neon-magenta text-glow-magenta shadow-neon-magenta"
                  : "text-cyan-800 hover:text-neon-magenta"
              }`}
            >
              Регистрация
            </button>
          </div>

          <form onSubmit={submitAuth} className="space-y-4">
            <label className="block text-sm text-cyan-400/90">
              Имя
              <input
                type="text"
                className="cyber-input mt-1 w-full"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                placeholder="Ваше имя в чате"
                maxLength={64}
                autoComplete="username"
                autoFocus
              />
            </label>
            <label className="block text-sm text-cyan-400/90">
              Пароль
              <input
                type="password"
                className="cyber-input mt-1 w-full"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                placeholder={authMode === "register" ? "Не короче 6 символов" : "••••••"}
                maxLength={128}
                autoComplete={authMode === "register" ? "new-password" : "current-password"}
              />
            </label>
            {banner && (
              <p className="border border-neon-amber/40 bg-neon-amber/10 px-3 py-2 font-mono text-sm text-neon-amber">
                {banner}
              </p>
            )}
            <button
              type="submit"
              className="font-display w-full bg-gradient-to-r from-cyan-600 via-neon-purple to-neon-hot py-2.5 font-semibold tracking-[0.2em] text-black shadow-neon-cyan transition hover:brightness-110"
            >
              {authMode === "register" ? "Зарегистрироваться" : "Войти"}
            </button>
          </form>
        </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-full">
      <div className="cyber-vignette" aria-hidden />
      <div className="cyber-scanlines" aria-hidden />
      <div className="relative z-10 flex min-h-full flex-col">
      {showFamilyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4 backdrop-blur-sm">
          <div className="cyber-panel w-full max-w-sm p-5 shadow-neon-magenta">
            <p className="mb-1 font-mono text-[10px] uppercase tracking-widest text-neon-magenta/80">encrypted channel</p>
            <h3 className="font-display mb-2 text-lg font-semibold text-neon-magenta text-glow-magenta">Family</h3>
            <p className="mb-4 text-sm text-cyan-600">Введите пароль комнаты.</p>
            <form onSubmit={confirmFamilyPassword} className="space-y-3">
              <input
                type="password"
                className="cyber-input w-full"
                value={familyRoomPwDraft}
                onChange={(e) => setFamilyRoomPwDraft(e.target.value)}
                placeholder="Пароль"
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowFamilyModal(false)}
                  className="flex-1 border border-neon-cyan/40 py-2 text-sm text-neon-cyan transition hover:bg-neon-cyan/15 hover:shadow-neon-cyan"
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  className="flex-1 bg-gradient-to-r from-neon-hot to-neon-purple py-2 font-display text-sm font-semibold tracking-wider text-black shadow-neon-magenta transition hover:brightness-110"
                >
                  Войти в чат
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <header className="flex flex-shrink-0 flex-wrap items-center justify-between gap-3 border-b-2 border-neon-cyan/35 bg-black/85 px-4 py-3 shadow-neon-cyan backdrop-blur-md">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-3">
            <h1 className="font-display text-lg font-bold tracking-[0.35em] text-neon-bright text-glow-cyan md:text-xl">
              TATARCHAT
            </h1>
            <span className="hidden font-mono text-[9px] uppercase tracking-widest text-cyan-900 sm:inline">v1</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="hud-chip max-w-[160px] truncate border-neon-cyan/55 text-neon-cyan" title={`Вы: ${nickname}`}>
              {nickname}
            </span>
            <span className="hud-chip border-neon-purple/50 text-neon-purple">{roomTitle}</span>
            <span
              className={`hud-chip ${
                status === "online"
                  ? "border-neon-bright/80 text-neon-bright text-glow-cyan"
                  : "border-neon-amber/70 text-neon-amber"
              }`}
            >
              {status === "online" ? "LINK_OK" : "NO_LINK"}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={handleLogout}
          className="hud-chip border-neon-hot/60 text-neon-hot transition hover:bg-neon-hot/15 hover:shadow-neon-magenta"
        >
          Выйти
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 md:flex-row md:p-4">
        <aside className="cyber-panel order-2 w-full flex-shrink-0 p-3 md:order-1 md:w-60">
          <h2 className="mb-3 font-mono text-[10px] font-bold uppercase tracking-[0.35em] text-neon-cyan/50">Каналы</h2>
          <ul className="space-y-1.5 text-sm">
            {rooms.map((r) => (
              <li key={r.slug}>
                <button
                  type="button"
                  onClick={() => selectRoom(r.slug)}
                  className={`flex w-full items-center justify-between border px-2.5 py-2 text-left font-mono transition ${
                    activeRoom === r.slug
                      ? "border-neon-cyan bg-neon-cyan/10 text-neon-bright shadow-neon-cyan"
                      : "border-transparent bg-black/40 text-cyan-600 hover:border-neon-cyan/30 hover:text-neon-cyan"
                  }`}
                >
                  <span className="truncate">{r.title}</span>
                  {r.requiresPassword && (
                    <span
                      className="hud-chip ml-1 shrink-0 border-neon-hot/70 bg-black/60 text-[8px] text-neon-hot"
                      title="Защищённый канал"
                    >
                      SEC
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="cyber-panel order-1 flex min-h-0 flex-1 flex-col md:order-2">
          {banner && (
            <div className="border-b-2 border-neon-amber/35 bg-neon-amber/10 px-3 py-2 font-mono text-xs text-neon-amber">
              {banner}
            </div>
          )}
          <div
            ref={listRef}
            className="messages-scroll min-h-0 flex-1 space-y-3 overflow-y-auto p-3 md:p-4"
            style={{ maxHeight: "min(60vh, 520px)" }}
          >
            {messages.length === 0 ? (
              <p className="text-center font-mono text-sm uppercase tracking-widest text-cyan-900">
                Нет данных в буфере — передача открыта
              </p>
            ) : (
              messages.map((m, i) => (
                <div
                  key={`${m.time}-${i}-${m.user_nick}`}
                  className="border border-neon-cyan/25 border-l-2 border-l-neon-hot bg-black/55 px-3 py-2 shadow-[inset_0_0_28px_rgba(0,229,255,0.04)]"
                >
                  <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium text-neon-cyan">{m.user_nick}</span>
                    <span className="font-mono text-[9px] uppercase tracking-widest text-cyan-900">{formatTime(m.time)}</span>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-cyan-50/95">{m.text}</p>
                </div>
              ))
            )}
          </div>

          <form
            onSubmit={sendMessage}
            className="flex flex-shrink-0 gap-2 border-t-2 border-neon-cyan/20 bg-black/50 p-3"
          >
            <input
              className="cyber-input min-w-0 flex-1"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Сообщение…"
              maxLength={2000}
              autoComplete="off"
            />
            <button
              type="submit"
              disabled={status === "online" && !roomJoined}
              className="font-display border border-neon-cyan/50 bg-gradient-to-br from-neon-cyan to-neon-purple px-4 py-2 text-sm font-bold tracking-wider text-black shadow-neon-cyan transition hover:brightness-110 disabled:cursor-not-allowed disabled:border-cyan-900 disabled:bg-cyan-950 disabled:text-cyan-800 disabled:shadow-none"
            >
              {status === "online" && !roomJoined ? "SYNC…" : "TX"}
            </button>
          </form>
        </section>
      </div>
      </div>
    </div>
  );
}
