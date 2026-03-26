# TatarChat

Репозиторий — **корень проекта** (папка `tatarchat/` с каталогами `server/`, `client/` и файлом `init.sql` в корне).

Одна комната общего чата (в коде — `family`), текстовые сообщения в реальном времени, история в **PostgreSQL**, список онлайн-пользователей.

**Стек:** Node.js 20 + Express + Socket.io + `pg` · React 18 + Vite + Tailwind CSS · PostgreSQL 15 (Docker).

## Требования

- Node.js 20+
- Docker (Docker Desktop на Windows) или локальный PostgreSQL 15+

## Быстрый старт

### 1. Зависимости

```bash
cd tatarchat
npm install
cd server && npm install
cd ../client && npm install
```

(В корне ставится только `concurrently` для `npm run dev`.)

### 2. База данных

Поднимите Postgres:

```bash
docker compose up -d
```

Если команда не найдена, попробуйте `docker-compose up -d`.

Имя БД в Docker — **`tatarchat`** (как в `DATABASE_URL`). Если у вас остался старый том с базой `messenger_family`, удалите том и поднимите заново: `docker compose down -v`, затем снова `docker compose up -d` и `npm run db:init` (данные в Postgres будут сброшены).

Скопируйте переменные окружения и при необходимости поправьте URL:

```bash
copy server\.env.example server\.env
```

На Linux/macOS: `cp server/.env.example server/.env`

Пример для локального Docker:

```env
DATABASE_URL=postgres://postgres:password@localhost:5432/tatarchat
PORT=3001
NODE_ENV=development
```

Инициализация схемы (скрипт ждёт готовность БД и применяет `init.sql`):

```bash
npm run db:init
```

Если в логах Postgres ошибка вроде `column m.created_at does not exist`, а в таблице `messages` колонка называлась `timestamp`, выполните миграцию (подставьте своё имя БД):

```bash
# Linux / Git Bash
docker exec -i tatar-chat-db psql -U postgres -d messenger_family < migrations/001_rename_messages_timestamp.sql
```

В PowerShell:

```powershell
Get-Content migrations\001_rename_messages_timestamp.sql -Raw | docker exec -i tatar-chat-db psql -U postgres -d messenger_family
```

Вручную через `psql` (если установлен):

```bash
psql %DATABASE_URL% -f init.sql
```

### 3. Запуск разработки

Из корня проекта:

```bash
npm run dev
```

- Фронтенд: [http://localhost:5173](http://localhost:5173) (Vite, `npm run dev` в `client/`)
- API и Socket.io: [http://localhost:3001](http://localhost:3001)

Откройте два браузера или окна инкогнито с разными никами — проверьте онлайн и сообщения. После перезагрузки страницы история подтягивается из API.

## API

| Метод | Путь | Описание |
|--------|------|----------|
| `GET` | `/api/health` | Проверка сервера |
| `GET` | `/api/messages/family` | Последние 50 сообщений (JOIN с `users`) |
| `POST` | `/api/messages` | Тело: `{ "room": "family", "text": "...", "nickname": "..." }` (запасной канал без сокета) |

## Socket.io

- `join-family` — `{ nickname }` (или строка-ник); upsert пользователя, `online=true`, рассылка списка онлайн и истории.
- `message` — `{ text }` после join; запись в БД и broadcast.
- `leave` — снятие с онлайн (с учётом нескольких вкладок).

Ограничения: санитизация текста, не более **30 сообщений в минуту** на пользователя (in-memory).

## Production-сборка

```bash
cd client && npm run build
```

В корне `server` выставьте `NODE_ENV=production`. Сервер отдаёт статику из `client/dist` (путь `../client/dist` относительно `server/server.js`).

```bash
cd server && npm start
```

Один процесс слушает порт (например Render Web Service): и API, и статика, и WebSocket на том же хосте.

## Деплой (кратко)

1. **Render (или аналог):** отдельно **Web Service** (Node, старт `node server.js` из `server`) и **Managed Postgres**; в env задать `DATABASE_URL` и `NODE_ENV=production`; после депоя выполнить применение `init.sql` к облачной БД.
2. **Статика:** либо собрать клиент и раздавать с того же Express (как выше), либо **Static Site** на CDN + отдельный URL API (тогда в клиенте понадобится `VITE_*` для базового URL API и сокета — при необходимости добавьте сами).

## Миграция БД на свой сервер

```bash
pg_dump "исходный_DATABASE_URL" > backup.sql
psql "новый_DATABASE_URL" -f backup.sql
```

На VPS: Docker с образом `postgres:15`, том для данных, перед приложением — reverse proxy (nginx) с TLS.

## Замечания

- Счётчик «несколько вкладок» хранится в памяти процесса; после рестарта сервера флаги `online` в БД могут кратковременно расходиться с реальностью — для MVP это обычно приемлемо.
- CORS настроен на `localhost` и `127.0.0.1` с любым портом. Для продакшена укажите реальные origin в `server.js` при необходимости.

## Структура

```
tatarchat/
├── server/           # Express + Socket.io (server.js)
├── client/           # Vite + React
├── init.sql          # схема PostgreSQL
├── docker-compose.yml
├── package.json      # корень: concurrently, npm run dev
└── README.md
```

Команды `npm run dev`, `npm run db:init` и `docker compose up` выполняются **из корня** `tatarchat/`.
