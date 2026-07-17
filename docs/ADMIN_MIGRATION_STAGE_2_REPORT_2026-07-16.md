# Отчет по этапу 2 миграции GetoMerch Admin

Дата проверки: `2026-07-16`.

Статус: **выполнен**.

Production runtime, Supabase и базы `komui_production`/`komui_staging` на этом
этапе не изменялись. Постоянные `getomerch_rehearsal` и
`getomerch_production` еще не создавались.

## 1. Baseline schema

Создан `db/migrations/0001_getomerch_baseline.sql` на основе reviewed schema
snapshot 20 рабочих таблиц Supabase от `2026-07-16`.

Состав baseline:

| Объект | Количество |
|---|---:|
| Таблицы | 20 |
| Колонки | 177 |
| Constraints | 81 |
| Индексы, включая backing indexes PK/UNIQUE | 65 |
| Пользовательские trigger-функции | 1 |
| Пользовательские triggers | 1 |
| Пользовательские sequences | 0 |

UUID создаются встроенной в PostgreSQL 17 функцией `gen_random_uuid()`;
отдельные sequences и Supabase extension для baseline не требуются.

Из целевой схемы исключены:

- Supabase roles и grants;
- RLS и 32 открытые permissive policy;
- `auth`, `storage`, `realtime`, `vault`, `net` и `pg_net`;
- `notify_vercel_storefront_changed` и storefront deploy trigger;
- storefront, checkout, CDEK, payment и backup-таблицы вне allowlist.

## 2. Migration runner

Добавлен `db/scripts/migrate.mjs` с командами:

```text
status
up
verify
```

Реализованы следующие гарантии:

- отдельный ledger `getomerch_meta.schema_migrations`;
- SHA-256 каждого примененного SQL-файла;
- запрет изменения примененных миграций;
- session advisory lock для `up` и `verify`;
- отдельная транзакция и короткий `lock_timeout` на каждую миграцию;
- отсутствие автоматического запуска при старте Next.js;
- отказ от подключения к БД без префикса `getomerch_`;
- использование только `GETOMERCH_DATABASE_URL` или стандартных `PG*` env;
- отсутствие чтения и вывода `GETOMERCH_SUPABASE_DATABASE_URL`.

Команды добавлены в `package.json`:

```text
npm run db:migrate:status
npm run db:migrate:up
npm run db:migrate:verify
npm run db:rehearsal
```

## 3. Schema verification

`db/checks/0001_getomerch_baseline.sql` выполняется в read-only
repeatable-read транзакции и проверяет:

1. 20 обязательных таблиц;
2. 177 колонок;
3. 60 default expressions и 90 `NOT NULL` колонок;
4. 81 constraint и отдельно 20 PK, 31 FK, 14 UNIQUE, 16 CHECK;
5. 65 индексов, включая 5 partial и 38 unique indexes;
6. один trigger;
7. функцию `update_inventory_timestamp()`;
8. migration ledger;
9. отсутствие RLS на рабочих таблицах;
10. отсутствие policies;
11. отсутствие Supabase platform schemas.

Всего SQL возвращает 18 независимых проверок.

Checks ограничены baseline-таблицами, поэтому последующее добавление новых
таблиц отдельными миграциями не требует пересборки `0001`.

## 4. Фактическая rehearsal-проверка

На VPS использован PostgreSQL `17.10`.

Временная чистая БД `getomerch_rehearsal` была создана из `template0`, после
чего выполнено:

```text
status -> up -> status -> verify -> up -> verify
```

Результат:

- до применения `0001` корректно отображалась как `pending`;
- последний baseline rehearsal применился за `47 ms`;
- после применения статус стал `applied`;
- все 18 checks прошли;
- повторный `up` сообщил `No pending migrations`;
- повторный `verify` прошел без изменений;
- ledger содержал ровно одну запись;
- временная БД после теста удалена.

Дополнительные негативные проверки:

- подключение к БД `postgres` отклонено target database guard;
- изменение примененного SQL-файла обнаружено по checksum;
- параллельный `verify` отклонен при занятом advisory lock;
- после освобождения lock итоговый `verify` снова прошел;
- после всех проверок `getomerch_rehearsal` отсутствует на сервере.

## 5. Правило миграций до cutover

До переключения production источником данных остается Supabase. Поэтому каждое
новое DDL-изменение в переходный период должно иметь:

1. обычную миграцию текущего Supabase production;
2. следующую forward-only миграцию в `db/migrations` для локальной серверной
   БД;
3. актуализированную проверку в `db/checks`;
4. rehearsal до deploy.

Изменять `0001_getomerch_baseline.sql` после этой фиксации нельзя. После
cutover единственным активным DDL-контуром GetoMerch станет `db/migrations`.

## 6. Rollback

Для пустой rehearsal БД rollback baseline — удалить целиком тестовую БД и
построить заново из Git. Обратный `DROP TABLE` для заполненной production БД
запрещен.

Последующие миграции выполняются forward-only. Обратимый rollback должен быть
описан до применения миграции; для необратимого DDL используется forward-fix
либо полное восстановление БД из проверенного backup. Rollback приложения не
откатывает схему автоматически.

## 7. Следующий этап

Этап 3 должен создать постоянный изолированный PostgreSQL-контур и роли с
минимальными правами. До этого момента созданные инструменты остаются
репозиторными артефактами, а production-админка продолжает работать с Supabase.
