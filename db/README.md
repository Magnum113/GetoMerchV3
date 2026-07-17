# Миграции GetoMerch PostgreSQL

Эта директория является единственным источником DDL для будущей серверной БД
`getomerch_production`. Она не применяется автоматически при старте Next.js и
не изменяет `komui_production`.

## Структура

```text
db/
  migrations/  # неизменяемые SQL-файлы в порядке версий
  checks/      # read-only проверки фактической схемы
  scripts/     # migration runner и чистая rehearsal-проверка
  seeds/       # зарезервировано для явных, версионируемых seed-наборов
```

## Подключение

Runner использует только `GETOMERCH_DATABASE_URL` либо стандартные переменные
libpq `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`. Он намеренно не
читает `GETOMERCH_SUPABASE_DATABASE_URL` и `DATABASE_URL`.

Для TCP с TLS:

```bash
export GETOMERCH_DATABASE_URL='postgresql://.../getomerch_rehearsal'
export GETOMERCH_DATABASE_SSL=true
export GETOMERCH_DATABASE_SSL_REJECT_UNAUTHORIZED=true
```

Локальное Unix socket-подключение можно задавать стандартными `PG*` env.
Connection string никогда не печатается runner-ом.

На сервере `getomerch_migrator` имеет `NOINHERIT` membership в
`getomerch_owner`. Для создания объектов с единым NOLOGIN owner migration env
задает `GETOMERCH_MIGRATION_ROLE=getomerch_owner`; runner выполняет
валидированный `SET ROLE` до чтения ledger и применения DDL.

Runner отказывается работать с любой БД, имя которой не начинается с
`getomerch_`. Это дополнительная защита `komui_production`, `komui_staging` и
исходной Supabase DB от случайного применения миграций.

## Серверный контур

На production VPS этап 3 создал два независимых target:

- `getomerch_rehearsal` — постоянная БД с migrations `0001`–`0003`; содержит
  проверенную point-in-time копию 20 рабочих таблиц, mutation audit и private
  job schemas;
- `getomerch_production` — намеренно пустая БД до production rehearsal и
  cutover.

Идемпотентный provisioning выполняет root-скрипт:

```bash
sudo /usr/local/sbin/getomerch-postgres-bootstrap
```

Он управляет только ролями/БД GetoMerch, устанавливает ранний локальный HBA
include, создает root-only env и проверяет неизменность объектов `komui_*`.
PostgreSQL не рестартует: используется reload конфигурации.

Server env разделены по ответственности:

```text
/etc/getomerch/database.env
/etc/getomerch/database-rehearsal.env
/etc/getomerch/migrator-production.env
/etc/getomerch/migrator-rehearsal.env
/etc/getomerch/database-backup.env
/etc/getomerch/database-backup-rehearsal.env
```

`database.env` до cutover не подключается к `getomerch-admin.service`. Проверка
подключения не печатает URL:

```bash
sudo /usr/local/sbin/getomerch-db-healthcheck \
  /etc/getomerch/database-rehearsal.env getomerch_rehearsal 0003
sudo /usr/local/sbin/getomerch-db-healthcheck \
  /etc/getomerch/database.env getomerch_production none
```

Подробный отчет: `docs/ADMIN_MIGRATION_STAGE_3_REPORT_2026-07-16.md`.

## Data rehearsal

Свежий зашифрованный backup импортируется только через отдельный root-скрипт:

```bash
sudo /usr/local/sbin/getomerch-data-rehearsal \
  /var/backups/getomerch/daily/getomerch-backup-<timestamp>.tar.gz.gpg
```

Скрипт не очищает постоянную rehearsal до проверки. Он строит отдельную
candidate DB, применяет baseline, загружает данные через `COPY`, выполняет
`ANALYZE`, schema/data checks и source/target fingerprints. Предыдущая
rehearsal удаляется только после rename, app healthcheck и повторного verify.
При ошибке выполняется rollback на предыдущую БД.

Working source export должен содержать `verificationPass.status=stable`: все 20
таблиц читаются дважды и row-stream SHA-256 обоих проходов должен совпасть.
Перед production cutover этого недостаточно без writer freeze, поскольку REST
double-read не является единым PostgreSQL transaction snapshot.

Data integrity check `0001_getomerch_data_integrity.sql` проверяет фактические
`NOT NULL`, orphan FK, sequences, duplicates, quantities и остатки. Машинные
отчеты хранятся root-only в `/var/lib/getomerch/rehearsals/`.

Результат первой репетиции:
`docs/ADMIN_MIGRATION_STAGE_4_REPORT_2026-07-16.md`.

Этап 9 дважды повторил полный export/import с migration `0003` и одинаковым
source fingerprint. Native custom-format backup/restore всей rehearsal-БД:

```bash
sudo /usr/local/sbin/getomerch-local-db-restore-drill
```

Проверка сравнивает 25 таблиц в `public`, `getomerch_meta`,
`getomerch_audit` и `getomerch_jobs`, затем запускает migration/data/role
checks. Отчёт: `docs/ADMIN_MIGRATION_STAGE_9_REPORT_2026-07-17.md`.

## Mutation safety

Migration `0002_mutation_safety.sql` создаёт отдельную
`getomerch_audit` schema с idempotency ledger и audit log. Она не меняет
контракт переноса 20 business tables и не добавляет их в source allowlist.

Проверки находятся в `db/checks/0002_mutation_safety.sql`. Транзакционный
mutation-path и fault/concurrency tests описаны в
`docs/ADMIN_MIGRATION_STAGE_7_REPORT_2026-07-17.md`; локальный запуск против
явно изолированной test DB выполняется командой:

```bash
npm run check:db-mutations
```

Fault injection дополнительно требует test-only env и имя БД с префиксом
`getomerch_stage7_`; включать её для rehearsal/production запрещено.

## Background jobs

Migration `0003_background_jobs.sql` создаёт приватную схему
`getomerch_jobs` с durable queue `jobs`, журналом `job_events`, active dedupe,
idempotency, attempts, progress, heartbeat, cancellation и bounded retention.
Она не меняет контракт переноса 20 business tables и не входит в source
allowlist.

Проверки схемы находятся в `db/checks/0003_background_jobs.sql`. Полная
проверка claim двух workers, retries, stale recovery, cancellation и Ozon
sync/import выполняется только против явно изолированной test DB:

```bash
npm run check:db-jobs
```

Реальный Ozon smoke разрешён отдельным guard и выполняет только dry-run:

```bash
npm run check:ozon-dry-run
```

Production worker до cutover не установлен. Unit templates лежат в
`ops/systemd/`, а канонический server migration bundle — в
`/usr/local/lib/getomerch/database`. Подробности:
`docs/ADMIN_MIGRATION_STAGE_8_REPORT_2026-07-17.md`.

## Команды

```bash
npm run db:migrate:status
npm run db:migrate:up
npm run db:migrate:verify
```

- `status` не меняет БД и сравнивает Git с migration ledger;
- `up` берет session advisory lock, применяет каждую pending migration в
  отдельной транзакции и записывает SHA-256;
- `verify` требует отсутствие pending/diverged migrations и выполняет
  read-only SQL из `db/checks` в repeatable-read транзакции.

Изменение уже примененного migration-файла запрещено: checksum mismatch
останавливает `status`, `up` и `verify`. Исправление выполняется только новой
миграцией с большим номером.

## Создание следующей миграции

1. Создать файл `<NNNN>_<snake_case>.sql` со следующим свободным номером.
2. Не добавлять в файл `BEGIN` или `COMMIT`: транзакцией управляет runner.
3. Указать короткий `lock_timeout` или отдельный rollout-план для тяжелого DDL.
4. Добавить или актуализировать read-only проверки в `db/checks`.
5. Запустить чистую rehearsal-проверку.
6. Применять миграцию отдельной deploy-командой под ролью
   `getomerch_migrator`, никогда не при старте приложения.

## Rehearsal

Команда требует локальный PostgreSQL и роль с правом `CREATEDB`:

```bash
npm run db:rehearsal
```

Она создает только пустую `getomerch_rehearsal`, выполняет
`status -> up -> verify`, повторно запускает `up/verify` для проверки
идемпотентности runner-а и удаляет БД. Существующая БД никогда не удаляется и
не перезаписывается. Для диагностического сохранения результата:

```bash
GETOMERCH_KEEP_REHEARSAL_DATABASE=true npm run db:rehearsal
```

## Rollback и forward-fix

Baseline `0001` предназначен для пустой БД. Его rollback до появления данных —
удалить целиком rehearsal DB и построить заново из Git. Применять обратный
`DROP TABLE` к заполненной production БД запрещено.

После появления рабочих данных миграции считаются forward-only. Для
обратимого изменения в описании новой миграции заранее фиксируются SQL и
условия rollback. Для необратимого DDL используется новая forward-fix migration
либо восстановление всей БД из проверенного backup с последующим replay
миграций. Production rollback приложения не должен автоматически откатывать
схему.

## Граница baseline

`0001_getomerch_baseline.sql` воспроизводит 20 рабочих таблиц Supabase на дату
`2026-07-16`: 177 колонок, 81 constraint, 65 индексов, одну trigger-функцию и
один trigger. Из baseline намеренно исключены:

- роли и grants Supabase;
- RLS и 32 открытые permissive policy;
- `auth`, `storage`, `realtime`, `vault`, `net` и `pg_net`;
- storefront deploy trigger;
- storefront, checkout, CDEK и backup-таблицы вне migration scope.
