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

С `2026-07-17 13:08 UTC` рабочая production-схема живёт в локальной PostgreSQL
БД `getomerch_production` на VPS; таблицы используют префикс `merch_`.
Воспроизводимый baseline и migration runner находятся в `db/`; команды и правила описаны в
`db/README.md`. Подробная модель и ограничения описаны в `DATABASE.md`,
инварианты разработки — в `ARCHITECTURE.md`.

Production-приложение на `admin.komui.ru` читает и пишет локальную БД через
роль `getomerch_app`; `getomerch-worker.service` обрабатывает durable Ozon jobs.
Supabase зафиксирован на момент финального export и сохраняется минимум 30 дней
как rollback/archive source, но больше не является production writer.
`getomerch_rehearsal` остаётся отдельной проверочной БД и не является replica.

Этапы 6–9 server migration завершены: read-only контур, admin RPC mutations и
server-side Ozon sync/import проходят через независимые service layers.
Проверочная сборка
читает `getomerch_rehearsal` на `127.0.0.1:3101` и сравнивает read-домены с
Supabase; её постоянный write-source остаётся Supabase. Server writes отдельно
проверены на одноразовой изолированной БД: 12/12 групп, включая concurrency,
idempotency и fault rollback, плюс 10/10 групп durable queue/Ozon integration.
До cutover эти проверки выполнялись изолированно. Управление rehearsal-процессом:
`sudo /usr/local/sbin/getomerch-admin-rehearsal {start|stop|restart|status|test}`.
Два полных pre-production цикла проверили fresh export/import, все UI/KOMUI
sections, mutations/jobs/Ozon, native PostgreSQL restore и rollback-runtime на
Supabase. Подробности этапа 9:
`docs/ADMIN_MIGRATION_STAGE_9_REPORT_2026-07-17.md`.

Этап 10 выполнен. Release E переключил production source of truth на
`getomerch_production`. `GETOMERCH_MAINTENANCE_MODE=read_only` оставляет страницы,
health и read API доступными, показывает плашку в UI и возвращает `503` на
mutation/job routes. Переключение управляется только через:

```bash
sudo /usr/local/sbin/getomerch-cutover preflight
sudo /usr/local/sbin/getomerch-cutover prepare --confirm-maintenance
sudo /usr/local/sbin/getomerch-cutover go --confirm-writes
sudo /usr/local/sbin/getomerch-cutover abort --confirm-abort
sudo /usr/local/sbin/getomerch-cutover status
```

`prepare` оставляет запись закрытой. `go` выполнен `2026-07-17 13:08 UTC`;
простой abort на Supabase теперь запрещен, потому что в локальной БД уже есть
новые операции. Текущий статус проверяется командой `getomerch-cutover status`.

Основные чтения, записи и синхронизации production теперь используют локальный
PostgreSQL service/repository layer. Старые Supabase REST/direct adapters пока
сохраняются только на период стабилизации и не должны получать новые записи.

Любое новое DDL-изменение оформляется следующей forward-only миграцией в
`db/migrations`. Файл `0001_getomerch_baseline.sql` неизменяем; production не
применяет migration runner автоматически при запуске приложения.

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

Во время стабилизации старые Supabase fallback/diagnostic paths могут
использовать прямое server-side подключение. Production `server/server` runtime
от этой переменной не зависит.

```env
GETOMERCH_SUPABASE_DATABASE_URL=postgresql://postgres.<project-ref>:<password>@<region>.pooler.supabase.com:6543/postgres
GETOMERCH_POSTGRES_SSL=true
GETOMERCH_POSTGRES_POOL_MAX=1
GETOMERCH_POSTGRES_POOL_MAX_USES=1
```

Если legacy Supabase path временно запускается на VPS, нужно использовать pooler в transaction mode
(`pooler.supabase.com:6543`). Прямой host `db.<ref>.supabase.co:5432` может
резолвиться в IPv6 и падать с `ENETUNREACH`, а session pooler `:5432` уже
упирался в лимит сессий. Значения `POOL_MAX=1` и `POOL_MAX_USES=1` оставлены
консервативно: они стабилизируют `/orders` и основной список `/inventory` через
pooler, не раздувая число долгих сессий.

Для рабочей локальной БД используется отдельный server-only URL. Текущие
production flags после cutover:

```env
GETOMERCH_DATABASE_URL=postgresql://getomerch_app:<password>@127.0.0.1:5432/getomerch_production
GETOMERCH_DB_READ_SOURCE=server
GETOMERCH_DB_WRITE_SOURCE=server
GETOMERCH_DB_SHADOW_COMPARE=false
GETOMERCH_DB_SHADOW_COMPARE_STRICT=false
```

В постоянном rehearsal read-source равен `server`, shadow compare и strict
включены, а write-source остаётся `supabase`. Production server write-source
защищён транзакционным mutation layer, idempotency ledger и audit log.

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
admin session, а остальные API token не принимают. Production worker установлен,
включён и работает только с локальной БД. Автоматические Ozon timers первые
24 часа после cutover остаются выключенными; ручные синхронизации ставят jobs
в durable queue.

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

`Status admin prod` показывает человекочитаемую сводку: доступность login и
защищенного API, состояние web/worker/PostgreSQL/nginx, hourly backup timer,
последнюю off-site копию, failed units, совпадение с `origin/main`, последний
release и заполнение диска. Полный технический вывод остается доступен через
`sudo /usr/local/sbin/getomerch-deploy-status`.

Важные нюансы:

- `admin.komui.ru` закрыт собственной авторизацией Next.js:
  `/login` + HttpOnly Secure cookie + HMAC-подписанный token.
- Старую nginx Basic Auth для админки сняли после внедрения app-auth.
- `komui.ru` и `stage.komui.ru` обслуживаются отдельным проектом
  `/opt/komui`; этот репозиторий туда не копировать и с ним не объединять.
- Admin UI обращается к production/stage KOMUI только через backend API, а не
  прямым SQL в PostgreSQL магазина.
- Новый BFF read-path выбирает источник единым
  `GETOMERCH_DB_READ_SOURCE=supabase|server`. Production использует локальный
  PostgreSQL, а rehearsal — отдельную локальную БД с strict Supabase shadow.
- Матрица остатков больше не использует старый hybrid route: server adapter
  читает явные product columns и один SQL aggregate остатков, Supabase adapter
  использует ограниченную пагинацию. Оба возвращают один API contract.
- Список положительных остатков загружается страницами через
  `/api/admin/inventory`; `/orders` и вкладка `Изделия` всегда дочитывают все
  страницы и не строят наличие по произвольным первым строкам.
- Список заказов Ozon также дочитывается bounded page loop через
  `/api/admin/ozon/orders`; резервирование остатков учитывает все сохранённые
  активные FBS-заказы, а не только 50 последних записей.
- Эквивалентные legacy/new SKU суммируются в ячейке матрицы, а реальные варианты
  худи (`hoodie_fit`/`hoodie_fabric`) выводятся отдельными строками.
- `getomerch_production` является текущим runtime source of truth;
  `/etc/getomerch/database.env` подключён к web и worker systemd units.
  `getomerch_rehearsal` остаётся изолированной проверочной копией.
- Runtime-only `getomerch-admin-rehearsal.service` слушает только
  `127.0.0.1:3101`, не имеет nginx route и не включен при загрузке. Он использует
  только `/etc/getomerch/database-rehearsal.env`; strict shadow mismatch
  проваливает repository contract test.
- Текущий rehearsal release выбирается symlink
  `/opt/getomerch/rehearsals/current`; production symlink от него независим.
- `GETOMERCH_DB_WRITE_SOURCE=server` включён в production; mutation layer
  использует локальные транзакции, блокировки, idempotency и audit.
- Private queue `getomerch_jobs.jobs` и production worker активны. Ozon routes
  ставят sync/import operations в durable queue.
- Stage-9 rehearsal остаётся исторической контрольной точкой на
  `127.0.0.1:3101`; production cutover выполнен отдельной командой Go.
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
