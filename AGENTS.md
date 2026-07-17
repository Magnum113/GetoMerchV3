## Imported Claude Cowork project instructions

- Для всех футболок на Ozon использовать габариты упаковки `300 x 230 x 40 мм` и вес `250 г`.
- Production-админка живёт отдельно от магазина KOMUI: репозиторий/релизы в `/opt/getomerch`, сервис `getomerch-admin.service`, домен `admin.komui.ru`. Не копировать этот проект в `/opt/komui` и не смешивать deploy магазина с deploy админки.
- С `2026-07-17 13:08 UTC` рабочая БД production-админки — локальная `getomerch_production` на VPS. Runtime обязан использовать `GETOMERCH_DB_READ_SOURCE=server` и `GETOMERCH_DB_WRITE_SOURCE=server`; простой rollback на Supabase после этой отметки запрещён.
- Supabase хранится неизменённым минимум 30 дней как frozen rollback/archive source. Старый `GETOMERCH_SUPABASE_DATABASE_URL` и transaction pooler `:6543` допустимы только для явно обозначенных legacy/diagnostic путей периода стабилизации, не как production source of truth.
- Не выводить `service_role`, server keys и `GETOMERCH_SUPABASE_DATABASE_URL` в `NEXT_PUBLIC_*`, клиентский bundle, логи или screenshots.
- В PostgreSQL route не использовать `SELECT *` по тяжёлым таблицам и не возвращать широкие `to_jsonb(table)`; выбирать явные колонки и догидрировать справочники server-side.
