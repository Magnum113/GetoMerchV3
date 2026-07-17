# Статус полного переноса GetoMerch Admin на сервер

Последнее обновление: `2026-07-17`.

Основной план:
`docs/ADMIN_FULL_SERVER_MIGRATION_PLAN.md`.

Подробный отчет по уже выполненным этапам:

- `docs/ADMIN_MIGRATION_STAGE_0_1_REPORT_2026-07-16.md`;
- `docs/ADMIN_MIGRATION_STAGE_2_REPORT_2026-07-16.md`;
- `docs/ADMIN_MIGRATION_STAGE_3_REPORT_2026-07-16.md`;
- `docs/ADMIN_MIGRATION_STAGE_4_REPORT_2026-07-16.md`;
- `docs/ADMIN_MIGRATION_STAGE_5_REPORT_2026-07-16.md`;
- `docs/ADMIN_MIGRATION_STAGE_6_REPORT_2026-07-16.md`;
- `docs/ADMIN_MIGRATION_STAGE_7_REPORT_2026-07-17.md`;
- `docs/ADMIN_MIGRATION_STAGE_8_REPORT_2026-07-17.md`;
- `docs/ADMIN_MIGRATION_STAGE_9_REPORT_2026-07-17.md`;
- `docs/ADMIN_MIGRATION_STAGE_10_PREPARATION_REPORT_2026-07-17.md`.

## 1. Назначение документа

Это канонический оперативный статус реализации плана полного переноса
GetoMerch Admin с Supabase на PostgreSQL сервера. Основной план фиксирует
целевую архитектуру, последовательность и критерии этапов, а этот документ
показывает фактическое состояние работ.

После каждого этапа здесь обновляются:

- статус этапов и дата последней проверки;
- фактически созданные артефакты;
- проверки приложения, данных и сервера;
- известные риски и блокеры;
- следующий исполняемый шаг;
- журнал существенных решений.

Этап отмечается выполненным только после проверки его exit criteria. Наличие
кода или конфигурации без фактической проверки не считается завершением.

## 2. Общий статус

| Параметр | Состояние |
|---|---|
| Выполнено | `10 из 12` этапов |
| Текущий этап | этап 10 — Release E готов и проверен; `prepare`/`go` только в отдельное окно |
| Production БД админки | Supabase, без переключения |
| Production приложение | `/opt/getomerch/current`, `getomerch-admin.service` |
| Целевая БД | `getomerch_production` создана на VPS и намеренно пустая |
| Cutover выполнен | нет |
| Следующий production-риск | критический: этап 10 переключает source of truth; требуется maintenance window и явное подтверждение владельца |

Обозначения статусов:

- `выполнен` — exit criteria проверены и зафиксированы;
- `в работе` — реализация или проверка уже начата;
- `заблокирован` — продолжение невозможно без отдельного решения;
- `не начат` — работы этапа еще не выполнялись.

## 3. Статус этапов

| Этап | Статус | Дата | Результат / следующий критерий |
|---|---|---|---|
| 0. Границы и потребители | выполнен | `2026-07-16` | Зафиксированы 20 таблиц, writers, границы KOMUI и cutover-гейты |
| 1. Емкость и восстановление | выполнен | `2026-07-16` | Daily/off-site backup и restore drill успешно проверены |
| 2. Baseline-схема и migration runner | выполнен | `2026-07-16` | Чистая БД строится из Git; checksum, lock и verify проверены |
| 3. Изолированный PostgreSQL-контур | выполнен | `2026-07-16` | Роли, HBA, env, healthcheck и две целевые БД проверены без cutover |
| 4. Первая репетиция миграции | выполнен | `2026-07-16` | 6 621 строк, 20/20 fingerprints, 164 data checks, расхождений нет |
| 5. Database/service layer | выполнен | `2026-07-16` | Adapters и strict repository contracts проверены на rehearsal |
| 6. Read-path | выполнен | `2026-07-16` | Все домены и read-only RPC прошли strict compare; p95 `396/123 ms` |
| 7. Mutation-path | выполнен | `2026-07-17` | 12/12 mutation test groups, idempotency, audit и fault rollback проверены |
| 8. Ozon sync/import и workers | выполнен | `2026-07-17` | Durable queue, worker, pagination/retry и Ozon dry-run проверены |
| 9. Pre-production репетиция | выполнен | `2026-07-17` | Два полных цикла, backup/restore/rollback и все regression gates прошли |
| 10. Production cutover | в работе | `2026-07-17` | Release E и безопасная репетиция готовы; production `prepare`/`go` не запускались |
| 11. Стабилизация | не начат | — | Наблюдение, удаление Supabase runtime и финальная приемка |

## 4. Выполнено на этапе 0

- Migration scope закреплен в `ops/getomerch-working-tables.txt`: ровно 20
  рабочих таблиц.
- Зафиксированы активные и потенциальные потребители Supabase.
- Подтверждено, что production-админка остается единственным активным writer
  для migration scope.
- Подтверждено отсутствие ссылок на эти 20 таблиц в KOMUI production/staging и
  найденных Supabase Edge Functions.
- Зафиксировано разделение `komui_production` и будущей
  `getomerch_production`; shared catalog будет связан контрактами, а не
  cross-database foreign keys.
- Зафиксированы обязательные cutover-гейты для legacy SKU scripts и локального
  `GetoMerchV4`.

## 5. Выполнено на этапе 1

- Повторная очистка сервера не проводилась: владелец уже освободил место.
- Capacity gate пройден: корневой раздел был заполнен примерно на `64%`,
  свободно около `6.9 GiB`.
- `getomerch-backup.timer` включен и активен.
- Daily backup экспортирует данные 20 allowlist-таблиц с точной сверкой counts.
- Архив шифруется до off-site upload в
  `s3://komui-backups/getomerch/admin-production/`.
- Создан forensic archive всех 31 текущих таблиц `public`, каталога из 724
  объектов, OpenAPI snapshot и списка Auth users.
- Контрольный архив
  `getomerch-backup-20260716T152619Z.tar.gz.gpg` успешно восстановлен во
  временную PostgreSQL БД.
- Совпали counts всех 20 таблиц; 6 business invariants не выявили нарушений;
  restore drill занял `5 секунд`; временная БД удалена.

Forensic archive является прикладным архивом данных проекта, а не физической
копией внутренних managed-схем Supabase. Текущий RPO — до 24 часов. WAL/PITR с
целевым RPO до 5 минут вводится после создания локальной production БД.

## 6. Выполнено на этапе 2

- Добавлен reviewed baseline
  `db/migrations/0001_getomerch_baseline.sql`.
- Baseline воспроизводит 20 таблиц, 177 колонок, 81 constraint, 65 итоговых
  индексов, одну trigger-функцию и один trigger.
- Supabase roles/grants, 32 permissive policy, RLS, platform schemas,
  storefront deploy trigger и таблицы вне allowlist исключены.
- Добавлен migration ledger с SHA-256 и временем выполнения.
- Добавлены команды `status`, `up`, `verify` и session advisory lock.
- Runner принимает только базы с префиксом `getomerch_` и не читает
  `GETOMERCH_SUPABASE_DATABASE_URL`.
- Добавлены read-only schema checks и безопасный rehearsal-скрипт.
- На PostgreSQL 17 VPS чистая `getomerch_rehearsal` построена за `47 ms`;
  повторный `up` не внес изменений; все 18 проверок прошли.
- Отдельно проверены target database guard, checksum divergence и занятый
  advisory lock.
- После проверки временная БД удалена; production runtime, Supabase и базы
  KOMUI не менялись.

## 7. Выполнено на этапе 3

- Созданы `getomerch_owner`, `getomerch_migrator`, `getomerch_app` и
  `getomerch_backup`; DDL отделен от runtime и backup-доступа.
- Постоянная `getomerch_rehearsal` построена из Git: 20 таблиц, migration
  version `0001`, все 18 schema checks успешны.
- `getomerch_production` создана после проверки rehearsal и намеренно оставлена
  пустой: 0 пользовательских таблиц, migration version `none`.
- HBA разрешает новым ролям только локальные подключения к двум GetoMerch БД и
  отклоняет доступ к KOMUI; обратный доступ ролей KOMUI также заблокирован.
- Добавлены root-only env, идемпотентный bootstrap и healthcheck
  `SELECT 1 + database + migration version` без печати URL.
- Проверены запрет DDL для app-role, read-only backup-role, реальные cross-DB
  подключения, повторный bootstrap и неизменность ролей/БД KOMUI.
- PostgreSQL не перезапускался; production runtime не получил локальный DB env
  и продолжает работать с Supabase.
- Новый контур включен в зашифрованный backup; свежий backup, off-site upload и
  restore drill успешно завершены.

## 8. Выполнено на этапе 4

- Source export дважды стабильно прочитал все 20 allowlist-таблиц с exact
  counts и совпавшими SHA-256 row streams.
- Rollback-safe candidate DB построена из baseline, получила 6 621 строк через
  `COPY` и заменила постоянную rehearsal только после всех проверок.
- Source/target counts, primary keys, полное содержимое строк и диапазоны
  `created_at`/`updated_at` совпали для 20/20 таблиц.
- Совпали Ozon quantities/unmatched items, finance monthly aggregates,
  product dimension counts и workshop links.
- Успешны 164 data-integrity checks и 18 schema checks; orphan FK, NOT NULL,
  sequence и business нарушений нет.
- App/backup grants и HBA проверены на заполненной rehearsal.
- `getomerch_production` осталась пустой, production runtime остался на
  Supabase, свойства KOMUI не изменились.
- Post-stage backup создан, выгружен off-site и успешно восстановлен.

## 9. Выполнено на этапе 5

- Добавлен нейтральный `src/lib/db` с lazy local pool, transaction helper,
  repository/service contracts и безопасными ошибками.
- Реализованы Supabase и PostgreSQL adapters каталога и товаров без
  `SELECT *`, с SQL pagination и параметризованными фильтрами.
- `GET /api/admin/catalog` и `GET /api/admin/products` сохранили текущий
  response contract.
- Strict shadow compare нормализует timestamp, не логирует строки и проваливает
  rehearsal request при любом расхождении.
- Устранены различия collations для названий и SKU; product pagination теперь
  совпадает с действующим PostgREST-порядком.
- Contract tests прошли на текущем Supabase production process и отдельном
  приложении против `getomerch_rehearsal`.
- Rehearsal process слушает только `127.0.0.1:3101`, не включен в nginx и
  управляется `/usr/local/sbin/getomerch-admin-rehearsal`.
- На этапе 5 server writes были явно запрещены configuration guard до
  реализации транзакционного этапа 7.

## 10. Выполнено на этапе 6

- На единый repository/service layer переведены каталог, товары, остатки,
  матрица, движения, цех, Ozon orders/items, расходы, финансы и import history.
- Все read-only действия `/api/admin/rpc` используют тот же runtime; mutations
  остаются на Supabase.
- Связанные записи гидрируются пакетами; тяжелые `raw jsonb`, `SELECT *` по
  рабочим таблицам и широкие `to_jsonb` не используются.
- Свежая rehearsal-копия повторно прошла 20/20 fingerprints, 18 schema checks
  и 164 data checks.
- В local PostgreSQL primary + strict Supabase shadow прошли 8/8 групп
  контрактов.
- p95: обычные API `396 ms` на 40 samples, matrix `123 ms` на 3 samples.
- Representative SQL plans выполняются за `0.013–0.658 ms`; новых индексов без
  доказанного bottleneck не добавлено.
- Подробности: `docs/ADMIN_MIGRATION_STAGE_6_REPORT_2026-07-16.md`.

## 11. Выполнено на этапе 7

- Добавлена migration `0002_mutation_safety` со схемой `getomerch_audit`,
  idempotency ledger, audit log, ограничениями, индексами и точечными grants.
- Реализован server mutation layer для всех текущих записывающих admin RPC.
- Приёмка, перемещение, продажа, списание, корректировка, производство, цех и
  Ozon FBS выполняются одной SQL-транзакцией.
- Остатки блокируются через детерминированный `SELECT ... FOR UPDATE`; retry
  ограничен только serialization/deadlock ошибками.
- Повтор с тем же idempotency key возвращает сохранённый результат, а другой
  payload с тем же ключом отклоняется.
- Ozon FBO не может списывать внутренний склад или входить в FBS fulfillment.
- Подготовлены атомарные primitives для order snapshot и import run, но их
  подключение к внешним Ozon routes оставлено этапу 8.
- На disposable server DB успешно прошли 12/12 mutation test groups, включая
  fault rollback приёмки, производства, цеха и FBS shipment.
- Постоянная `getomerch_rehearsal` обновлена до migration `0002`; production
  Supabase, production release и пустая `getomerch_production` не менялись.
- Подробности: `docs/ADMIN_MIGRATION_STAGE_7_REPORT_2026-07-17.md`.

## 12. Выполнено на этапе 8

- Добавлена migration `0003_background_jobs` с приватной схемой
  `getomerch_jobs`, durable queue, событиями, heartbeat, cancellation,
  attempts, active dedupe и retention.
- Реализован отдельный worker с `FOR UPDATE SKIP LOCKED`, bounded retry,
  graceful shutdown и recovery потерянного heartbeat.
- Внутренний service token разрешён только для пяти точных Ozon route и
  независимо проверяется middleware и Route Handler; остальные API требуют
  admin cookie.
- Ozon client получил timeout/AbortSignal, `Retry-After`, безопасные ошибки и
  retry только временных network/408/429/5xx сбоев.
- Orders обрабатывают полную FBS/FBO pagination и stale/cancelled refresh;
  FBO сохраняется для аналитики и не входит во внутренний fulfillment.
- Finance обрабатывает 28-дневные окна и `page_count`, prices — cursor
  pagination, import — server-side preview и атомарный apply.
- При server write-source route ставит job в очередь и возвращает `202`, UI
  прозрачно опрашивает статус. Supabase production сохраняет прежний
  синхронный fallback до cutover.
- На disposable БД пройдены 10 групп queue/integration tests и реальный Ozon
  dry-run: orders `65`, prices `154`, finance `84`, import `154`; fingerprints
  данных не изменились.
- Постоянная `getomerch_rehearsal` обновлена до migration `0003`; production
  worker не установлен, production release и пустая `getomerch_production` не
  менялись.
- Подробности: `docs/ADMIN_MIGRATION_STAGE_8_REPORT_2026-07-17.md`.

## 13. Выполнено на этапе 9

- Создан loopback-only release
  `/opt/getomerch/rehearsals/stage9-20260717T104528Z`.
- Добавлен единый pre-production smoke для auth, всех UI sections, KOMUI
  prod/stage read API и bounded load.
- Дважды созданы свежие encrypted Supabase backup с off-site upload и дважды
  выполнен rollback-safe data rehearsal.
- В обоих циклах совпали `6 621` source/target rows и полный source fingerprint
  `8746fcd1…dde620`; candidate построен из migrations `0001`–`0003`.
- Дважды прошли repository 8/8, mutation 12/12, durable jobs 10/10 и real Ozon
  dry-run `66/154/86/154`.
- Дважды проверен encrypted native PostgreSQL backup/restore всех 25 runtime/
  meta/audit/jobs tables, migrations, integrity и DB roles.
- Дважды проверен rollback-runtime на Supabase, включая login/logout,
  UI/KOMUI/load regression и отсутствие production writes.
- Временные БД, HBA rules, units и listeners удалены; production release,
  пустая `getomerch_production` и production worker не менялись.
- Подробности: `docs/ADMIN_MIGRATION_STAGE_9_REPORT_2026-07-17.md`.

## 14. Этап 10 в работе

Цель — выполнить production cutover только в согласованное maintenance window.

Подготовительный Release E уже реализован, развернут и проверен:

- maintenance/read-only блокирует HTTP mutations, server mutation layer,
  очередь и worker; UI показывает актуальный режим;
- установлен root-only state machine `preflight -> prepare -> go`, а простой
  `abort` разрешен только до отметки первого write;
- установлен hourly encrypted local backup с обязательным off-site upload,
  retention tiers и отдельным restore drill;
- worker и новый backup timer установлены, но остаются disabled до Go;
- оба режима импорта проверены на `6 621` строках с точным fingerprint;
- production-format backup выгружен off-site и успешно восстановлен;
- после проверки `getomerch_production` возвращена в пустое состояние;
- повторный preflight, admin/KOMUI HTTP и service gates прошли.

Подробный отчет:
`docs/ADMIN_MIGRATION_STAGE_10_PREPARATION_REPORT_2026-07-17.md`.

До начала нужны отдельное подтверждение владельца и Go/No-Go checklist:

1. Зафиксировать окно, ответственного, критерии abort и запрет параллельных
   ручных/legacy writers.
2. Повторить consumer scan и ротировать ранее засвеченный Supabase DB password.
3. Сделать финальные Supabase/GetoMerch/KOMUI/config backups.
4. Включить maintenance/read-only только для админки, остановить jobs/timers и
   дождаться отсутствия активных операций.
5. Выполнить финальный frozen export/import/checks до первого production write.
6. Переключить app, провести read/transaction/Ozon/KOMUI smoke и принять
   отдельное решение Go/No-Go до снятия maintenance.
7. Worker включать только после Go и отдельно от web runtime.

## 15. Текущие риски и обязательные гейты

| Риск / действие | Когда закрыть | Состояние |
|---|---|---|
| Сменить пароль Supabase DB после ранней диагностики process list | до cutover | открыто |
| Заморозить credentials локального `GetoMerchV4` | перед write cutover | открыто |
| Запретить ручной запуск legacy SKU scripts | на окно cutover | открыто |
| Повторить consumer/writer scan | непосредственно перед cutover | открыто |
| Устранить `500` у `/api/admin/inventory?limit=10` | до приемки read-path | закрыто в stage-6 candidate; production получит исправление только с новым release |
| Добавить неинтерактивную ESLint-конфигурацию | до полного CI gate | открыто |
| Расширить диск перед WAL/PITR или существенным ростом данных | до включения PITR | открыто |

Native `pg_dump` через текущий Supabase Supavisor не используется как основа
RPO: соединение зависает после служебной настройки сессии. Рабочий backup
использует Supabase REST, keyset pagination, точные counts и restore drill.

## 16. Последняя проверенная серверная точка

| Компонент | Проверенное состояние |
|---|---|
| `getomerch-admin.service` | production runtime продолжает работать с Supabase |
| `getomerch-admin-rehearsal.service` | active, disabled, `127.0.0.1:3101`, local PostgreSQL read + strict Supabase shadow; persistent write-source `supabase` |
| Rehearsal app release | `/opt/getomerch/rehearsals/stage9-20260717T104528Z` |
| Repository contract tests | два цикла 8/8; persistent p95 `373/144` и `380/107 ms` |
| Mutation/job tests | два цикла mutation 12/12 и queue/Ozon integration 10/10; disposable artifacts removed |
| Ozon dry-run | оба цикла: orders `66`, prices `154`, finance `86`, import `154` |
| Full UI/KOMUI/load | оба цикла пройдены; concurrency 4 p95 `489` и `457 ms` |
| Production BFF | production release не менялся; queue-path запускался только на disposable server-write candidate |
| Production worker | установлен, `inactive/disabled`; запускается только командой Go |
| `getomerch-backup.timer` | enabled, active |
| Последний полный Supabase backup | `getomerch-backup-20260717T124802Z.tar.gz.gpg`, encrypted и uploaded off-site |
| Последний native DB backup | `getomerch-database-backup-20260717T125149Z.tar.gz.gpg`, encrypted и uploaded off-site |
| Последний native DB restore | `20260717T125200Z`, migrations/counts/integrity/roles успешно |
| Постоянная rehearsal БД | migrations `0001`–`0003`, 20 business tables, 6 621 source rows, audit/jobs schemas, fingerprints совпали |
| Data rehearsal report | `/var/lib/getomerch/rehearsals/20260717T124930Z/`, status success |
| `komui_production` | не изменялась |
| `komui_staging` | не изменялась |
| Новая `getomerch_production` | создана, 0 пользовательских таблиц, migration version `none` |
| Cross-DB isolation | GetoMerch <-> KOMUI реальные подключения заблокированы |
| Временные stage-9 artifacts | DB `0`, HBA rules `0`, units `0`, listeners `3102/3103` закрыты |
| Новый local DB backup timer | установлен, `inactive/disabled` до Go |
| Cutover preflight | `ok`, phase `idle`, production target пустой |
| Диск после cleanup | около `74%` занято, свободно около `5.0 GiB` |

## 17. Журнал изменений

| Дата | Изменение |
|---|---|
| `2026-07-16` | Создан отдельный статус реализации; этапы 0 и 1 отмечены выполненными |
| `2026-07-16` | Зафиксировано, что очистка VPS не выполнялась и не требовалась для capacity gate |
| `2026-07-16` | Рабочим backup-маршрутом выбран REST export с off-site encryption и обязательным restore drill |
| `2026-07-16` | Этап 2 завершен: baseline, migration ledger/runner, schema checks и rehearsal проверены на VPS |
| `2026-07-16` | Этап 3 завершен: раздельные роли, HBA, постоянная rehearsal, пустая production БД, env и healthcheck проверены без cutover |
| `2026-07-16` | Этап 4 завершен: стабильный double-read snapshot импортирован в rehearsal, все fingerprints и 164 data checks совпали |
| `2026-07-16` | Этап 5 завершен: независимый DB layer, adapters, strict shadow compare и отдельный rehearsal process проверены без production cutover |
| `2026-07-16` | Этап 6 завершен: весь read-path и read-only RPC прошли strict compare, EXPLAIN и p95 gates без production cutover |
| `2026-07-17` | Этап 7 завершен: server mutations, SQL-транзакции, idempotency/audit и 12 fault/concurrency test groups проверены без production cutover |
| `2026-07-17` | Этап 8 завершен: durable jobs, worker, Ozon pagination/retry/import и 10 integration test groups проверены без production cutover |
| `2026-07-17` | Этап 9 завершен: два полных pre-production цикла, native backup/restore и Supabase rollback прошли без production cutover |
| `2026-07-17` | Подготовка этапа 10 завершена: Release E установлен, maintenance/cutover/backup проверены, production target возвращен пустым; `prepare` и `go` не запускались |
