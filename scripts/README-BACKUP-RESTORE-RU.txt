TatarChat — куда положить бэкап на НОВОМ компьютере
====================================================

Старый ПК: запусти scripts\backup-tatarchat.ps1 — появится папка backups\ГГГГММДД-ЧЧММСС с файлами:
  - tatarchat-db.dump       (основной дамп PostgreSQL, формат custom)
  - tatarchat-db-plain.sql  (запасной вариант, plain SQL)
  - uploads\                (копия server\data\uploads — вложения, если были)
  - dot-env.example-copy.txt (копия server\.env — переименуй и проверь на новом ПК)

НОВЫЙ ПК — куда класть
----------------------
1) Скопируй ВСЮ папку с timestamp в:
     C:\tatarchat\backups\import\
   (или любой путь; ниже подставь свой)

2) БАЗА (Docker, контейнер tatarchat-db запущен, база tatarchat-db существует):

   docker cp C:\tatarchat\backups\import\tatarchat-db.dump tatarchat-db:/tmp/restore.dump
   docker exec tatarchat-db pg_restore -U postgres -d tatarchat-db --clean --if-exists --no-owner /tmp/restore.dump

   Если много ошибок — пересоздай пустую БД и залей без --clean:
   docker exec tatarchat-db psql -U postgres -c "DROP DATABASE IF EXISTS \"tatarchat-db\";"
   docker exec tatarchat-db psql -U postgres -c "CREATE DATABASE \"tatarchat-db\";"
   docker exec tatarchat-db pg_restore -U postgres -d tatarchat-db --no-owner /tmp/restore.dump

   Plain SQL (если нужно):
   Get-Content C:\tatarchat\backups\import\tatarchat-db-plain.sql -Raw | docker exec -i tatarchat-db psql -U postgres -d tatarchat-db

3) ВЛОЖЕНИЯ — содержимое папки uploads из бэкапа в:
     C:\tatarchat\server\data\uploads
   (сохрани подпапки: rooms, avatars, gallery, staging, …)

4) server\.env — DATABASE_URL = postgres://postgres:ПАРОЛЬ@localhost:ПОРТ/tatarchat-db
   Порт должен совпадать с тем Postgres, куда восстановил (если Docker на 5433 — пиши 5433).
