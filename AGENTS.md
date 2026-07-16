## Imported Claude Cowork project instructions

- Для всех футболок на Ozon использовать габариты упаковки `300 x 230 x 40 мм` и вес `250 г`.
- Production-админка живёт отдельно от магазина KOMUI: репозиторий/релизы в `/opt/getomerch`, сервис `getomerch-admin.service`, домен `admin.komui.ru`. Не копировать этот проект в `/opt/komui` и не смешивать deploy магазина с deploy админки.
- Рабочая БД админки остаётся Supabase. Direct Postgres через `GETOMERCH_SUPABASE_DATABASE_URL` — только server-side read-path к той же Supabase DB, не перенос данных на VPS.
- На сервере для direct Postgres использовать Supabase transaction pooler `:6543`, `GETOMERCH_POSTGRES_SSL=true`, `GETOMERCH_POSTGRES_POOL_MAX=1`, `GETOMERCH_POSTGRES_POOL_MAX_USES=1`, пока не проведён отдельный нагрузочный тест.
- Не выводить `service_role`, server keys и `GETOMERCH_SUPABASE_DATABASE_URL` в `NEXT_PUBLIC_*`, клиентский bundle, логи или screenshots.
- В direct Postgres route не использовать `SELECT *` по тяжёлым таблицам и не возвращать широкие `to_jsonb(table)` через pooler; выбирать явные колонки и догидрировать справочники server-side.
