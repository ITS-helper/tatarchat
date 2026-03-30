-- Общая галерея (доступ по GALLERY_MEMBER_NICKNAMES на сервере). Применяется автоматически через ensureGallerySchema в server.js.

CREATE TABLE IF NOT EXISTS gallery_folders (
  id SERIAL PRIMARY KEY,
  parent_id INTEGER REFERENCES gallery_folders (id) ON DELETE CASCADE,
  name VARCHAR(128) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gallery_folders_parent ON gallery_folders (parent_id);

CREATE TABLE IF NOT EXISTS gallery_items (
  id SERIAL PRIMARY KEY,
  folder_id INTEGER REFERENCES gallery_folders (id) ON DELETE CASCADE,
  storage_key VARCHAR(512) NOT NULL UNIQUE,
  original_name VARCHAR(200) NOT NULL DEFAULT '',
  mime VARCHAR(80) NOT NULL DEFAULT 'image/jpeg',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gallery_items_folder ON gallery_items (folder_id);
