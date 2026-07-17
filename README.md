# GetoMerch — учёт мерча

Веб-приложение для управления складом, товарами Ozon и заказами KOMUI. Стек:
Next.js 15, React 19, Supabase, Tailwind CSS и локальные shadcn/ui-компоненты.

Проект теперь живёт в двух режимах:

- локально — для разработки из этого репозитория;
- на сервере KOMUI как отдельная production-админка `https://admin.komui.ru`.

Админка на сервере развёрнута отдельно от публичного магазина `komui.ru`.
Репозитории, systemd-сервисы, nginx vhost, deploy registry и release-папки не
смешиваются с магазином KOMUI.

## Возможности

- **Каталог SKU** — товары строятся из категории, ткани, цвета, размера,
  дизайна, типа нанесения и Ozon SKU. Старые offer_id хранятся в
  `legacy_skus`, чтобы исторические заказы и финоперации продолжали
  сопоставляться.
- **Склады** — остатки по своему складу и цеху вышивки.
- **Заказы Ozon** — синхронизация FBS/FBO, отгрузка FBS, привязка вышивки к
  заказам в цех, финоперации и COGS для аналитики.
- **Ozon import** — preview/apply импорт товаров Ozon в каталог с историей
  запусков.
- **KOMUI** — витрина/API товаров и заказов, импорт и связывание offer_id.
- **Заказы в цех** — отправка заготовок в цех, производство готовых изделий и
  отгрузка заказов, связанных с вышивкой.
- **Производство принтов** — нанесение принта превращает заготовку в готовый
  товар и списывает принт-сток.
- **Журнал операций** — приёмки, перемещения, продажи, производство,
  корректировки и списания.
- **Дашборд** — выручка, расходы, комиссии Ozon, налог, прибыль, стоимость
  остатков и динамика заказов.

## База данных

Рабочая production-схема пока живёт в Supabase, таблицы используют префикс
`merch_`. Для полного переноса на сервер добавлен воспроизводимый PostgreSQL
baseline и migration runner в `db/`; команды и правила описаны в
`db/README.md`. Подробная модель и ограничения описаны в `DATABASE.md`,
инварианты разработки — в `ARCHITECTURE.md`.

Важно: production-приложение на `admin.komui.ru` всё ещё работает с текущим
Supabase-проектом. На VPS уже подготовлен отдельный изолированный PostgreSQL-
контур: `getomerch_rehearsal` с migrations `0001`–`0003`, проверенной копией
6 621 строки из 20 рабочих таблиц, audit/idempotency и private job schemas, а
также пустая `getomerch_production`. Rehearsal не синхронизируется
автоматически, DB env не подключен к `getomerch-admin.service`, поэтому
production source of truth не менялся.

Этапы 6–9 server migration завершены: read-only контур, admin RPC mutations и
server-side Ozon sync/import проходят через независимые service layers.
Проверочная сборка
читает `getomerch_rehearsal` на `127.0.0.1:3101` и сравнивает read-домены с
Supabase; её постоянный write-source остаётся Supabase. Server writes отдельно
проверены на одноразовой изолированной БД: 12/12 групп, включая concurrency,
idempotency и fault rollback, плюс 10/10 групп durable queue/Ozon integration.
Production release, default Supabase source и production worker не
переключались. Управление rehearsal-процессом:
`sudo /usr/local/sbin/getomerch-admin-rehearsal {start|stop|restart|status|test}`.
Два полных pre-production цикла проверили fresh export/import, все UI/KOMUI
sections, mutations/jobs/Ozon, native PostgreSQL restore и rollback-runtime на
Supabase. Подробности этапа 9:
`docs/ADMIN_MIGRATION_STAGE_9_REPORT_2026-07-17.md`.

Для этапа 10 подготовлен Release E, но production source of truth пока не
переключен. Новый `GETOMERCH_MAINTENANCE_MODE=read_only` оставляет страницы,
health и read API доступными, показывает плашку в UI и возвращает `503` на
mutation/job routes. Переключение управляется только через:

```bash
sudo /usr/local/sbin/getomerch-cutover preflight
sudo /usr/local/sbin/getomerch-cutover prepare --confirm-maintenance
sudo /usr/local/sbin/getomerch-cutover go --confirm-writes
sudo /usr/local/sbin/getomerch-cutover abort --confirm-abort
sudo /usr/local/sbin/getomerch-cutover status
```

`prepare` оставляет запись закрытой. После `go` простой abort на Supabase
запрещен, потому что в локальной БД уже могли появиться новые операции.

Для части тяжёлых серверных чтений production-админка подключается напрямую к
Postgres Supabase через server-only `pg`. Это ускоряющий read-path к той же
Supabase-базе, а не перенос данных на VPS. Записи, синхронизации и остальные
разделы продолжают использовать существующие server-side API/Supabase-клиенты,
если для них не сделан отдельный прямой route.

До cutover любое новое DDL-изменение должно быть оформлено и для текущего
Supabase production, и следующей forward-only миграцией в `db/migrations`.
Файл `0001_getomerch_baseline.sql` неизменяем; production не применяет новый
runner автоматически при запуске приложения.

## Запуск

```bash
npm install
npm run dev
```

Открой http://localhost:3000.

## Конфигурация

Минимально нужны публичные ключи Supabase:

```env
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<publishable_key>
```

Новый server-side BFF для админских Supabase-запросов читает URL и ключи
только из server env. В переходном режиме он может использовать anon fallback,
но целевое состояние перед закрытием RLS — service role key или отдельный
ограниченный серверный ключ:

```env
GETOMERCH_SUPABASE_URL=https://<ref>.supabase.co
GETOMERCH_SUPABASE_SERVICE_ROLE_KEY=<server_only_key>
# или GETOMERCH_SUPABASE_SERVER_KEY=<restricted_server_key>
```

Для тяжёлых чтений админки используется прямое server-side подключение к
Postgres Supabase. Если переменная не задана, backend продолжает работать через
Supabase REST fallback, но большие разделы могут грузиться медленнее.

```env
GETOMERCH_SUPABASE_DATABASE_URL=postgresql://postgres.<project-ref>:<password>@<region>.pooler.supabase.com:6543/postgres
GETOMERCH_POSTGRES_SSL=true
GETOMERCH_POSTGRES_POOL_MAX=1
GETOMERCH_POSTGRES_POOL_MAX_USES=1
```

На текущем VPS нужно использовать Supabase pooler в transaction mode
(`pooler.supabase.com:6543`). Прямой host `db.<ref>.supabase.co:5432` может
резолвиться в IPv6 и падать с `ENETUNREACH`, а session pooler `:5432` уже
упирался в лимит сессий. Значения `POOL_MAX=1` и `POOL_MAX_USES=1` оставлены
консервативно: они стабилизируют `/orders` и основной список `/inventory` через
pooler, не раздувая число долгих сессий.

Для целевой локальной БД используется другой server-only URL и отдельные
feature flags. В production они остаются `supabase/supabase/false` до cutover:

```env
GETOMERCH_DATABASE_URL=postgresql://getomerch_app:<password>@127.0.0.1:5432/getomerch_production
GETOMERCH_DB_READ_SOURCE=supabase
GETOMERCH_DB_WRITE_SOURCE=supabase
GETOMERCH_DB_SHADOW_COMPARE=false
GETOMERCH_DB_SHADOW_COMPARE_STRICT=false
```

В постоянном rehearsal read-source равен `server`, shadow compare и strict
включены, а write-source остаётся `supabase`. Значение
`GETOMERCH_DB_WRITE_SOURCE=server` поддерживается транзакционным mutation layer,
но до cutover разрешено только в изолированных test/candidate process с
локальной `GETOMERCH_DATABASE_URL`.

Эти переменные нельзя добавлять в `NEXT_PUBLIC_*`; deploy дополнительно
сканирует client bundle на утечки имён server-only env. Runtime env админки
лежит в `/etc/getomerch/admin-production.env`. Env для backup Supabase dump
отдельный: `/etc/getomerch/backup.env`.

Для серверных Ozon-операций дополнительно используются ключи Ozon:
локально из `.env.local`, на сервере из `/etc/getomerch/admin-production.env`.

Durable Ozon jobs после server cutover используют тот же локальный DB URL и
отдельный worker. Все параметры server-only:

```env
GETOMERCH_INTERNAL_SERVICE_TOKEN=<long_random_token>
GETOMERCH_WORKER_POLL_MS=2000
GETOMERCH_WORKER_HEARTBEAT_MS=10000
GETOMERCH_WORKER_STALE_SECONDS=120
GETOMERCH_JOB_RETENTION_DAYS=30
```

Token разрешён только для пяти точных Ozon sync/import route. UI использует
admin session, а остальные API token не принимают. Production worker нельзя
устанавливать или включать до server DB cutover; сейчас подготовлены только
unit templates.

Для раздела Komui админка умеет переключаться между production и stage прямо
из UI. Значение сохраняется в cookie `komui_api_target`.

```env
KOMUI_MIGRATION_API_BASE_URL=https://komui.ru/api
KOMUI_ADMIN_API_TOKEN=<admin_token>
KOMUI_PROD_API_BASE_URL=https://komui.ru/api
KOMUI_STAGE_API_BASE_URL=https://stage.komui.ru/api
```

`KOMUI_MIGRATION_API_BASE_URL` остаётся fallback/default. Если для контуров
будут разные токены, используй `KOMUI_PROD_ADMIN_API_TOKEN` и
`KOMUI_STAGE_ADMIN_API_TOKEN`; иначе достаточно общего
`KOMUI_ADMIN_API_TOKEN`.

`KOMUI_STAGE_BASIC_AUTH` нужен только для `https://stage.komui.ru/api`; на
production-домен этот заголовок не отправляется.

Для production-сервера дополнительно используются переменные авторизации
админки:

```env
ADMIN_AUTH_PASSWORD_HASH=pbkdf2_sha256$310000$...
ADMIN_AUTH_COOKIE_SECRET=<long_random_secret>
ADMIN_AUTH_COOKIE_NAME=getomerch_admin_session
ADMIN_AUTH_SESSION_DAYS=60
```

Хеш пароля генерируется без внешних зависимостей:

```bash
printf '%s' 'your-password' | node scripts/generate-admin-password-hash.mjs
```

На сервере env лежит в `/etc/getomerch/admin-production.env`, права:
`root:root`, `600`. Секреты не должны попадать в `NEXT_PUBLIC_*`.

## Production на сервере

Production-админка работает на том же сервере, где живёт KOMUI, но как
отдельный контур:

```text
GitHub GetoMerchV3.git
  -> /opt/getomerch/deploy-source
  -> /opt/getomerch/releases/<timestamp>-admin-<commit>
  -> /opt/getomerch/current
  -> systemd: getomerch-admin.service
  -> 127.0.0.1:3100
  -> nginx: admin.komui.ru
```

Ключевые пути на сервере:

| Путь | Назначение |
|---|---|
| `/opt/getomerch/deploy-source` | Git checkout `GetoMerchV3` |
| `/opt/getomerch/releases/` | Immutable production releases |
| `/opt/getomerch/current` | Symlink на активный release |
| `/opt/getomerch/rehearsals/current` | Текущий изолированный rehearsal release |
| `/etc/getomerch/admin-production.env` | Production env и секреты админки |
| `/etc/getomerch/database.env` | Будущий app-доступ к локальной production БД; пока не подключен к сервису |
| `/etc/getomerch/database-rehearsal.env` | App-доступ к постоянной rehearsal БД |
| `/etc/getomerch/migrator-*.env` | Отдельные подключения migration runner |
| `/etc/getomerch/database-backup*.env` | Read-only подключения backup-роли |
| `/etc/postgresql/17/main/pg_hba_getomerch.conf` | Локальная изоляция ролей/БД GetoMerch от KOMUI |
| `/usr/local/lib/getomerch/database` | Канонический server migration/check bundle `0001`–`0003` |
| `/usr/local/share/getomerch/systemd` | Подготовленные worker unit templates; production unit пока не установлен |
| `/var/lib/getomerch/preproduction` | Root-only reports server-write, native restore и rollback rehearsals |
| `/var/backups/getomerch/database` | Encrypted native PostgreSQL dumps и checksums |
| `/var/lib/getomerch/rehearsals/` | Root-only отчёты import rehearsal и fingerprints |
| `/var/lib/getomerch/deploy-registry.jsonl` | История deploy/rollback событий |
| `/var/lib/getomerch/deploy-current.json` | Последнее active-состояние |
| `/var/log/getomerch/deploy/` | Логи deploy/rollback |
| `/var/cache/getomerch/npm` | npm cache для deploy-сборок |
| `/var/backups/getomerch/` | Зашифрованные backup админки |

Основные команды:

```bash
sudo /usr/local/sbin/getomerch-deploy-from-git prod main
sudo /usr/local/sbin/getomerch-deploy-status
sudo /usr/local/sbin/getomerch-rollback prod
sudo /usr/local/sbin/getomerch-backup
sudo /usr/local/sbin/getomerch-db-healthcheck \
  /etc/getomerch/database-rehearsal.env getomerch_rehearsal 0003
sudo /usr/local/sbin/getomerch-data-rehearsal \
  /var/backups/getomerch/daily/getomerch-backup-<timestamp>.tar.gz.gpg
sudo /usr/local/sbin/getomerch-server-write-rehearsal
sudo /usr/local/sbin/getomerch-local-db-restore-drill
sudo /usr/local/sbin/getomerch-supabase-rollback-rehearsal
sudo /usr/local/sbin/getomerch-database-backup
sudo /usr/local/sbin/getomerch-database-restore-drill
```

`getomerch-deploy-from-git` собирает проект в одноразовой папке, создаёт новый
release, переключает `/opt/getomerch/current`, перезапускает
`getomerch-admin.service`, делает smoke-check и пишет событие в registry.
Если smoke падает, скрипт возвращает предыдущий active release.

`getomerch-backup` запускается systemd timer `getomerch-backup.timer`,
собирает env админки, root-only конфигурацию целевого DB-контура, HBA include,
systemd/nginx config, migration bundle, deploy registry, manifest active
release, свежие deploy-логи и логический export ровно 20 рабочих таблиц
Supabase. Данные читаются через server-side REST с ключом из
`/etc/getomerch/admin-production.env`; reviewed schema snapshot хранится рядом
с backup scripts. Архив шифруется, сохраняется в `/var/backups/getomerch` и
выгружается в `s3://komui-backups/getomerch/admin-production/`. Проверка
восстановления: `sudo /usr/local/sbin/getomerch-restore-drill`.

Working export выполняет два полных keyset-прохода: snapshot принимается только
если exact counts и SHA-256 упорядоченных row streams совпали. Data rehearsal
строится в отдельной candidate DB, сравнивает source/target fingerprints и
заменяет постоянную rehearsal только после успешных checks. Raw rows после
репетиции не сохраняются вне зашифрованного backup.

После server cutover старый timer останавливается после финального Supabase
архива. Локальную `getomerch_production` защищает отдельный
`getomerch-database-backup.timer`: каждый час он создаёт custom-format dump,
шифрует и проверяет архив, отправляет его под off-site prefix
`getomerch/database/hourly` и ведёт hourly/daily/weekly/monthly retention.
Перед открытием записей первый такой архив обязательно восстанавливается в
одноразовую БД с проверкой counts, migrations, invariants и runtime roles.

Расширенный forensic archive всех текущих `public`-таблиц, catalog/OpenAPI и
Auth users создаётся явным запуском:

```bash
sudo env GETOMERCH_BACKUP_INCLUDE_FULL_SUPABASE_DUMP=true \
  /usr/local/sbin/getomerch-backup
```

Он не является физическим backup внутренних managed-схем Supabase. Подробный
результат этапов 0–1 находится в
`docs/ADMIN_MIGRATION_STAGE_0_1_REPORT_2026-07-16.md`.

Telegram deploy bot магазина KOMUI расширен inline-кнопками:

```text
Deploy admin prod
Status admin prod
Rollback admin prod
```

Эти кнопки вызывают те же команды `getomerch-*`. Сам публичный магазин KOMUI
при этом не деплоится.

Важные нюансы:

- `admin.komui.ru` закрыт собственной авторизацией Next.js:
  `/login` + HttpOnly Secure cookie + HMAC-подписанный token.
- Старую nginx Basic Auth для админки сняли после внедрения app-auth.
- `komui.ru` и `stage.komui.ru` обслуживаются отдельным проектом
  `/opt/komui`; этот репозиторий туда не копировать и с ним не объединять.
- Admin UI обращается к production/stage KOMUI только через backend API, а не
  прямым SQL в PostgreSQL магазина.
- Новый BFF read-path выбирает источник единым
  `GETOMERCH_DB_READ_SOURCE=supabase|server`. Production пока использует
  Supabase, а rehearsal — локальный PostgreSQL с strict Supabase shadow.
- Матрица остатков больше не использует старый hybrid route: server adapter
  читает явные product columns и один SQL aggregate остатков, Supabase adapter
  использует ограниченную пагинацию. Оба возвращают один API contract.
- Локальные `getomerch_rehearsal` и `getomerch_production` не являются текущим
  runtime источником. Первая содержит проверенную point-in-time копию данных,
  вторая намеренно пустая;
  подключать `/etc/getomerch/database.env` к сервису до этапа cutover нельзя.
- Runtime-only `getomerch-admin-rehearsal.service` слушает только
  `127.0.0.1:3101`, не имеет nginx route и не включен при загрузке. Он использует
  только `/etc/getomerch/database-rehearsal.env`; strict shadow mismatch
  проваливает repository contract test.
- Текущий rehearsal release выбирается symlink
  `/opt/getomerch/rehearsals/current`; production symlink от него независим.
- `GETOMERCH_DB_WRITE_SOURCE=server` реализован и проверен, но до cutover
  включается только в изолированном candidate/test process. Наличие server
  mutation layer не означает выполненный production write-cutover.
- Private queue `getomerch_jobs.jobs` и worker реализованы, но production
  Ozon routes до cutover используют прежний Supabase fallback. Наличие unit
  template не означает, что worker установлен или запущен.
- Stage-9 release слушает только `127.0.0.1:3101`. Два полных rehearsal цикла
  пройдены, но это не является разрешением на cutover: этап 10 требует
  отдельного maintenance window и явного Go/No-Go.
- Роли `getomerch_app`, `getomerch_migrator`, `getomerch_backup` ограничены
  локальными HBA-правилами и не могут подключаться к базам KOMUI. В обратную
  сторону роли KOMUI не допускаются к БД GetoMerch.
- Для всех футболок на Ozon использовать габариты упаковки `300 x 230 x 40 мм`
  и вес `250 г`.

## Бизнес-логика заказов в цех

Жизненный цикл заказа: `sent` → `ready` → `received`, плюс терминальный
`cancelled`.

- **Создание заказа** сразу означает отправку в цех: система выставляет
  `sent_at` и при необходимости перемещает заготовки со своего склада в цех.
- **Получено** — для каждой позиции создаётся производство в цехе:
  заготовки списываются, готовые изделия приходятся на склад цеха.
- **Связанный Ozon-заказ** закрывается через сценарий «Произвели и отправили»:
  сначала завершается заказ в цех, затем списывается отгрузка Ozon.
