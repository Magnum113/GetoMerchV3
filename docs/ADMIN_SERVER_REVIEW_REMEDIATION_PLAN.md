# План устранения замечаний по серверной админке GetoMerch

Дата аудита: 14 июля 2026 года.

Этот документ описывает рекомендуемый порядок исправлений после code review
переноса админки на `admin.komui.ru`. Главная цель — закрыть реальные риски,
не нарушив работу магазина `komui.ru`, production PostgreSQL магазина и
текущей админки, которая пока использует Supabase.

## 1. Границы работ и два отдельных репозитория

В проекте остаются два независимых приложения и два независимых Git-репозитория:

| Контур | Локальный путь | Репозиторий | Что в нём менять |
|---|---|---|---|
| Админка GetoMerch | `/Users/kadimagomedov/Documents/GetoMerchV3` | `GetoMerchV3.git` | Авторизация, Supabase BFF, deploy/rollback админки, документация админки |
| Магазин KOMUI | `/Users/kadimagomedov/Documents/KomuiMerch` | `komui.git` | Общий Telegram deploy bot, общий backup/healthcheck и только общая серверная инфраструктура |

Нельзя копировать содержимое одного репозитория в другой, объединять их `.git`
или запускать `git add .` из общей родительской папки. Коммиты, push и deploy
делаются отдельно для каждого проекта.

Production-магазин продолжает работать независимо от админки. Изменения в
админке не должны:

- перезапускать `komui-production-backend` без необходимости;
- менять схему `komui_production`;
- переключать `/opt/komui/current`;
- изменять CDEK, Т-Банк и checkout магазина;
- переносить секреты магазина в клиентский JavaScript админки.

## 2. Приоритеты

Исправления рекомендуется выполнять в таком порядке:

1. Зафиксировать состояние и наладить backup админки.
2. Исправить production-сборку с `NEXT_PUBLIC_SUPABASE_*`.
3. Ограничить рост release-каталога и диска.
4. Подготовить защищённый server-side слой для Supabase.
5. Перевести интерфейс с прямого Supabase на BFF.
6. Закрыть небезопасные RLS-политики Supabase.
7. Усилить авторизацию и защиту административных API.
8. Исправить Telegram-меню и безопасность deploy-команд.
9. Усилить systemd/nginx и эксплуатационные алерты.
10. Добавить полноценные тесты, smoke-check и актуализировать документацию.

RLS нельзя закрывать раньше шагов 4–5: текущий интерфейс пишет в Supabase прямо
из браузера и после преждевременного закрытия политик перестанет работать.

---

## Этап 1. Зафиксировать baseline и добавить backup админки

### Зачем

Текущий `/usr/local/sbin/komui-backup` успешно создаёт и отправляет backup
магазина, но не включает GetoMerch. Документация ошибочно утверждает, что
конфигурация и deploy registry админки уже резервируются.

Перед изменением RLS, deploy-скриптов и авторизации необходимо иметь точку
восстановления.

### Что сделать

1. Сохранить в audit-записи:
   - активный admin release и commit;
   - текущий `origin/main`;
   - состояние `getomerch-admin.service` и nginx;
   - список текущих Supabase policies;
   - результат Supabase Security Advisor.
2. Создать отдельный `getomerch-backup` либо аккуратно расширить общий backup.
3. В зашифрованный архив включить:
   - `/etc/getomerch/admin-production.env`;
   - unit `getomerch-admin.service`;
   - nginx vhost `admin.komui.ru`;
   - `/var/lib/getomerch/deploy-registry.jsonl`;
   - `/var/lib/getomerch/deploy-current.json`;
   - активный release или manifest с commit и способом его восстановления;
   - последние deploy-логи без лишнего многолетнего архива.
4. Отдельно организовать export Supabase:
   - schema-only export;
   - data export таблиц `merch_*` и связанных таблиц;
   - хранение в зашифрованном Object Storage;
   - отдельную политику хранения, например 7 ежедневных и 4 еженедельных копии.
5. Выполнить тестовое восстановление в отдельную временную папку/тестовую БД.

### Безопасность

- Не печатать env и секреты в Telegram и deploy-логи.
- Архивировать env только после шифрования или внутри локальной временной папки
  с правами `0700`.
- Не складывать backup в Git.
- Не считать загрузку файла в bucket успешным backup без проверки расшифровки и
  контрольных сумм.

### Критерий готовности

- timer последовательно создаёт backup;
- архив присутствует локально и в Yandex Object Storage;
- внутри расшифрованной тестовой копии есть GetoMerch env, registry и manifest;
- выполнен и задокументирован хотя бы один тест восстановления;
- ошибка backup отправляется в Telegram.

### Статус внедрения на 14 июля 2026

Сделано:

- добавлен отдельный backup script `ops/getomerch-backup`;
- добавлены `ops/getomerch-backup.service` и `ops/getomerch-backup.timer`;
- script установлен на сервер как `/usr/local/sbin/getomerch-backup`;
- timer включён на сервере и запускает `getomerch-backup.service`;
- baseline-аудит положен в `docs/ADMIN_SERVER_BASELINE_2026-07-14.md` и на
  сервер в `/var/lib/getomerch/audit/baseline-2026-07-14.md`;
- ручной backup и backup через systemd service успешно создали encrypted
  archive в `/var/backups/getomerch/daily`;
- archive выгружен в Yandex Object Storage с prefix `getomerch`;
- test restore выполнен в отдельную временную папку: SHA256 проверен, manifest,
  env, deploy registry/current state, nginx/systemd config и audit record есть.

Ограничение:

- полный Supabase `pg_dump` пока не выполняется, потому что на сервере нет
  отдельного `GETOMERCH_SUPABASE_DATABASE_URL`; script поддерживает этот режим
  через `/etc/getomerch/backup.env`, а пока кладёт marker
  `skipped_missing_database_url`;
- RLS/policies и Security Advisor baseline сняты через Supabase MCP и
  задокументированы, но автоматический nightly Supabase export нужно включить
  после выдачи server-side DB connection string.

---

## Этап 2. Исправить build-time Supabase-конфигурацию

### Зачем

`NEXT_PUBLIC_SUPABASE_URL` и `NEXT_PUBLIC_SUPABASE_ANON_KEY` нужны во время
`next build`. Сейчас env загружается только systemd при запуске приложения,
поэтому production browser bundle собирается без фактического URL и ключа.

### Что сделать

В `ops/getomerch-deploy-from-git` перед `npm run build`:

1. Безопасно прочитать `/etc/getomerch/admin-production.env`.
2. Экспортировать в build-процесс только:
   - `NEXT_PUBLIC_SUPABASE_URL`;
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
3. Не экспортировать в клиентскую сборку:
   - `ADMIN_AUTH_COOKIE_SECRET`;
   - Ozon credentials;
   - KOMUI admin token;
   - Supabase service role key;
   - другие серверные секреты.
4. До сборки проверить, что обе публичные переменные непустые и имеют ожидаемый
   формат.
5. После сборки добавить assertion, подтверждающий, что клиентская конфигурация
   сформирована корректно. Проверка не должна выводить сам ключ.
6. Добавить smoke реального read-only экрана, который загружает данные Supabase.

### Порядок выкладки

1. Локальный `npm ci`, `npm run build`, `npx tsc --noEmit`.
2. Commit и push только в `GetoMerchV3.git`.
3. Deploy админки.
4. Проверка входа, товаров, остатков, заказов и справочников.
5. При ошибке — `getomerch-rollback prod`, без изменений магазина.

### Критерий готовности

- после нового deploy интерфейс читает Supabase без client-side configuration
  error;
- в клиентских чанках нет ни одного серверного секрета;
- deploy падает до активации release, если публичные Supabase-переменные не
  заданы;
- rollback остаётся рабочим.

### Статус внедрения на 15 июля 2026

Причина production-сбоя с заказами была в этом этапе: browser bundle был
собран без `NEXT_PUBLIC_SUPABASE_URL` и `NEXT_PUBLIC_SUPABASE_ANON_KEY`, хотя в
runtime env systemd эти переменные были. Поэтому `@supabase/ssr` падал в
браузере с ошибкой `Your project's URL and API key are required`.

Сделано:

- `ops/getomerch-deploy-from-git` перед `npm run build` читает
  `/etc/getomerch/admin-production.env` без `source` всего файла;
- в build-process экспортируются только `NEXT_PUBLIC_SUPABASE_URL` и
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`;
- перед сборкой проверяется наличие и формат обеих переменных;
- после сборки проверяется, что public Supabase config попал в `.next/static`;
- client assets проверяются на отсутствие имён server-only env:
  auth secrets, Ozon keys, KOMUI tokens, Supabase DB/service-role markers;
- добавлен read-only smoke к Supabase REST `merch_ozon_orders?select=id&limit=1`;
- deploy должен падать до создания/активации release, если public Supabase env
  не задан или не встроился в client assets.

---

## Этап 3. Добавить retention релизов и контроль диска

### Зачем

Четыре admin release занимают около 2,3 ГБ, а на сервере остаётся около 3,9 ГБ.
Без очистки несколько следующих деплоев могут заполнить диск и затронуть не
только админку, но также магазин, PostgreSQL, логи и backup.

### Что сделать

1. После успешного deploy и smoke удалять старые admin release.
2. Всегда сохранять:
   - активный release;
   - release, на который указывает предыдущий успешный deploy;
   - ещё 1–2 последних успешных release;
   - release, помеченные как сохранённые вручную.
3. Никогда не удалять путь, на который указывает `/opt/getomerch/current`.
4. Не выполнять cleanup до успешной активации и smoke-check.
5. Очищать неактуальную `/opt/getomerch/build-source` после ошибок.
6. Добавить отдельную безопасную очистку npm cache по размеру/возрасту.
7. Добавить GetoMerch в disk healthcheck.

### Критерий готовности

- после нескольких тестовых deploy остаётся заданное количество release;
- active и предыдущий release доступны для rollback;
- rollback после cleanup проходит;
- при нехватке места deploy останавливается до `npm ci` и присылает понятный
  Telegram alert.

### Статус внедрения на 15 июля 2026

Сделано в `ops/getomerch-deploy-from-git`:

- добавлена preflight-проверка свободного места до checkout/build и перед
  `npm ci`, созданием release и production install;
- порог свободного места задаётся через `GETOMERCH_MIN_FREE_MB`, default
  `2048`;
- после успешной активации и smoke запускается retention старых release;
- всегда сохраняются active release, предыдущий release, последние успешные
  release по registry и release с marker-файлом `.getomerch-keep` или
  `KEEP_RELEASE`;
- количество дополнительных успешных release задаётся через
  `GETOMERCH_KEEP_RECENT_SUCCESSFUL`, default `2`;
- stale `/opt/getomerch/build-source` и `*.tmp` release очищаются до сборки и
  при ошибке;
- npm cache/log cleanup выполняется после успешного deploy, порог задаётся
  через `GETOMERCH_NPM_CACHE_MAX_MB`, default `1024`;
- post-deploy cleanup не откатывает уже активированный рабочий release, если
  сама очистка дала warning.

Сделано в `ops/getomerch-deploy-status`:

- добавлен блок `disk` со свободным местом, размером release-каталога,
  количеством release и размером npm cache/logs.

Проверено на сервере:

- обновлённые `getomerch-deploy-from-git` и `getomerch-deploy-status`
  установлены в `/usr/local/sbin`;
- deploy `main` прошёл успешно, active release:
  `20260715T101417Z-admin-94e900c02df5`;
- retention после deploy оставил active release, rollback release и последние
  успешные release, всего 4 директории в `/opt/getomerch/releases`;
- rollback на предыдущий release прошёл smoke-check, затем текущий `main`
  повторно задеплоен;
- low-disk preflight проверен искусственным порогом
  `GETOMERCH_MIN_FREE_MB=999999`: deploy остановился до `npm ci` с понятной
  ошибкой;
- `getomerch-deploy-status` показывает `disk` block: свободное место, release
  count/size и npm cache.

---

## Этап 4. Спроектировать server-side BFF для Supabase

### Зачем

Сейчас пароль защищает только Next.js UI. Браузер получает publishable key и
напрямую выполняет административные операции в Supabase, где RLS разрешает
анонимную запись. Поэтому данные можно изменять в обход `admin.komui.ru`.

### Целевая схема

```text
Browser
  -> admin.komui.ru/api/admin/...
  -> requireAdminSession()
  -> server-only Supabase client
  -> Supabase Postgres
```

### Что сделать

1. Добавить единый `requireAdminSession()` для Route Handlers.
2. Добавить server-only Supabase client:
   - URL из server env;
   - service role key либо ограниченный серверный ключ;
   - запрет импорта этого модуля в client components.
3. Разбить API по доменам:
   - товары и справочники;
   - остатки и движения;
   - заказы Ozon;
   - производство;
   - расходы и финансы;
   - импорт и синхронизация.
4. Для каждого mutation endpoint добавить:
   - валидацию входа;
   - явный allowlist изменяемых полей;
   - единый формат ошибок;
   - audit log пользователя, действия и сущности;
   - идемпотентность там, где возможен повторный запрос.
5. Composite-операции с несколькими таблицами выносить в транзакционные
   Postgres RPC, чтобы частичный сбой не оставлял неконсистентные данные.
6. Не объединять Supabase BFF с API production PostgreSQL магазина. Связь с
   магазином по-прежнему идёт через существующий KOMUI admin API.

### Переходный режим

На этом этапе старый browser Supabase client ещё остаётся, а новые API
добавляются параллельно. RLS пока не меняется.

### Критерий готовности

- серверные endpoints без cookie возвращают `401`;
- endpoints с валидной сессией выполняют read-only запросы;
- service role key отсутствует в `_next/static` и HTML;
- ошибки не раскрывают токены, SQL и env;
- имеются тесты минимум на auth, validation и основные CRUD-операции.

---

## Этап 5. Перевести UI с прямого Supabase на BFF

### Зачем

RLS можно безопасно закрыть только после того, как браузер перестанет напрямую
обновлять административные таблицы.

### Рекомендуемый порядок миграции экранов

1. Справочники и read-only списки.
2. Товары и дизайны.
3. Остатки и транзакции.
4. Заказы Ozon.
5. Заказы в цех.
6. Расходы и финансовые операции.
7. Ozon import/sync.

Для каждого раздела:

1. Заменить вызовы из `src/lib/api.ts` на `/api/admin/...`.
2. Сохранить существующие типы данных и поведение UI.
3. Проверить чтение, создание, редактирование и удаление на тестовой сущности.
4. Добавить обработку `401`, `403`, `409`, `422` и `500`.
5. Удалить больше не используемые прямые browser Supabase методы.
6. Зафиксировать раздел как мигрированный в checklist.

### Критерий готовности

- поиск по `src` не находит административных browser-side `.from(...)`;
- publishable key не даёт возможности выполнить административную запись;
- все рабочие экраны проходят ручной regression-check;
- Ozon sync и импорт продолжают работать через сервер.

---

## Этап 6. Закрыть Supabase RLS и небезопасные функции

### Зачем

Это фактическое закрытие главного security-риска. Выполняется только после
успешного этапа 5 и свежего backup.

### Что сделать

1. Создать версионируемую SQL migration, а не менять policies вручную без
   истории.
2. Удалить политики `ALL USING (true) WITH CHECK (true)` для `anon` и `public`.
3. Для административных таблиц запретить анонимные SELECT/INSERT/UPDATE/DELETE.
4. Для действительно публичных данных оставить только минимальный `SELECT` с
   ограничением строк/полей, если он необходим другому приложению.
5. Проверить `SECURITY DEFINER` функции:
   - убрать EXECUTE у `public`, `anon` и `authenticated`, если не требуется;
   - убрать hardcoded deploy hook из функции;
   - хранить внешние URL и секреты вне SQL source.
6. Пересмотреть backup-таблицы в public schema: удалить ненужные либо перенести
   в закрытую schema.
7. Повторно запустить Supabase Security Advisor.

### Безопасная выкладка

1. Свежий export Supabase.
2. Проверка миграции на отдельной копии/branch.
3. Deploy BFF-версии админки.
4. Применение RLS migration.
5. Полный smoke UI.
6. Проверка, что запрос с publishable key без сессии больше не может изменять
   данные.

### Критерий готовности

- Security Advisor не показывает permissive write policies;
- anon не может читать финансы, остатки, заказы и производство;
- anon не может записывать ни в одну административную таблицу;
- админка с валидной сессией продолжает работать через BFF.

---

## Этап 7. Усилить auth и административные API

### Что сделать

1. Оставить middleware как первый уровень защиты.
2. Добавить `requireAdminSession()` внутрь всех критических Route Handlers.
3. Исправить определение IP:
   - nginx должен передавать приложению доверенный `$remote_addr`;
   - приложение не должно доверять первому клиентскому `X-Forwarded-For`.
4. Добавить nginx `limit_req` для `/api/auth/login`.
5. Ограничивать попытки одновременно:
   - по IP;
   - глобально;
   - при необходимости по временному fingerprint без сохранения персональных
     данных.
6. Удалять протухшие записи limiter и ограничить максимальный размер памяти.
7. Добавить аудит успешных входов и блокировок без записи пароля/cookie.
8. Рассмотреть ротацию cookie secret с поддержкой текущего и предыдущего ключа
   на короткий переходный период.
9. Для особо опасных операций добавить повторное подтверждение в UI.

### Критерий готовности

- подмена `X-Forwarded-For` не обходит лимит;
- прямой вызов mutation route без сессии возвращает `401` независимо от
  middleware;
- middleware bypass regression tests проходят;
- в логах отсутствуют password, cookie и admin token.

---

## Этап 8. Переделать Telegram deploy UX и права бота

Этот этап меняется в отдельном репозитории
`/Users/kadimagomedov/Documents/KomuiMerch`.

### Что сделать в интерфейсе бота

1. Использовать существующую `ReplyKeyboardMarkup` как постоянную клавиатуру
   над строкой ввода.
2. Зарегистрировать Bot API commands, например:
   - `/status`;
   - `/deploy_stage`;
   - `/deploy_prod`;
   - `/deploy_admin`;
   - `/rollback_admin`.
3. Оставить inline-кнопки для подтверждения опасного действия:
   - `Подтвердить deploy prod`;
   - `Отмена`.
4. Для deploy prod и rollback сделать двухшаговый flow с короткоживущим
   confirmation token.
5. Разделить подписи магазина и админки, чтобы их нельзя было перепутать.
6. Использовать Telegram HTML formatting и экранировать динамический текст.
7. В итоговом сообщении показывать:
   - компонент;
   - stage/prod;
   - commit и release;
   - длительность;
   - статус smoke-check;
   - краткую причину ошибки;
   - путь к полному логу без вывода секретов.
8. Обработать timeout: пользователь всегда должен получить финальное сообщение.

### Что сделать с правами

1. Перевести bot service с root на отдельного пользователя.
2. Дать через `sudoers` право только на конкретные скрипты deploy/status/rollback.
3. Не разрешать произвольные аргументы и shell-команды из Telegram payload.
4. Усилить systemd unit через `ProtectSystem`, `ProtectHome`, `PrivateDevices` и
   узкие `ReadWritePaths`.

### Критерий готовности

- клавиатура постоянно видна над строкой ввода;
- `/menu` восстанавливает её;
- prod deploy и rollback нельзя запустить одним случайным нажатием;
- посторонний chat ID не получает статус и не запускает команды;
- timeout и ошибка всегда заканчиваются понятным Telegram-сообщением.

---

## Этап 9. Усилить systemd, nginx и monitoring

### Systemd

Для `getomerch-admin.service` проверить и по возможности добавить:

- `ProtectSystem=strict` или `full`;
- `ProtectHome=true`;
- `PrivateDevices=true`;
- `RestrictSUIDSGID=true`;
- `RestrictNamespaces=true`;
- `CapabilityBoundingSet=`;
- `LockPersonality=true`;
- `UMask=0077`;
- `MemoryMax` и `TasksMax` с безопасным запасом;
- разрешение записи только в реально необходимые runtime-пути.

После каждого изменения проверять запуск приложения и
`systemd-analyze security getomerch-admin.service`.

### Nginx

1. Добавить HSTS после проверки всех поддоменов и HTTPS.
2. Подготовить Content-Security-Policy сначала в режиме Report-Only.
3. Удалить `X-Powered-By` через Next.js config/nginx.
4. Добавить rate limit для login.
5. Сохранить корректные proxy headers и WebSocket/keep-alive поведение.

### Monitoring

Добавить проверки:

- `getomerch-admin.service` active;
- `/login` отвечает;
- защищённый health endpoint проходит;
- срок TLS-сертификата;
- размер `/opt/getomerch/releases`;
- свободный диск;
- возраст последнего backup;
- расхождение active commit с `origin/main`;
- серия неудачных входов или deploy.

### Критерий готовности

- systemd exposure заметно ниже текущего `8.7 EXPOSED`;
- приложение не теряет доступ к необходимым файлам и сети;
- healthcheck сообщает не только о доступности login, но и о зависимостях;
- алерты понятны владельцу и не содержат секретов.

---

## Этап 10. CI, тесты, smoke-check и документация

### CI и статические проверки

1. Заменить устаревший `next lint` на ESLint CLI.
2. Добавить стабильный ESLint config без интерактивного мастера.
3. В обязательные проверки включить:
   - `npm ci`;
   - ESLint;
   - `npx tsc --noEmit`;
   - `npm run build`;
   - unit/integration tests;
   - `npm audit` с зафиксированной политикой допустимых severity.
4. Не разрешать deploy, если обязательные проверки не прошли.

### Минимальный набор тестов

- правильный и неправильный пароль;
- истечение/подделка session cookie;
- middleware и route-level auth;
- rate limit и подмена forwarded headers;
- отсутствие service keys в client bundle;
- CRUD через BFF;
- транзакционные операции остатков/производства;
- Komui prod/stage target selection;
- deploy failure до активации;
- rollback;
- retention не удаляет active release;
- Telegram confirmation и запрет чужого chat ID.

### Post-deploy smoke

После активации release автоматически проверить:

1. `/login`.
2. Редирект неавторизованной страницы.
3. `401` для API без cookie.
4. Валидную временную smoke-session.
5. Read-only запрос к Supabase через BFF.
6. Read-only запрос к Komui production API.
7. Загрузку ключевой страницы и отсутствие критических client-side ошибок.

Smoke не должен создавать товар, заказ, Ozon import или движение остатка.

### Документация

После завершения работ исправить `README.md`, `ARCHITECTURE.md` и deployment
plan так, чтобы они отражали фактическое состояние:

- где находится auth;
- что browser больше не пишет напрямую в Supabase;
- какие RLS policies действуют;
- что именно входит в backup;
- как выполняется restore;
- сколько release хранится;
- как устроено Telegram confirmation;
- как откатить только админку, не трогая магазин.

---

## 3. Рекомендуемое разбиение на релизы

Чтобы не объединять слишком много рискованных изменений в один deploy:

### Release A — эксплуатационная безопасность

- build-time public env;
- backup GetoMerch;
- release retention;
- расширенный read-only smoke.

### Release B — каркас безопасности данных

- `requireAdminSession()`;
- server-only Supabase client;
- первые read-only BFF endpoints;
- тесты auth и утечки секретов.

### Releases C1–C4 — миграция экранов

- C1: справочники и товары;
- C2: остатки и движения;
- C3: Ozon, производство и расходы;
- C4: удаление browser Supabase data layer.

### Release D — RLS lockdown

- SQL migration policies;
- закрытие dangerous functions;
- Security Advisor verification;
- полный regression-check.

### Release E — эксплуатационный polish

- Telegram persistent menu и confirmation;
- systemd/nginx hardening;
- CI/lint/dependency updates;
- финальная документация и restore drill.

## 4. Условия окончательной приёмки

Работу можно считать полностью закрытой, когда одновременно выполняются все
условия:

- пароль `admin.komui.ru` нельзя обойти прямым запросом к Supabase;
- browser bundle не содержит серверных секретов;
- production build получает только необходимые публичные env;
- backup админки и Supabase проверен восстановлением;
- deploy и rollback сохраняют минимум два рабочих release и не заполняют диск;
- все mutation API имеют route-level auth и validation;
- подмена `X-Forwarded-For` не обходит login limit;
- Telegram показывает постоянное меню и требует подтверждение prod/rollback;
- systemd и nginx усилены без нарушения работы;
- CI, tests и post-deploy smoke проходят;
- документация совпадает с фактической конфигурацией сервера;
- ни один из этих процессов не изменяет и не перезапускает магазин без явной
  необходимости.
