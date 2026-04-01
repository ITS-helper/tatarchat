import { useCallback, useEffect, useMemo, useState } from "react";

const MONTH_NAMES = [
  "Январь",
  "Февраль",
  "Март",
  "Апрель",
  "Май",
  "Июнь",
  "Июль",
  "Август",
  "Сентябрь",
  "Октябрь",
  "Ноябрь",
  "Декабрь",
];

function pad2(n) {
  return String(n).padStart(2, "0");
}

function localDateKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseLocalDateKey(key) {
  const [y, m, day] = key.split("-").map((x) => parseInt(x, 10));
  if (!y || !m || !day) return null;
  return new Date(y, m - 1, day);
}

/** Понедельник = 0 … воскресенье = 6 */
function mondayIndex(y, m) {
  const wd = new Date(y, m, 1).getDay();
  return (wd + 6) % 7;
}

function monthRangeISO(y, m) {
  const from = new Date(y, m, 1, 0, 0, 0, 0);
  const to = new Date(y, m + 1, 0, 23, 59, 59, 999);
  return { from: from.toISOString(), to: to.toISOString() };
}

function buildMonthTabs(centerY, centerM) {
  const out = [];
  const base = new Date(centerY, centerM, 1);
  for (let i = -6; i <= 8; i++) {
    const d = new Date(base.getFullYear(), base.getMonth() + i, 1);
    out.push({ y: d.getFullYear(), m: d.getMonth() });
  }
  return out;
}

function formatEventTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function formatMarqueeLine(ev) {
  const d = new Date(ev.startsAt);
  const dateStr = d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
  const t = formatEventTime(ev.startsAt);
  return `${dateStr}, ${t} — ${ev.title}`;
}

export default function CalendarView({ getApiBase, token, getAuthHeaders, room, onError, currentUserId, isAdmin }) {
  const bareHeaders = useMemo(() => {
    return typeof getAuthHeaders === "function" ? getAuthHeaders() : { Authorization: `Bearer ${token}` };
  }, [getAuthHeaders, token]);
  const jsonHeaders = useMemo(
    () => ({ ...bareHeaders, "Content-Type": "application/json" }),
    [bareHeaders]
  );

  const now = new Date();
  const [viewY, setViewY] = useState(now.getFullYear());
  const [viewM, setViewM] = useState(now.getMonth());
  const [events, setEvents] = useState([]);
  const [upcoming, setUpcoming] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dayKey, setDayKey] = useState(null);
  const [newTitle, setNewTitle] = useState("");
  const [newTime, setNewTime] = useState("12:00");
  const [newNotes, setNewNotes] = useState("");
  const [saving, setSaving] = useState(false);

  /** Вкладки не перестраиваются от выбранного месяца — только от смены канала */
  const monthTabs = useMemo(() => {
    const d = new Date();
    return buildMonthTabs(d.getFullYear(), d.getMonth());
  }, [room]);

  useEffect(() => {
    const d = new Date();
    setViewY(d.getFullYear());
    setViewM(d.getMonth());
    setDayKey(null);
  }, [room]);

  const loadMonth = useCallback(async () => {
    if (!token || !room) return;
    setLoading(true);
    try {
      const { from, to } = monthRangeISO(viewY, viewM);
      const q = new URLSearchParams({ room, from, to });
      const res = await fetch(`${getApiBase()}/api/calendar/events?${q}`, { headers: bareHeaders });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "Не удалось загрузить календарь");
      }
      const data = await res.json();
      setEvents(Array.isArray(data.events) ? data.events : []);
    } catch (e) {
      onError?.(e.message || "Ошибка календаря");
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [token, room, viewY, viewM, getApiBase, bareHeaders, onError]);

  const loadUpcoming = useCallback(async () => {
    if (!token || !room) return;
    try {
      const q = new URLSearchParams({ room, limit: "14" });
      const res = await fetch(`${getApiBase()}/api/calendar/upcoming?${q}`, { headers: bareHeaders });
      if (!res.ok) return;
      const data = await res.json();
      setUpcoming(Array.isArray(data.events) ? data.events : []);
    } catch {
      setUpcoming([]);
    }
  }, [token, room, getApiBase, bareHeaders]);

  useEffect(() => {
    loadMonth();
  }, [loadMonth]);

  useEffect(() => {
    loadUpcoming();
  }, [loadUpcoming]);

  const eventsByDay = useMemo(() => {
    const map = new Map();
    for (const ev of events) {
      const start = new Date(ev.startsAt);
      const end = ev.endsAt ? new Date(ev.endsAt) : start;
      const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
      while (cursor <= last) {
        const key = localDateKey(cursor);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(ev);
        cursor.setDate(cursor.getDate() + 1);
      }
    }
    for (const [, list] of map) {
      list.sort((a, b) => +new Date(a.startsAt) - +new Date(b.startsAt));
    }
    return map;
  }, [events]);

  const daysInMonth = new Date(viewY, viewM + 1, 0).getDate();
  const lead = mondayIndex(viewY, viewM);
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push({ type: "pad" });
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ type: "day", d });
  }
  while (cells.length % 7 !== 0) cells.push({ type: "pad" });
  while (cells.length < 42) cells.push({ type: "pad" });

  const todayKey = localDateKey(new Date());

  const openDay = (d) => {
    setDayKey(`${viewY}-${pad2(viewM + 1)}-${pad2(d)}`);
    setNewTitle("");
    setNewTime("12:00");
    setNewNotes("");
  };

  const closeDay = () => setDayKey(null);

  const refreshAll = () => {
    loadMonth();
    loadUpcoming();
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!dayKey || !newTitle.trim()) return;
    const base = parseLocalDateKey(dayKey);
    if (!base) return;
    const [hh, mm] = (newTime || "12:00").split(":").map((x) => parseInt(x, 10));
    const startsAt = new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate(),
      Number.isFinite(hh) ? hh : 12,
      Number.isFinite(mm) ? mm : 0,
      0,
      0
    );
    setSaving(true);
    try {
      const res = await fetch(`${getApiBase()}/api/calendar/events`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          room,
          title: newTitle.trim(),
          notes: newNotes.trim() || null,
          startsAt: startsAt.toISOString(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Не сохранилось");
      setNewTitle("");
      setNewNotes("");
      refreshAll();
    } catch (err) {
      onError?.(err.message || "Ошибка");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    try {
      const res = await fetch(`${getApiBase()}/api/calendar/events/${id}`, {
        method: "DELETE",
        headers: bareHeaders,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Не удалось удалить");
      refreshAll();
    } catch (err) {
      onError?.(err.message || "Ошибка");
    }
  };

  const dayModalEvents = dayKey ? eventsByDay.get(dayKey) || [] : [];
  const dayModalLabel = dayKey
    ? (() => {
        const dt = parseLocalDateKey(dayKey);
        return dt
          ? dt.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" })
          : dayKey;
      })()
    : "";

  const marqueeText =
    upcoming.length === 0
      ? "Нет предстоящих событий в этом канале"
      : upcoming.map(formatMarqueeLine).join("   •   ");

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {/* Бегущая строка: ближайшие события */}
      <div className="tc-calendar-marquee shrink-0 border-b border-tc-border bg-tc-header/80 py-2">
        <div className="tc-calendar-marquee-track text-sm text-tc-text-sec">
          <span className="pr-12">{marqueeText}</span>
          <span className="pr-12" aria-hidden>
            {marqueeText}
          </span>
        </div>
      </div>

      {/* Вкладки месяцев */}
      <div className="shrink-0 border-b border-tc-border bg-tc-panel/40 px-2 py-2">
        <div className="flex gap-1 overflow-x-auto pb-1 scrollbar-thin">
          {monthTabs.map(({ y, m }) => {
            const active = y === viewY && m === viewM;
            return (
              <button
                key={`${y}-${m}`}
                type="button"
                onClick={() => {
                  setViewY(y);
                  setViewM(m);
                }}
                className={`shrink-0 rounded-lg px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? "bg-tc-accent/20 font-medium text-tc-accent"
                    : "text-tc-text-muted hover:bg-tc-hover hover:text-tc-text"
                }`}
              >
                {MONTH_NAMES[m]} {y}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {loading ? (
          <div className="flex h-40 items-center justify-center text-sm text-tc-text-muted">Загрузка…</div>
        ) : (
          <>
            <div className="mb-2 text-center text-sm font-medium text-tc-text-sec">
              {MONTH_NAMES[viewM]} {viewY}
            </div>
            <div className="mx-auto grid max-w-3xl grid-cols-7 gap-1 text-xs text-tc-text-muted sm:text-sm">
              {["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((w) => (
                <div key={w} className="py-1 text-center font-medium">
                  {w}
                </div>
              ))}
              {cells.map((cell, idx) => {
                if (cell.type === "pad") {
                  return <div key={`p-${idx}`} className="aspect-square rounded-lg bg-transparent" />;
                }
                const { d } = cell;
                const key = `${viewY}-${pad2(viewM + 1)}-${pad2(d)}`;
                const isToday = key === todayKey;
                const dayEvents = eventsByDay.get(key) || [];
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => openDay(d)}
                    className={`flex aspect-square flex-col items-center justify-start rounded-lg border p-1 transition-colors sm:p-1.5 ${
                      isToday
                        ? "border-tc-accent/60 bg-tc-accent/10 text-tc-text"
                        : "border-tc-border/60 bg-tc-panel/30 hover:border-tc-accent/40 hover:bg-tc-hover"
                    }`}
                  >
                    <span className={`text-sm font-medium ${isToday ? "text-tc-accent" : ""}`}>{d}</span>
                    <div className="mt-0.5 flex w-full flex-col gap-0.5 overflow-hidden">
                      {dayEvents.slice(0, 3).map((ev) => (
                        <span
                          key={ev.id}
                          className="truncate rounded bg-tc-asphalt/90 px-0.5 text-[10px] leading-tight text-tc-text-sec sm:text-[11px]"
                          title={ev.title}
                        >
                          {ev.title}
                        </span>
                      ))}
                      {dayEvents.length > 3 ? (
                        <span className="text-[10px] text-tc-text-muted">+{dayEvents.length - 3}</span>
                      ) : null}
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      {dayKey ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cal-day-title"
          onClick={closeDay}
        >
          <div
            className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl border border-tc-border bg-tc-panel p-4 shadow-xl"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2">
              <h3 id="cal-day-title" className="text-base font-semibold capitalize text-tc-text">
                {dayModalLabel}
              </h3>
              <button
                type="button"
                onClick={closeDay}
                className="rounded-lg px-2 py-1 text-tc-text-muted hover:bg-tc-hover hover:text-tc-text"
              >
                ✕
              </button>
            </div>

            <ul className="mt-3 space-y-2 border-b border-tc-border pb-3">
              {dayModalEvents.length === 0 ? (
                <li className="text-sm text-tc-text-muted">Событий нет</li>
              ) : (
                dayModalEvents.map((ev) => (
                  <li
                    key={ev.id}
                    className="flex items-start justify-between gap-2 rounded-lg bg-tc-input/50 px-3 py-2 text-sm"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-tc-text">{ev.title}</div>
                      <div className="text-xs text-tc-text-muted">
                        {formatEventTime(ev.startsAt)}
                        {ev.creatorNickname ? ` · ${ev.creatorNickname}` : ""}
                      </div>
                      {ev.notes ? <p className="mt-1 text-xs text-tc-text-sec">{ev.notes}</p> : null}
                    </div>
                    {currentUserId != null && (ev.userId === currentUserId || isAdmin) ? (
                      <button
                        type="button"
                        onClick={() => handleDelete(ev.id)}
                        className="shrink-0 text-xs text-tc-danger hover:underline"
                      >
                        Удалить
                      </button>
                    ) : null}
                  </li>
                ))
              )}
            </ul>

            <form className="mt-4 space-y-3" onSubmit={handleCreate}>
              <div>
                <label className="block text-xs text-tc-text-muted">Событие</label>
                <input
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-tc-border bg-tc-input px-3 py-2 text-sm text-tc-text outline-none focus:border-tc-accent"
                  placeholder="Название"
                  maxLength={240}
                  required
                />
              </div>
              <div>
                <label className="block text-xs text-tc-text-muted">Время</label>
                <input
                  type="time"
                  value={newTime}
                  onChange={(e) => setNewTime(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-tc-border bg-tc-input px-3 py-2 text-sm text-tc-text outline-none focus:border-tc-accent"
                />
              </div>
              <div>
                <label className="block text-xs text-tc-text-muted">Заметка (необязательно)</label>
                <textarea
                  value={newNotes}
                  onChange={(e) => setNewNotes(e.target.value)}
                  rows={2}
                  className="mt-1 w-full resize-none rounded-lg border border-tc-border bg-tc-input px-3 py-2 text-sm text-tc-text outline-none focus:border-tc-accent"
                />
              </div>
              <button
                type="submit"
                disabled={saving || !newTitle.trim()}
                className="w-full rounded-xl bg-tc-accent py-2.5 text-sm font-medium text-tc-bg hover:bg-tc-accent-hover disabled:opacity-50"
              >
                {saving ? "Сохранение…" : "Добавить"}
              </button>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
