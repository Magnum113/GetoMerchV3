# Независимое ревью миграции GetoMerch Admin на собственный сервер

Дата: `2026-07-22`.
Автор: независимая проверка (Claude Opus 4.8), выполнена без изменения кода и конфигурации.

Предмет ревью:

- документы миграции `docs/ADMIN_*`, `docs/GETOMERCH_KOMUI_*`;
- код приложения `src/` (frontend, API routes, DB/mutation/jobs layer);
- фактическое состояние production-сервера `89.111.152.112` (`admin.komui.ru`);
- PostgreSQL-контур, systemd, nginx, backup, firewall.

Все проверки выполнены read-only: `SELECT`-запросы, чтение конфигов, `curl` на
неаутентифицированные эндпоинты, чтение journald. Ни одна мутация не выполнялась.

---

## 1. Итоговая оценка

| Область | Оценка | Комментарий |
|---|---|---|
| Архитектура миграции и её документирование | **отлично** | Редко встречающийся уровень: 11 этапов, exit criteria, fingerprints, rollback-репетиции |
| Слой данных (repository/mutation/jobs) | **отлично** | Транзакции, идемпотентность, аудит, `FOR UPDATE`, корректный retry |
| Изоляция PostgreSQL | **отлично** | Раздельные роли, двусторонний HBA-запрет GetoMerch↔KOMUI, app-роль без DDL |
| Интеграция с Ozon | **отлично** | Timeout, AbortSignal, `Retry-After`, ретрай только transient |
| Безопасность периметра | **требует работы** | SSH password auth под активным брутфорсом, нет HSTS, обходимый rate-limit |
| Устойчивость конфигурации | **требует работы** | Опасный дефолт `supabase` в `readSourceEnv` без guard |
| Disaster recovery | **требует работы** | Ключ шифрования бэкапов на том же сервере; нет PITR |
| Инженерные практики (CI/тесты/линт) | **слабо** | Нет CI, нет юнит-тестов, нет ESLint-конфига |

Общий вывод: **миграция выполнена качественно и методично**, слой данных
написан на профессиональном уровне. Основные оставшиеся риски — не в логике
приложения, а в **периметре сервера, в дефолтах конфигурации и в disaster
recovery**. Ниже 5 находок уровня HIGH, 11 MEDIUM, 12 LOW.

---

## 2. Находки HIGH

### H-1. Дефолт источника данных — `supabase`, без единого guard

`src/lib/db/config.ts:15-16`

```ts
const readSource  = readSourceEnv("GETOMERCH_DB_READ_SOURCE",  "supabase");
const writeSource = readSourceEnv("GETOMERCH_DB_WRITE_SOURCE", "supabase");
```

`AGENTS.md:5` прямо фиксирует, что с `2026-07-17 13:08 UTC` runtime **обязан**
использовать `server/server`, а простой rollback на Supabase запрещён. При этом
в коде нет ни одной проверки, которая бы это обеспечила.

Сценарий отказа: `/etc/getomerch/database.env` не подхватился (опечатка в
`EnvironmentFile`, ручной `npm start`, новый unit, `systemctl edit`, восстановление
из старого бэкапа конфигов) → приложение **молча** стартует на замороженной
Supabase от 17.07.2026. Пользователь видит устаревшие остатки и заказы как
production-данные, а мутации уходят в архивную БД. Ошибки не будет — только
`getServerDatabaseUrl()` проверяется, и то лишь если источник уже `server`.

Рекомендация: сменить дефолт на `server` либо добавить fail-fast: если
`GETOMERCH_CUTOVER_STATE=live`, то `writeSource === "supabase"` должен бросать
`DatabaseConfigurationError` на старте.

### H-2. SSH: включена парольная аутентификация при активном брутфорсе

```
permitrootlogin without-password
passwordauthentication yes      <--
pubkeyauthentication yes
```

Фактическая статистика fail2ban на момент проверки:

```
Total failed:  8028
Total banned:  716
Currently banned: 16
```

Сервер под непрерывным перебором. Ключевая аутентификация уже настроена и
используется — парольная не нужна и является чистым добавлением поверхности
атаки. Компрометация SSH здесь означает мгновенный доступ ко всем секретам
(`/etc/getomerch/*.env`), к production-БД и к бэкапам.

Рекомендация: `PasswordAuthentication no`, `KbdInteractiveAuthentication no`,
опционально `AllowUsers`/`Match` и перенос SSH за нестандартный порт или
IP-allowlist.

### H-3. Учётная запись агента имеет безусловный passwordless root

`/etc/sudoers.d/codex-migrate`:

```
codex-migrate ALL=(ALL) NOPASSWD:ALL
```

Это учётка, которой оперируют AI-агенты. Полный root без пароля и без
ограничения набора команд. В связке с H-2 (парольный SSH) это означает, что
единственный барьер между интернетом и root — стойкость пароля SSH-пользователей
и fail2ban.

Рекомендация: либо сузить до конкретного списка команд
(`NOPASSWD: /usr/local/sbin/getomerch-*, /bin/systemctl status *` и т.д.), либо
оставить NOPASSWD только на период активных работ и отзывать после.

### H-4. Ключ расшифровки бэкапов хранится на том же сервере, что и данные

`/usr/local/sbin/getomerch-database-backup:194-205`:

```
gpg --batch --yes --pinentry-mode loopback --symmetric --cipher-algo AES256
```

Симметричная парольная фраза берётся с того же хоста (`/etc/komui/backup-encryption.key`,
`/etc/komui/backup.key`), приватный `GNUPGHOME` — `/var/backups/getomerch/database/.gnupg`.
Off-site копии уходят в Yandex S3, и **это работает** (проверено по журналу:
`external_upload=ok` ежечасно, последняя — `20260722T100005Z`).

Проблема: сценарий, ради которого делается off-site бэкап, — это потеря VPS.
Если VPS утрачен, ключ утрачен вместе с ним, и все зашифрованные архивы в S3
становятся мусором. Архив дополнительно содержит «encrypted runtime
configuration», то есть env-файлы со всеми production-секретами — цена ключа
максимальна.

Смежно: креды Yandex S3 (`/etc/komui/yandex-backup.env`) лежат на том же хосте и
имеют право записи в бакет. Root на сервере может удалить off-site историю.
Object Lock / immutability не настроены.

Рекомендация:
1. Вынести парольную фразу в отдельное хранилище вне сервера (менеджер паролей,
   бумажный конверт, второй хост) и **проверить восстановление с нуля** на
   чистой машине, имея только архив из S3 и ключ.
2. Включить versioning + Object Lock на бакете, выдать серверу write-only
   (без `DeleteObject`) ключ.

### H-5. Rate-limit логина обходится подделкой `X-Forwarded-For`

`src/app/api/auth/login/route.ts:63-66`:

```ts
function clientIp(request: NextRequest) {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwardedFor || request.headers.get("x-real-ip") || "unknown";
}
```

nginx (`/etc/nginx/sites-available/getomerch-admin`) передаёт
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` — это
`<клиентское значение>, <реальный IP>`. Приложение берёт **первый** элемент,
то есть полностью подконтрольный атакующему.

Последствия:
1. Лимит «5 попыток / 10 минут» не работает: достаточно менять заголовок на
   каждый запрос. Пароль администратора становится единственным барьером при
   неограниченном переборе.
2. `attempts: Map` растёт без ограничения и без вытеснения — каждый уникальный
   поддельный IP создаёт запись, которая живёт минимум 10 минут. Это прямой
   вектор исчерпания памяти процесса.
3. Усилитель: `verifyAdminPassword` выполняет PBKDF2-SHA256 (по умолчанию
   310 000 итераций, минимум 100 000 — `src/lib/auth/password.ts:9,17`) на каждую
   попытку. Без работающего лимита это ещё и CPU-DoS.

Плюс: лимит хранится в памяти процесса и обнуляется при каждом рестарте/деплое.

Рекомендация: использовать `$remote_addr` (`proxy_set_header X-Forwarded-For $remote_addr`)
или брать **последний** элемент XFF; добавить `limit_req` на `/api/auth/login`
в nginx; ограничить размер `attempts` (LRU) и добавить глобальный лимит попыток
поверх пер-IP.

---

## 3. Находки MEDIUM

### M-1. 12 роутов `/api/komui/*` защищены только middleware

Все `/api/admin/*` и `/api/ozon/*` вызывают `requireAdminSession()` внутри
обработчика (проверено grep'ом: 21 вызов). Ни один из роутов `/api/komui/*` этого
не делает — например `src/app/api/komui/storefront/orders/[orderId]/mark-shipped/route.ts`
и `src/app/api/komui/runtime/route.ts` начинают работу сразу.

Эти роуты — прокси в KOMUI admin API с production-токеном
(`KOMUI_PROD_ADMIN_API_TOKEN`), включая мутации: `mark-shipped`, `fulfillment`,
`create-product`, `link-offers`, `import`. Любая регрессия middleware (изменение
`matcher`, добавление пути в `PUBLIC_PREFIXES`, будущая уязвимость Next.js класса
CVE-2025-29927) превращает их в неаутентифицированный прокси в админку магазина.

Сейчас защита работает — проверено вживую:

```
GET  https://admin.komui.ru/api/admin/catalog  -> 401
GET  https://admin.komui.ru/api/komui/runtime  -> 401
POST https://admin.komui.ru/api/admin/rpc      -> 401
```

Но это единственный слой, в отличие от остальных 21 роута.

Рекомендация: добавить `await requireAdminSession()` в начало каждого
`/api/komui/*` обработчика — это ~12 строк и полностью выравнивает модель.

### M-2. Отсутствует HSTS во всех vhost

`grep -rn "Strict-Transport-Security" /etc/nginx/` → пусто. Проверено на живом
ответе `https://admin.komui.ru/login`: заголовка нет.

Присутствуют `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`,
`Permissions-Policy` — но именно HSTS отсутствует. Для админки с сессионной
кукой это означает окно SSL-strip при первом заходе или при явном `http://`.

Рекомендация: `add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;`
(осторожно с `includeSubDomains` — затронет `stage.komui.ru`).

### M-3. Сессия неотзываема, срок 60 дней

`src/lib/auth/session.ts`: токен — `base64url(JSON).HMAC-SHA256`, полезная
нагрузка `{sub:"owner", iat, exp}`, срок по умолчанию 60 дней
(`ADMIN_AUTH_SESSION_DAYS`).

- нет `jti`/версии сессии → отозвать конкретный токен невозможно;
- `/api/auth/logout` только удаляет куку у клиента; сам токен остаётся валидным
  до истечения `exp`;
- смена пароля администратора **не** инвалидирует выданные сессии;
- единственный способ отозвать всё — сменить `ADMIN_AUTH_COOKIE_SECRET` и
  перезапустить сервис.

Криптография при этом корректна: HMAC проверяется до парсинга payload,
сравнение constant-time, `secure` в production, `httpOnly`, `SameSite=Lax`.

Рекомендация: добавить в payload `ver`, сверять с `ADMIN_AUTH_SESSION_VERSION`
из env; сократить срок до 7–14 дней.

### M-4. Нет PITR; RPO — 1 час

```
wal_level    = replica
archive_mode = off
```

Резервное копирование — `pg_dump -Fc` ежечасно (работает, проверено). Значит,
при отказе теряется до часа операций: приёмки, списания, отгрузки Ozon.
В `ADMIN_FULL_SERVER_MIGRATION_STATUS.md:330` это честно зафиксировано как
открытый пункт («расширить диск перед WAL/PITR»).

Фактическое состояние диска: `/dev/sda1 20G, занято 15G, свободно 4.2G (78%)`.
Это же ограничение блокирует и PITR.

### M-5. Rehearsal-сервис всё ещё запущен с production-секретами

```
getomerch-admin-rehearsal.service   active running   127.0.0.1:3101
WorkingDirectory=/opt/getomerch/rehearsals/stage9-20260717T104528Z
EnvironmentFile=/etc/getomerch/admin-production.env
GETOMERCH_DB_WRITE_SOURCE=supabase
GETOMERCH_DB_SHADOW_COMPARE_STRICT=true
```

Это код от 17.07 (этап 9), работающий пятые сутки после cutover. Он:

- держит в памяти **все** production-секреты, включая `ADMIN_AUTH_COOKIE_SECRET`
  (то есть принимает те же сессионные куки, что и прод), `OZON_API_KEY`,
  `KOMUI_PROD_ADMIN_API_TOKEN`;
- настроен на запись в Supabase;
- определён в `/run/systemd/system` — то есть исчезнет при перезагрузке, что
  делает его состояние неочевидным;
- расходует RAM и держит пул к БД.

По плану этапа 11 rehearsal-контур подлежал снятию. Рекомендация: остановить,
удалить transient-unit, удалить релиз `stage9-*`.

### M-6. Worker проверяет maintenance-режим только на старте

`src/lib/jobs/worker.ts:24-25`:

```ts
export async function runBackgroundWorker() {
  assertAdminWritesEnabled();   // единственная проверка
  ...
  while (!stopping) { const job = await claimNextJob(workerId); ... }
```

Два следствия:

1. Включение `GETOMERCH_MAINTENANCE_MODE=read_only` при уже работающем воркере
   **не остановит запись** — цикл продолжит забирать задания и выполнять Ozon-sync
   с мутациями. Read-only режим оказывается неполным.
   (Смягчает: `runServerMutation` в `src/lib/db/mutations/runner.ts:45` тоже
   вызывает `assertAdminWritesEnabled()`, но `executeOrdersSync` и др. пишут не
   только через него.)
2. Обратный случай: при включённом maintenance воркер бросает на старте, а unit
   имеет `Restart=always` + `RestartSec=5` → бесконечный crash-loop с записью в
   журнал каждые 5 секунд.

Рекомендация: перенести проверку внутрь цикла (перед `claimNextJob`), а при
maintenance — засыпать, а не падать.

### M-7. Секреты Supabase остаются в production-окружении

`/etc/getomerch/admin-production.env` по-прежнему содержит:

```
GETOMERCH_SUPABASE_SERVER_KEY
GETOMERCH_SUPABASE_DATABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
```

Пункт «сменить пароль Supabase DB после ранней диагностики process list» в
`ADMIN_FULL_SERVER_MIGRATION_STATUS.md:324` открыт с 16.07 — то есть учётные
данные, засветившиеся в списке процессов, всё ещё действительны и всё ещё
загружены в production-процесс.

Дополнительно в `/etc/getomerch/` лежат три резервные копии env с секретами:

```
admin-production.env.bak.20260715224750
admin-production.env.bak.20260717T130513Z
admin-production.env.bak.20260717T130635Z
```

Права корректные (`0600 root:root`, каталог `0700`), но копии секретов
множатся без ротации.

### M-8. Деплой production зависит от доступности замороженной Supabase

`/usr/local/sbin/getomerch-deploy-from-git:531-532`:

```
smoke_supabase_readonly
add_check "Supabase read-only smoke"
```

После cutover Supabase — архив, а не источник истины. Согласно `AGENTS.md:6` он
хранится frozen минимум 30 дней, то есть примерно до `2026-08-16`. После его
приостановки или удаления **деплой админки перестанет проходить smoke** и
завершится откатом, хотя с самим релизом всё будет в порядке.

Рекомендация: сделать этот smoke условным по `GETOMERCH_DB_READ_SOURCE` или
удалить.

### M-9. Нет CI, нет юнит-тестов, нет рабочего линтера

- ESLint-конфига в репозитории нет (`eslint.config.*` / `.eslintrc*` отсутствуют)
  при заявленном `"lint": "next lint"` в `package.json:9`. Пункт «добавить
  неинтерактивную ESLint-конфигурацию» открыт в статусе миграции (строка 329).
- Все `check:*` скрипты (`scripts/check-*.mjs`) — интеграционные, требуют живую
  БД и запускаются вручную. Юнит-тестов нет ни одного.
- Деплой (`getomerch-deploy-from-git`) выполняет `npm ci` + `npm run build` +
  smoke. Типы проверяются только через `next build`; линт и тесты — нет.
- Деплой берёт `origin/main` HEAD без проверки подписи и без пиннинга на
  ревьюированный тег: компрометация GitHub-аккаунта = выполнение произвольного
  кода на production при следующем деплое.

Учитывая, что вся бизнес-логика остатков и денег теперь в
`src/lib/db/mutations/`, отсутствие автотестов на инварианты (не уйти в минус,
идемпотентность, FBO не списывает склад) — самый значимый долгосрочный риск
качества.

### M-10. `getomerch-admin.service` захарден слабее, чем worker

| Директива | admin | worker |
|---|---|---|
| `NoNewPrivileges` | ✅ | ✅ |
| `PrivateTmp` | ✅ | ✅ |
| `ProtectHome` | ❌ | ✅ |
| `ProtectSystem=strict` | ❌ | ✅ |
| `UMask=0077` | ❌ | ✅ |

Веб-процесс — единственный, доступный из интернета, и при этом защищён слабее
фонового. Ассиметрия выглядит как недосмотр, а не как осознанное решение.

### M-11. Осиротевшие базы данных на диске 78%

```
getomerch_production_previous_20260717_130717   7534 kB
getomerch_rehearsal                              20 MB
komui_production_prev_20260630163957             15 MB
```

Плюс `/opt/getomerch/rehearsals/stage9-*` с полным `node_modules`. При 4.2 GiB
свободного места и заблокированном по этой причине PITR это заметный объём.

---

## 4. Находки LOW

| # | Находка | Расположение |
|---|---|---|
| L-1 | `ssl: { rejectUnauthorized: false }` — сейчас не активируется (`localhost` → SSL off), но при переносе БД на удалённый хост даст MITM-уязвимость молча | `src/lib/db/pool.ts:36` |
| L-2 | Нет `Content-Security-Policy` ни на одном vhost | nginx |
| L-3 | Раскрытие версий: `x-powered-by: Next.js`, `server: nginx/1.24.0 (Ubuntu)`; `server_tokens off` задан только для `komui-staging` | nginx, `next.config.mjs` |
| L-4 | Нет явной проверки `Origin`/CSRF-токена. Практически закрыто `SameSite=Lax` + JSON-роутами, но defense-in-depth отсутствует | `src/app/api/admin/rpc/route.ts` |
| L-5 | `lockRow(query, table, id, "*")` использует `SELECT *` вопреки `AGENTS.md:8` (на малых справочниках — некритично) | `src/lib/db/mutations/product-catalog.ts:412` |
| L-6 | `log_connections=off` — нет аудита подключений к БД | postgresql.conf |
| L-7 | Опечатка `OZON_CLIEN_ID` закреплена в коде и env как основное имя | `src/lib/ozon/client.ts:118` |
| L-8 | `/api/komui/*` возвращают наружу `rawText` от KOMUI и `e.message` — утечка внутренних деталей | `src/app/api/komui/**/route.ts` |
| L-9 | fail2ban имеет единственный jail `sshd`; нет jail на nginx / брутфорс `/api/auth/login` | fail2ban |
| L-10 | 188 пакетов ожидают обновления при работающем `unattended-upgrades` | apt |
| L-11 | Нет `default_server` vhost — запрос с неизвестным `Host` попадает в первый блок (`api.komui.ru`) | nginx |
| L-12 | `dispatchJob` без `default`-ветки: неизвестный тип задания из БД вернёт `undefined` и будет записан как успешный | `src/lib/jobs/worker.ts:114-145` |

Отдельно, не как дефект: **RLS отключена** (0 из 20 таблиц) — сознательный
размен относительно 32 permissive-политик Supabase. Для однопользовательской
админки с выделенной ролью это оправдано, но означает, что приложение теперь
единственный барьер: любой обход авторизации даёт полный доступ к данным.
Это усиливает значимость M-1.

---

## 5. Что сделано действительно хорошо

Это не формальная секция — перечисленное ниже проверено, а не принято на веру.

**Изоляция PostgreSQL — образцовая.**
`pg_hba_getomerch.conf` запрещает доступ в обе стороны явными `reject`-правилами,
а не только отсутствием grant'ов:

```
local getomerch_* getomerch_app,getomerch_migrator,getomerch_backup  scram-sha-256
local all         getomerch_app,getomerch_migrator,getomerch_backup  reject
local getomerch_* komui_app,komui_migrator,komui_backup              reject
```

Роль `getomerch_app` не имеет `CREATE` ни на схеме, ни на БД (проверено:
`has_schema_privilege → f`, `has_database_privilege → f`), ни одной superuser-роли
кроме `postgres`, `listen_addresses=127.0.0.1,::1`, `scram-sha-256`.
`audit_log` и `job_events` выданы только `INSERT, SELECT` — без `UPDATE`/`DELETE`,
то есть аудит защищён от подчистки самим приложением. Это осознанное и правильное
решение.

**Слой мутаций.** `runServerMutation` (`src/lib/db/mutations/runner.ts`)
объединяет в одной транзакции: claim идемпотентности через
`INSERT ... ON CONFLICT DO NOTHING`, саму операцию, запись в `audit_log` и
пометку `succeeded`. Повтор с тем же ключом и тем же payload-hash возвращает
сохранённый ответ; тот же ключ с другим payload — `idempotency_conflict`.
Retry ограничен исключительно `40001`/`40P01` (`transaction.ts:63`) — именно так,
как надо, без ретраев на произвольных ошибках.

**Отсутствие SQL-инъекций.** Проверено целенаправленно. Все места интерполяции
идентификаторов (`crud.ts:13-15`, `product-catalog.ts:99,384,412`) получают имена
таблиц и колонок либо из литералов кода, либо через `pickPatch`, где целевые
имена колонок захардкожены в allowlist-мапе. Пользовательские данные везде идут
через `$n`-плейсхолдеры.

**Ozon-клиент** (`src/lib/ozon/client.ts`) — один из лучших фрагментов проекта:
`AbortSignal.any` для комбинации timeout+cancel, честный разбор `Retry-After`
(и число, и HTTP-дата), экспоненциальная задержка с джиттером, ретрай только на
408/429/5xx и transient-сетевых, санитизация тела ошибки до 300 символов,
override базового URL заперт за флагом **и** ограничен `http://localhost`.

**Прочее, проверенное фактически:**

- Next.js `15.5.18` — CVE-2025-29927 (обход middleware через
  `x-middleware-subrequest`) закрыт в 15.2.3; middleware как гейт использовать
  безопасно.
- Гигиена логов: 5000 строк журнала админки, 0 совпадений по
  `postgres://|service_role|eyJ...|Api-Key|X-Komui-Admin-Token|password`.
- `dangerouslySetInnerHTML`, `eval`, `new Function`, `innerHTML` — не найдены.
- Секреты не попадают в клиентский бандл: единственные `NEXT_PUBLIC_*` в `src/` —
  URL и anon-key Supabase (`src/lib/supabase/server.ts:12,50`).
- Права на секреты: `/etc/getomerch` — `0700 root:root`, все `*.env` — `0600`.
- ufw: default deny incoming, открыты только 22/80/443; всё остальное
  (3000/3001/3100/3101/5432/10808/18789) — на loopback.
- Бэкапы работают: ежечасно, GFS-ретеншн (3д/14д/42д/190д), sha256, off-site
  upload `external_upload=ok`, последний — `20260722T100005Z`.
- `systemctl --failed` → пусто.
- Деплой: immutable releases, `git reset --hard origin/main`, проверка свободного
  места, smoke-проверки, автоматический rollback, journal в
  `deploy-registry.jsonl`. Текущий релиз `20260720T133639Z-admin-b8d45ca6204b`
  соответствует HEAD репозитория.
- Миграции `0001`–`0003` применены, SHA-256 в ledger совпадают, 20 бизнес-таблиц.

---

## 6. Приоритизированный план действий

### Немедленно (в течение суток)

1. **H-2** `PasswordAuthentication no` в sshd → `systemctl reload ssh`.
   Одна строка, снимает наиболее активно эксплуатируемую поверхность.
2. **H-5** `proxy_set_header X-Forwarded-For $remote_addr;` для
   `admin.komui.ru` + `limit_req` на `/api/auth/login`.
3. **H-4** Вынести парольную фразу GPG в хранилище вне сервера и **проверить**
   восстановление на чистой машине из S3-архива.

### На этой неделе

4. **H-1** Fail-fast на `writeSource === "supabase"` при `cutover=live`, либо
   смена дефолта на `server`.
5. **M-1** `requireAdminSession()` в 12 роутах `/api/komui/*`.
6. **M-5** Остановить и удалить rehearsal-контур (сервис, transient-unit, релиз).
7. **M-2** HSTS.
8. **H-3** Сузить sudoers для `codex-migrate`.
9. **M-7** Сменить пароль Supabase DB, удалить `.bak`-копии env.

### В течение месяца

10. **M-9** ESLint-конфиг + юнит-тесты на инварианты склада + CI на PR.
11. **M-8** Убрать зависимость деплоя от Supabase **до** истечения 30-дневного
    окна (~16.08.2026).
12. **M-6** Проверка maintenance внутри цикла воркера.
13. **M-3** Версионирование сессий + сокращение срока до 7–14 дней.
14. **M-10** Выровнять хардненинг `getomerch-admin.service` по worker.
15. **M-11** Удалить осиротевшие БД и релизы; расширить диск.
16. **M-4** После расширения диска — включить WAL-архивирование и PITR.

---

## 7. Замечание о самих документах миграции

Документация этапов (`ADMIN_MIGRATION_STAGE_0_1` … `STAGE_10_CUTOVER`,
`ADMIN_FULL_SERVER_MIGRATION_STATUS.md`) заслуживает отдельного упоминания:
зафиксированы exit criteria, fingerprints данных, число проверок, p95-латентности,
двукратные репетиции, отдельно отмечено, что «наличие кода без фактической
проверки не считается завершением». Заявленное состояние **совпало с фактическим**
по всем пунктам, которые я смог проверить независимо: миграции, роли, HBA, состав
таблиц, активность сервисов и таймеров, соответствие релиза коммиту.

Единственное расхождение с планом — раздел «Последняя проверенная серверная точка»
описывает rehearsal-сервис как активный, но этап 11 предполагал его вывод из
эксплуатации; он всё ещё работает (M-5).

Таблица открытых рисков (раздел 15 статуса) честна: три открытых пункта —
пароль Supabase, ESLint, расширение диска — подтверждены как всё ещё открытые.

---

*Ревью выполнено без изменений кода, конфигурации и данных.*
