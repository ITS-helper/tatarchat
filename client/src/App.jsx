import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const LS_TOKEN = "tatarchat_token";
const LS_NICKNAME = "tatarchat_nickname";
const LS_USER_ID = "tatarchat_user_id";
const LS_LAST_ROOM = "tatarchat_last_room";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🔥", "👎"];
/** sessionStorage: выбранный раздел и пароли комнат (не путать с паролем аккаунта) */
const SS_DTD_ROOM_PW = "tatarchat_room_pw_dreamteamdauns";

/** Видеосообщения: удерживать кнопку записи, как в Telegram (превью — квадрат) */
const VIDEO_NOTE_MAX_MS = 60_000;
const VIDEO_NOTE_MIN_MS = 450;
const VIDEO_NOTE_MIN_BYTES = 1800;

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

async function acquireVideoNoteStream() {
  const strategies = [
    () =>
      navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 720, max: 1280 },
          height: { ideal: 720, max: 1280 },
          frameRate: { ideal: 24, max: 30 },
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
  const alnum = s.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (alnum && alnum.length <= 64) return alnum;
  return "lobby";
}

function getInitialRoom() {
  return canonicalizeStoredRoom(localStorage.getItem(LS_LAST_ROOM));
}

function hasStoredDtdChannelPw() {
  return !!sessionStorage.getItem(SS_DTD_ROOM_PW);
}

function clearGateSession() {
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
  if (m.attachment?.kind === "video_note") return "Видеосообщение";
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
  if (attachment.kind === "video_note" && url) {
    return (
      <div className="mt-1.5 w-48">
        <div className="aspect-square overflow-hidden rounded-full bg-black">
          <video
            src={url}
            className="h-full w-full object-cover"
            controls
            playsInline
            preload="metadata"
            aria-label={attachment.name || "Видеосообщение"}
          />
        </div>
      </div>
    );
  }
  if (attachment.kind === "video_note" && !url) {
    return <p className="mt-1 text-xs text-tg-text-muted">Загрузка видео…</p>;
  }
  if (attachment.kind === "image" && url) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="mt-1.5 block max-h-64 overflow-hidden rounded-lg">
        <img src={url} alt={attachment.name} className="max-h-64 w-auto max-w-full rounded-lg object-contain" />
      </a>
    );
  }
  if (attachment.kind === "image" && !url) {
    return <p className="mt-1 text-xs text-tg-text-muted">Загрузка изображения…</p>;
  }
  if (!url) {
    return <p className="mt-1 text-xs text-tg-text-muted">Загрузка файла…</p>;
  }
  return (
    <a
      href={url}
      download={attachment.name}
      className="mt-1.5 inline-flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2 text-xs text-tg-link transition hover:bg-white/10"
    >
      📎 {attachment.name}
      {attachment.size != null ? <span className="text-tg-text-muted">({formatFileSize(attachment.size)})</span> : null}
    </a>
  );
}

export default function App() {
  const [token, setToken] = useState(() => getStoredToken());
  const [nickname, setNickname] = useState(() => localStorage.getItem(LS_NICKNAME) || "");
  const [authMode, setAuthMode] = useState("login");
  const [nameInput, setNameInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [dtdChannelUnlocked, setDtdChannelUnlocked] = useState(() => hasStoredDtdChannelPw());
  const [dtdPwModalDraft, setDtdPwModalDraft] = useState("");
  const [publicChannels, setPublicChannels] = useState([]);
  const [directChannels, setDirectChannels] = useState([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [dmModalOpen, setDmModalOpen] = useState(false);
  const [dmUsers, setDmUsers] = useState([]);
  const [dmUsersLoading, setDmUsersLoading] = useState(false);
  const publicChannelsRef = useRef([]);
  const [activeRoom, setActiveRoom] = useState(() => getInitialRoom());
  const [roomTitle, setRoomTitle] = useState(() => {
    const slug = getInitialRoom();
    return slug.startsWith("dm-") ? "ЛС" : slug === "lobby" ? "Лобби" : "DTD";
  });
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [myUserId, setMyUserId] = useState(() => readUserId());
  const [replyTo, setReplyTo] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [typingPeers, setTypingPeers] = useState([]);
  const [pendingFile, setPendingFile] = useState(null);
  const [videoNoteRecording, setVideoNoteRecording] = useState(false);
  const [videoNoteUploading, setVideoNoteUploading] = useState(false);
  const [recordingPreviewStream, setRecordingPreviewStream] = useState(null);
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
  const videoNoteLiveRef = useRef(null);
  const videoNoteChunksRef = useRef([]);
  const videoNoteStreamRef = useRef(null);
  const videoNoteRecorderRef = useRef(null);
  const videoNoteMaxTimerRef = useRef(null);
  const videoNoteStoppingRef = useRef(false);
  const videoNoteStartedAtRef = useRef(0);
  const stopVideoNoteRecordRef = useRef(() => {});
  const videoNoteWindowCleanRef = useRef(null);
  const replyToRef = useRef(null);
  const nicknameRef = useRef(nickname);

  useEffect(() => {
    nicknameRef.current = nickname;
  }, [nickname]);

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

  useEffect(() => {
    if (activeRoom === "dreamteamdauns") {
      setDtdChannelUnlocked(hasStoredDtdChannelPw());
      if (!hasStoredDtdChannelPw()) setBanner(null);
    } else {
      setDtdChannelUnlocked(true);
    }
  }, [activeRoom]);

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
    const need =
      row?.requiresPassword === true || (row == null && room === "dreamteamdauns");
    if (need) {
      const pw = sessionStorage.getItem(SS_DTD_ROOM_PW);
      if (pw) headers["X-Room-Password"] = pw;
    }
    return headers;
  }, [publicChannels]);

  const refreshChannels = useCallback(async () => {
    if (!token.trim()) return;
    try {
      const base = getApiBase();
      const res = await fetch(`${base}/api/channels`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setPublicChannels(data.publicChannels || []);
        setDirectChannels(data.directChannels || []);
      }
    } catch (e) {
      console.error(e);
    }
  }, [token]);

  useEffect(() => {
    if (token.trim()) refreshChannels();
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
  }, [searchInput, token, buildRoomHeaders]);

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
    if (editingId != null || pendingFile != null || videoNoteUploading) return;
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
                videoBitsPerSecond: 2_500_000,
                audioBitsPerSecond: 128_000,
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
      const onGlobalUp = () => stopVideoNoteRecordRef.current();
      window.addEventListener("pointerup", onGlobalUp, true);
      window.addEventListener("pointercancel", onGlobalUp, true);
      videoNoteWindowCleanRef.current = () => {
        window.removeEventListener("pointerup", onGlobalUp, true);
        window.removeEventListener("pointercancel", onGlobalUp, true);
      };
      videoNoteMaxTimerRef.current = setTimeout(() => {
        stopVideoNoteRecordRef.current();
      }, VIDEO_NOTE_MAX_MS);
    } catch (e) {
      console.error(e);
      setBanner("Нет доступа к камере или микрофону");
      videoNoteStreamRef.current?.getTracks().forEach((t) => t.stop());
      videoNoteStreamRef.current = null;
    }
  }, [editingId, pendingFile, videoNoteUploading]);

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
          if (room === "dreamteamdauns" && (res.status === 403 || res.status === 401)) {
            sessionStorage.removeItem(SS_DTD_ROOM_PW);
            setDtdChannelUnlocked(false);
          }
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
    [token, buildRoomHeaders]
  );

  useEffect(() => {
    if (!token) return;
    localStorage.setItem(LS_LAST_ROOM, activeRoom);
    if (activeRoom === "dreamteamdauns" && !sessionStorage.getItem(SS_DTD_ROOM_PW)) {
      setMessages([]);
      setBanner(null);
      return;
    }
    loadHistoryForRoom(activeRoom);
  }, [token, activeRoom, loadHistoryForRoom]);

  const emitJoinRoom = useCallback((socket) => {
    const r = activeRoomRef.current;
    if (r === "dreamteamdauns" && !sessionStorage.getItem(SS_DTD_ROOM_PW)) {
      setRoomJoined(false);
      roomJoinedRef.current = false;
      return;
    }
    const gen = ++joinGenRef.current;
    const row = publicChannelsRef.current.find((c) => c.slug === r);
    const need =
      row?.requiresPassword === true || (row == null && r === "dreamteamdauns");
    const pw = need ? sessionStorage.getItem(SS_DTD_ROOM_PW) || "" : "";
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
        if (r === "dreamteamdauns" && need) {
          sessionStorage.removeItem(SS_DTD_ROOM_PW);
          setDtdChannelUnlocked(false);
        }
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

  const submitDtdChannelPassword = (e) => {
    e.preventDefault();
    setBanner(null);
    const p = dtdPwModalDraft.trim();
    if (!p) {
      setBanner("Введите пароль канала");
      return;
    }
    sessionStorage.setItem(SS_DTD_ROOM_PW, p);
    setDtdPwModalDraft("");
    setDtdChannelUnlocked(true);
    const room = activeRoomRef.current;
    void loadHistoryForRoom(room);
    const sock = socketRef.current;
    if (sock?.connected) emitJoinRoom(sock);
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
    setDtdChannelUnlocked(false);
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
    setPublicChannels([]);
    setDirectChannels([]);
    setActiveRoom("lobby");
    setRoomTitle("Лобби");
    setStatus("offline");
    setRoomJoined(false);
    roomJoinedRef.current = false;
  };

  const selectChannel = (slug) => {
    setBanner(null);
    setActiveRoom(slug);
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
      <div className="flex min-h-full items-center justify-center bg-tg-bg p-4">
        <div className="w-full max-w-sm rounded-xl bg-tg-panel p-8 shadow-xl">
          <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-tg-accent/20">
            <svg viewBox="0 0 24 24" className="h-10 w-10 text-tg-accent" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
            </svg>
          </div>
          <h1 className="mb-1 text-center text-2xl font-bold text-tg-text">TatarChat</h1>
          <p className="mb-6 text-center text-sm text-tg-text-sec">
            Вход по имени и паролю. Новый пользователь — регистрация.
          </p>

          <div className="mb-5 flex overflow-hidden rounded-lg bg-tg-bg">
            <button
              type="button"
              onClick={() => { setAuthMode("login"); setBanner(null); }}
              className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                authMode === "login"
                  ? "bg-tg-accent text-white"
                  : "text-tg-text-sec hover:text-tg-text"
              }`}
            >
              Вход
            </button>
            <button
              type="button"
              onClick={() => { setAuthMode("register"); setBanner(null); }}
              className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                authMode === "register"
                  ? "bg-tg-accent text-white"
                  : "text-tg-text-sec hover:text-tg-text"
              }`}
            >
              Регистрация
            </button>
          </div>

          <form onSubmit={submitAuth} className="space-y-4">
            <div>
              <input
                type="text"
                className="w-full rounded-lg border border-tg-border bg-tg-input px-4 py-3 text-sm text-tg-text outline-none transition placeholder:text-tg-text-muted focus:border-tg-accent"
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
                className="w-full rounded-lg border border-tg-border bg-tg-input px-4 py-3 text-sm text-tg-text outline-none transition placeholder:text-tg-text-muted focus:border-tg-accent"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                placeholder={authMode === "register" ? "Пароль (от 6 символов)" : "Пароль"}
                maxLength={128}
                autoComplete={authMode === "register" ? "new-password" : "current-password"}
              />
            </div>
            {banner && (
              <p className="rounded-lg bg-tg-danger/15 px-4 py-2.5 text-sm text-tg-danger">
                {banner}
              </p>
            )}
            <button
              type="submit"
              className="w-full rounded-lg bg-tg-accent py-3 text-sm font-semibold text-white transition hover:bg-tg-accent/85 active:scale-[0.98]"
            >
              {authMode === "register" ? "Зарегистрироваться" : "Войти"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden bg-tg-bg">
      {/* Sidebar */}
      <aside
        className={`${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        } fixed inset-y-0 left-0 z-40 flex w-72 flex-col bg-tg-sidebar transition-transform duration-200 md:static md:translate-x-0`}
      >
        <div className="flex items-center justify-between px-4 py-3">
          <h2 className="text-base font-semibold text-tg-text">Чаты</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => openDmModal()}
              className="rounded-full p-1.5 text-tg-text-sec transition hover:bg-tg-hover"
              title="Написать"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1.003 1.003 0 000-1.42l-2.34-2.33a1.003 1.003 0 00-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.83z"/></svg>
            </button>
            <button
              type="button"
              className="rounded-full p-1.5 text-tg-text-sec transition hover:bg-tg-hover md:hidden"
              onClick={() => setSidebarOpen(false)}
            >
              ✕
            </button>
          </div>
        </div>

        <div className="px-3 pb-2">
          <input
            type="search"
            className="w-full rounded-lg bg-tg-input px-3 py-2 text-sm text-tg-text outline-none placeholder:text-tg-text-muted"
            placeholder="Поиск"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          {searchInput.trim() && searchResults.length > 0 ? (
            <div className="mt-1 max-h-40 overflow-y-auto rounded-lg bg-tg-panel">
              {searchResults.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className="block w-full truncate px-3 py-2 text-left text-sm text-tg-text-sec transition hover:bg-tg-hover"
                  onClick={() => {
                    const el = document.querySelector(`[data-message-id="${r.id}"]`);
                    el?.scrollIntoView({ behavior: "smooth", block: "center" });
                    setSearchInput("");
                    setSidebarOpen(false);
                  }}
                >
                  <span className="font-medium text-tg-accent">{r.user_nick}</span>{" "}
                  <span className="text-tg-text-muted">
                    {r.deleted
                      ? "удалено"
                      : (r.text || "").trim().slice(0, 60) ||
                        (r.attachment?.kind === "video_note"
                          ? "Видео"
                          : r.attachment
                            ? `📎 ${r.attachment.name}`
                            : "—")}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <nav className="sidebar-scroll flex-1 overflow-y-auto">
          {publicChannels.map((r) => (
            <button
              key={r.slug}
              type="button"
              onClick={() => { selectChannel(r.slug); setSidebarOpen(false); }}
              className={`flex w-full items-center gap-3 px-4 py-3 transition ${
                activeRoom === r.slug ? "bg-tg-accent/20" : "hover:bg-tg-hover"
              }`}
            >
              <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white ${
                r.slug === "lobby" ? "bg-blue-600" : r.slug === "dreamteamdauns" ? "bg-purple-600" : "bg-teal-600"
              }`}>
                {r.title?.[0]?.toUpperCase() || "#"}
              </div>
              <div className="min-w-0 flex-1 text-left">
                <div className="flex items-center justify-between">
                  <span className={`truncate text-sm font-medium ${activeRoom === r.slug ? "text-tg-accent" : "text-tg-text"}`}>
                    {r.title}
                  </span>
                  {r.requiresPassword ? (
                    <span className="ml-1 text-[10px] text-tg-text-muted">🔒</span>
                  ) : null}
                </div>
                <p className="truncate text-xs text-tg-text-muted">Канал</p>
              </div>
            </button>
          ))}
          {directChannels.length > 0 && (
            <div className="px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-tg-text-muted">
              Личные
            </div>
          )}
          {directChannels.map((r) => (
            <button
              key={r.slug}
              type="button"
              onClick={() => { selectChannel(r.slug); setSidebarOpen(false); }}
              className={`flex w-full items-center gap-3 px-4 py-3 transition ${
                activeRoom === r.slug ? "bg-tg-accent/20" : "hover:bg-tg-hover"
              }`}
            >
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-orange-600 text-sm font-semibold text-white">
                {r.peer?.nickname?.[0]?.toUpperCase() || "?"}
              </div>
              <div className="min-w-0 flex-1 text-left">
                <span className={`block truncate text-sm font-medium ${activeRoom === r.slug ? "text-tg-accent" : "text-tg-text"}`}>
                  {r.peer?.nickname || r.title}
                </span>
                <p className="truncate text-xs text-tg-text-muted">Личное сообщение</p>
              </div>
            </button>
          ))}
        </nav>

        <div className="border-t border-tg-border p-3">
          <button
            type="button"
            onClick={handleLogout}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-tg-danger transition hover:bg-tg-danger/10"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor"><path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5-5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z"/></svg>
            Выйти
          </button>
        </div>
      </aside>

      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Main area */}
      <main className="flex min-w-0 flex-1 flex-col">
        {/* DTD password modal */}
        {activeRoom === "dreamteamdauns" && !dtdChannelUnlocked ? (
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dtd-pw-title"
          >
            <div className="w-full max-w-sm rounded-xl bg-tg-panel p-6 shadow-xl">
              <h2 id="dtd-pw-title" className="mb-2 text-lg font-semibold text-tg-text">
                🔒 Пароль канала
              </h2>
              <p className="mb-4 text-sm text-tg-text-sec">
                Канал DTD защищён паролем.
              </p>
              <form onSubmit={submitDtdChannelPassword} className="space-y-4">
                <input
                  type="password"
                  className="w-full rounded-lg border border-tg-border bg-tg-input px-4 py-3 text-sm text-tg-text outline-none placeholder:text-tg-text-muted focus:border-tg-accent"
                  value={dtdPwModalDraft}
                  onChange={(e) => setDtdPwModalDraft(e.target.value)}
                  placeholder="Пароль"
                  maxLength={128}
                  autoComplete="off"
                  autoFocus
                />
                {banner && (
                  <p className="rounded-lg bg-tg-danger/15 px-4 py-2.5 text-sm text-tg-danger">{banner}</p>
                )}
                <button
                  type="submit"
                  className="w-full rounded-lg bg-tg-accent py-3 text-sm font-semibold text-white transition hover:bg-tg-accent/85"
                >
                  Войти
                </button>
              </form>
            </div>
          </div>
        ) : null}

        {/* Chat header */}
        <header className="flex h-14 flex-shrink-0 items-center gap-3 border-b border-tg-border bg-tg-header px-4">
          <button
            type="button"
            className="rounded-full p-1.5 text-tg-text-sec transition hover:bg-tg-hover md:hidden"
            onClick={() => setSidebarOpen(true)}
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold text-tg-text">{roomTitle}</h2>
            <div className="flex items-center gap-2 text-xs text-tg-text-muted">
              <span className={`inline-block h-2 w-2 rounded-full ${status === "online" ? "bg-tg-online" : "bg-tg-text-muted"}`} />
              {status === "online" ? "подключено" : "нет связи"}
              <span className="text-tg-text-muted">·</span>
              <span className="truncate">{nickname}</span>
            </div>
          </div>
        </header>

        {/* Banner */}
        {banner && !(activeRoom === "dreamteamdauns" && !dtdChannelUnlocked) && (
          <div className="bg-tg-danger/15 px-4 py-2 text-sm text-tg-danger">{banner}</div>
        )}

        {/* Messages */}
        <div
          ref={listRef}
          className="messages-scroll flex-1 overflow-y-auto px-4 py-3"
        >
          {messages.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-tg-text-muted">Нет сообщений</p>
            </div>
          ) : (
            <div className="mx-auto max-w-2xl space-y-1">
              {messages.map((m, i) => {
                const key = m.id != null ? m.id : `leg-${i}-${m.time}-${m.user_nick}`;
                const mine = myUserId != null && m.user_id === myUserId;
                const deleted = !!m.deleted;
                return (
                  <div
                    key={key}
                    data-message-id={m.id != null ? m.id : undefined}
                    className={`flex ${mine ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`group relative max-w-[85%] rounded-xl px-3 py-2 sm:max-w-[70%] ${
                        mine
                          ? "rounded-br-sm bg-tg-msg-own"
                          : "rounded-bl-sm bg-tg-msg"
                      }`}
                    >
                      {!mine && (
                        <p className="mb-0.5 text-[13px] font-semibold text-tg-accent">{m.user_nick}</p>
                      )}
                      {m.reply_to && (
                        <div className="mb-1.5 rounded-md border-l-2 border-tg-accent bg-white/5 py-1 pl-2 pr-2">
                          <p className="text-xs font-medium text-tg-accent">{m.reply_to.user_nick}</p>
                          {m.reply_to.deleted ? (
                            <p className="text-xs italic text-tg-text-muted">удалено</p>
                          ) : (
                            <p className="truncate text-xs text-tg-text-sec">
                              {m.reply_to.preview?.trim() || "📎 файл"}
                            </p>
                          )}
                        </div>
                      )}
                      {deleted ? (
                        <p className="text-sm italic text-tg-text-muted">Сообщение удалено</p>
                      ) : (
                        <>
                          {(m.text || "").trim() ? (
                            <p className="whitespace-pre-wrap break-words text-sm text-tg-text">{m.text}</p>
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
                                onClick={() => m.id != null && toggleReaction(m.id, r.emoji)}
                                className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs transition ${
                                  me
                                    ? "bg-tg-accent/25 text-tg-accent"
                                    : "bg-white/5 text-tg-text-sec hover:bg-white/10"
                                }`}
                              >
                                {r.emoji}
                                <span className="text-[10px]">{r.count}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                      {/* Actions on hover */}
                      <div className="absolute -top-7 right-1 hidden rounded-lg bg-tg-panel px-1 py-0.5 shadow-lg group-hover:flex">
                        {QUICK_REACTIONS.map((em) => (
                          <button
                            key={em}
                            type="button"
                            disabled={deleted || m.id == null}
                            onClick={() => m.id != null && toggleReaction(m.id, em)}
                            className="px-1 text-sm transition hover:scale-125 disabled:opacity-30"
                          >
                            {em}
                          </button>
                        ))}
                        {!deleted && m.id != null && (
                          <button
                            type="button"
                            onClick={() => {
                              setReplyTo({ id: m.id, user_nick: m.user_nick, preview: messagePreviewForReply(m) });
                              setEditingId(null);
                            }}
                            className="px-1 text-sm text-tg-text-sec transition hover:text-tg-accent"
                            title="Ответить"
                          >
                            ↩
                          </button>
                        )}
                        {!mine && !deleted && m.user_id != null && myUserId != null && (
                          <button
                            type="button"
                            onClick={() => startDmWithPeer(m.user_id)}
                            className="px-1 text-sm text-tg-text-sec transition hover:text-tg-accent"
                            title="В ЛС"
                          >
                            ✉
                          </button>
                        )}
                        {mine && !deleted && m.id != null && (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingId(m.id);
                                setInput(m.text || "");
                                setReplyTo(null);
                                setPendingFile(null);
                                if (fileInputRef.current) fileInputRef.current.value = "";
                              }}
                              className="px-1 text-sm text-tg-text-sec transition hover:text-tg-accent"
                              title="Изменить"
                            >
                              ✏
                            </button>
                            <button
                              type="button"
                              onClick={() => deleteMessage(m.id)}
                              className="px-1 text-sm text-tg-text-sec transition hover:text-tg-danger"
                              title="Удалить"
                            >
                              🗑
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Reply / Edit bar */}
        {(replyTo || editingId != null) && (
          <div className="flex items-center gap-3 border-t border-tg-border bg-tg-header px-4 py-2">
            <div className="h-8 w-0.5 rounded-full bg-tg-accent" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-tg-accent">
                {editingId != null ? "Редактирование" : `Ответ для ${replyTo?.user_nick}`}
              </p>
              <p className="truncate text-xs text-tg-text-sec">
                {editingId != null ? input.slice(0, 80) : replyTo?.preview || ""}
              </p>
            </div>
            <button
              type="button"
              className="shrink-0 rounded-full p-1 text-tg-text-muted transition hover:bg-tg-hover hover:text-tg-text"
              onClick={() => { setReplyTo(null); setEditingId(null); setInput(""); }}
            >
              ✕
            </button>
          </div>
        )}

        {/* Typing indicator */}
        {typingPeers.length > 0 && (
          <div className="border-t border-tg-border px-4 py-1.5 text-xs text-tg-accent">
            {typingPeers.length === 1
              ? `${typingPeers[0]} печатает…`
              : `${typingPeers.slice(0, 4).join(", ")} печатают…`}
          </div>
        )}

        {/* Video note recording / uploading */}
        {videoNoteRecording && recordingPreviewStream ? (
          <div className="flex items-center gap-3 border-t border-tg-border bg-tg-header px-4 py-2">
            <div className="h-12 w-12 shrink-0 overflow-hidden rounded-full border-2 border-red-500 bg-black">
              <video ref={videoNoteLiveRef} className="h-full w-full scale-x-[-1] object-cover" muted playsInline autoPlay />
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-red-400">Запись видео…</p>
              <p className="text-xs text-tg-text-muted">Отпустите для отправки</p>
            </div>
          </div>
        ) : null}
        {videoNoteUploading && !videoNoteRecording ? (
          <div className="border-t border-tg-border px-4 py-2 text-xs text-tg-accent">
            Отправка видеосообщения…
          </div>
        ) : null}

        {/* Input area */}
        <form onSubmit={sendMessage} className="flex items-end gap-2 border-t border-tg-border bg-tg-header px-3 py-2">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain,.pdf,.txt"
            onChange={(e) => { setPendingFile(e.target.files?.[0] || null); }}
          />
          <button
            type="button"
            disabled={editingId != null}
            title="Прикрепить файл"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-tg-text-sec transition hover:bg-tg-hover hover:text-tg-accent disabled:opacity-40"
            onClick={() => fileInputRef.current?.click()}
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5a2.5 2.5 0 015 0v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5a2.5 2.5 0 005 0V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>
          </button>

          <div className="min-w-0 flex-1">
            {pendingFile && editingId == null ? (
              <div className="mb-1 flex items-center gap-2 rounded-lg bg-tg-input px-3 py-1.5 text-xs text-tg-text-sec">
                <span className="truncate">📎 {pendingFile.name}</span>
                <button
                  type="button"
                  className="shrink-0 text-tg-danger hover:underline"
                  onClick={() => { setPendingFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}
                >
                  ✕
                </button>
              </div>
            ) : null}
            <input
              className="w-full rounded-xl bg-tg-input px-4 py-2.5 text-sm text-tg-text outline-none placeholder:text-tg-text-muted"
              value={input}
              onChange={onInputChange}
              placeholder={editingId != null ? "Редактирование…" : "Сообщение"}
              maxLength={2000}
              autoComplete="off"
            />
          </div>

          <button
            type="button"
            disabled={editingId != null || !!pendingFile || videoNoteUploading || (status === "online" && !roomJoined)}
            title="Видеосообщение (зажмите)"
            className={`flex h-10 w-10 shrink-0 touch-none select-none items-center justify-center rounded-full transition disabled:opacity-40 ${
              videoNoteRecording
                ? "animate-pulse bg-red-500 text-white"
                : "text-tg-text-sec hover:bg-tg-hover hover:text-tg-accent"
            }`}
            onPointerDown={(e) => { e.preventDefault(); if (e.button !== 0) return; void startVideoNoteRecord(); }}
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>
          </button>

          <button
            type="submit"
            disabled={
              status === "online" && !roomJoined
                ? true
                : editingId != null
                  ? !input.trim()
                  : !input.trim() && !pendingFile
            }
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-tg-accent text-white transition hover:bg-tg-accent/85 disabled:opacity-40"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </button>
        </form>
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
          <div className="w-full max-w-sm rounded-xl bg-tg-panel p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 id="dm-modal-title" className="text-base font-semibold text-tg-text">Написать</h3>
              <button
                type="button"
                className="rounded-full p-1 text-tg-text-muted transition hover:bg-tg-hover hover:text-tg-text"
                onClick={() => setDmModalOpen(false)}
              >
                ✕
              </button>
            </div>
            {dmUsersLoading ? (
              <p className="py-8 text-center text-sm text-tg-text-muted">Загрузка…</p>
            ) : dmUsers.length === 0 ? (
              <p className="py-8 text-center text-sm text-tg-text-muted">Нет других пользователей</p>
            ) : (
              <ul className="max-h-72 space-y-0.5 overflow-y-auto">
                {dmUsers.map((u) => (
                  <li key={u.id}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-tg-hover"
                      onClick={() => startDmWithPeer(u.id)}
                    >
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-orange-600 text-sm font-semibold text-white">
                        {u.nickname?.[0]?.toUpperCase() || "?"}
                      </div>
                      <span className="truncate text-sm text-tg-text">{u.nickname}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
