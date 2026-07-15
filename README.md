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

Схема живёт в Supabase, таблицы используют префикс `merch_`, миграции лежат в
`supabase/migrations`. Подробная модель и ограничения описаны в `DATABASE.md`,
инварианты разработки — в `ARCHITECTURE.md`.

Важно: даже после переноса админки на сервер данные админки не переехали в
PostgreSQL сервера. Production-приложение на `admin.komui.ru` всё ещё работает
с текущим Supabase-проектом. Сервер хранит только код, конфиги, release-артефакты,
логи deploy и runtime-состояние, но не основную БД админки.

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
GETOMERCH_SUPABASE_DATABASE_URL=postgresql://...
GETOMERCH_POSTGRES_SSL=true
GETOMERCH_POSTGRES_POOL_MAX=5
```

Эти переменные нельзя добавлять в `NEXT_PUBLIC_*`; deploy дополнительно
сканирует client bundle на утечки имён server-only env.

Для серверных Ozon-операций дополнительно используются ключи Ozon из
`.env.local`.

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
| `/etc/getomerch/admin-production.env` | Production env и секреты админки |
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
```

`getomerch-deploy-from-git` собирает проект в одноразовой папке, создаёт новый
release, переключает `/opt/getomerch/current`, перезапускает
`getomerch-admin.service`, делает smoke-check и пишет событие в registry.
Если smoke падает, скрипт возвращает предыдущий active release.

`getomerch-backup` запускается systemd timer `getomerch-backup.timer`,
собирает env админки, systemd/nginx config, deploy registry, manifest active
release и свежие deploy-логи в зашифрованный архив. Архив хранится локально в
`/var/backups/getomerch` и выгружается в Yandex Object Storage через
существующие S3 credentials. Supabase `pg_dump` подключается отдельно через
`/etc/getomerch/backup.env` (`GETOMERCH_SUPABASE_DATABASE_URL`); без этого
backup фиксирует marker о пропущенном Supabase export.

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
