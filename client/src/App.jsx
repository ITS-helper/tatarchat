import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import GalleryView from "./GalleryView.jsx";
import CalendarView from "./CalendarView.jsx";

const LS_TOKEN = "tatarchat_token";
const LS_NICKNAME = "tatarchat_nickname";
const LS_USER_ID = "tatarchat_user_id";
const LS_LAST_ROOM = "tatarchat_last_room";
const LS_HAS_AVATAR = "tatarchat_has_avatar";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🔥", "👎"];
const REACTION_SVG = {
  "👍": "/reactions/thumbsup.svg",
  "❤️": "/reactions/heart.svg",
  "😂": "/reactions/laugh.svg",
  "🔥": "/reactions/fire.svg",
  "👎": "/reactions/thumbsdown.svg",
};
/** sessionStorage: выбранный раздел и пароли комнат (не путать с паролем аккаунта) */
/** Вкладка канала: чат/галерея/календарь */
const CHANNEL_VIEWS = { chat: "chat", gallery: "gallery", calendar: "calendar" };

/** Фон паттерна движется при скролле медленнее, чем сообщения (0…1) */
const CHAT_BG_PARALLAX = 0.22;

/** Видеосообщения: удерживать кнопку записи, как в Telegram (превью — квадрат) */
const VIDEO_NOTE_MAX_MS = 60_000;
const VIDEO_NOTE_MIN_MS = 450;
const VIDEO_NOTE_MIN_BYTES = 1800;

const VOICE_MAX_MS = 120_000;
const VOICE_MIN_MS = 400;
const VOICE_MIN_BYTES = 800;
const VOICE_MIMES_CLIENT = new Set(["audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4"]);

function stripMimeParams(m) {
  const s = String(m || "").trim().toLowerCase();
  const i = s.indexOf(";");
  return (i === -1 ? s : s.slice(0, i)).trim();
}

function pickRecorderMimeType() {
  const candidates = [
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4",
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

function pickAudioMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
    "audio/mp4",
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

async function acquireVideoNoteStream() {
  const strategies = [
    () =>
      navigator.mediaDevices.getUserMedia({
        video: {
          // Reasonable "best" quality: keep square preview sharp without exploding bitrate on phones
          width: { ideal: 960, max: 1280 },
          height: { ideal: 960, max: 1280 },
          frameRate: { ideal: 30, max: 30 },
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      }),
    () =>
      navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 } },
        audio: true,
      }),
    () =>
      navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: true,
      }),
    () => navigator.mediaDevices.getUserMedia({ video: true, audio: true }),
  ];
  let lastErr;
  for (const fn of strategies) {
    try {
      const stream = await fn();
      await new Promise((r) => setTimeout(r, 200));
      const vt = stream.getVideoTracks()[0];
      if (!vt || vt.readyState !== "live") {
        stream.getTracks().forEach((t) => t.stop());
        lastErr = new Error("Нет видеодорожки");
        continue;
      }
      return stream;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Камера недоступна");
}

function getApiBase() {
  const fromEnv = import.meta.env.VITE_API_URL;
  if (fromEnv) return String(fromEnv).replace(/\/$/, "");
  // В dev Vite проксирует /api → localhost:3001; в prod сервер отдаёт статику сам → относительный URL
  return "";
}

function getSocketUrl() {
  const fromEnv = import.meta.env.VITE_SOCKET_URL;
  if (fromEnv) return fromEnv;
  if (import.meta.env.DEV) return "http://127.0.0.1:3001";
  // В prod подключаемся к тому же origin что открыта страница
  return window.location.origin;
}

function getStoredToken() {
  return localStorage.getItem(LS_TOKEN) || "";
}

function canonicalizeStoredRoom(s) {
  if (!s || typeof s !== "string") return "lobby";
  const dm = s.trim().match(/^dm-(\d+)-(\d+)$/i);
  if (dm) {
    let a = parseInt(dm[1], 10);
    let b = parseInt(dm[2], 10);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1 || a === b) return "lobby";
    if (a > b) [a, b] = [b, a];
    return `dm-${a}-${b}`;
  }
  const sv = s.trim().match(/^saved-(\d+)$/i);
  if (sv) {
    const id = parseInt(sv[1], 10);
    if (!Number.isInteger(id) || id < 1) return "lobby";
    const me = readUserId();
    if (me != null && id !== me) return "lobby";
    return `saved-${id}`;
  }
  const alnum = s.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (alnum && alnum.length <= 64) return alnum;
  return "lobby";
}

function getInitialRoom() {
  return canonicalizeStoredRoom(localStorage.getItem(LS_LAST_ROOM));
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
  if (m.attachment?.kind === "video_note") return "Видеосообщение";
  if (m.attachment?.kind === "voice") return "Голосовое сообщение";
  if (m.attachment?.name) return `📎 ${m.attachment.name}`;
  return "📎 файл";
}

function MessageAttachment({ messageId, messageRoom, attachment, getAttachmentHeaders, onOpenImage }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!messageId || !attachment) return undefined;
    let revoke = null;
    let cancelled = false;
    setFailed(false);
    setUrl(null);
    (async () => {
      try {
        const base = getApiBase();
        const res = await fetch(`${base}/api/files/${messageId}`, {
          headers: getAttachmentHeaders(messageRoom),
        });
        if (cancelled) return;
        if (!res.ok) {
          setFailed(true);
          return;
        }
        const ct = (res.headers.get("content-type") || "").toLowerCase();
        if (ct.includes("application/json")) {
          setFailed(true);
          return;
        }
        const blob = await res.blob();
        if (cancelled) return;
        const u = URL.createObjectURL(blob);
        revoke = u;
        setUrl(u);
      } catch (e) {
        console.error(e);
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [messageId, messageRoom, attachment?.kind, getAttachmentHeaders]);

  if (!attachment) return null;
  if (failed) {
    return (
      <p
        className="mt-1 max-w-xs text-xs text-tc-danger"
        title="Нет файла на диске (часто после деплоя на Render без постоянного диска) или нет доступа к комнате"
      >
        Не удалось загрузить вложение
      </p>
    );
  }
  if (attachment.kind === "video_note" && url) {
    const vt = stripMimeParams(attachment.mime) || "video/webm";
    return (
      <div className="mt-1.5 w-52">
        <div className="aspect-square overflow-hidden rounded-xl bg-black">
          <video
            className="h-full w-full object-cover"
            controls
            playsInline
            preload="metadata"
            aria-label={attachment.name || "Видеосообщение"}
          >
            <source src={url} type={vt} />
          </video>
        </div>
      </div>
    );
  }
  if (attachment.kind === "video_note" && !url) {
    return <p className="mt-1 text-xs text-tc-text-muted">Загрузка видео…</p>;
  }
  if (attachment.kind === "image" && url) {
    return (
      <button
        type="button"
        onClick={() => onOpenImage?.({ url, name: attachment.name })}
        className="mt-1.5 block max-h-64 overflow-hidden rounded-lg transition hover:opacity-95"
        title="Открыть"
      >
        <img src={url} alt={attachment.name} className="max-h-64 w-auto max-w-full rounded-lg object-contain" />
      </button>
    );
  }
  if (attachment.kind === "image" && !url) {
    return <p className="mt-1 text-xs text-tc-text-muted">Загрузка изображения…</p>;
  }
  if (attachment.kind === "voice" && url) {
    return (
      <div className="mt-1.5 min-w-[200px]">
        <audio src={url} controls className="h-9 w-full max-w-xs" preload="metadata" aria-label="Голосовое сообщение" />
      </div>
    );
  }
  if (attachment.kind === "voice" && !url) {
    return <p className="mt-1 text-xs text-tc-text-muted">Загрузка аудио…</p>;
  }
  if (!url) {
    return <p className="mt-1 text-xs text-tc-text-muted">Загрузка файла…</p>;
  }
  return (
    <a
      href={url}
      download={attachment.name}
      className="mt-1.5 inline-flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2 text-xs text-tc-link transition hover:bg-white/10"
    >
      📎 {attachment.name}
      {attachment.size != null ? <span className="text-tc-text-muted">({formatFileSize(attachment.size)})</span> : null}
    </a>
  );
}

function UserAvatarBubble({ userId, hasAvatar, getAuthHeaders, className }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!hasAvatar || userId == null) {
      setUrl(null);
      return undefined;
    }
    let revoke = null;
    let cancelled = false;
    (async () => {
      try {
        const base = getApiBase();
        const res = await fetch(`${base}/api/avatar/user/${userId}`, { headers: getAuthHeaders() });
        if (!res.ok || cancelled) return;
        const blob = await res.blob();
        if (cancelled) return;
        const u = URL.createObjectURL(blob);
        revoke = u;
        setUrl(u);
      } catch {
        setUrl(null);
      }
    })();
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [userId, hasAvatar, getAuthHeaders]);
  if (url) {
    return <img src={url} alt="" className={className} />;
  }
  return <div className={`bg-tc-asphalt ${className}`} aria-hidden />;
}

function ChannelIconThumb({ slug, enabled, getAuthHeaders, className }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!enabled || !slug) {
      setUrl(null);
      return undefined;
    }
    let revoke = null;
    let cancelled = false;
    (async () => {
      try {
        const base = getApiBase();
        const res = await fetch(`${base}/api/avatar/channel/${encodeURIComponent(slug)}`, { headers: getAuthHeaders() });
        if (!res.ok || cancelled) return;
        const blob = await res.blob();
        if (cancelled) return;
        const u = URL.createObjectURL(blob);
        revoke = u;
        setUrl(u);
      } catch {
        setUrl(null);
      }
    })();
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [slug, enabled, getAuthHeaders]);
  if (!enabled || !url) return null;
  return <img src={url} alt="" className={className} />;
}

function ChannelGlyph({ slug, className }) {
  const s = String(slug || "").toLowerCase();
  if (s === "dreamteamdauns") {
    // Beer mug
    return (
      <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden>
        <path d="M6 8h9v10a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8z" stroke="currentColor" strokeWidth="1.6" />
        <path d="M15 10h2.2a2.2 2.2 0 0 1 0 4.4H15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M6 8c0-1.8 1.6-3 3.2-2.2.8-1.3 2.6-1.6 3.7-.6.9-1.1 2.7-.9 3.4.5.9-.3 1.7.5 1.7 1.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M8 12v6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity=".45" />
        <path d="M11 12v6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity=".45" />
      </svg>
    );
  }
  if (s === "lobby") {
    // Heart
    return (
      <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden>
        <path
          d="M12 21.2s-7.2-4.4-9.6-9C.6 9.2 2.1 6.6 4.8 6.1c1.7-.3 3.3.5 4.2 1.9.9-1.4 2.5-2.2 4.2-1.9 2.7.5 4.2 3.1 2.4 6.1-2.4 4.6-9.6 9-9.6 9z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path
          d="M8.4 7.8c-1.1-1.2-2.9-1.5-4.2-.8"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          opacity=".35"
        />
      </svg>
    );
  }
  return null;
}

export default function App() {
  const [token, setToken] = useState(() => getStoredToken());
  const [nickname, setNickname] = useState(() => localStorage.getItem(LS_NICKNAME) || "");
  const [nameInput, setNameInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [authScreenMode, setAuthScreenMode] = useState("login");
  const [publicChannels, setPublicChannels] = useState([]);
  const [directChannels, setDirectChannels] = useState([]);
  const [canUseGallery, setCanUseGallery] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [dmModalOpen, setDmModalOpen] = useState(false);
  const [roomModalOpen, setRoomModalOpen] = useState(false);
  const [roomModalSlug, setRoomModalSlug] = useState("");
  const [roomModalTitle, setRoomModalTitle] = useState("");
  const [dmUsers, setDmUsers] = useState([]);
  const [dmUsersLoading, setDmUsersLoading] = useState(false);
  const publicChannelsRef = useRef([]);
  const [activeRoom, setActiveRoom] = useState(() => getInitialRoom());
  const [roomTitle, setRoomTitle] = useState(() => {
    const slug = getInitialRoom();
    return slug.startsWith("dm-") ? "ЛС" : slug === "lobby" ? "Семья" : "DTD";
  });
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [myUserId, setMyUserId] = useState(() => readUserId());
  const [imAdmin, setImAdmin] = useState(() => localStorage.getItem("tatarchat_admin") === "1");
  const [replyTo, setReplyTo] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [selectedMsgId, setSelectedMsgId] = useState(null);
  const [typingPeers, setTypingPeers] = useState([]);
  const [pendingFile, setPendingFile] = useState(null);
  const [videoNoteRecording, setVideoNoteRecording] = useState(false);
  const [videoNoteUploading, setVideoNoteUploading] = useState(false);
  const [recordingPreviewStream, setRecordingPreviewStream] = useState(null);
  const [voiceRecording, setVoiceRecording] = useState(false);
  const [voiceUploading, setVoiceUploading] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [hasAvatar, setHasAvatar] = useState(() => localStorage.getItem(LS_HAS_AVATAR) === "1");
  const [searchInput, setSearchInput] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [status, setStatus] = useState("offline");
  const [roomJoined, setRoomJoined] = useState(false);
  const [banner, setBanner] = useState(null);
  const [changePwOpen, setChangePwOpen] = useState(false);
  const [changePwCurrent, setChangePwCurrent] = useState("");
  const [changePwNew, setChangePwNew] = useState("");
  const [changePwNew2, setChangePwNew2] = useState("");
  const [changePwBusy, setChangePwBusy] = useState(false);
  const [changePwOk, setChangePwOk] = useState("");
  const [adminPanelOpen, setAdminPanelOpen] = useState(false);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [themeLight, setThemeLight] = useState(() => localStorage.getItem("tatarchat_theme") === "light");
  const [activePattern, setActivePattern] = useState(() => localStorage.getItem("tatarchat_pattern") || "bottles");
  const [activeView, setActiveView] = useState(() => sessionStorage.getItem("tatarchat_active_view") || CHANNEL_VIEWS.chat);
  const [channelMenuRoom, setChannelMenuRoom] = useState(null);
  const [personalOpen, setPersonalOpen] = useState(false);
  const [adminUsers, setAdminUsers] = useState([]);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminSaving, setAdminSaving] = useState(null);
  const [chatImageLightbox, setChatImageLightbox] = useState(null);

  const savedChannel = publicChannels.find((c) => c.isSaved) || null;
  const listRef = useRef(null);
  const chatParallaxRef = useRef(null);
  const socketRef = useRef(null);
  const roomJoinedRef = useRef(false);
  const joinGenRef = useRef(0);
  const activeRoomRef = useRef(activeRoom);
  const typingIdleRef = useRef(null);
  const fileInputRef = useRef(null);
  const videoNoteLiveRef = useRef(null);
  const videoNoteChunksRef = useRef([]);
  const videoNoteStreamRef = useRef(null);
  const videoNoteRecorderRef = useRef(null);
  const videoNoteMaxTimerRef = useRef(null);
  const videoNoteStoppingRef = useRef(false);
  const videoNoteStartedAtRef = useRef(0);
  const stopVideoNoteRecordRef = useRef(() => {});
  const videoNoteWindowCleanRef = useRef(null);
  const voiceChunksRef = useRef([]);
  const voiceStreamRef = useRef(null);
  const voiceRecorderRef = useRef(null);
  const voiceMaxTimerRef = useRef(null);
  const voiceStoppingRef = useRef(false);
  const voiceWindowCleanRef = useRef(null);
  const voiceStartedAtRef = useRef(0);
  const stopVoiceRecordRef = useRef(() => {});
  const avatarFileRef = useRef(null);
  // const channelAvatarFileRef = useRef(null);
  const replyToRef = useRef(null);
  const nicknameRef = useRef(nickname);

  useEffect(() => {
    nicknameRef.current = nickname;
  }, [nickname]);

  useEffect(() => {
    if (themeLight) document.documentElement.classList.add("theme-light");
    else document.documentElement.classList.remove("theme-light");
    localStorage.setItem("tatarchat_theme", themeLight ? "light" : "dark");
  }, [themeLight]);

  const PATTERNS = {
    bottles:   { url: "/city-pattern.svg",     label: "Бутылки" },
    beer:      { url: "/pattern-beer.svg",      label: "Пиво" },
    wine:      { url: "/pattern-wine.svg",      label: "Вино" },
    cocktails: { url: "/pattern-cocktail.svg",  label: "Коктейли" },
  };

  useEffect(() => {
    const p = PATTERNS[activePattern] || PATTERNS.bottles;
    document.documentElement.style.setProperty("--bg-pattern", `url("${p.url}")`);
    localStorage.setItem("tatarchat_pattern", activePattern);
  }, [activePattern]);

  useEffect(() => {
    sessionStorage.setItem("tatarchat_active_view", activeView);
  }, [activeView]);

  useEffect(() => {
    replyToRef.current = replyTo;
  }, [replyTo]);

  useEffect(() => {
    const el = videoNoteLiveRef.current;
    if (!el || !recordingPreviewStream) return;
    el.srcObject = recordingPreviewStream;
    return () => {
      el.srcObject = null;
    };
  }, [recordingPreviewStream]);

  useEffect(() => {
    return () => {
      clearTimeout(videoNoteMaxTimerRef.current);
      videoNoteWindowCleanRef.current?.();
      videoNoteWindowCleanRef.current = null;
      videoNoteStreamRef.current?.getTracks().forEach((t) => t.stop());
      const r = videoNoteRecorderRef.current;
      if (r && r.state !== "inactive") {
        try {
          r.stop();
        } catch (_) {}
      }
    };
  }, []);

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

  // галерея теперь вкладка внутри каждого канала; отдельной "__gallery" комнаты больше нет

  useEffect(() => {
    publicChannelsRef.current = publicChannels;
  }, [publicChannels]);

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
    const room = activeRoomRef.current;
    const row = publicChannels.find((c) => c.slug === room);
    if (row?.requiresPassword === true) {
      const pw = sessionStorage.getItem(`tatarchat_room_pw_${room}`);
      if (pw) headers["X-Room-Password"] = pw;
    }
    return headers;
  }, [publicChannels]);

  const getAttachmentHeaders = useCallback(
    (messageRoom) => {
      const headers = { Authorization: `Bearer ${token}` };
      const slug = String(messageRoom || "");
      const row = publicChannels.find((c) => c.slug === slug);
      if (row?.requiresPassword === true) {
        const pw = sessionStorage.getItem(`tatarchat_room_pw_${slug}`);
        if (pw) headers["X-Room-Password"] = pw;
      }
      return headers;
    },
    [token, publicChannels]
  );

  const refreshChannels = useCallback(async () => {
    if (!token.trim()) return;
    try {
      const base = getApiBase();
      const headers = { Authorization: `Bearer ${token}` };
      const [chRes, meRes] = await Promise.all([
        fetch(`${base}/api/channels`, { headers }),
        fetch(`${base}/api/me`, { headers }),
      ]);
      const data = await chRes.json().catch(() => ({}));
      const me = await meRes.json().catch(() => ({}));
      if (chRes.ok) {
        setPublicChannels(data.publicChannels || []);
        setDirectChannels(data.directChannels || []);
      }
      if (meRes.ok) {
        setCanUseGallery(!!me.canUseGallery);
      }
    } catch (e) {
      console.error(e);
    }
  }, [token]);

  /** Текущая комната недоступна этому пользователю — уводим на первую из списка */
  useEffect(() => {
    if (!token.trim()) return;
    if (publicChannels.length === 0 && directChannels.length === 0) return;

    const inPub = publicChannels.some((c) => c.slug === activeRoom);
    const inDm = directChannels.some((c) => c.slug === activeRoom);
    if (inPub || inDm) return;

    const next =
      publicChannels.find((c) => !c.isSaved)?.slug ||
      publicChannels.find((c) => c.isSaved)?.slug ||
      directChannels[0]?.slug;
    if (next) {
      setActiveRoom(next);
      const row =
        publicChannels.find((x) => x.slug === next) || directChannels.find((x) => x.slug === next);
      setRoomTitle(next.startsWith("dm-") ? "ЛС" : row?.title || next);
      setBanner(null);
    }
  }, [token, activeRoom, publicChannels, directChannels, canUseGallery]);

  useEffect(() => {
    if (token.trim()) refreshChannels();
  }, [token, refreshChannels]);

  const uploadMyAvatar = useCallback(
    async (file) => {
      if (!file) return;
      try {
        const base = getApiBase();
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch(`${base}/api/me/avatar`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: fd,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setBanner(data.error || "Не удалось загрузить аватар");
          return;
        }
        setHasAvatar(true);
        localStorage.setItem(LS_HAS_AVATAR, "1");
        setBanner(null);
      } catch {
        setBanner("Сеть: аватар");
      }
    },
    [token]
  );

  // channel avatars disabled in UI

  const createRoom = useCallback(async (slug, title) => {
    try {
      const base = getApiBase();
      const res = await fetch(`${base}/api/rooms`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ slug, title }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setBanner(data.error || "Ошибка"); return; }
      refreshChannels();
      setRoomModalOpen(false);
      setRoomModalSlug("");
      setRoomModalTitle("");
    } catch { setBanner("Не удалось создать комнату"); }
  }, [token, refreshChannels]);

  const openDmModal = useCallback(async () => {
    setDmModalOpen(true);
    setDmUsersLoading(true);
    try {
      const base = getApiBase();
      const res = await fetch(`${base}/api/users/for-dm`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setDmUsers(data.users || []);
      else setDmUsers([]);
    } catch {
      setDmUsers([]);
    } finally {
      setDmUsersLoading(false);
    }
  }, [token]);

  const startDmWithPeer = useCallback(
    async (peerId) => {
      try {
        const base = getApiBase();
        const res = await fetch(`${base}/api/channels/open-dm`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ peerId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setBanner(data.error || "Не удалось открыть личку");
          return;
        }
        await refreshChannels();
        if (data.slug) {
          setActiveRoom(data.slug);
          if (data.title) setRoomTitle(data.title);
        }
        setDmModalOpen(false);
        setBanner(null);
      } catch (e) {
        console.error(e);
        setBanner("Сеть: личка");
      }
    },
    [token, refreshChannels]
  );

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
        if (activeView !== CHANNEL_VIEWS.chat) {
          setSearchResults([]);
          setSearchLoading(false);
          return;
        }
        const base = getApiBase();
        const params = new URLSearchParams({ q });
        const room = activeRoomRef.current;
        const headers = { Authorization: `Bearer ${token}`, ...buildRoomHeaders() };
        const res = await fetch(
          `${base}/api/messages/${encodeURIComponent(room)}/search?${params}`,
          { headers }
        );
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
  }, [searchInput, token, buildRoomHeaders, activeView]);

  const stopTyping = useCallback(() => {
    if (typingIdleRef.current) {
      clearTimeout(typingIdleRef.current);
      typingIdleRef.current = null;
    }
    const s = socketRef.current;
    if (s?.connected) s.emit("typing", { typing: false });
  }, []);

  const uploadVideoNoteBlob = useCallback(
    async (blob) => {
      let mime = blob.type || "";
      if (!mime || mime === "audio/webm" || mime === "application/octet-stream") {
        mime = pickRecorderMimeType() || "video/webm";
      }
      const ext = mime.includes("mp4") ? "mp4" : "webm";
      const baseMime = ext === "mp4" ? "video/mp4" : "video/webm";
      const file = new File([blob], `videonote.${ext}`, { type: baseMime });
      setVideoNoteUploading(true);
      stopTyping();
      try {
        const base = getApiBase();
        const fd = new FormData();
        fd.append("room", activeRoomRef.current);
        fd.append("text", "");
        fd.append("videoNote", "1");
        fd.append("video_note", "1");
        const rt = replyToRef.current;
        if (rt?.id != null) fd.append("replyToId", String(rt.id));
        fd.append("file", file);
        const res = await fetch(`${base}/api/messages/send-with-file`, {
          method: "POST",
          headers: { ...getAuthHeaders(), "X-Video-Note": "1" },
          body: fd,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setBanner(data.error || "Не удалось отправить видео");
          return;
        }
        if (data.message) setMessages((prev) => upsertMessageList(prev, data.message));
        setReplyTo(null);
        setBanner(null);
      } catch (e) {
        console.error(e);
        setBanner("Сеть: видеосообщение");
      } finally {
        setVideoNoteUploading(false);
      }
    },
    [getAuthHeaders, stopTyping]
  );

  const uploadVoiceBlob = useCallback(
    async (blob) => {
      let mime = stripMimeParams(blob.type || "") || "audio/webm";
      if (!VOICE_MIMES_CLIENT.has(mime)) mime = "audio/webm";
      const ext =
        mime === "audio/mpeg"
          ? "mp3"
          : mime === "audio/mp4"
            ? "m4a"
            : mime === "audio/ogg"
              ? "ogg"
              : "webm";
      const file = new File([blob], `voicemessage.${ext}`, { type: mime });
      setVoiceUploading(true);
      stopTyping();
      try {
        const base = getApiBase();
        const fd = new FormData();
        fd.append("room", activeRoomRef.current);
        fd.append("text", "");
        fd.append("voiceMessage", "1");
        fd.append("voice_message", "1");
        const rt = replyToRef.current;
        if (rt?.id != null) fd.append("replyToId", String(rt.id));
        fd.append("file", file);
        const res = await fetch(`${base}/api/messages/send-with-file`, {
          method: "POST",
          headers: { ...getAuthHeaders(), "X-Voice-Message": "1" },
          body: fd,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setBanner(data.error || "Не удалось отправить голос");
          return;
        }
        if (data.message) setMessages((prev) => upsertMessageList(prev, data.message));
        setReplyTo(null);
        setBanner(null);
      } catch (e) {
        console.error(e);
        setBanner("Сеть: голосовое сообщение");
      } finally {
        setVoiceUploading(false);
      }
    },
    [getAuthHeaders, stopTyping]
  );

  const stopVoiceRecord = useCallback(async () => {
    if (voiceStoppingRef.current) return;
    voiceStoppingRef.current = true;
    voiceWindowCleanRef.current?.();
    voiceWindowCleanRef.current = null;
    clearTimeout(voiceMaxTimerRef.current);
    voiceMaxTimerRef.current = null;
    setVoiceRecording(false);

    const rec = voiceRecorderRef.current;
    const stream = voiceStreamRef.current;
    voiceRecorderRef.current = null;
    voiceStreamRef.current = null;

    const started = voiceStartedAtRef.current;
    if (!rec) {
      stream?.getTracks().forEach((t) => t.stop());
      voiceStoppingRef.current = false;
      return;
    }

    if (rec.state === "recording") {
      try {
        rec.requestData();
      } catch (_) {
        /* ignore */
      }
    }

    if (rec.state !== "inactive") {
      await new Promise((resolve) => {
        rec.addEventListener("stop", resolve, { once: true });
        try {
          rec.stop();
        } catch (_) {
          resolve();
        }
      });
    }

    stream?.getTracks().forEach((t) => t.stop());
    await new Promise((r) => setTimeout(r, 60));

    const chunks = voiceChunksRef.current;
    voiceChunksRef.current = [];
    let blobType = rec.mimeType || "";
    if (!blobType || !blobType.startsWith("audio/")) {
      blobType = pickAudioMimeType() || "audio/webm";
    }
    const blob = new Blob(chunks, { type: blobType });
    const elapsed = Date.now() - started;
    voiceStoppingRef.current = false;

    if (elapsed < VOICE_MIN_MS || blob.size < VOICE_MIN_BYTES) {
      setBanner("Голосовое слишком короткое");
      return;
    }
    await uploadVoiceBlob(blob);
  }, [uploadVoiceBlob]);

  useEffect(() => {
    stopVoiceRecordRef.current = () => {
      void stopVoiceRecord();
    };
  }, [stopVoiceRecord]);

  const startVoiceRecord = useCallback(async () => {
    if (editingId != null || pendingFile != null || videoNoteUploading || voiceUploading || videoNoteRecording) return;
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setBanner("Запись голоса не поддерживается");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      voiceStreamRef.current = stream;
      voiceChunksRef.current = [];
      const mime = pickAudioMimeType();
      let rec;
      try {
        rec = mime !== "" ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      } catch {
        rec = new MediaRecorder(stream);
      }
      voiceRecorderRef.current = rec;
      rec.ondataavailable = (e) => {
        if (e.data?.size) voiceChunksRef.current.push(e.data);
      };
      rec.start(250);
      voiceStartedAtRef.current = Date.now();
      setVoiceRecording(true);
      const onGlobalUp = () => stopVoiceRecordRef.current();
      window.addEventListener("pointerup", onGlobalUp, true);
      window.addEventListener("pointercancel", onGlobalUp, true);
      voiceWindowCleanRef.current = () => {
        window.removeEventListener("pointerup", onGlobalUp, true);
        window.removeEventListener("pointercancel", onGlobalUp, true);
      };
      voiceMaxTimerRef.current = setTimeout(() => {
        stopVoiceRecordRef.current();
      }, VOICE_MAX_MS);
    } catch (e) {
      console.error(e);
      setBanner("Нет доступа к микрофону");
      voiceStreamRef.current?.getTracks().forEach((t) => t.stop());
      voiceStreamRef.current = null;
    }
  }, [editingId, pendingFile, videoNoteUploading, voiceUploading, videoNoteRecording]);

  const stopVideoNoteRecord = useCallback(async () => {
    if (videoNoteStoppingRef.current) return;
    videoNoteStoppingRef.current = true;
    videoNoteWindowCleanRef.current?.();
    videoNoteWindowCleanRef.current = null;
    clearTimeout(videoNoteMaxTimerRef.current);
    videoNoteMaxTimerRef.current = null;
    setVideoNoteRecording(false);
    setRecordingPreviewStream(null);

    const rec = videoNoteRecorderRef.current;
    const stream = videoNoteStreamRef.current;
    videoNoteRecorderRef.current = null;
    videoNoteStreamRef.current = null;

    const started = videoNoteStartedAtRef.current;
    if (!rec) {
      stream?.getTracks().forEach((t) => t.stop());
      videoNoteStoppingRef.current = false;
      return;
    }

    if (rec.state === "recording") {
      try {
        rec.requestData();
      } catch (_) {
        /* ignore */
      }
    }

    if (rec.state !== "inactive") {
      await new Promise((resolve) => {
        rec.addEventListener("stop", resolve, { once: true });
        try {
          rec.stop();
        } catch (_) {
          resolve();
        }
      });
    }

    stream?.getTracks().forEach((t) => t.stop());

    await new Promise((r) => setTimeout(r, 60));

    const chunks = videoNoteChunksRef.current;
    videoNoteChunksRef.current = [];
    let blobType = rec.mimeType || "";
    if (!blobType || blobType === "audio/webm") {
      blobType = pickRecorderMimeType() || "video/webm";
    }
    const blob = new Blob(chunks, { type: blobType });
    const elapsed = Date.now() - started;
    videoNoteStoppingRef.current = false;

    if (elapsed < VIDEO_NOTE_MIN_MS || blob.size < VIDEO_NOTE_MIN_BYTES) {
      setBanner("Видео слишком короткое");
      return;
    }
    await uploadVideoNoteBlob(blob);
  }, [uploadVideoNoteBlob]);

  useEffect(() => {
    stopVideoNoteRecordRef.current = () => {
      void stopVideoNoteRecord();
    };
  }, [stopVideoNoteRecord]);

  const startVideoNoteRecord = useCallback(async () => {
    if (editingId != null || pendingFile != null || videoNoteUploading || voiceRecording || voiceUploading) return;
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setBanner("Запись видео не поддерживается в этом браузере");
      return;
    }
    try {
      const stream = await acquireVideoNoteStream();
      videoNoteStreamRef.current = stream;
      videoNoteChunksRef.current = [];
      const mime = pickRecorderMimeType();
      let rec;
      try {
        rec =
          mime !== ""
            ? new MediaRecorder(stream, {
                mimeType: mime,
                videoBitsPerSecond: 4_000_000,
                audioBitsPerSecond: 160_000,
              })
            : new MediaRecorder(stream);
      } catch {
        rec = mime !== "" ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      }
      videoNoteRecorderRef.current = rec;
      rec.ondataavailable = (e) => {
        if (e.data?.size) videoNoteChunksRef.current.push(e.data);
      };
      rec.start(250);
      videoNoteStartedAtRef.current = Date.now();
      setRecordingPreviewStream(stream);
      setVideoNoteRecording(true);
      videoNoteWindowCleanRef.current?.();
      videoNoteWindowCleanRef.current = null;
      videoNoteMaxTimerRef.current = setTimeout(() => {
        stopVideoNoteRecordRef.current();
      }, VIDEO_NOTE_MAX_MS);
    } catch (e) {
      console.error(e);
      setBanner("Нет доступа к камере или микрофону");
      videoNoteStreamRef.current?.getTracks().forEach((t) => t.stop());
      videoNoteStreamRef.current = null;
    }
  }, [editingId, pendingFile, videoNoteUploading, voiceRecording, voiceUploading]);

  const syncChatParallax = useCallback(() => {
    const el = listRef.current;
    const bg = chatParallaxRef.current;
    if (!el || !bg) return;
    const y = el.scrollTop * CHAT_BG_PARALLAX;
    bg.style.transform = `translate3d(0, ${-y}px, 0)`;
  }, []);

  const handleChatScroll = useCallback(() => {
    syncChatParallax();
  }, [syncChatParallax]);

  const scrollToBottom = useCallback(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    scrollToBottom();
    requestAnimationFrame(() => syncChatParallax());
  }, [messages, scrollToBottom, syncChatParallax]);

  useEffect(() => {
    requestAnimationFrame(() => syncChatParallax());
  }, [activeRoom, syncChatParallax]);

  const loadHistoryForRoom = useCallback(
    async (room) => {
      if (!token) return;
      try {
        const base = getApiBase();
        const headers = { Authorization: `Bearer ${token}`, ...buildRoomHeaders() };
        const res = await fetch(`${base}/api/messages/${encodeURIComponent(room)}`, { headers });
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
        setMessages((data.messages || []).filter((m) => !m.deleted));
        if (data.title) setRoomTitle(data.title);
        setBanner(null);
      } catch (e) {
        console.error(e);
        setBanner("Не удалось загрузить историю.");
      }
    },
    [token, buildRoomHeaders, activeView]
  );

  useEffect(() => {
    if (!token) return;
    localStorage.setItem(LS_LAST_ROOM, activeRoom);
    if (activeView === CHANNEL_VIEWS.chat) {
      loadHistoryForRoom(activeRoom);
    } else {
      setMessages([]);
      setBanner(null);
    }
  }, [token, activeRoom, loadHistoryForRoom, activeView]);

  const emitJoinRoom = useCallback((socket) => {
    const r = activeRoomRef.current;
    const gen = ++joinGenRef.current;
    const row = publicChannelsRef.current.find((c) => c.slug === r);
    const need = row?.requiresPassword === true;
    const pw = need ? sessionStorage.getItem(`tatarchat_room_pw_${r}`) || "" : "";
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
        if (need) sessionStorage.removeItem(`tatarchat_room_pw_${r}`);
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
      setMessages(rows.filter((m) => !m.deleted));
      setRoomJoined(true);
      roomJoinedRef.current = true;
    });

    socket.on("room-changed", ({ title }) => {
      if (title) setRoomTitle(title);
    });

    socket.on("message", (msg) => {
      if (activeView !== CHANNEL_VIEWS.chat) return;
      if (msg.room && msg.room !== activeRoomRef.current) return;
      setMessages((prev) => upsertMessageList(prev, msg));
    });

    socket.on("message-edited", (msg) => {
      if (activeView !== CHANNEL_VIEWS.chat) return;
      if (msg.room && msg.room !== activeRoomRef.current) return;
      setMessages((prev) => upsertMessageList(prev, msg));
    });

    socket.on("message-deleted", (payload) => {
      if (activeView !== CHANNEL_VIEWS.chat) return;
      const msg = payload?.message;
      if (!msg || (msg.room && msg.room !== activeRoomRef.current)) return;
      const id = payload.id ?? msg.id;
      if (id != null) {
        setMessages((prev) => prev.filter((m) => m.id !== id));
      }
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
  }, [token, emitJoinRoom]);

  useEffect(() => {
    const s = socketRef.current;
    if (!token || !s?.connected) return;
    emitJoinRoom(s);
  }, [activeRoom, token, emitJoinRoom]);

  function applyAuthPayload(data, fallbackName) {
    if (!data?.token) {
      setBanner("Неверный ответ сервера (нет token)");
      return;
    }
    const name = fallbackName;
    localStorage.setItem(LS_TOKEN, data.token);
    localStorage.setItem(LS_NICKNAME, data.user?.nickname || name);
    if (data.user?.id != null) {
      localStorage.setItem(LS_USER_ID, String(data.user.id));
      setMyUserId(data.user.id);
    }
    const adm = !!data.user?.isAdmin;
    localStorage.setItem("tatarchat_admin", adm ? "1" : "0");
    setImAdmin(adm);
    const ha = !!data.user?.hasAvatar;
    localStorage.setItem(LS_HAS_AVATAR, ha ? "1" : "0");
    setHasAvatar(ha);
    setCanUseGallery(!!data.user?.canUseGallery);
    setNickname(data.user?.nickname || name);
    setToken(data.token);
    setPasswordInput("");
    setBanner(null);
  }

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
    try {
      const res = await fetch(`${base}/api/auth/login`, {
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
      applyAuthPayload(data, name);
    } catch (err) {
      console.error(err);
      setBanner("Сеть: не удалось связаться с сервером");
    }
  };

  const submitRegister = async (e) => {
    e.preventDefault();
    setBanner(null);
    const name = nameInput.trim();
    const password = passwordInput;
    if (!name || !password) {
      setBanner("Введите имя и пароль");
      return;
    }
    if (password.length < 6 || password.length > 128) {
      setBanner("Пароль: от 6 до 128 символов");
      return;
    }

    const base = getApiBase();
    try {
      const res = await fetch(`${base}/api/auth/register`, {
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
      applyAuthPayload(data, name);
    } catch (err) {
      console.error(err);
      setBanner("Сеть: не удалось связаться с сервером");
    }
  };

  const openAdminPanel = async () => {
    setAdminPanelOpen(true);
    setAdminLoading(true);
    try {
      const base = getApiBase();
      const res = await fetch(`${base}/api/admin/users`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setAdminUsers(data.users || []);
      else setBanner(data.error || "Не удалось загрузить пользователей");
    } catch {
      setBanner("Сеть: ошибка загрузки пользователей");
    } finally {
      setAdminLoading(false);
    }
  };

  const toggleUserPerm = async (userId, field, value) => {
    setAdminSaving(userId);
    try {
      const base = getApiBase();
      const res = await fetch(`${base}/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ [field]: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setAdminUsers((prev) => prev.map((u) => u.id === userId ? { ...u, ...data.user } : u));
      } else {
        setBanner(data.error || "Ошибка сохранения");
      }
    } catch {
      setBanner("Сеть: ошибка сохранения");
    } finally {
      setAdminSaving(null);
    }
  };

  const submitChangePassword = async (e) => {
    e.preventDefault();
    setBanner(null);
    setChangePwOk("");
    const c = changePwCurrent;
    const n = changePwNew.trim();
    const n2 = changePwNew2.trim();
    if (!c || !n || !n2) {
      setBanner("Заполните все поля");
      return;
    }
    if (n !== n2) {
      setBanner("Новый пароль и подтверждение не совпадают");
      return;
    }
    if (n.length < 6 || n.length > 128) {
      setBanner("Новый пароль: от 6 до 128 символов");
      return;
    }
    setChangePwBusy(true);
    try {
      const base = getApiBase();
      const res = await fetch(`${base}/api/auth/change-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ currentPassword: c, newPassword: n }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setBanner(data.error || "Не удалось сменить пароль");
        return;
      }
      setChangePwCurrent("");
      setChangePwNew("");
      setChangePwNew2("");
      setChangePwOk("Пароль обновлён");
      window.setTimeout(() => setChangePwOk(""), 5000);
    } catch (err) {
      console.error(err);
      setBanner("Сеть: не удалось сменить пароль");
    } finally {
      setChangePwBusy(false);
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
    setToken("");
    setNickname("");
    setNameInput("");
    setPasswordInput("");
    setMessages([]);
    setMyUserId(null);
    setImAdmin(false);
    localStorage.removeItem("tatarchat_admin");
    setHasAvatar(false);
    localStorage.removeItem(LS_HAS_AVATAR);
    setReplyTo(null);
    setEditingId(null);
    setTypingPeers([]);
    setPendingFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setSearchInput("");
    setSearchResults([]);
    setPublicChannels([]);
    setDirectChannels([]);
    setCanUseGallery(false);
    setActiveRoom("lobby");
    setRoomTitle("Семья");
    setStatus("offline");
    setRoomJoined(false);
    roomJoinedRef.current = false;
    setChangePwOpen(false);
    setChangePwCurrent("");
    setChangePwNew("");
    setChangePwNew2("");
    setChangePwOk("");
    setChangePwBusy(false);
  };

  const selectChannel = (slug) => {
    setBanner(null);
    setActiveRoom(slug);
    setActiveView(CHANNEL_VIEWS.chat);
    setChannelMenuRoom(null);
  };

  const openChannelMenu = (slug) => {
    const s = String(slug || "").toLowerCase();
    const enabled = s === "lobby" || s === "dreamteamdauns";
    if (!enabled) {
      selectChannel(slug);
      return;
    }
    setActiveRoom(slug);
    setChannelMenuRoom((prev) => (prev === slug ? null : slug));
  };

  const chooseChannelView = (view) => {
    setActiveView(view);
    if (channelMenuRoom) setActiveRoom(channelMenuRoom);
    setChannelMenuRoom(null);
  };

  useEffect(() => {
    const onDocDown = (e) => {
      if (!attachMenuOpen) return;
      // close on any click outside; menu button stops propagation
      setAttachMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDocDown);
    return () => document.removeEventListener("pointerdown", onDocDown);
  }, [attachMenuOpen]);

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
        setMessages((prev) => prev.filter((m) => m.id !== id));
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

  if (!token) {
    return (
      <div className="flex min-h-full items-center justify-center bg-tc-bg p-4">
        <div className="w-full max-w-sm rounded-xl bg-tc-panel p-8 shadow-xl">
          <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-tc-accent/20">
            <svg viewBox="0 0 24 24" className="h-10 w-10 text-tc-accent" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
            </svg>
          </div>
          <h1 className="mb-1 text-center text-2xl font-bold text-tc-text">TatarChat</h1>
          <p className="mb-4 text-center text-sm text-tc-text-sec">
            {authScreenMode === "register"
              ? "Создайте имя и пароль (от 6 символов)."
              : "Вход по имени и паролю."}
          </p>
          <div className="mb-4 flex rounded-lg border border-tc-border p-0.5 text-sm">
            <button
              type="button"
              onClick={() => {
                setAuthScreenMode("login");
                setBanner(null);
              }}
              className={`flex-1 rounded-md py-2 font-medium transition ${
                authScreenMode === "login"
                  ? "bg-tc-accent text-white"
                  : "text-tc-text-sec hover:text-tc-text"
              }`}
            >
              Вход
            </button>
            <button
              type="button"
              onClick={() => {
                setAuthScreenMode("register");
                setBanner(null);
              }}
              className={`flex-1 rounded-md py-2 font-medium transition ${
                authScreenMode === "register"
                  ? "bg-tc-accent text-white"
                  : "text-tc-text-sec hover:text-tc-text"
              }`}
            >
              Регистрация
            </button>
          </div>

          <form onSubmit={authScreenMode === "register" ? submitRegister : submitAuth} className="space-y-4">
            <div>
              <input
                type="text"
                className="w-full rounded-lg border border-tc-border bg-tc-input px-4 py-3 text-sm text-tc-text outline-none transition placeholder:text-tc-text-muted focus:border-tc-accent"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                placeholder="Имя"
                maxLength={64}
                autoComplete="username"
                autoFocus
              />
            </div>
            <div>
              <input
                type="password"
                className="w-full rounded-lg border border-tc-border bg-tc-input px-4 py-3 text-sm text-tc-text outline-none transition placeholder:text-tc-text-muted focus:border-tc-accent"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                placeholder="Пароль"
                maxLength={128}
                autoComplete={authScreenMode === "register" ? "new-password" : "current-password"}
              />
            </div>
            {banner && (
              <p className="rounded-lg bg-tc-danger/15 px-4 py-2.5 text-sm text-tc-danger">
                {banner}
              </p>
            )}
            <button
              type="submit"
              className="w-full rounded-lg bg-tc-accent py-3 text-sm font-semibold text-white transition hover:bg-tc-accent/85 active:scale-[0.98]"
            >
              {authScreenMode === "register" ? "Зарегистрироваться" : "Войти"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full min-w-0 overflow-hidden bg-tc-bg">
      <input
        ref={avatarFileRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          void uploadMyAvatar(f);
        }}
      />
      {/* Sidebar: на iOS fixed внутри flex резервирует ~w-72 — обёртка max-md:w-0 + absolute панель */}
      <div className="relative z-40 max-md:w-0 max-md:min-w-0 max-md:flex-none max-md:overflow-visible md:w-72 md:shrink-0">
        <aside
          className={`absolute inset-y-0 left-0 z-40 flex h-full w-72 flex-col bg-tc-sidebar transition-transform duration-200 md:relative md:z-auto md:translate-x-0 ${
            sidebarOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
        <div className="flex items-center justify-between px-4 py-3">
          <button
            type="button"
            onClick={() => setProfileModalOpen(true)}
            className="flex min-w-0 items-center gap-2 rounded-lg px-1 py-0.5 transition hover:bg-tc-hover"
            title="Профиль"
          >
            <UserAvatarBubble
              userId={myUserId}
              hasAvatar={hasAvatar}
              getAuthHeaders={getAuthHeaders}
              className="h-7 w-7 shrink-0 rounded-lg object-cover"
            />
            <span className="truncate text-sm font-semibold text-tc-text">{nickname}</span>
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-tc-text-muted" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
          </button>
          <div className="flex items-center gap-1">
            {imAdmin && (
              <button
                type="button"
                onClick={() => setRoomModalOpen(true)}
                className="rounded-full p-1.5 text-tc-text-sec transition hover:bg-tc-hover"
                title="Создать комнату"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
              </button>
            )}
            <button
              type="button"
              onClick={() => openDmModal()}
              className="rounded-full p-1.5 text-tc-text-sec transition hover:bg-tc-hover"
              title="Написать"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1.003 1.003 0 000-1.42l-2.34-2.33a1.003 1.003 0 00-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.83z"/></svg>
            </button>
            <button
              type="button"
              onClick={() => {
                setSearchOpen((v) => !v);
                if (searchOpen) setSearchInput("");
              }}
              className={`rounded-full p-1.5 text-tc-text-sec transition hover:bg-tc-hover ${searchOpen ? "bg-tc-hover text-tc-accent" : ""}`}
              title="Поиск"
              aria-label="Поиск"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79L20 21.49 21.49 20 15.5 14zM9.5 14C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
            </button>
            <button
              type="button"
              className="rounded-full p-1.5 text-tc-text-sec transition hover:bg-tc-hover md:hidden"
              onClick={() => setSidebarOpen(false)}
            >
              ✕
            </button>
          </div>
        </div>

        {searchOpen ? (
          <div className="px-3 pb-2">
            <div className="flex items-center gap-2">
              <input
                type="search"
                autoFocus
                className="w-full rounded-lg bg-tc-input px-3 py-2 text-sm text-tc-text outline-none placeholder:text-tc-text-muted"
                placeholder="Поиск по сообщениям…"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
              <button
                type="button"
                onClick={() => { setSearchOpen(false); setSearchInput(""); }}
                className="rounded-lg px-2 py-2 text-sm text-tc-text-sec transition hover:bg-tc-hover"
                title="Закрыть"
              >
                ✕
              </button>
            </div>
            {searchInput.trim() && searchResults.length > 0 ? (
              <div className="mt-1 max-h-40 overflow-y-auto rounded-lg bg-tc-panel">
                {searchResults.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className="block w-full truncate px-3 py-2 text-left text-sm text-tc-text-sec transition hover:bg-tc-hover"
                    onClick={() => {
                      const el = document.querySelector(`[data-message-id="${r.id}"]`);
                      el?.scrollIntoView({ behavior: "smooth", block: "center" });
                      setSearchInput("");
                      setSearchOpen(false);
                      setSidebarOpen(false);
                    }}
                  >
                    <span className="font-medium text-tc-accent">{r.user_nick}</span>{" "}
                    <span className="text-tc-text-muted">
                      {r.deleted
                        ? "удалено"
                        : (r.text || "").trim().slice(0, 60) ||
                          (r.attachment?.kind === "video_note"
                            ? "Видео"
                            : r.attachment?.kind === "voice"
                              ? "Голос"
                              : r.attachment
                                ? `📎 ${r.attachment.name}`
                                : "—")}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <nav className="sidebar-scroll flex-1 overflow-y-auto">
          {/* Personal (top) */}
          <button
            type="button"
            onClick={() => setPersonalOpen((v) => !v)}
            className="mx-3 mb-2 flex items-center justify-between rounded-xl border border-tc-border/70 bg-tc-panel/30 px-3 py-2 text-sm text-tc-text-sec transition hover:bg-tc-hover hover:text-tc-accent"
          >
            <span className="flex items-center gap-2">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
              Личное
            </span>
            <svg viewBox="0 0 24 24" className={`h-4 w-4 transition-transform ${personalOpen ? "rotate-180" : ""}`} fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
          </button>

          <div className={`overflow-hidden px-3 transition-all duration-200 ${personalOpen ? "max-h-[520px] opacity-100 pb-2" : "max-h-0 opacity-0"}`}>
            {savedChannel ? (
              <button
                type="button"
                onClick={() => { selectChannel(savedChannel.slug); setSidebarOpen(false); }}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 transition-colors duration-200 ${
                  activeRoom === savedChannel.slug ? "bg-tc-accent/20" : "hover:bg-tc-hover"
                }`}
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/20 text-amber-500" aria-hidden>
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
                </div>
                <div className="min-w-0 flex-1 text-left">
                  <span className={`block truncate text-sm font-medium ${activeRoom === savedChannel.slug ? "text-tc-accent" : "text-tc-text"}`}>
                    Избранное
                  </span>
                  <p className="truncate text-xs text-tc-text-muted">{savedChannel.title}</p>
                </div>
              </button>
            ) : null}

            {directChannels.length ? (
              <div className="mt-2 rounded-xl border border-tc-border/60 bg-tc-panel/20">
                {directChannels.map((r) => (
                  <button
                    key={r.slug}
                    type="button"
                    onClick={() => { selectChannel(r.slug); setSidebarOpen(false); }}
                    className={`flex w-full items-center gap-3 px-3 py-2.5 transition-colors duration-200 ${
                      activeRoom === r.slug ? "bg-tc-accent/20" : "hover:bg-tc-hover"
                    }`}
                  >
                    <div className="min-w-0 flex-1 text-left">
                      <span className={`block truncate text-sm font-medium ${activeRoom === r.slug ? "text-tc-accent" : "text-tc-text"}`}>
                        {r.peer?.nickname || r.title}
                      </span>
                      <p className="truncate text-xs text-tc-text-muted">Личное сообщение</p>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <p className="px-3 py-2 text-xs text-tc-text-muted">Нет личных диалогов</p>
            )}
          </div>

          {/* Channels */}
          {(() => {
            const restCh = publicChannels.filter((c) => !c.isSaved);
            return (
              <>
                {restCh.map((r) => (
                  <div key={r.slug}>
                  <button
                    type="button"
                    onClick={() => { openChannelMenu(r.slug); setSidebarOpen(false); }}
                    className={`flex w-full items-center gap-3 px-4 py-3 transition-colors duration-200 ${
                      activeRoom === r.slug ? "bg-tc-accent/20" : "hover:bg-tc-hover"
                    }`}
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-tc-asphalt/35 text-tc-text-sec" aria-hidden>
                      <ChannelGlyph slug={r.slug} className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1 text-left">
                      <div className="flex items-center justify-between">
                        <span
                          className={`truncate text-sm font-medium ${
                            activeRoom === r.slug ? "text-tc-accent" : "text-tc-text"
                          }`}
                        >
                          {r.title}
                        </span>
                        {r.requiresPassword ? (
                          <span className="ml-1 text-[10px] text-tc-text-muted">🔒</span>
                        ) : null}
                      </div>
                      <p className="truncate text-xs text-tc-text-muted">Канал</p>
                    </div>
                  </button>
                  <div
                    className={`overflow-hidden px-4 transition-all duration-200 ${
                      channelMenuRoom === r.slug ? "max-h-40 opacity-100 pb-2" : "max-h-0 opacity-0"
                    }`}
                  >
                    <div className="mt-1 space-y-1 rounded-xl border border-tc-border/70 bg-tc-panel/40 p-2">
                      <button
                        type="button"
                        onClick={() => chooseChannelView(CHANNEL_VIEWS.chat)}
                        className="w-full rounded-lg px-3 py-2 text-left text-sm text-tc-text-sec transition hover:bg-tc-hover hover:text-tc-accent"
                      >
                        Чат
                      </button>
                      <button
                        type="button"
                        disabled={!canUseGallery}
                        onClick={() => chooseChannelView(CHANNEL_VIEWS.gallery)}
                        className={`w-full rounded-lg px-3 py-2 text-left text-sm transition ${
                          canUseGallery ? "text-tc-text-sec hover:bg-tc-hover hover:text-tc-accent" : "text-tc-text-muted opacity-60"
                        }`}
                      >
                        Галерея
                      </button>
                      <button
                        type="button"
                        onClick={() => chooseChannelView(CHANNEL_VIEWS.calendar)}
                        className="w-full rounded-lg px-3 py-2 text-left text-sm text-tc-text-sec transition hover:bg-tc-hover hover:text-tc-accent"
                      >
                        Календарь
                      </button>
                    </div>
                  </div>
                  </div>
                ))}
              </>
            );
          })()}
        </nav>

      </aside>
      </div>

      {/* Profile modal */}
      {profileModalOpen && (
        <div
          className="fixed inset-0 z-[300] flex items-start justify-start p-0 md:items-center md:justify-center md:bg-black/50 md:p-4 md:backdrop-blur-sm"
          onClick={() => setProfileModalOpen(false)}
        >
          <div
            className="relative mt-12 w-72 rounded-xl bg-tc-panel shadow-2xl md:mt-0 md:w-80"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center gap-3 border-b border-tc-border px-4 py-3">
              <UserAvatarBubble userId={myUserId} hasAvatar={hasAvatar} getAuthHeaders={getAuthHeaders} className="h-10 w-10 rounded-xl object-cover" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-tc-text">{nickname}</p>
                <p className="text-xs text-tc-text-muted">Профиль</p>
              </div>
              <button type="button" onClick={() => setProfileModalOpen(false)} className="rounded-lg p-1 text-tc-text-sec hover:bg-tc-hover">
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
              </button>
            </div>

            <div className="p-2 space-y-0.5">
              {/* Avatar */}
              <button
                type="button"
                onClick={() => { avatarFileRef.current?.click(); setProfileModalOpen(false); }}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-tc-text-sec transition hover:bg-tc-hover hover:text-tc-accent"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
                {hasAvatar ? "Сменить аватар" : "Загрузить аватар"}
              </button>

              {/* Change password */}
              <div>
                <button
                  type="button"
                  onClick={() => { setChangePwOpen((v) => !v); setChangePwOk(""); }}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-tc-text-sec transition hover:bg-tc-hover hover:text-tc-accent"
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>
                  <span className="flex-1 text-left">{changePwOpen ? "Скрыть" : "Сменить пароль"}</span>
                  <svg viewBox="0 0 24 24" className={`h-4 w-4 shrink-0 transition-transform ${changePwOpen ? "rotate-180" : ""}`} fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
                </button>
                {changePwOpen && (
                  <form onSubmit={submitChangePassword} className="mx-3 mb-2 mt-1 space-y-2">
                    <input type="password" autoComplete="current-password" className="w-full rounded-lg border border-tc-border bg-tc-input px-3 py-2 text-sm text-tc-text outline-none placeholder:text-tc-text-muted focus:border-tc-accent" placeholder="Текущий пароль" value={changePwCurrent} onChange={(e) => setChangePwCurrent(e.target.value)} disabled={changePwBusy} />
                    <input type="password" autoComplete="new-password" className="w-full rounded-lg border border-tc-border bg-tc-input px-3 py-2 text-sm text-tc-text outline-none placeholder:text-tc-text-muted focus:border-tc-accent" placeholder="Новый пароль" value={changePwNew} onChange={(e) => setChangePwNew(e.target.value)} disabled={changePwBusy} />
                    <input type="password" autoComplete="new-password" className="w-full rounded-lg border border-tc-border bg-tc-input px-3 py-2 text-sm text-tc-text outline-none placeholder:text-tc-text-muted focus:border-tc-accent" placeholder="Повторите пароль" value={changePwNew2} onChange={(e) => setChangePwNew2(e.target.value)} disabled={changePwBusy} />
                    {changePwOk && <p className="text-center text-xs text-tc-green">{changePwOk}</p>}
                    <button type="submit" disabled={changePwBusy} className="w-full rounded-lg bg-tc-accent py-2 text-sm font-medium text-white transition hover:bg-tc-accent-hover disabled:opacity-50">{changePwBusy ? "Сохранение…" : "Сохранить"}</button>
                  </form>
                )}
              </div>

              {/* Pattern picker */}
              <div>
                <div className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-tc-text-sec">
                  <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0" fill="currentColor"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/></svg>
                  <span>Фон</span>
                </div>
                <div className="mx-3 mb-2 grid grid-cols-4 gap-2">
                  {Object.entries(PATTERNS).map(([key, p]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setActivePattern(key)}
                      className={`flex flex-col items-center gap-1 rounded-lg border-2 p-1.5 transition ${activePattern === key ? "border-tc-accent" : "border-tc-border hover:border-tc-accent/50"}`}
                      title={p.label}
                    >
                      <img src={p.url} alt={p.label} className="h-10 w-full rounded object-cover" style={{imageRendering:"pixelated"}} />
                      <span className="text-[9px] leading-none text-tc-text-muted">{p.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Theme toggle */}
              <button
                type="button"
                onClick={() => setThemeLight((v) => !v)}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-tc-text-sec transition hover:bg-tc-hover hover:text-tc-accent"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0" fill="currentColor">
                  {themeLight
                    ? <path d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.389 5.389 0 0 1-4.4 2.26 5.403 5.403 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z"/>
                    : <path d="M12 7a5 5 0 1 0 0 10A5 5 0 0 0 12 7zm-1-5h2v3h-2V2zm0 17h2v3h-2v-3zm8.66-14.24l1.41 1.41-2.12 2.12-1.41-1.41 2.12-2.12zM4.05 19.36l1.41 1.41-2.12 2.12-1.41-1.41 2.12-2.12zM22 11v2h-3v-2h3zm-17 0v2H2v-2h3zm14.95 8.36-2.12-2.12 1.41-1.41 2.12 2.12-1.41 1.41zM6.17 7.05 4.05 4.93l1.41-1.41 2.12 2.12-1.41 1.41z"/>
                  }
                </svg>
                <span className="flex-1 text-left">{themeLight ? "Тёмная тема" : "Светлая тема"}</span>
                <div className={`relative h-5 w-9 rounded-full transition-colors ${themeLight ? "bg-tc-accent" : "bg-tc-asphalt"}`}>
                  <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${themeLight ? "translate-x-4" : "translate-x-0.5"}`}/>
                </div>
              </button>

              {/* Admin */}
              {imAdmin && (
                <button
                  type="button"
                  onClick={() => { openAdminPanel(); setProfileModalOpen(false); }}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-tc-text-sec transition hover:bg-tc-hover hover:text-tc-accent"
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg>
                  Управление пользователями
                </button>
              )}

              <div className="my-1 border-t border-tc-border"/>

              {/* Logout */}
              <button
                type="button"
                onClick={() => { handleLogout(); setProfileModalOpen(false); }}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-tc-danger transition hover:bg-tc-danger/10"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor"><path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5-5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z"/></svg>
                Выйти
              </button>
            </div>
          </div>
        </div>
      )}

      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Chat image lightbox */}
      {chatImageLightbox?.url ? (
        <div
          className="fixed inset-0 z-[400] flex items-center justify-center bg-black/80 p-3 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          onClick={() => setChatImageLightbox(null)}
        >
          <div className="w-full max-w-4xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="min-w-0 flex-1 truncate text-sm text-white/80">
                {chatImageLightbox.name || "Фото"}
              </p>
              <div className="flex items-center gap-2">
                <a
                  href={chatImageLightbox.url}
                  download={chatImageLightbox.name || "photo"}
                  className="rounded-lg bg-white/10 px-3 py-2 text-xs text-white/90 transition hover:bg-white/15"
                >
                  Скачать
                </a>
                <button
                  type="button"
                  onClick={() => setChatImageLightbox(null)}
                  className="rounded-lg bg-white/10 p-2 text-white/90 transition hover:bg-white/15"
                  aria-label="Закрыть"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                </button>
              </div>
            </div>
            <div className="overflow-hidden rounded-2xl bg-black/40">
              <img
                src={chatImageLightbox.url}
                alt={chatImageLightbox.name || "Фото"}
                className="max-h-[80vh] w-full object-contain"
              />
            </div>
          </div>
        </div>
      ) : null}

      {/* Main area */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Admin panel modal */}
        {adminPanelOpen && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={() => setAdminPanelOpen(false)}>
            <div className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-xl bg-tc-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between border-b border-tc-border px-6 py-4">
                <h2 className="text-base font-semibold text-tc-text">Управление пользователями</h2>
                <button type="button" onClick={() => setAdminPanelOpen(false)} className="rounded-lg p-1.5 text-tc-text-sec hover:bg-tc-hover">
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                </button>
              </div>
              <div className="overflow-y-auto flex-1">
                {adminLoading ? (
                  <p className="p-8 text-center text-sm text-tc-text-muted">Загрузка…</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-tc-border text-left text-xs text-tc-text-muted uppercase">
                        <th className="px-6 py-3 font-medium">Пользователь</th>
                        <th className="px-3 py-3 text-center font-medium">Семья</th>
                        <th className="px-3 py-3 text-center font-medium">DTD</th>
                        <th className="px-3 py-3 text-center font-medium">Галерея</th>
                        <th className="px-3 py-3 text-center font-medium">Админ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {adminUsers.map((u) => {
                        const saving = adminSaving === u.id;
                        const Toggle = ({ field, value }) => (
                          <button
                            type="button"
                            disabled={saving}
                            onClick={() => toggleUserPerm(u.id, field, !value)}
                            className={`mx-auto flex h-6 w-11 items-center rounded-full transition-colors ${value ? "bg-tc-accent" : "bg-tc-border"} ${saving ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                          >
                            <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${value ? "translate-x-6" : "translate-x-1"}`} />
                          </button>
                        );
                        return (
                          <tr key={u.id} className="border-b border-tc-border/50 hover:bg-tc-hover/30">
                            <td className="px-6 py-3">
                              <div className="font-medium text-tc-text">{u.nickname}</div>
                              <div className="text-xs text-tc-text-muted">ID {u.id}</div>
                            </td>
                            <td className="px-3 py-3">
                              <div className="flex justify-center">
                                <Toggle field="can_see_lobby" value={!!u.can_see_lobby} />
                              </div>
                            </td>
                            <td className="px-3 py-3">
                              <div className="flex justify-center">
                                <Toggle field="can_see_dtd" value={!!u.can_see_dtd} />
                              </div>
                            </td>
                            <td className="px-3 py-3">
                              <div className="flex justify-center">
                                <Toggle field="can_use_gallery" value={!!u.can_use_gallery} />
                              </div>
                            </td>
                            <td className="px-3 py-3">
                              <div className="flex justify-center">
                                <Toggle field="is_admin" value={!!u.is_admin} />
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
              <div className="border-t border-tc-border px-6 py-3 text-xs text-tc-text-muted">
                Переключатели сохраняются мгновенно. Изменения вступят в силу при следующем действии пользователя.
              </div>
            </div>
          </div>
        )}

        {/* Chat header */}
        <header className="flex h-14 flex-shrink-0 items-center gap-3 border-b border-tc-border bg-tc-header px-4">
          <button
            type="button"
            className="rounded-full p-1.5 text-tc-text-sec transition hover:bg-tc-hover md:hidden"
            onClick={() => setSidebarOpen(true)}
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold text-tc-text">{roomTitle}</h2>
            <div className="flex items-center gap-2 text-xs text-tc-text-muted">
              <span className={`inline-block h-2 w-2 rounded-full ${status === "online" ? "bg-tc-online" : "bg-tc-text-muted"}`} />
              {status === "online" ? "подключено" : "нет связи"}
              <span className="text-tc-text-muted">·</span>
              <span className="truncate">{nickname}</span>
            </div>
          </div>
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-tc-asphalt/35 text-tc-text-sec" aria-hidden>
            <ChannelGlyph slug={activeRoom} className="h-5 w-5" />
          </div>
        </header>

        {/* Banner */}
        {banner && (
          <div className="bg-tc-danger/15 px-4 py-2 text-sm text-tc-danger">{banner}</div>
        )}

        {activeView === CHANNEL_VIEWS.gallery ? (
          canUseGallery ? (
            <GalleryView getApiBase={getApiBase} token={token} room={activeRoom} onError={setBanner} />
          ) : (
            <div className="flex flex-1 items-center justify-center px-6">
              <p className="text-sm text-tc-text-muted">Нет доступа к галерее</p>
            </div>
          )
        ) : activeView === CHANNEL_VIEWS.calendar ? (
          <CalendarView
            getApiBase={getApiBase}
            token={token}
            room={activeRoom}
            onError={setBanner}
            currentUserId={myUserId}
            isAdmin={imAdmin}
          />
        ) : (
          <>
        {/* Messages + parallax pattern (фон медленнее ленты) */}
        <div className="relative flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden">
          <div ref={chatParallaxRef} className="chat-bg-parallax pointer-events-none z-0" aria-hidden />
          <div
            ref={listRef}
            className="messages-scroll relative z-10 w-full min-w-0 flex-1 overflow-y-auto bg-transparent px-4 py-3"
            onScroll={handleChatScroll}
            onClick={(e) => { if (e.target === e.currentTarget) setSelectedMsgId(null); }}
          >
          {messages.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-tc-text-muted">Нет сообщений</p>
            </div>
          ) : (
            <div className="space-y-1">
              {messages.map((m, i) => {
                const key = m.id != null ? m.id : `leg-${i}-${m.time}-${m.user_nick}`;
                const mine = myUserId != null && m.user_id === myUserId;
                const deleted = !!m.deleted;
                const selected = selectedMsgId === m.id && m.id != null;
                return (
                  <div
                    key={key}
                    data-message-id={m.id != null ? m.id : undefined}
                    className={`flex ${mine ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`flex max-w-[92%] items-end gap-2 sm:max-w-[80%] ${mine ? "flex-row-reverse" : "flex-row"}`}
                    >
                      <UserAvatarBubble
                        userId={m.user_id}
                        hasAvatar={!!m.user_has_avatar}
                        getAuthHeaders={getAuthHeaders}
                        className="h-12 w-12 shrink-0 rounded-xl object-cover"
                      />
                      <div
                        className={`relative min-w-0 max-w-full flex-1 cursor-pointer rounded-xl px-3 py-2 transition-colors ${
                          mine
                            ? "rounded-br-sm bg-tc-msg-own"
                            : "rounded-bl-sm bg-tc-msg"
                        } ${selected ? "ring-2 ring-tc-accent/60" : ""}`}
                        onClick={() => setSelectedMsgId(selected ? null : m.id)}
                      >
                      {!mine && (
                        <p className="mb-0.5 text-[13px] font-semibold text-tc-accent">{m.user_nick}</p>
                      )}
                      {m.reply_to && (
                        <div className="mb-1.5 rounded-md border-l-2 border-tc-accent bg-white/5 py-1 pl-2 pr-2">
                          <p className="text-xs font-medium text-tc-accent">{m.reply_to.user_nick}</p>
                          {m.reply_to.deleted ? (
                            <p className="text-xs italic text-tc-text-muted">удалено</p>
                          ) : (
                            <p className="truncate text-xs text-tc-text-sec">
                              {m.reply_to.preview?.trim() || "📎 файл"}
                            </p>
                          )}
                        </div>
                      )}
                      {deleted ? (
                        <p className="text-sm italic text-tc-text-muted">Сообщение удалено</p>
                      ) : (
                        <>
                          {(m.text || "").trim() ? (
                            <p className="select-text whitespace-pre-wrap break-words text-sm text-tc-text">{m.text}</p>
                          ) : null}
                          {m.attachment && m.id != null ? (
                            <MessageAttachment
                              messageId={m.id}
                              messageRoom={m.room}
                              attachment={m.attachment}
                              getAttachmentHeaders={getAttachmentHeaders}
                              onOpenImage={setChatImageLightbox}
                            />
                          ) : null}
                        </>
                      )}
                      <div className="mt-1 flex items-center justify-end gap-1">
                        <span className="text-[10px] text-white/40">
                          {formatTime(m.time)}
                          {m.edited_at ? " · изм." : ""}
                        </span>
                      </div>
                      {/* Reactions */}
                      {(m.reactions || []).some((r) => r.count > 0) && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {(m.reactions || []).filter((r) => r.count > 0).map((r) => {
                            const me = myUserId != null && r.user_ids?.includes(myUserId);
                            return (
                              <button
                                key={r.emoji}
                                type="button"
                                onClick={(e) => { e.stopPropagation(); m.id != null && toggleReaction(m.id, r.emoji); }}
                                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs transition ${
                                  me
                                    ? "bg-tc-accent/25 text-tc-accent"
                                    : "bg-white/5 text-tc-text-sec hover:bg-white/10"
                                }`}
                              >
                                {REACTION_SVG[r.emoji]
                                  ? <img src={REACTION_SVG[r.emoji]} alt={r.emoji} className="reaction-icon" />
                                  : r.emoji}
                                <span className="text-[10px]">{r.count}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                      {/* Action bar on select */}
                      {selected && !deleted && (
                        <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-white/10 pt-2">
                          {QUICK_REACTIONS.map((em) => (
                            <button
                              key={em}
                              type="button"
                              onClick={(e) => { e.stopPropagation(); m.id != null && toggleReaction(m.id, em); }}
                              className="rounded-full p-1 transition hover:bg-white/10 active:scale-110"
                            >
                              <img src={REACTION_SVG[em]} alt={em} className="reaction-icon" />
                            </button>
                          ))}
                          <span className="mx-1 h-4 w-px bg-white/10" />
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setReplyTo({ id: m.id, user_nick: m.user_nick, preview: messagePreviewForReply(m) });
                              setEditingId(null);
                              setSelectedMsgId(null);
                            }}
                            className="rounded-full px-2 py-1 text-xs text-tc-text-sec transition hover:bg-white/10 hover:text-tc-accent"
                          >
                            Ответить
                          </button>
                          {!mine && m.user_id != null && myUserId != null && (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); startDmWithPeer(m.user_id); setSelectedMsgId(null); }}
                              className="rounded-full px-2 py-1 text-xs text-tc-text-sec transition hover:bg-white/10 hover:text-tc-accent"
                            >
                              В ЛС
                            </button>
                          )}
                          {mine && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingId(m.id);
                                setInput(m.text || "");
                                setReplyTo(null);
                                setPendingFile(null);
                                if (fileInputRef.current) fileInputRef.current.value = "";
                                setSelectedMsgId(null);
                              }}
                              className="rounded-full px-2 py-1 text-xs text-tc-text-sec transition hover:bg-white/10 hover:text-tc-accent"
                            >
                              Изменить
                            </button>
                          )}
                          {(mine || imAdmin) && (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); deleteMessage(m.id); setSelectedMsgId(null); }}
                              className="rounded-full px-2 py-1 text-xs text-tc-danger transition hover:bg-tc-danger/10"
                            >
                              Удалить
                            </button>
                          )}
                        </div>
                      )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        </div>

        {/* Reply / Edit bar */}
        {(replyTo || editingId != null) && (
          <div className="flex items-center gap-3 border-t border-tc-border bg-tc-header px-4 py-2">
            <div className="h-8 w-0.5 rounded-full bg-tc-accent" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-tc-accent">
                {editingId != null ? "Редактирование" : `Ответ для ${replyTo?.user_nick}`}
              </p>
              <p className="truncate text-xs text-tc-text-sec">
                {editingId != null ? input.slice(0, 80) : replyTo?.preview || ""}
              </p>
            </div>
            <button
              type="button"
              className="shrink-0 rounded-full p-1 text-tc-text-muted transition hover:bg-tc-hover hover:text-tc-text"
              onClick={() => { setReplyTo(null); setEditingId(null); setInput(""); }}
            >
              ✕
            </button>
          </div>
        )}

        {/* Typing indicator */}
        {typingPeers.length > 0 && (
          <div className="border-t border-tc-border px-4 py-1.5 text-xs text-tc-accent">
            {typingPeers.length === 1
              ? `${typingPeers[0]} печатает…`
              : `${typingPeers.slice(0, 4).join(", ")} печатают…`}
          </div>
        )}

        {/* Video note recording / uploading */}
        {videoNoteRecording && recordingPreviewStream ? (
          <div className="flex items-center gap-3 border-t border-tc-border bg-tc-header px-4 py-2">
            <div className="h-12 w-12 shrink-0 overflow-hidden rounded-full border-2 border-red-500 bg-black">
              <video ref={videoNoteLiveRef} className="h-full w-full scale-x-[-1] object-cover" muted playsInline autoPlay />
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-red-400">Запись видео…</p>
              <p className="text-xs text-tc-text-muted">Отпустите для отправки</p>
            </div>
          </div>
        ) : null}
        {videoNoteUploading && !videoNoteRecording ? (
          <div className="border-t border-tc-border px-4 py-2 text-xs text-tc-accent">
            Отправка видеосообщения…
          </div>
        ) : null}
        {voiceRecording ? (
          <div className="flex items-center gap-3 border-t border-tc-border bg-tc-header px-4 py-2">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-red-500/25 text-red-400">
              <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.3 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.77 5.91-5.78.1-.6-.39-1.14-1-1.14z"/></svg>
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-red-400">Запись голоса…</p>
              <p className="text-xs text-tc-text-muted">Отпустите для отправки</p>
            </div>
          </div>
        ) : null}
        {voiceUploading && !voiceRecording ? (
          <div className="border-t border-tc-border px-4 py-2 text-xs text-tc-accent">
            Отправка голосового…
          </div>
        ) : null}

        {/* Input area */}
        {activeView === CHANNEL_VIEWS.chat ? (
        <form onSubmit={sendMessage} className="flex items-end gap-2 border-t border-tc-border bg-tc-header px-3 py-2">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain,.pdf,.txt"
            onChange={(e) => { setPendingFile(e.target.files?.[0] || null); }}
          />
          <div className="min-w-0 flex-1">
            {pendingFile && editingId == null ? (
              <div className="mb-1 flex items-center gap-2 rounded-lg bg-tc-input px-3 py-1.5 text-xs text-tc-text-sec">
                <span className="truncate">📎 {pendingFile.name}</span>
                <button
                  type="button"
                  className="shrink-0 text-tc-danger hover:underline"
                  onClick={() => { setPendingFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}
                >
                  ✕
                </button>
              </div>
            ) : null}
            <input
              className="w-full rounded-xl bg-tc-input px-4 py-2.5 text-sm text-tc-text outline-none placeholder:text-tc-text-muted"
              value={input}
              onChange={onInputChange}
              placeholder={editingId != null ? "Редактирование…" : "Сообщение"}
              maxLength={2000}
              autoComplete="off"
            />
          </div>

          <div className="relative shrink-0">
            <button
              type="button"
              disabled={editingId != null}
              title="Вложения / запись"
              className={`flex h-10 w-10 items-center justify-center rounded-full text-tc-text-sec transition hover:bg-tc-hover hover:text-tc-accent disabled:opacity-40 ${
                attachMenuOpen ? "bg-tc-hover text-tc-accent" : ""
              }`}
              onPointerDown={(e) => { e.stopPropagation(); }}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setAttachMenuOpen((v) => !v); }}
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5a2.5 2.5 0 015 0v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5a2.5 2.5 0 005 0V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>
            </button>
            {attachMenuOpen ? (
              <div
                className="absolute bottom-12 right-0 z-50 w-56 overflow-hidden rounded-xl border border-tc-border bg-tc-panel shadow-2xl"
                onPointerDown={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-4 py-3 text-sm text-tc-text-sec transition hover:bg-tc-hover hover:text-tc-accent"
                  onClick={() => { setAttachMenuOpen(false); fileInputRef.current?.click(); }}
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5a2.5 2.5 0 015 0v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5a2.5 2.5 0 005 0V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>
                  Файл
                </button>
                <button
                  type="button"
                  disabled={editingId != null || !!pendingFile || videoNoteUploading || voiceUploading || voiceRecording || (status === "online" && !roomJoined)}
                  className={`flex w-full items-center gap-3 px-4 py-3 text-sm transition ${
                    videoNoteRecording ? "bg-red-500/20 text-red-300" : "text-tc-text-sec hover:bg-tc-hover hover:text-tc-accent"
                  } disabled:opacity-50`}
                  onClick={(e) => {
                    e.preventDefault();
                    if (videoNoteRecording) {
                      setAttachMenuOpen(false);
                      void stopVideoNoteRecord();
                      return;
                    }
                    setAttachMenuOpen(false);
                    void startVideoNoteRecord();
                  }}
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>
                  {videoNoteRecording ? "Остановить видео" : "Записать видео"}
                </button>
                <button
                  type="button"
                  disabled={editingId != null || !!pendingFile || videoNoteUploading || videoNoteRecording || voiceUploading || (status === "online" && !roomJoined)}
                  className={`flex w-full items-center gap-3 px-4 py-3 text-sm transition ${
                    voiceRecording ? "bg-red-500/20 text-red-300" : "text-tc-text-sec hover:bg-tc-hover hover:text-tc-accent"
                  } disabled:opacity-50`}
                  onPointerDown={(e) => { e.preventDefault(); if (e.button !== 0) return; void startVoiceRecord(); }}
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-7 1h2v-1H5v1zm14 0h2v-1h-2v1zm-3 4.26V18c0 1.1-.9 2-2 2H8c-1.1 0-2-.9-2-2v-2.26C4.48 15.5 3 13.41 3 11h2c0 2.76 2.24 5 5 5s5-2.24 5-5h2c0 2.41-1.48 4.5-3.74 5.26z"/></svg>
                  Голос (зажмите)
                </button>
              </div>
            ) : null}
          </div>

          <button
            type="submit"
            disabled={
              status === "online" && !roomJoined
                ? true
                : editingId != null
                  ? !input.trim()
                  : !input.trim() && !pendingFile
            }
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-tc-text-sec transition hover:bg-tc-hover hover:text-tc-accent disabled:opacity-40"
          >
            <svg viewBox="0 0 24 24" className="h-6 w-6 rotate-90" fill="currentColor">
              <path d="M10 2h4v4l3 4v11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V10l3-4V2z"/>
              <rect x="9" y="12" width="6" height="1.2" rx="0.5" fill="currentColor" opacity="0.45"/>
              <rect x="9" y="14.5" width="6" height="1.2" rx="0.5" fill="currentColor" opacity="0.45"/>
            </svg>
          </button>
        </form>
        ) : null}
          </>
        )}
      </main>

      {/* DM modal */}
      {dmModalOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="dm-modal-title"
          onClick={(e) => { if (e.target === e.currentTarget) setDmModalOpen(false); }}
        >
          <div className="w-full max-w-sm rounded-xl bg-tc-panel p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 id="dm-modal-title" className="text-base font-semibold text-tc-text">Написать</h3>
              <button
                type="button"
                className="rounded-full p-1 text-tc-text-muted transition hover:bg-tc-hover hover:text-tc-text"
                onClick={() => setDmModalOpen(false)}
              >
                ✕
              </button>
            </div>
            {dmUsersLoading ? (
              <p className="py-8 text-center text-sm text-tc-text-muted">Загрузка…</p>
            ) : dmUsers.length === 0 ? (
              <p className="py-8 text-center text-sm text-tc-text-muted">Нет других пользователей</p>
            ) : (
              <ul className="max-h-72 space-y-0.5 overflow-y-auto">
                {dmUsers.map((u) => (
                  <li key={u.id}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-tc-hover"
                      onClick={() => startDmWithPeer(u.id)}
                    >
                      <span className="truncate text-sm text-tc-text">{u.nickname}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}

      {/* Room create modal (admin) */}
      {roomModalOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          onClick={(e) => { if (e.target === e.currentTarget) setRoomModalOpen(false); }}
        >
          <div className="w-full max-w-sm rounded-xl bg-tc-panel p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-semibold text-tc-text">Новая комната</h3>
              <button type="button" className="rounded-full p-1 text-tc-text-muted transition hover:bg-tc-hover hover:text-tc-text" onClick={() => setRoomModalOpen(false)}>✕</button>
            </div>
            <form onSubmit={(e) => { e.preventDefault(); createRoom(roomModalSlug, roomModalTitle); }} className="space-y-3">
              <input
                type="text"
                placeholder="slug (eng, без пробелов)"
                value={roomModalSlug}
                onChange={(e) => setRoomModalSlug(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))}
                className="w-full rounded-lg bg-tc-input px-3 py-2 text-sm text-tc-text outline-none placeholder:text-tc-text-muted focus:ring-1 focus:ring-tc-accent"
              />
              <input
                type="text"
                placeholder="Название"
                value={roomModalTitle}
                onChange={(e) => setRoomModalTitle(e.target.value)}
                className="w-full rounded-lg bg-tc-input px-3 py-2 text-sm text-tc-text outline-none placeholder:text-tc-text-muted focus:ring-1 focus:ring-tc-accent"
              />
              <button
                type="submit"
                disabled={!roomModalSlug.trim() || !roomModalTitle.trim()}
                className="w-full rounded-lg bg-tc-accent py-2 text-sm font-medium text-white transition hover:bg-tc-accent-hover disabled:opacity-40"
              >
                Создать
              </button>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
