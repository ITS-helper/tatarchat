import { useCallback, useEffect, useMemo, useState } from "react";

const SORT_OPTIONS = [
  { value: "created_desc", label: "Сначала новые" },
  { value: "created_asc", label: "Сначала старые" },
  { value: "name_asc", label: "Имя А→Я" },
  { value: "name_desc", label: "Имя Я→А" },
  { value: "manual", label: "Свой порядок" },
];

function GalleryThumb({ itemId, getApiBase, authHeaders, className, alt }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let blobUrl = null;
    let cancelled = false;
    setFailed(false);
    setUrl(null);
    (async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/gallery/file/${itemId}`, {
          headers: authHeaders,
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
        blobUrl = URL.createObjectURL(blob);
        setUrl(blobUrl);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [itemId, getApiBase, authHeaders]);
  if (failed) {
    return (
      <div
        className={`flex items-center justify-center bg-tc-asphalt/80 text-[10px] text-tc-text-muted ${className || ""}`}
        title="Файл не найден на сервере или нет доступа"
      >
        нет файла
      </div>
    );
  }
  if (!url) {
    return (
      <div className={`animate-pulse bg-tc-asphalt/60 ${className || ""}`} aria-hidden />
    );
  }
  return <img src={url} alt={alt || ""} className={className} loading="lazy" />;
}

export default function GalleryView({ getApiBase, token, onError }) {
  const authHeaders = useMemo(
    () => ({ Authorization: `Bearer ${token}` }),
    [token]
  );
  const [sort, setSort] = useState("created_desc");
  const [stack, setStack] = useState([{ id: null, name: "Галерея" }]);
  const [folders, setFolders] = useState([]);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [folderModal, setFolderModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [moveItem, setMoveItem] = useState(null);
  const [allFolders, setAllFolders] = useState([]);
  const [lightbox, setLightbox] = useState(null);
  const [dragId, setDragId] = useState(null);

  const current = stack[stack.length - 1];
  const folderId = current.id;

  const load = useCallback(async () => {
    setLoading(true);
    onError?.(null);
    try {
      const base = getApiBase();
      const h = authHeaders;
      const parentQ =
        folderId == null ? "" : `?parentId=${encodeURIComponent(String(folderId))}`;
      const itemQ =
        folderId == null ? "" : `?folderId=${encodeURIComponent(String(folderId))}`;
      const [fr, ir, ar] = await Promise.all([
        fetch(`${base}/api/gallery/folders${parentQ}`, { headers: h }),
        fetch(
          `${base}/api/gallery/items${itemQ ? `${itemQ}&` : "?"}sort=${encodeURIComponent(sort)}`,
          { headers: h }
        ),
        fetch(`${base}/api/gallery/folders-all`, { headers: h }),
      ]);
      const fd = await fr.json().catch(() => ({}));
      const id = await ir.json().catch(() => ({}));
      const ad = await ar.json().catch(() => ({}));
      if (!fr.ok) {
        onError?.(fd.error || "Папки");
        setFolders([]);
        setItems([]);
        return;
      }
      if (!ir.ok) {
        onError?.(id.error || "Фото");
        setFolders(fd.folders || []);
        setItems([]);
        return;
      }
      setFolders(fd.folders || []);
      setItems(id.items || []);
      if (ar.ok) setAllFolders(ad.folders || []);
    } catch {
      onError?.("Сеть: галерея");
    } finally {
      setLoading(false);
    }
  }, [folderId, sort, getApiBase, authHeaders, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const openFolder = (f) => {
    setStack((s) => [...s, { id: f.id, name: f.name }]);
  };

  const crumbClick = (index) => {
    setStack((s) => s.slice(0, index + 1));
  };

  const createFolder = async (e) => {
    e.preventDefault();
    const name = newFolderName.trim();
    if (!name) return;
    try {
      const base = getApiBase();
      const res = await fetch(`${base}/api/gallery/folders`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ name, parentId: folderId ?? "" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError?.(data.error || "Не создать папку");
        return;
      }
      setFolderModal(false);
      setNewFolderName("");
      onError?.(null);
      await load();
    } catch {
      onError?.("Сеть");
    }
  };

  const deleteFolder = async (f) => {
    if (!window.confirm(`Удалить папку «${f.name}» и всё внутри?`)) return;
    try {
      const base = getApiBase();
      const res = await fetch(`${base}/api/gallery/folders/${f.id}`, {
        method: "DELETE",
        headers: authHeaders,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError?.(data.error || "Не удалить");
        return;
      }
      if (folderId === f.id) {
        setStack((s) => s.slice(0, -1));
      }
      onError?.(null);
      await load();
    } catch {
      onError?.("Сеть");
    }
  };

  const uploadFiles = async (fileList) => {
    if (!fileList?.length) return;
    setUploading(true);
    onError?.(null);
    try {
      const base = getApiBase();
      for (const file of fileList) {
        const fd = new FormData();
        fd.append("file", file);
        if (folderId != null) fd.append("folderId", String(folderId));
        const res = await fetch(`${base}/api/gallery/upload`, {
          method: "POST",
          headers: authHeaders,
          body: fd,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          onError?.(data.error || `Файл: ${file.name}`);
          break;
        }
      }
      await load();
    } catch {
      onError?.("Сеть: загрузка");
    } finally {
      setUploading(false);
    }
  };

  const deleteItem = async (it) => {
    if (!window.confirm(`Удалить «${it.original_name || "фото"}»?`)) return;
    try {
      const base = getApiBase();
      const res = await fetch(`${base}/api/gallery/items/${it.id}`, {
        method: "DELETE",
        headers: authHeaders,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError?.(data.error || "Не удалить");
        return;
      }
      onError?.(null);
      await load();
    } catch {
      onError?.("Сеть");
    }
  };

  const doMoveItem = async (targetFolderId) => {
    if (!moveItem) return;
    try {
      const base = getApiBase();
      const res = await fetch(`${base}/api/gallery/items/${moveItem.id}`, {
        method: "PATCH",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          folderId: targetFolderId === "" || targetFolderId == null ? null : targetFolderId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError?.(data.error || "Не переместить");
        return;
      }
      setMoveItem(null);
      onError?.(null);
      await load();
    } catch {
      onError?.("Сеть");
    }
  };

  const folderPathLabel = (fid) => {
    if (fid == null) return "Корень (без папки)";
    const map = new Map(allFolders.map((f) => [f.id, f]));
    const parts = [];
    let cur = map.get(fid);
    let guard = 0;
    while (cur && guard++ < 32) {
      parts.unshift(cur.name);
      cur = cur.parent_id != null ? map.get(cur.parent_id) : null;
    }
    return parts.join(" / ") || `#${fid}`;
  };

  const saveManualOrder = async (orderedIds) => {
    try {
      const base = getApiBase();
      const res = await fetch(`${base}/api/gallery/items/reorder`, {
        method: "PUT",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ itemIds: orderedIds, folderId: folderId ?? "" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError?.(data.error || "Порядок не сохранён");
        return;
      }
      onError?.(null);
      await load();
    } catch {
      onError?.("Сеть");
    }
  };

  const onDragStart = (e, id) => {
    if (sort !== "manual") return;
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
  };

  const onDragOver = (e) => {
    if (sort !== "manual") return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const onDrop = (e, targetId) => {
    if (sort !== "manual" || dragId == null || dragId === targetId) return;
    e.preventDefault();
    const ids = items.map((x) => x.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, dragId);
    setDragId(null);
    setItems((prev) => {
      const byId = new Map(prev.map((x) => [x.id, x]));
      return next.map((id) => byId.get(id)).filter(Boolean);
    });
    void saveManualOrder(next);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-tc-bg">
      <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-tc-border bg-tc-header px-4 py-3">
        <nav className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-sm">
          {stack.map((cr, i) => (
            <span key={`${cr.id ?? "root"}-${i}`} className="flex items-center gap-1">
              {i > 0 ? <span className="text-tc-text-muted">/</span> : null}
              <button
                type="button"
                onClick={() => crumbClick(i)}
                className={`truncate rounded px-1.5 py-0.5 transition hover:bg-tc-hover ${
                  i === stack.length - 1 ? "font-semibold text-tc-accent" : "text-tc-text-sec"
                }`}
              >
                {cr.name}
              </button>
            </span>
          ))}
        </nav>
        <label className="text-xs text-tc-text-muted">
          Сортировка
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            className="ml-2 rounded-lg border border-tc-border bg-tc-input px-2 py-1.5 text-sm text-tc-text outline-none"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => setFolderModal(true)}
          className="rounded-lg border border-tc-border bg-tc-panel px-3 py-1.5 text-sm text-tc-text transition hover:bg-tc-hover"
        >
          Новая папка
        </button>
        <label className="cursor-pointer rounded-lg bg-tc-accent px-3 py-1.5 text-sm font-medium text-white transition hover:bg-tc-accent/85">
          {uploading ? "Загрузка…" : "Добавить фото"}
          <input
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            multiple
            className="hidden"
            disabled={uploading}
            onChange={(e) => {
              void uploadFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loading ? (
          <p className="py-12 text-center text-sm text-tc-text-muted">Загрузка…</p>
        ) : (
          <>
            {sort === "manual" ? (
              <p className="mb-3 text-xs text-tc-text-muted">
                Режим своего порядка: перетащите миниатюры — порядок сохранится автоматически.
              </p>
            ) : null}
            {folders.length > 0 ? (
              <div className="mb-6">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-tc-text-muted">
                  Папки
                </h3>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                  {folders.map((f) => (
                    <div
                      key={f.id}
                      className="group relative flex flex-col overflow-hidden rounded-xl border border-tc-border bg-tc-panel transition hover:border-tc-accent/40"
                    >
                      <button
                        type="button"
                        onClick={() => openFolder(f)}
                        className="flex flex-1 flex-col items-start p-4 text-left"
                      >
                        <svg
                          viewBox="0 0 24 24"
                          className="mb-2 h-10 w-10 text-tc-accent"
                          fill="currentColor"
                          aria-hidden
                        >
                          <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
                        </svg>
                        <span className="line-clamp-2 text-sm font-medium text-tc-text">{f.name}</span>
                      </button>
                      <button
                        type="button"
                        title="Удалить папку"
                        onClick={() => deleteFolder(f)}
                        className="absolute right-2 top-2 rounded-md p-1 text-tc-danger opacity-0 transition group-hover:opacity-100 hover:bg-tc-danger/15"
                      >
                        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                          <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-tc-text-muted">
              Фотографии
            </h3>
            {items.length === 0 ? (
              <p className="py-8 text-center text-sm text-tc-text-muted">
                Пока пусто — загрузите изображения.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {items.map((it) => (
                  <div
                    key={it.id}
                    draggable={sort === "manual"}
                    onDragStart={(e) => onDragStart(e, it.id)}
                    onDragOver={onDragOver}
                    onDrop={(e) => onDrop(e, it.id)}
                    className={`group relative aspect-square overflow-hidden rounded-xl border border-tc-border bg-tc-panel ${
                      sort === "manual" ? "cursor-grab active:cursor-grabbing" : ""
                    }`}
                  >
                    <button
                      type="button"
                      className="absolute inset-0 z-0"
                      onClick={() => setLightbox(it)}
                      title={it.original_name || "Открыть"}
                    >
                      <GalleryThumb
                        itemId={it.id}
                        getApiBase={getApiBase}
                        authHeaders={authHeaders}
                        className="h-full w-full object-cover"
                        alt={it.original_name || ""}
                      />
                    </button>
                    <div className="absolute right-1 top-1 z-10 flex gap-0.5 opacity-0 transition group-hover:opacity-100">
                      <button
                        type="button"
                        title="Переместить"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMoveItem(it);
                        }}
                        className="rounded-md bg-black/50 p-1 text-white hover:bg-black/70"
                      >
                        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                          <path d="M10 9h4V6h3l-5-5-5 5h3v3zm-1 1H6V7l-5 5 5 5v-3h3v-4zm14 2l-5-5v3h-3v4h3v3l5-5zm-9 3h-4v3H7l5 5 5-5h-3v-3z" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        title="Удалить"
                        onClick={(e) => {
                          e.stopPropagation();
                          void deleteItem(it);
                        }}
                        className="rounded-md bg-black/50 p-1 text-white hover:bg-red-600/90"
                      >
                        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                          <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
                        </svg>
                      </button>
                    </div>
                    <p className="pointer-events-none absolute bottom-0 left-0 right-0 truncate bg-black/55 px-1.5 py-1 text-[10px] text-white/90">
                      {it.original_name || `фото ${it.id}`}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {folderModal ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget) setFolderModal(false);
          }}
        >
          <form
            onSubmit={createFolder}
            className="w-full max-w-sm rounded-xl bg-tc-panel p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-3 text-base font-semibold text-tc-text">Новая папка</h3>
            <input
              autoFocus
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="Название"
              maxLength={128}
              className="mb-4 w-full rounded-lg border border-tc-border bg-tc-input px-3 py-2 text-sm text-tc-text outline-none focus:border-tc-accent"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setFolderModal(false)}
                className="rounded-lg px-3 py-2 text-sm text-tc-text-sec hover:bg-tc-hover"
              >
                Отмена
              </button>
              <button
                type="submit"
                className="rounded-lg bg-tc-accent px-3 py-2 text-sm font-medium text-white hover:bg-tc-accent/85"
              >
                Создать
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {moveItem ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget) setMoveItem(null);
          }}
        >
          <div
            className="max-h-[70vh] w-full max-w-md overflow-hidden rounded-xl bg-tc-panel shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-tc-border px-4 py-3">
              <h3 className="text-base font-semibold text-tc-text">Переместить фото</h3>
              <p className="truncate text-xs text-tc-text-muted">
                {moveItem.original_name || `id ${moveItem.id}`}
              </p>
            </div>
            <ul className="max-h-56 overflow-y-auto p-2">
              <li>
                <button
                  type="button"
                  onClick={() => doMoveItem(null)}
                  className="w-full rounded-lg px-3 py-2 text-left text-sm text-tc-text hover:bg-tc-hover"
                >
                  В корень (без папки)
                </button>
              </li>
              {allFolders
                .filter((f) => f.id !== folderId)
                .map((f) => (
                  <li key={f.id}>
                    <button
                      type="button"
                      onClick={() => doMoveItem(f.id)}
                      className="w-full rounded-lg px-3 py-2 text-left text-sm text-tc-text hover:bg-tc-hover"
                    >
                      {folderPathLabel(f.id)}
                    </button>
                  </li>
                ))}
            </ul>
            <div className="border-t border-tc-border p-3">
              <button
                type="button"
                onClick={() => setMoveItem(null)}
                className="w-full rounded-lg py-2 text-sm text-tc-text-sec hover:bg-tc-hover"
              >
                Отмена
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {lightbox ? (
        <div
          className="fixed inset-0 z-[60] flex flex-col bg-black/90 p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setLightbox(null)}
        >
          <div className="flex justify-end">
            <button
              type="button"
              className="rounded-lg px-3 py-2 text-sm text-white hover:bg-white/10"
              onClick={() => setLightbox(null)}
            >
              Закрыть
            </button>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center" onClick={(e) => e.stopPropagation()}>
            <GalleryThumb
              itemId={lightbox.id}
              getApiBase={getApiBase}
              authHeaders={authHeaders}
              className="max-h-[85vh] max-w-full object-contain"
              alt={lightbox.original_name || ""}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
