# TatarChat

Репозиторий — **корень проекта** (папка `tatarchat/` с каталогами `server/`, `client/` и файлом `init.sql` в корне).

Групповой чат **DTD** (`dreamteamdauns`), текстовые сообщения в реальном времени, история в **PostgreSQL**, список онлайн-пользователей.

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

Имя контейнера и базы в Docker — **`tatarchat-db`** (см. `docker-compose.yml` и `DATABASE_URL`). Если нужно пересоздать том: `docker compose down -v`, затем `docker compose up -d` и `npm run db:init`.

Скопируйте переменные окружения и при необходимости поправьте URL:

```bash
copy server\.env.example server\.env
```

На Linux/macOS: `cp server/.env.example server/.env`

Пример для локального Docker:

```env
DATABASE_URL=postgres://postgres:password@localhost:5432/tatarchat-db
PORT=3001
NODE_ENV=development
JWT_SECRET=любая-длинная-случайная-строка-для-локальной-разработки
```

Инициализация схемы (скрипт ждёт готовность БД и применяет `init.sql`):

```bash
npm run db:init
```

Если в логах Postgres ошибка вроде `column m.created_at does not exist`, а в таблице `messages` колонка называлась `timestamp`, выполните миграцию (подставьте своё имя БД):

```bash
# Linux / Git Bash
docker exec -i tatarchat-db psql -U postgres -d tatarchat-db < migrations/001_rename_messages_timestamp.sql
```

В PowerShell:

```powershell
Get-Content migrations\001_rename_messages_timestamp.sql -Raw | docker exec -i tatarchat-db psql -U postgres -d tatarchat-db
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

Сначала **зарегистрируйте** пользователя (имя + пароль), затем войдите. Чат **DTD** защищён паролем комнаты (по умолчанию `1488` на клиенте и сервере, см. `DTD_ROOM_PASSWORD` на сервере). История и отправка — с JWT и заголовком `X-Room-Password` после ввода пароля на экране гейта.

В **production** на Render задайте **`JWT_SECRET`** (длинная случайная строка), иначе сервер не запустится.

Если база создана до появления паролей, примените миграцию:

```powershell
Get-Content migrations\002_users_password_hash.sql -Raw | docker exec -i tatarchat-db psql -U postgres -d tatarchat-db
```

Если в интерфейсе ошибка про отсутствие **`user_id`** в `messages` (часто на старой БД без пересоздания таблицы):

```powershell
Get-Content migrations\003_messages_user_id.sql -Raw | docker exec -i tatarchat-db psql -U postgres -d tatarchat-db
```

На **Render**: подключитесь к `DATABASE_URL` и выполните миграцию целиком.

- Из **cmd.exe** (подставьте URL из панели Render):

  `psql "postgresql://USER:PASS@HOST/DB" -f migrations/003_messages_user_id.sql`

- Уже внутри **psql** флаг `-f` не работает — вставьте SQL вручную или:

  `\i C:/path/to/tatarchat/migrations/003_messages_user_id.sql`

  (путь к файлу на вашем ПК; или скопируйте текст файла в буфер и выполните.)

Сообщения без сопоставимого пользователя (ник в `user` / `user_nick` / … не совпал с `users.nickname`) будут **удалены**. После миграции перезапустите **веб-сервис** на Render.

**Автоматически:** при старте `server.js` выполняется `ensureMessagesUserIdSchema()` (колонка `user` → `user_id`, затем `DROP "user"`). Достаточно задеплоить новую версию и перезапустить сервис — ручной `psql` не обязателен.

## API

| Метод | Путь | Описание |
|--------|------|----------|
| `GET` | `/api/health` | Проверка сервера |
| `POST` | `/api/auth/register` | `{ "name", "password" }` — пароль от 6 символов; ответ `{ token, user }` |
| `POST` | `/api/auth/login` | `{ "name", "password" }` — ответ `{ token, user }` |
| `GET` | `/api/rooms` | Список комнат: `slug`, `title`, `requiresPassword` |
| `GET` | `/api/messages/:slug` | История (`dreamteamdauns`). Заголовки: `Authorization: Bearer`, `X-Room-Password` для DTD |
| `POST` | `/api/messages` | `Authorization: Bearer`, `X-Room-Password`; тело `{ "room": "dreamteamdauns", "text": "..." }` |

## Socket.io

- Подключение с **`auth: { token }`**. Клиент шлёт **`join-room`**: `{ room: "dreamteamdauns", roomPassword: "…" }` (пароль комнаты).
- **`message`** — `{ text }` в текущей комнате (после успешного `join-room`).
- **`leave`** — выход и снятие с онлайн (несколько вкладок учитываются).

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

1. **Render (или аналог):** **Web Service** (Node) и **Managed Postgres**; `DATABASE_URL`, `NODE_ENV=production`, `JWT_SECRET`. Папка сервиса — **`server`**.
2. **Обязательная сборка фронта:** каталог `client/dist` не в git (см. `.gitignore`). В **Build Command** должно быть не только `npm install`, но и сборка клиента, например:
   - **Root Directory = `server`:** `npm install && npm run build`  
     (в `server/package.json` скрипт `build` ставит зависимости клиента и вызывает `vite build`).
   - Либо из корня репозитория: `npm ci --prefix client && npm run build --prefix client && npm ci --prefix server`, **Start:** `npm start --prefix server`.
3. После пуша в `main` дождитесь успешного деплоя; при «старый сайт» — **Manual Deploy** в Render и жёсткое обновление страницы (**Ctrl+Shift+R** / без кэша).
4. **Статика отдельно:** если фронт на CDN, задайте `VITE_API_URL` / `VITE_SOCKET_URL` под ваш API.

В репозитории есть **`render.yaml`** (пример с `rootDir: server` и `buildCommand: npm install && npm run build`).

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
