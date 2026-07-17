# Отчёт по этапу 9: полная pre-production репетиция

Дата завершения: `2026-07-17`.

Основной план:
`docs/ADMIN_FULL_SERVER_MIGRATION_PLAN.md`.

## 1. Итог

Этап 9 завершён двумя последовательными полными репетициями по одному
воспроизводимому runbook. Обе репетиции прошли без расхождений данных и без
изменения production runtime.

Production cutover не выполнялся:

- `admin.komui.ru` продолжает работать на прежнем release и Supabase;
- `getomerch_production` остаётся пустой, migration version `none`;
- production worker не установлен;
- candidate доступен только на `127.0.0.1:3101`, nginx к нему не подключён;
- KOMUI production/staging, `/opt/komui` и их БД не изменялись.

Проверенный candidate release:
`/opt/getomerch/rehearsals/stage9-20260717T104528Z`.

## 2. Воспроизводимый runbook

Добавлены и установлены следующие проверки:

- `scripts/check-preproduction.mjs` — auth, все основные UI sections,
  operational API, KOMUI prod/stage read API и bounded load smoke;
- `ops/getomerch-server-write-rehearsal` — disposable server-write БД,
  mutation/jobs/Ozon tests, временные exact HBA rules и гарантированная очистка;
- `ops/getomerch-local-db-restore-drill` — encrypted native `pg_dump -Fc`,
  restore в отдельную БД, counts, migrations, integrity и role checks;
- `ops/getomerch-supabase-rollback-rehearsal` — временный runtime на Supabase,
  включая успешный login с одноразовым password/hash и logout;
- `ops/getomerch-data-rehearsal` теперь определяет ожидаемую migration version
  из канонического migration bundle, а не ожидает устаревшую `0001`.

Fault injection разрешён только при явном test flag и для disposable БД
`getomerch_stage7_*`/`getomerch_stage9_*`. Production/rehearsal DB names этот
guard не проходят.

## 3. Два цикла данных

### Цикл 1

- Supabase backup: `getomerch-backup-20260717T104701Z.tar.gz.gpg`;
- encrypted archive проверен и загружен в Object Storage;
- data rehearsal report: `/var/lib/getomerch/rehearsals/20260717T104740Z/`;
- source/target rows: `6 621 / 6 621`;
- migration version: `0003`;
- comparison: `success`.

### Цикл 2

- Supabase backup: `getomerch-backup-20260717T105457Z.tar.gz.gpg`;
- encrypted archive проверен и загружен в Object Storage;
- data rehearsal report: `/var/lib/getomerch/rehearsals/20260717T105534Z/`;
- source/target rows: `6 621 / 6 621`;
- migration version: `0003`;
- comparison: `success`.

SHA-256 обоих source fingerprints одинаков:
`8746fcd1d471c82bfc7192bf2e18b22dc2f5cc74a7a798161617d2accadde620`.

В каждом цикле candidate строился из migrations `0001`–`0003`, данные
загружались одной import-транзакцией, выполнялись 18 baseline schema checks,
164 data checks, 10 mutation-schema checks и 13 job checks. Постоянная
rehearsal заменялась только после успешных fingerprints и checks.

## 4. Read, UI, auth и KOMUI

В обоих циклах прошли:

- 8/8 repository contract groups;
- dashboard, products, designs, settings, inventory/matrix, movements,
  workshop, Ozon orders/import, expenses и KOMUI pages;
- anonymous API `401`, redirect страниц на login, expired/tampered cookie;
- invalid login без cookie, valid signed session и logout cookie cleanup;
- отдельный успешный password login в временном rollback runtime;
- KOMUI production и stage runtime/products/orders read API;
- 48 API requests при concurrency `4` и четыре matrix requests.

Основные метрики:

| Проверка | Цикл 1 | Цикл 2 | Лимит |
|---|---:|---:|---:|
| Persistent repository p95 | `373 ms` | `380 ms` | `1 000 ms` |
| Persistent matrix p95 | `144 ms` | `107 ms` | `3 000 ms` |
| Persistent load p95 | `489 ms` | `457 ms` | `1 500 ms` |
| Persistent load matrix p95 | `108 ms` | `131 ms` | `5 000 ms` |
| Disposable server-write repository p95 | `17 ms` | `17 ms` | `1 000 ms` |
| Disposable server-write matrix p95 | `16 ms` | `12 ms` | `3 000 ms` |

Supabase rollback runtime также прошёл repository/UI/KOMUI/load checks:
`393/109 ms` и `577/134 ms` в первом цикле, `359/154 ms` и `442/109 ms` во
втором.

## 5. Mutation, jobs и Ozon

На отдельной копии свежей rehearsal-БД в каждом цикле прошли:

- 12/12 mutation groups: idempotency, locks, fault rollback, production,
  workshop, Ozon FBS и FBO isolation;
- 10/10 queue groups: claim двух workers, retry, cancellation, heartbeat,
  stale recovery, retention, pagination и import apply;
- pre-production server-write UI/load smoke;
- real Ozon smoke через временный worker.

Оба реальных Ozon dry-run дали одинаковый результат:

- active orders: `66`;
- prices: `154`;
- finance: `86`;
- import preview: `154`.

Перед real Ozon phase disposable БД восстанавливалась заново из чистого dump,
поэтому mock fixtures не могли попасть в реальные запросы. FBO не менял
внутренний склад. Все тестовые записи существовали только в disposable БД.

Успешные server-write reports:

- `/var/lib/getomerch/preproduction/server-write-20260717T105226Z/`;
- `/var/lib/getomerch/preproduction/server-write-20260717T105651Z/`.

## 6. Backup, restore и rollback

Native PostgreSQL drill дважды создал encrypted custom-format dump постоянной
rehearsal и восстановил его в новую disposable БД:

- `getomerch-db-getomerch_rehearsal-20260717T105350Z.dump.gpg`;
- `getomerch-db-getomerch_rehearsal-20260717T105731Z.dump.gpg`.

В обоих случаях совпали counts всех `25` таблиц в `public`,
`getomerch_meta`, `getomerch_audit` и `getomerch_jobs`; migration verify, data
integrity и app/backup role checks прошли. Восстановление заняло по `12 секунд`.
После перевода checksum-файла на переносимый basename-формат выполнен третий
контрольный restore `local-restore-20260717T110437Z` из
`getomerch-db-getomerch_rehearsal-20260717T110437Z.dump.gpg`, также успешный за
`12 секунд`.

Rollback до открытия записей проверен отдельным временным runtime на Supabase:

- `/var/lib/getomerch/preproduction/rollback-20260717T105413Z/`;
- `/var/lib/getomerch/preproduction/rollback-20260717T105751Z/`.

Оба runtime прошли полный read/auth/UI/KOMUI/load regression и были удалены.
Production service во время проверки не перезапускался.

## 7. Найденные проблемы runbook

Репетиция обнаружила и позволила исправить четыре проблемы тестового контура:

1. data rehearsal ожидал migration `0001` вместо текущей версии bundle;
2. wrapper требовал executable bit у Node scripts, хотя они запускаются через
   `/usr/bin/node`;
3. временный dump был недоступен роли `postgres` из-за ownership/permissions;
4. mock Ozon fixtures оставались в disposable БД перед real Ozon dry-run.

Все четыре причины устранены в скриптах. Неуспешные промежуточные reports
сохранены для аудита, но их disposable DB/HBA/unit/process artifacts удалены.
Failed encrypted dump удалён; остаются только два успешно восстановленных.

## 8. Финальное состояние и exit criteria

После очистки подтверждено:

- временных `getomerch_stage9_*` БД: `0`;
- временных HBA rules: `0`;
- listeners `3102/3103`: `0`;
- временных stage-9 systemd units: `0`;
- jobs в постоянной rehearsal: `0`;
- production public tables: `0`;
- production worker: `not-found`;
- свободный диск: около `5.8 GiB`, занято около `70%`.

Exit criteria этапа выполнены: две последовательные репетиции прошли одним
задокументированным runbook с одинаковыми source fingerprints и успешными
data/application/backup/rollback checks.

Следующий этап — этап 10, production cutover. Он требует отдельного решения о
maintenance window и явного Go/No-Go; этап 9 сам по себе ничего в production
не переключает.
