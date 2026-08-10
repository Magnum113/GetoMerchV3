# Серверная основа интеграции «Честного знака»

Этот каталог описывает инфраструктуру маркировки, начиная с fail-closed основы
этапа 1 и заканчивая вводом и дистанционным выводом этапов 10-11. Все операции
записи в ГИС МТ и СУЗ по умолчанию отключены. Отсутствие разрешительного
документа не блокирует техническую интеграцию, импорт или будущий заказ КМ.

## Компоненты

- `getomerch-marking-worker.service` — отдельный процесс и OS-пользователь;
- `getomerch-marking-signer.service` — legacy/local Unix signer template; при
  production transport `remote` на VPS не устанавливается и не запускается;
- `scripts/getomerch-marking-mac-agent.ts` — исходящий relay для Рутокена на Mac;
- `ops/nginx/getomerch-marking-agent-*.conf` — `limit_req` и exact location
  публичного HMAC endpoint Mac-агента;
- `getomerch_marking_worker` — PostgreSQL-роль только для ограниченного
  представления `getomerch_jobs.marking_jobs`, безопасной записи marking events
  и узких процедур этапов 8-11;
- `/etc/getomerch/marking-production.env` — feature flags без секретов;
- `/etc/getomerch/credentials/marking-keyring.json` — versioned AES/HMAC
  ключи, `root:root`, режим `0600`;
- `/etc/getomerch/credentials/marking-agent-secrets.json` — HMAC credentials
  Mac-агентов, не связанные с сертификатом УКЭП;
- `/etc/getomerch/marking-database.env` — пароль отдельной PostgreSQL-роли,
  `root:root`, режим `0600`.

Обычный `getomerch-worker.service` явно забирает только core Ozon jobs.
Marking worker на этапе 1 имеет пустой claim-list и не подключается к БД.
Signer не получает database URL ни на одном этапе. При transport `remote`
VPS signer не запускается: worker использует encrypted broker, а CryptoPro и
Рутокен остаются на Mac. Полный порядок описан в
`docs/chestny-znak-ozon/stage-9/MAC_AGENT.md`.

## Подготовка сервера

Команды выполняются только после выкладки соответствующего release:

```bash
sudo install -m 0755 ops/getomerch-marking-keyring-init \
  /usr/local/sbin/getomerch-marking-keyring-init
sudo install -m 0755 ops/getomerch-marking-postgres-bootstrap \
  /usr/local/sbin/getomerch-marking-postgres-bootstrap
sudo install -m 0644 ops/systemd/getomerch-marking-worker.service \
  /etc/systemd/system/getomerch-marking-worker.service
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin \
  getomerch-marking 2>/dev/null || true

sudo install -m 0600 -o root -g root \
  ops/chestny-znak/marking-production.env.example \
  /etc/getomerch/marking-production.env
sudo /usr/local/sbin/getomerch-marking-keyring-init
sudo /usr/local/sbin/getomerch-marking-postgres-bootstrap
sudo systemctl daemon-reload
```

Сначала применяются миграции, затем запускается
`getomerch-marking-postgres-bootstrap`: скрипт требует наличия ограниченного
представления очереди и объектов этапа 9. Повторный запуск идемпотентен, не
меняет пароль и обновляет узкие grants. Worker unit отдельно загружает
`/etc/getomerch/marking-database.env`; signer этот файл не получает.
Ротация пароля выполняется только явно:

```bash
sudo GETOMERCH_ROTATE_MARKING_DATABASE_PASSWORD=true \
  /usr/local/sbin/getomerch-marking-postgres-bootstrap
```

На этапе 1 сервисы можно запустить только с базовым env, где все флаги
`false`. `IPAddressDeny=any` и `RestrictAddressFamilies=AF_UNIX` запрещают им
сетевой доступ. Перед этапом с реальными интеграциями ограничения меняются
отдельным reviewed systemd drop-in и узким egress allow-list.

## Передача keyring процессу

Keyring нельзя добавлять в общий env, Git, логи или backup БД. Когда он
потребуется процессу, используется systemd credential:

```ini
[Service]
LoadCredential=marking-keyring:/etc/getomerch/credentials/marking-keyring.json
```

Приложение автоматически читает путь
`$CREDENTIALS_DIRECTORY/marking-keyring`. Для ручного импорта этапа 5
credential нужен `getomerch-admin.service`; готовый drop-in:

```bash
sudo install -d -m 0755 /etc/systemd/system/getomerch-admin.service.d
sudo install -m 0644 \
  ops/systemd/getomerch-admin-marking-import.conf \
  /etc/systemd/system/getomerch-admin.service.d/marking-import.conf
sudo systemctl daemon-reload
```

Signer получает ключ УКЭП своим отдельным механизмом криптопровайдера;
marking keyring не является приватным ключом УКЭП.

## Ротация AES/HMAC

1. Сделать зашифрованный off-host backup текущего keyring.
2. Добавить новую версию в `encryptionKeys` и `hmacKeys`, не удаляя старую.
3. Переключить `currentEncryptionKeyVersion` и `currentHmacKeyVersion`.
4. Перезапустить только фактических потребителей keyring (на этапе 5 это web
   service, позднее также marking worker) и выполнить canary decrypt.
5. Новые записи шифруются новой версией; старые читаются по `keyVersion`.
6. Фоновую перешифровку выполнять отдельной идемпотентной job.
7. Старый ключ удалять только после проверки, что записей этой версии нет,
   завершен retention и существует проверенный backup новой версии.

## Backup и recovery drill

Backup БД содержит ciphertext, IV, auth tag, key version и HMAC fingerprint,
но не keyring. Keyring хранится в отдельном зашифрованном off-host backup с
ограниченным доступом.

Проверка восстановления:

1. Восстановить database backup в изолированную rehearsal БД.
2. Восстановить keyring отдельно во временный root-only путь.
3. Расшифровать одну синтетическую контрольную запись.
4. Повторить с посторонним keyring и подтвердить отказ.
5. Проверить, что строка plaintext отсутствует в database dump и логах.
6. Удалить тестовые ключи и rehearsal данные.

Локальный автоматизированный эквивалент этой проверки:

```bash
npm run check:marking-security
```

## Наблюдаемость

- `/api/admin/health` показывает только состояния flags и количество
  allow-list entries, без их значений;
- worker/signer logs содержат entity ID, безопасный error class и состояние,
  но не КМ, GS1 payload, PDF, подпись или signed body;
- connectivity Ozon и CRPT проверяется отдельно и не считается готовностью к
  записи;
- systemd unit, DB role и signer имеют отдельные health/alerts;
- journal retention настраивается на сервере без экспорта payload.

Production-сервисы этапа 1 не следует включать автоматически при deploy.
Сначала проверяются миграция, `npm run check:marking-security`, сборка и
ручной запуск каждого процесса с flags off.

## Этап 5: защищенный импорт КМ

До включения импорта должны быть выполнены migration first и все проверки:

```bash
npm run db:migrate:up
npm run db:migrate:verify
npm run check:marking-security
npm run check:marking-stage5
```

Установить автоматическую очистку просроченных preview:

```bash
sudo install -m 0644 \
  ops/systemd/getomerch-marking-import-scrub.service \
  /etc/systemd/system/getomerch-marking-import-scrub.service
sudo install -m 0644 \
  ops/systemd/getomerch-marking-import-scrub.timer \
  /etc/systemd/system/getomerch-marking-import-scrub.timer
sudo systemctl daemon-reload
sudo systemctl enable --now getomerch-marking-import-scrub.timer
sudo systemctl start getomerch-marking-import-scrub.service
sudo systemctl status getomerch-marking-import-scrub.timer --no-pager
```

После установки keyring и timer разрешается только ограниченный pilot:

```text
GETOMERCH_MARKING_ENABLED=true
GETOMERCH_MARKING_IMPORT_ENABLED=true
GETOMERCH_MARKING_ALLOWED_GTINS=<проверенный GTIN-14>
GETOMERCH_MARKING_ALLOWED_ADMIN_IDS=<actor ID администратора>
```

Все остальные marking flags остаются `false`, shipping gate — `observe`.
Сначала выполняется preview синтетического или отдельно выделенного тестового
пула, сверяются строки и счетчики, затем явный apply. Полный КМ нельзя
проверять через SQL, API, логи или screenshot: допустимы только GTIN,
fingerprint и агрегаты. После проверки выполняется recovery drill keyring и
только затем разрешается импорт рабочего пула.

Отключение импорта:

1. Установить `GETOMERCH_MARKING_IMPORT_ENABLED=false`.
2. Перезапустить `getomerch-admin.service`.
3. Не откатывать миграцию и не удалять зашифрованный пул.
4. Оставить cleanup timer включенным.
5. Разобрать незавершенные preview и audit до повторного включения.

## Этап 2: fulfillment rollout

Этап 2 не включает запуск marking worker, signer или внешние записи. Он
добавляет миграцию `0006_generic_fulfillment.sql`, расширяет текущий Ozon sync
и требует последовательности `migration first, application second`.

Перед rollout:

```sql
select order_id, offer_id, coalesce(ozon_sku, ''), count(*)
from merch_ozon_order_items
group by order_id, offer_id, coalesce(ozon_sku, '')
having count(*) > 1;
```

Результат должен быть пустым. После backup и включения maintenance:

```bash
npm run db:migrate:up
npm run db:migrate:verify
```

После запуска совместимого release сначала выполняется обычная активная
синхронизация Ozon, затем небольшой локальный backfill:

```bash
GETOMERCH_FULFILLMENT_BACKFILL_LIMIT=50 \
GETOMERCH_FULFILLMENT_BACKFILL_MAX_BATCHES=1 \
GETOMERCH_FULFILLMENT_BACKFILL_ACTIVE_ONLY=true \
npm run fulfillment:backfill:ozon
```

Команда не вызывает Ozon, ГИС МТ или СУЗ, не меняет inventory и печатает
только счетчики. Ее можно повторять. Первый rollout не должен использовать
`GETOMERCH_FULFILLMENT_BACKFILL_ACTIVE_ONLY=false` до проверки активных
заказов, FBO isolation и складских итогов.

Production rollout этапа 2 считается завершенным только после сверки:

```sql
select count(*)
from merch_ozon_orders ozon_order
where ozon_order.source = 'fbs'
  and ozon_order.status not in ('cancelled', 'delivered', 'not_accepted')
  and ozon_order.fulfillment_order_id is null;

select count(*)
from merch_ozon_orders
where source = 'fbo'
  and fulfillment_order_id is not null;
```

Оба результата должны быть `0`. Затем проверяются экран заказов, суммы
остатков и последние движения. Развернутый порядок и ограничения приведены в
`docs/chestny-znak-ozon/stage-2/README.md`.

## Этап 9: signer и read-only ГИС МТ

Этап 9 добавляет signer по Unix socket и read-only проверки КМ/документов.
Полный runbook, credentials, CryptoPro preflight, canary и ротация сертификата
описаны в `docs/chestny-znak-ozon/stage-9/README.md`.

Базовые services сохраняют сетевой запрет. Сетевой доступ marking-worker
включается только установкой reviewed drop-in
`getomerch-marking-worker-stage9.conf`; signer остаётся без IP-сети.
Production write flag ГИС МТ должен оставаться `false`.
