import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const LS_TOKEN = "tatarchat_token";
const LS_NICKNAME = "tatarchat_nickname";
const LS_USER_ID = "tatarchat_user_id";
const LS_LAST_ROOM = "tatarchat_last_room";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🔥", "👎"];
/** sessionStorage: выбранный раздел и пароли комнат (не путать с паролем аккаунта) */
const SS_SITE_ROOM = "tatarchat_site_room";
const SS_DTD_ROOM_PW = "tatarchat_room_pw_dreamteamdauns";

const GATE_PASSWORD_DTD = "1488";

const PRODUCTION_API_ORIGIN = "https://tatarchat-server.onrender.com";

const DEFAULT_ROOMS = [{ slug: "dreamteamdauns", title: "DTD", requiresPassword: true }];

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
  if (s === "dreamteamdauns") return s;
  return "dreamteamdauns";
}

function readSiteRoomFromSession() {
  const slug = sessionStorage.getItem(SS_SITE_ROOM);
  if (slug !== "dreamteamdauns") return null;
  const pw = sessionStorage.getItem(SS_DTD_ROOM_PW);
  return pw ? "dreamteamdauns" : null;
}

function clearGateSession() {
  sessionStorage.removeItem(SS_SITE_ROOM);
  sessionStorage.removeItem(SS_DTD_ROOM_PW);
}

function readUserId() {
  const s = localStorage.getItem(LS_USER_ID);
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function userIdFromToken(jwt) {
  try {
    const parts = String(jwt).split(".");
    if (parts.length < 2) return null;
    const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(json);
    const id = payload.userId;
    const n = typeof id === "number" ? id : parseInt(id, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function upsertMessageList(prev, msg) {
  if (msg == null || msg.id == null) return [...prev, msg];
  const i = prev.findIndex((x) => x && x.id === msg.id);
  if (i === -1) return [...prev, msg];
  const next = [...prev];
  next[i] = { ...next[i], ...msg };
  return next;
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

function formatFileSize(n) {
  if (n == null || Number.isNaN(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function messagePreviewForReply(m) {
  if (!m || m.deleted) return "";
  const t = (m.text || "").trim();
  if (t) return t.slice(0, 120);
  if (m.attachment?.name) return `📎 ${m.attachment.name}`;
  return "📎 файл";
}

function MessageAttachment({ messageId, attachment, getAuthHeaders }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!messageId || !attachment) return undefined;
    let revoke = null;
    let cancelled = false;
    (async () => {
      try {
        const base = getApiBase();
        const res = await fetch(`${base}/api/files/${messageId}`, { headers: getAuthHeaders() });
        if (!res.ok || cancelled) return;
        const blob = await res.blob();
        if (cancelled) return;
        const u = URL.createObjectURL(blob);
        revoke = u;
        setUrl(u);
      } catch (e) {
        console.error(e);
      }
    })();
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [messageId, attachment, getAuthHeaders]);

  if (!attachment) return null;
  if (attachment.kind === "image" && url) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="mt-2 block max-h-56 overflow-hidden rounded border border-neon-cyan/30">
        <img src={url} alt={attachment.name} className="max-h-56 w-auto max-w-full object-contain" />
      </a>
    );
  }
  if (attachment.kind === "image" && !url) {
    return <p className="mt-2 font-mono text-xs text-cyan-700">Загрузка изображения…</p>;
  }
  if (!url) {
    return <p className="mt-2 font-mono text-xs text-cyan-700">Загрузка файла…</p>;
  }
  return (
    <a
      href={url}
      download={attachment.name}
      className="mt-2 inline-flex items-center gap-2 border border-neon-purple/40 bg-black/40 px-2 py-1 font-mono text-xs text-neon-purple hover:border-neon-cyan/50 hover:text-neon-cyan"
    >
      📎 {attachment.name}
      {attachment.size != null ? <span className="text-cyan-700">({formatFileSize(attachment.size)})</span> : null}
    </a>
  );
}

export default function App() {
  const [token, setToken] = useState(() => getStoredToken());
  const [nickname, setNickname] = useState(() => localStorage.getItem(LS_NICKNAME) || "");
  const [authMode, setAuthMode] = useState("login");
  const [nameInput, setNameInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [siteRoom, setSiteRoom] = useState(() => readSiteRoomFromSession());
  const [gatePasswordDraft, setGatePasswordDraft] = useState("");
  const rooms = useMemo(
    () => (siteRoom ? DEFAULT_ROOMS.filter((r) => r.slug === siteRoom) : []),
    [siteRoom]
  );
  const [activeRoom, setActiveRoom] = useState(
    () => readSiteRoomFromSession() || getInitialRoom()
  );
  const [roomTitle, setRoomTitle] = useState(() => {
    const slug = readSiteRoomFromSession() || getInitialRoom();
    const m = DEFAULT_ROOMS.find((r) => r.slug === slug);
    return m?.title || "DTD";
  });
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [myUserId, setMyUserId] = useState(() => readUserId());
  const [replyTo, setReplyTo] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [typingPeers, setTypingPeers] = useState([]);
  const [pendingFile, setPendingFile] = useState(null);
  const [searchInput, setSearchInput] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [status, setStatus] = useState("offline");
  const [roomJoined, setRoomJoined] = useState(false);
  const [banner, setBanner] = useState(null);
  const listRef = useRef(null);
  const socketRef = useRef(null);
  const roomJoinedRef = useRef(false);
  const joinGenRef = useRef(0);
  const activeRoomRef = useRef(activeRoom);
  const typingIdleRef = useRef(null);
  const fileInputRef = useRef(null);
  const nicknameRef = useRef(nickname);

  useEffect(() => {
    nicknameRef.current = nickname;
  }, [nickname]);

  useEffect(() => {
    if (!token.trim()) {
      setMyUserId(null);
      return;
    }
    const stored = readUserId();
    if (stored != null) {
      setMyUserId(stored);
      return;
    }
    const fromJwt = userIdFromToken(token);
    if (fromJwt != null) {
      localStorage.setItem(LS_USER_ID, String(fromJwt));
      setMyUserId(fromJwt);
    }
  }, [token]);

  useEffect(() => {
    activeRoomRef.current = activeRoom;
  }, [activeRoom]);

  useEffect(() => {
    setReplyTo(null);
    setEditingId(null);
    setTypingPeers([]);
    setPendingFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setSearchInput("");
    setSearchResults([]);
  }, [activeRoom]);

  const buildRoomHeaders = useCallback(() => {
    const headers = {};
    if (activeRoomRef.current === "dreamteamdauns") {
      const pw = sessionStorage.getItem(SS_DTD_ROOM_PW);
      if (pw) headers["X-Room-Password"] = pw;
    }
    return headers;
  }, []);

  const getAuthHeaders = useCallback(
    () => ({
      Authorization: `Bearer ${token}`,
      ...buildRoomHeaders(),
    }),
    [token, buildRoomHeaders]
  );

  useEffect(() => {
    if (!token.trim()) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    const q = searchInput.trim();
    if (q.length < 1) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    const t = setTimeout(async () => {
      try {
        const base = getApiBase();
        const params = new URLSearchParams({ q });
        const room = activeRoomRef.current;
        const headers = { Authorization: `Bearer ${token}`, ...buildRoomHeaders() };
        const res = await fetch(`${base}/api/messages/${room}/search?${params}`, { headers });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setSearchResults([]);
          return;
        }
        setSearchResults(data.results || []);
      } catch {
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 380);
    return () => clearTimeout(t);
  }, [searchInput, token, buildRoomHeaders]);

  const stopTyping = useCallback(() => {
    if (typingIdleRef.current) {
      clearTimeout(typingIdleRef.current);
      typingIdleRef.current = null;
    }
    const s = socketRef.current;
    if (s?.connected) s.emit("typing", { typing: false });
  }, []);

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
        if (room === "dreamteamdauns") {
          const pw = sessionStorage.getItem(SS_DTD_ROOM_PW);
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
    const pw = r === "dreamteamdauns" ? sessionStorage.getItem(SS_DTD_ROOM_PW) || "" : "";
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
      setMessages((prev) => upsertMessageList(prev, msg));
    });

    socket.on("message-edited", (msg) => {
      if (msg.room && msg.room !== activeRoomRef.current) return;
      setMessages((prev) => upsertMessageList(prev, msg));
    });

    socket.on("message-deleted", (payload) => {
      const msg = payload?.message;
      if (!msg || (msg.room && msg.room !== activeRoomRef.current)) return;
      setMessages((prev) => upsertMessageList(prev, msg));
    });

    socket.on("message-reactions", (payload) => {
      if (payload?.room && payload.room !== activeRoomRef.current) return;
      const { id, reactions } = payload;
      if (id == null) return;
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, reactions: reactions || [] } : m))
      );
    });

    socket.on("typing", (payload) => {
      if (payload?.room && payload.room !== activeRoomRef.current) return;
      if (payload?.nickname === nicknameRef.current) return;
      setTypingPeers((prev) => {
        const s = new Set(prev);
        if (payload?.typing) s.add(payload.nickname);
        else s.delete(payload.nickname);
        return [...s];
      });
    });

    socket.on("error-toast", (payload) => {
      if (payload?.error) setBanner(payload.error);
    });

    return () => {
      if (typingIdleRef.current) clearTimeout(typingIdleRef.current);
      typingIdleRef.current = null;
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

  useEffect(() => {
    if (siteRoom && activeRoom !== siteRoom) setActiveRoom(siteRoom);
  }, [siteRoom, activeRoom]);

  const submitGate = (e) => {
    e.preventDefault();
    setBanner(null);
    const slug = "dreamteamdauns";
    const p = gatePasswordDraft.trim();
    if (!p) {
      setBanner("Введите пароль чата");
      return;
    }
    if (p !== GATE_PASSWORD_DTD) {
      setBanner("Неверный пароль");
      return;
    }
    sessionStorage.setItem(SS_SITE_ROOM, slug);
    sessionStorage.setItem(SS_DTD_ROOM_PW, p);
    setSiteRoom(slug);
    setActiveRoom(slug);
    const meta = DEFAULT_ROOMS.find((r) => r.slug === slug);
    if (meta) setRoomTitle(meta.title);
    localStorage.setItem(LS_LAST_ROOM, slug);
    setGatePasswordDraft("");
    setBanner(null);
  };

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
      if (data.user?.id != null) {
        localStorage.setItem(LS_USER_ID, String(data.user.id));
        setMyUserId(data.user.id);
      }
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
    localStorage.removeItem(LS_USER_ID);
    localStorage.removeItem(LS_LAST_ROOM);
    clearGateSession();
    setSiteRoom(null);
    setToken("");
    setNickname("");
    setNameInput("");
    setPasswordInput("");
    setMessages([]);
    setMyUserId(null);
    setReplyTo(null);
    setEditingId(null);
    setTypingPeers([]);
    setPendingFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setSearchInput("");
    setSearchResults([]);
    setActiveRoom("dreamteamdauns");
    setStatus("offline");
    setRoomJoined(false);
    roomJoinedRef.current = false;
  };

  const selectRoom = (slug) => {
    setBanner(null);
    if (slug === siteRoom) setActiveRoom(slug);
  };

  const flushReaction = useCallback(
    async (messageId, emoji) => {
      const base = getApiBase();
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...buildRoomHeaders(),
      };
      try {
        const res = await fetch(`${base}/api/messages/${messageId}/reaction`, {
          method: "POST",
          headers,
          body: JSON.stringify({ emoji }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setBanner(data.error || "Реакция не сохранена");
          return;
        }
        if (data.reactions) {
          setMessages((prev) =>
            prev.map((m) => (m.id === messageId ? { ...m, reactions: data.reactions } : m))
          );
        }
      } catch (err) {
        console.error(err);
        setBanner("Сеть: реакция");
      }
    },
    [token, buildRoomHeaders]
  );

  const toggleReaction = useCallback(
    (messageId, emoji) => {
      const s = socketRef.current;
      if (s?.connected && roomJoinedRef.current) {
        s.emit("toggle-reaction", { messageId, emoji }, (ack) => {
          if (ack && !ack.ok && ack.error) setBanner(ack.error);
        });
        return;
      }
      flushReaction(messageId, emoji);
    },
    [flushReaction]
  );

  const deleteMessage = useCallback(
    async (id) => {
      if (!window.confirm("Удалить сообщение?")) return;
      const socket = socketRef.current;
      if (socket?.connected && roomJoinedRef.current) {
        socket.emit("delete-message", { id }, (ack) => {
          if (ack && !ack.ok && ack.error) setBanner(ack.error);
        });
        if (editingId === id) {
          setEditingId(null);
          setInput("");
        }
        return;
      }
      try {
        const base = getApiBase();
        const res = await fetch(`${base}/api/messages/${id}`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
            ...buildRoomHeaders(),
          },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setBanner(data.error || "Не удалось удалить");
          return;
        }
        if (data.message) setMessages((prev) => upsertMessageList(prev, data.message));
        if (editingId === id) {
          setEditingId(null);
          setInput("");
        }
      } catch (err) {
        console.error(err);
        setBanner("Сеть: удаление");
      }
    },
    [token, buildRoomHeaders, editingId]
  );

  const sendMessage = async (e) => {
    e.preventDefault();
    const text = input.trim();

    if (editingId != null) {
      if (!text) return;
      stopTyping();
      const socket = socketRef.current;
      if (socket?.connected && roomJoinedRef.current) {
        socket.emit("edit-message", { id: editingId, text }, (ack) => {
          if (ack && !ack.ok && ack.error) setBanner(ack.error);
        });
        setInput("");
        setEditingId(null);
        return;
      }
      try {
        const base = getApiBase();
        const res = await fetch(`${base}/api/messages/${editingId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            ...buildRoomHeaders(),
          },
          body: JSON.stringify({ text }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setBanner(data.error || "Не удалось изменить");
          return;
        }
        if (data.message) setMessages((prev) => upsertMessageList(prev, data.message));
        setInput("");
        setEditingId(null);
      } catch (err) {
        console.error(err);
        setBanner("Сеть: правка");
      }
      return;
    }

    if (!pendingFile && !text) return;
    stopTyping();

    if (pendingFile) {
      try {
        const base = getApiBase();
        const fd = new FormData();
        fd.append("room", activeRoom);
        fd.append("text", text);
        fd.append("file", pendingFile);
        if (replyTo?.id != null) fd.append("replyToId", String(replyTo.id));
        const res = await fetch(`${base}/api/messages/send-with-file`, {
          method: "POST",
          headers: getAuthHeaders(),
          body: fd,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setBanner(data.error || "Не удалось отправить файл");
          return;
        }
        if (data.message) setMessages((prev) => upsertMessageList(prev, data.message));
        setInput("");
        setPendingFile(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
        setReplyTo(null);
      } catch (err) {
        console.error(err);
        setBanner("Сеть: отправка файла");
      }
      return;
    }

    const socket = socketRef.current;
    if (socket && socket.connected) {
      if (!roomJoinedRef.current) {
        setBanner("Подождите — подключение к комнате…");
        return;
      }
      const payload = { text };
      if (replyTo?.id != null) payload.replyToId = replyTo.id;
      socket.emit("message", payload, (ack) => {
        if (ack && !ack.ok && ack.error) setBanner(ack.error);
      });
      setInput("");
      setReplyTo(null);
      return;
    }

    try {
      const base = getApiBase();
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...buildRoomHeaders(),
      };
      const body = { room: activeRoom, text };
      if (replyTo?.id != null) body.replyToId = replyTo.id;
      const res = await fetch(`${base}/api/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setBanner(data.error || "Ошибка отправки");
        return;
      }
      setInput("");
      setReplyTo(null);
      if (data.message) setMessages((prev) => upsertMessageList(prev, data.message));
    } catch (err) {
      console.error(err);
      setBanner("Не удалось отправить сообщение");
    }
  };

  const onInputChange = (e) => {
    setInput(e.target.value);
    const s = socketRef.current;
    if (s?.connected && roomJoinedRef.current) {
      s.emit("typing", { typing: true });
      if (typingIdleRef.current) clearTimeout(typingIdleRef.current);
      typingIdleRef.current = setTimeout(() => {
        typingIdleRef.current = null;
        s.emit("typing", { typing: false });
      }, 2200);
    }
  };

  if (!siteRoom) {
    return (
      <div className="relative min-h-full">
        <div className="cyber-vignette" aria-hidden />
        <div className="cyber-scanlines" aria-hidden />
        <div className="relative z-10 flex min-h-full flex-col items-center justify-center p-4">
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-neon-purple/10 via-transparent to-neon-hot/5" />
          <div className="cyber-panel relative w-full max-w-md p-6 shadow-neon-cyan">
            <p className="mb-2 text-center font-mono text-[10px] uppercase tracking-[0.35em] text-neon-cyan/60">
              // uplink
            </p>
            <h1 className="font-display mb-1 text-center text-2xl font-bold tracking-wide text-neon-bright text-glow-cyan">
              TatarChat
            </h1>
            <p className="mb-4 text-center text-sm text-cyan-600/90">
              Введите пароль чата <span className="font-semibold text-neon-cyan">DTD</span>. Дальше — вход в аккаунт.
              {getStoredToken().trim() ? (
                <span className="mt-2 block text-cyan-500/90">Аккаунт уже сохранён — после пароля откроется чат.</span>
              ) : null}
            </p>

            <form onSubmit={submitGate} className="space-y-4">
              <label className="block text-sm text-cyan-400/90">
                Пароль чата
                <input
                  type="password"
                  className="cyber-input mt-1 w-full"
                  value={gatePasswordDraft}
                  onChange={(e) => setGatePasswordDraft(e.target.value)}
                  placeholder="DTD"
                  maxLength={64}
                  autoComplete="off"
                  autoFocus
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
                Продолжить
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

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
            Чат <span className="font-semibold text-neon-cyan">DTD</span>. Вход по имени и паролю. Новый пользователь — регистрация.
          </p>
          <button
            type="button"
            onClick={() => {
              clearGateSession();
              setSiteRoom(null);
              setGatePasswordDraft("");
              setBanner(null);
            }}
            className="mb-4 w-full border border-cyan-800/60 py-2 text-xs font-mono uppercase tracking-widest text-cyan-700 transition hover:border-neon-cyan/50 hover:text-neon-cyan"
          >
            Сменить пароль чата
          </button>

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
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              type="search"
              className="cyber-input max-w-[min(100%,280px)] flex-1 py-1.5 text-xs"
              placeholder="Поиск в чате…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              aria-label="Поиск в чате"
            />
            {searchLoading ? (
              <span className="font-mono text-[10px] text-cyan-700">…</span>
            ) : null}
          </div>
          {searchInput.trim() && searchResults.length > 0 ? (
            <div className="mt-2 max-h-36 overflow-y-auto rounded border border-neon-cyan/25 bg-black/80 p-2 font-mono text-[11px]">
              {searchResults.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className="block w-full truncate py-1 text-left text-cyan-400 hover:text-neon-cyan"
                  onClick={() => {
                    const el = document.querySelector(`[data-message-id="${r.id}"]`);
                    el?.scrollIntoView({ behavior: "smooth", block: "center" });
                    setSearchInput("");
                  }}
                >
                  <span className="text-neon-purple">{r.user_nick}</span>
                  {" · "}
                  {r.deleted
                    ? "удалено"
                    : (r.text || "").trim().slice(0, 80) ||
                      (r.attachment ? `📎 ${r.attachment.name}` : "—")}
                </button>
              ))}
            </div>
          ) : null}
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
              messages.map((m, i) => {
                const key = m.id != null ? m.id : `leg-${i}-${m.time}-${m.user_nick}`;
                const mine = myUserId != null && m.user_id === myUserId;
                const deleted = !!m.deleted;
                return (
                  <div
                    key={key}
                    data-message-id={m.id != null ? m.id : undefined}
                    className="border border-neon-cyan/25 border-l-2 border-l-neon-hot bg-black/55 px-3 py-2 shadow-[inset_0_0_28px_rgba(0,229,255,0.04)]"
                  >
                    {m.reply_to && (
                      <div className="mb-2 border-l-2 border-neon-purple/60 pl-2 text-xs text-cyan-600">
                        <span className="font-medium text-neon-purple">{m.reply_to.user_nick}</span>
                        {m.reply_to.deleted ? (
                          <span className="italic"> — удалено</span>
                        ) : (
                          <span className="mt-0.5 block truncate text-cyan-500/90">
                            {m.reply_to.preview?.trim() || "📎 файл"}
                          </span>
                        )}
                      </div>
                    )}
                    <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-medium text-neon-cyan">{m.user_nick}</span>
                      <span className="font-mono text-[9px] uppercase tracking-widest text-cyan-900">
                        {formatTime(m.time)}
                        {m.edited_at ? " · изм." : ""}
                      </span>
                    </div>
                    {deleted ? (
                      <p className="italic text-cyan-800">Сообщение удалено</p>
                    ) : (
                      <>
                        {(m.text || "").trim() ? (
                          <p className="whitespace-pre-wrap break-words text-cyan-50/95">{m.text}</p>
                        ) : null}
                        {m.attachment && m.id != null ? (
                          <MessageAttachment
                            messageId={m.id}
                            attachment={m.attachment}
                            getAuthHeaders={getAuthHeaders}
                          />
                        ) : null}
                      </>
                    )}
                    <div className="mt-2 flex flex-wrap gap-1 border-t border-neon-cyan/10 pt-2">
                      {QUICK_REACTIONS.map((em) => {
                        const r = (m.reactions || []).find((x) => x.emoji === em);
                        const cnt = r?.count ?? 0;
                        const me = myUserId != null && r?.user_ids?.includes(myUserId);
                        return (
                          <button
                            key={em}
                            type="button"
                            disabled={deleted || m.id == null}
                            onClick={() => m.id != null && toggleReaction(m.id, em)}
                            className={`rounded border px-1.5 py-0.5 text-xs transition ${
                              me
                                ? "border-neon-cyan bg-neon-cyan/20 text-neon-bright"
                                : "border-cyan-900/60 bg-black/40 text-cyan-500 hover:border-neon-cyan/40"
                            }`}
                          >
                            {em}
                            {cnt > 0 ? <span className="ml-0.5 font-mono text-[10px]">{cnt}</span> : null}
                          </button>
                        );
                      })}
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-3 font-mono text-[10px] uppercase tracking-wide">
                      <button
                        type="button"
                        disabled={deleted}
                        className="text-cyan-600 hover:text-neon-cyan disabled:opacity-40"
                        onClick={() => {
                          if (deleted || m.id == null) return;
                          setReplyTo({
                            id: m.id,
                            user_nick: m.user_nick,
                            preview: messagePreviewForReply(m),
                          });
                          setEditingId(null);
                        }}
                      >
                        Ответить
                      </button>
                      {mine && !deleted && m.id != null && (
                        <>
                          <button
                            type="button"
                            className="text-cyan-600 hover:text-neon-cyan"
                            onClick={() => {
                              setEditingId(m.id);
                              setInput(m.text || "");
                              setReplyTo(null);
                              setPendingFile(null);
                              if (fileInputRef.current) fileInputRef.current.value = "";
                            }}
                          >
                            Изменить
                          </button>
                          <button
                            type="button"
                            className="text-neon-amber hover:text-neon-hot"
                            onClick={() => deleteMessage(m.id)}
                          >
                            Удалить
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {(replyTo || editingId != null) && (
            <div className="flex flex-shrink-0 items-center justify-between gap-2 border-t border-neon-cyan/20 bg-black/50 px-3 py-2 text-xs text-cyan-500">
              <span className="min-w-0 truncate">
                {editingId != null
                  ? `Правка сообщения #${editingId}`
                  : `Ответ ${replyTo?.user_nick}: ${replyTo?.preview || ""}`}
              </span>
              <button
                type="button"
                className="shrink-0 font-mono text-neon-hot hover:underline"
                onClick={() => {
                  setReplyTo(null);
                  setEditingId(null);
                  setInput("");
                }}
              >
                Отмена
              </button>
            </div>
          )}
          {typingPeers.length > 0 && (
            <div className="flex-shrink-0 border-t border-neon-purple/25 bg-neon-purple/5 px-3 py-1.5 font-mono text-[11px] text-neon-purple">
              {typingPeers.length === 1
                ? `${typingPeers[0]} печатает…`
                : `${typingPeers.slice(0, 4).join(", ")} печатают…`}
            </div>
          )}

          <form
            onSubmit={sendMessage}
            className="flex flex-shrink-0 flex-wrap items-center gap-2 border-t-2 border-neon-cyan/20 bg-black/50 p-3"
          >
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain,.pdf,.txt"
              onChange={(e) => {
                const f = e.target.files?.[0];
                setPendingFile(f || null);
              }}
            />
            <button
              type="button"
              disabled={editingId != null}
              title="Прикрепить файл"
              className="shrink-0 border border-neon-purple/45 bg-black/50 px-2.5 py-2 font-mono text-sm text-neon-purple transition hover:border-neon-cyan/50 hover:text-neon-cyan disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => fileInputRef.current?.click()}
            >
              📎
            </button>
            {pendingFile && editingId == null ? (
              <span className="flex max-w-[140px] items-center gap-1 truncate font-mono text-[10px] text-cyan-600">
                <span className="truncate" title={pendingFile.name}>
                  {pendingFile.name}
                </span>
                <button
                  type="button"
                  className="shrink-0 text-neon-hot hover:underline"
                  onClick={() => {
                    setPendingFile(null);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                >
                  ✕
                </button>
              </span>
            ) : null}
            <input
              className="cyber-input min-w-0 flex-1 basis-[min(100%,12rem)]"
              value={input}
              onChange={onInputChange}
              placeholder={editingId != null ? "Редактирование…" : "Сообщение…"}
              maxLength={2000}
              autoComplete="off"
            />
            <button
              type="submit"
              disabled={
                status === "online" && !roomJoined
                  ? true
                  : editingId != null
                    ? !input.trim()
                    : !input.trim() && !pendingFile
              }
              className="font-display shrink-0 border border-neon-cyan/50 bg-gradient-to-br from-neon-cyan to-neon-purple px-4 py-2 text-sm font-bold tracking-wider text-black shadow-neon-cyan transition hover:brightness-110 disabled:cursor-not-allowed disabled:border-cyan-900 disabled:bg-cyan-950 disabled:text-cyan-800 disabled:shadow-none"
            >
              {editingId != null
                ? "OK"
                : status === "online" && !roomJoined
                  ? "SYNC…"
                  : "TX"}
            </button>
          </form>
        </section>
      </div>
      </div>
    </div>
  );
}
