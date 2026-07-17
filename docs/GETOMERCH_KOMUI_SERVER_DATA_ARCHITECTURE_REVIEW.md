# Ревью целевой архитектуры данных GetoMerch и KOMUI

Дата: 16 июля 2026 года.

Статус: архитектурное ревью и перечень обязательных уточнений перед
реализацией.

Основной документ:
`docs/GETOMERCH_KOMUI_SERVER_DATA_ARCHITECTURE.md`.

Этот документ:

- не выполняет миграции;
- не изменяет production;
- не заменяет основной архитектурный документ;
- фиксирует критические замечания и важные дополнения, которые нужно встроить
  в основной контракт до реализации соответствующих этапов;
- намеренно не рассматривает отдельную политику персональных данных.

## 1. Итог ревью

Базовое направление архитектуры одобрено:

- GetoMerch и KOMUI остаются отдельными проектами и используют отдельные базы;
- у каждого домена и поля есть один источник истины;
- общий каталог передается в KOMUI как управляемая проекция;
- заказы KOMUI передаются в GetoMerch как события;
- прямой SQL-доступ одного приложения в базу другого запрещен;
- надежность интеграции строится на outbox, inbox, idempotency и
  reconciliation;
- Ozon FBS и KOMUI используют общий fulfillment-процесс;
- Ozon FBO не участвует в резервировании и производстве.

До начала реализации интеграционных этапов необходимо закрыть следующие
архитектурные вопросы.

| Приоритет | Вопрос | Когда должен быть закрыт |
|---|---|---|
| P0 | Разделить статусы заказа, оплаты, производства, доставки и возврата | До интеграции заказов KOMUI |
| P0 | Перевести складские mutation-path на атомарные SQL-транзакции | До резервов и общего fulfillment |
| P0 | Формализовать idempotency, версии, HMAC и повторную доставку событий | До запуска outbox workers |
| P1 | Определить точный момент отключения legacy dual-write | До включения публикации каталога |
| P1 | Закрепить DB-инварианты резервирования | До запуска allocator |
| P1 | Ввести стабильную идентичность медиа и storefront exclusions | До переноса управления медиа |
| P1 | Создавать новые витринные карточки только как draft | До автоматической публикации каталога |
| P1 | Установить ресурсные лимиты для текущего сервера | До добавления workers и PITR |
| P2 | Разделить основной документ на обзор, контракты и runbooks | До активной параллельной разработки |

## 2. Критическое замечание: модель статусов

### 2.1. Проблема

Основная архитектура правильно утверждает, что заказ, оплата, производство,
доставка, денежный refund и физический возврат являются разными процессами.
Однако дальше используется объединенное понятие `delivery/fulfillment status`,
которое может привести к неявным переходам между независимыми процессами.

Например:

- готовность товара в GetoMerch не означает, что отправление уже передано в
  СДЭК;
- статус СДЭК `delivered` не должен автоматически означать, что отсутствует
  возврат или refund;
- неуспешная попытка оплаты не должна окончательно закрывать возможность
  повторной оплаты того же заказа;
- поздний webhook старой платежной попытки не должен откатывать уже
  подтвержденную оплату;
- refund не означает фактическое возвращение изделия на склад.

### 2.2. Целевая модель

В KOMUI рекомендуется разделить минимум следующие состояния.

#### `order_status`

Общий жизненный цикл клиентского заказа:

```text
open
completed
canceled
```

Этот статус не должен дублировать детальные состояния оплаты или доставки.

#### `payment_status`

Агрегированное состояние оплаты заказа:

```text
not_started
pending
authorized
paid
review
partially_refunded
refunded
```

Ошибки отдельных попыток хранятся в `merch_payment_attempts`. Значение
`payment_failed` не должно становиться необратимым терминальным состоянием
заказа, если пользователь может повторить оплату.

#### `production_status`

Состояние подготовки изделия, владельцем которого является GetoMerch:

```text
not_required
pending
reserved
partial
shortage
in_production
ready
canceled
```

KOMUI хранит только примененную проекцию этого статуса и его source version.

#### `shipment_status`

Состояние доставки и накладной СДЭК:

```text
not_created
creating
created
accepted
in_transit
delivered
delivery_failed
canceled
returned
```

Точный набор должен быть сопоставлен со статусами СДЭК через отдельную mapping
таблицу или adapter, а не распространяться по бизнес-коду условными строками.

#### `refund_status`

Денежный возврат:

```text
none
pending
partial
full
failed
```

#### `return_status`

Физический возврат товара:

```text
none
requested
in_transit
received
accepted
rejected
```

### 2.3. Владение статусами

| Статус | Владелец | Кто может присылать входные события |
|---|---|---|
| `order_status` | KOMUI | KOMUI backend/admin |
| `payment_status` | KOMUI | Т-Банк через KOMUI webhook handler |
| `production_status` | GetoMerch | GetoMerch fulfillment worker |
| `shipment_status` | KOMUI | СДЭК adapter и KOMUI admin |
| `refund_status` | KOMUI | Т-Банк и KOMUI admin |
| `return_status` | KOMUI/GetoMerch по утвержденному workflow | СДЭК, admin, складское подтверждение |

Для `return_status` до реализации нужно выбрать одного владельца. Без этого
нельзя допускать запись статуса из двух приложений.

### 2.4. Обязательная таблица переходов

Для каждого статуса должна быть создана transition matrix:

| Текущее состояние | Событие | Новое состояние | Разрешено | Побочные действия |
|---|---|---|---:|---|
| `pending` payment | подтвержденный webhook | `paid` | да | записать `order.paid.v1` |
| `paid` payment | поздний failed webhook старой попытки | `paid` | нет перехода | сохранить event как stale |
| `ready` production | admin/SДЭК shipment created | без изменения | да | меняется только shipment |
| `delivered` shipment | refund | без изменения | да | меняется только refund |

Матрица должна использоваться в коде, тестах и документации API.

### 2.5. Критерии готовности

- В БД отсутствует одно поле, одновременно описывающее производство и СДЭК.
- Повторная платежная попытка не требует создания нового заказа.
- Позднее событие старой попытки не может понизить `paid`.
- Refund и физический возврат тестируются отдельно.
- Production callback не может отметить заказ отправленным.
- Для каждого перехода существует unit или integration test.

## 3. Критическое замечание: транзакционность mutation-path

### 3.1. Текущее ограничение

В текущем GetoMerch ряд операций выполняется несколькими последовательными
Supabase REST-запросами:

- read-modify-write остатка;
- перемещение между складами;
- производство готового изделия;
- списание заготовки и принта;
- запись строки журнала;
- отправка нескольких позиций Ozon;
- приемка результата из цеха.

Если одна из промежуточных операций завершается ошибкой, уже примененные
изменения не откатываются автоматически. При параллельных действиях также
возможна потеря обновления между чтением и записью количества.

Целевая архитектура резервов и общего fulfillment не может строиться поверх
такого mutation-path.

### 3.2. Обязательное решение

После переноса GetoMerch на server PostgreSQL все составные бизнес-операции
должны выполняться через server-only service/repository слой:

```text
Route Handler / Worker
  -> domain service
    -> BEGIN
      -> repositories on one pg client
      -> row locks
      -> inventory changes
      -> domain ledger/events
      -> outbox event
    -> COMMIT
```

Операция и ее outbox-событие записываются в одной транзакции.

### 3.3. Операции, требующие одной транзакции

- приемка товара или принта вместе с ledger entry;
- перемещение между складами;
- корректировка и списание;
- производство `blank + print -> finished`;
- передача заготовок в цех;
- приемка результата из цеха;
- создание fulfillment requirements;
- allocation, consumption и release;
- подтверждение FBS-отправки;
- отмена ранее выполненной отправки;
- создание/обновление canonical catalog entity и catalog outbox event;
- применение входного события и запись inbox result.

### 3.4. Требования к конкурентному доступу

- Остатки блокируются через `SELECT ... FOR UPDATE`.
- Несколько строк блокируются в стабильном порядке по ID.
- Внешние HTTP-вызовы не выполняются внутри транзакции.
- Повтор deadlock/serialization error ограничен и журналируется.
- Все изменения количества используют один и тот же service path.
- Admin UI не выполняет прямые изменения inventory таблиц.

### 3.5. Deployment gate

Этап унифицированного fulfillment запрещено начинать, пока:

- mutation endpoints не используют server PostgreSQL;
- composite operations не переведены на транзакции;
- не выполнены fault-injection tests;
- не доказан rollback при ошибке на каждом промежуточном шаге;
- ledger и inventory reconciliation не показывают расхождений.

## 4. Критическое замечание: события, версии и HMAC

### 4.1. Семантика idempotency

Inbox consumer должен использовать следующую таблицу решений.

| Условие | Результат |
|---|---|
| Новый `event_id`, версия новее текущей | применить в транзакции |
| Тот же `event_id`, тот же payload hash | вернуть success/no-op |
| Тот же `event_id`, другой payload hash | security conflict, не применять |
| Версия меньше примененной | stale/no-op, сохранить диагностический результат |
| Версия равна, hash совпадает | duplicate/no-op |
| Версия равна, hash отличается | version conflict, отправить в manual review |
| Пропущена версия полного catalog snapshot | применить новейший snapshot и поставить reconciliation job |
| Пропущена версия transition-based order event | не применять вслепую; запросить reconciliation/current aggregate |

Условие вида «версия не меньше примененной» недостаточно и должно быть заменено
этой явной семантикой.

### 4.2. Подпись запроса

Рекомендуемая canonical signing string:

```text
v1\n<X-Event-Timestamp>\n<X-Event-Id>\n<SHA256(raw-body)>
```

Headers:

```text
X-Event-Id
X-Event-Timestamp
X-Event-Key-Id
X-Event-Signature
```

Требования:

- timestamp создается заново для каждой HTTP-попытки;
- `occurredAt` внутри события не заменяет delivery timestamp;
- signature сравнивается constant-time;
- body hash считается от исходных байтов до JSON parsing;
- replay window проверяется до применения payload;
- `key_id` позволяет держать текущий и предыдущий secret во время ротации;
- секреты двух направлений различаются;
- событие не содержит секретов и полных HTTP response dumps.

Если повторно отправлять старый неизменный `X-Event-Timestamp`, retry после
replay window будет ошибочно отклоняться.

### 4.3. HTTP-семантика

| Ответ | Значение для producer |
|---|---|
| `200/204` | applied или безопасный duplicate/no-op |
| `202` | принято в локальную очередь, окончательное применение асинхронно |
| `400/422` | schema error, автоматический retry не нужен |
| `401/403` | auth/signature error, остановить бесконечные retries и alert |
| `409` | version/hash conflict, manual review или reconciliation |
| `429` | retry с учетом `Retry-After` |
| `5xx/network timeout` | exponential retry with jitter |

Producer не должен считать любой `4xx` временной сетевой ошибкой.

### 4.4. Версии агрегатов

- `catalog_version` является версией конкретного catalog product, а не
  временем сборки всего каталога.
- Версия увеличивается транзакционно вместе с publishable изменением.
- Изменение связанной размерной сетки или базового media order должно увеличить
  версии всех затронутых catalog products либо создать эквивалентные события.
- Order event version увеличивается в той же транзакции, что и изменение
  заказа.
- Hash строится по canonical JSON и не включает нестабильные timestamps,
  временные signed URLs или случайный порядок ключей.

### 4.5. Критерии готовности

- Повтор одного события не создает дубль.
- Измененный payload с тем же ID отклоняется.
- Retry работает после истечения первого replay window.
- Старое событие не откатывает более новую версию.
- Пропуск catalog snapshot восстанавливается reconciliation.
- Пропуск order transition не приводит к некорректному перескакиванию статуса.

## 5. Важное замечание: single-writer cutover

### 5.1. Риск

Во время переходного периода source-owned поля товара потенциально могут
редактироваться через:

- GetoMerch canonical catalog;
- legacy Ozon import в KOMUI backend;
- старые Supabase-инструменты;
- ручные admin endpoints KOMUI.

Если публикация GetoMerch уже включена, но старый importer продолжает писать
те же поля, появятся два источника истины и непредсказуемые перезаписи.

### 5.2. Правило

Для каждого поля в каждый момент времени существует ровно один writer.

После включения GetoMerch publication:

- design/category/fabric/color/variants/SKU/base media/size chart записываются
  только событиями GetoMerch;
- KOMUI endpoints для этих полей переходят в read-only или emergency mode;
- Ozon importer KOMUI может временно работать как preview, но не применять
  source-owned изменения;
- storefront title, description, slug, SEO, price, badges и sort order
  продолжают редактироваться только в KOMUI;
- emergency rollback выполняется feature flag, а не одновременной записью в
  оба контура.

### 5.3. Рекомендуемый порядок переключения

1. Добавить source IDs/version/hash в KOMUI без изменения текущего поведения.
2. Развернуть consumer GetoMerch catalog events.
3. Выполнить dry-run reconciliation.
4. Backfill mapping существующих карточек.
5. Включить публикацию для небольшого набора карточек.
6. Проверить сохранение KOMUI overrides.
7. Включить публикацию для всего каталога.
8. Одновременно отключить legacy apply для source-owned полей.
9. Оставить старый importer только для preview/диагностики на ограниченный
   срок.
10. После периода наблюдения удалить legacy write-path.

### 5.4. Feature flags

Рекомендуемые независимые flags:

```text
GETOMERCH_CATALOG_PUBLICATION_ENABLED
KOMUI_CATALOG_EVENT_CONSUMER_ENABLED
KOMUI_LEGACY_SOURCE_FIELDS_WRITE_ENABLED
KOMUI_CATALOG_RECONCILIATION_ENABLED
```

Комбинация, при которой новый и legacy writer одновременно свободно изменяют
source-owned поля, должна считаться invalid configuration и блокировать
startup либо mutation request.

## 6. Важное замечание: DB-инварианты резервирования

### 6.1. Единственный источник факта резерва

Фактический резерв хранится в `merch_stock_allocations`. Поле
`allocated_quantity` в requirement является либо:

- вычисляемым значением из активных allocations;
- либо денормализованным cache, обновляемым только той же транзакционной
  функцией и регулярно сверяемым.

Прямое независимое обновление обоих представлений запрещено.

### 6.2. Ссылки allocation на inventory

Полиморфная пара `subject_type + subject_id` не обеспечивает полноценные FK.
Предпочтительная модель:

```text
product_inventory_id uuid nullable -> merch_inventory(id)
print_inventory_id   uuid nullable -> merch_print_inventory(id)
CHECK exactly_one_reference_is_not_null
```

Это обеспечивает:

- реальную ссылочную целостность;
- однозначный warehouse;
- невозможность зарезервировать несуществующий ресурс;
- более простую блокировку inventory row.

Если будет выбран polymorphic ID, потребуется отдельный trigger validation и
это решение должно быть явно обосновано.

### 6.3. Инварианты

```text
on_hand >= 0
active_allocated >= 0
active_allocated <= on_hand
requirement.allocated <= requirement.required
allocation.quantity > 0
```

Дополнительно:

- один idempotency key не может создать два allocation;
- consumed allocation нельзя освободить обычной отменой;
- released allocation нельзя consume;
- уменьшение on-hand ниже активного резерва запрещено;
- ручная корректировка использует те же row locks;
- повторный cancel не выполняет release дважды.

### 6.4. Транзакция allocator

1. Claim fulfillment job через `FOR UPDATE SKIP LOCKED`.
2. Загрузить requirements.
3. Найти inventory rows.
4. Заблокировать inventory rows в стабильном порядке.
5. Посчитать активные allocations внутри транзакции.
6. Создать allocations не больше available.
7. Обновить requirement/fulfillment state.
8. Записать append-only fulfillment event.
9. Commit.

Внешние вызовы Ozon, KOMUI, Telegram или СДЭК выполняются только после commit.

### 6.5. Reconciliation

Периодическая проверка должна выявлять:

- allocation больше on-hand;
- active allocation для отмененного fulfillment;
- requirement quantity и allocation sum, которые расходятся;
- consumed/released timestamp без соответствующего статуса;
- один ресурс, зарезервированный сверх доступного количества;
- fulfillment в `reserved`, у которого нет полного allocation.

Любое такое расхождение создает alert и не исправляется молча.

## 7. Важное дополнение: стабильная модель медиа

### 7.1. Почему URL недостаточно

URL изображения может измениться при:

- повторной загрузке из Ozon;
- переносе в Object Storage;
- изменении CDN/domain;
- регенерации оптимизированных размеров;
- обновлении исходного изображения.

Если storefront override хранит только URL, KOMUI не сможет надежно понять,
что новое значение соответствует ранее скрытому изображению.

### 7.2. Контракт media asset

В publishable snapshot каждое изображение передается как объект:

```json
{
  "assetId": "uuid",
  "checksum": "sha256:...",
  "role": "primary",
  "position": 1,
  "publicUrl": "https://...",
  "width": 1200,
  "height": 1600,
  "mimeType": "image/webp",
  "sourceUpdatedAt": "2026-07-16T10:00:00Z"
}
```

`assetId` является основной идентичностью. `checksum` помогает обнаруживать
одинаковый бинарный файл после повторного импорта.

### 7.3. Storefront exclusions

KOMUI должен хранить отдельно:

```text
hidden_source_asset_ids
storefront_media_order
storefront_primary_asset_id
local_storefront_assets
```

Правила:

- скрытый source asset не возвращается на сайт при следующей публикации;
- изменение URL при том же `assetId` не сбрасывает exclusion;
- повторный импорт идентичного бинарного файла с тем же checksum не создает
  новый видимый дубль;
- новое изображение появляется в preview как добавленное и может быть
  включено/скрыто;
- удаление asset из источника не удаляет локальный storefront asset;
- физическое удаление из Object Storage выполняется только после проверки
  ссылок и retention period.

Эта модель предотвращает повторное появление медиа, которое владелец уже
вручную удалил или скрыл на сайте.

### 7.4. Изменение медиа и catalog version

- Изменение порядка, role, checksum или набора source assets является
  publishable изменением.
- Оно увеличивает `catalog_version` затронутого товара.
- Один только перенос файла на другой CDN URL при том же asset/checksum может
  обновляться без изменения пользовательского порядка, но должен обновить
  projection metadata.
- Медиа со статусом `pending/failed` не публикуется как готовое.

## 8. Важное дополнение: draft и безопасная публикация карточек

### 8.1. Риск автоматического включения

Новая canonical карточка GetoMerch может еще не иметь:

- утвержденного названия сайта;
- SEO slug;
- цены;
- compare-at price;
- короткого и полного описания;
- выбранной главной фотографии;
- корректного порядка медиа;
- SEO metadata.

Автоматическое создание `is_active=true` может вывести на production
неподготовленную карточку.

### 8.2. Раздельные состояния

Рекомендуется хранить независимо:

```text
source_status       = active | archived
storefront_status   = draft | ready | published | hidden | archived
```

GetoMerch управляет только `source_status`. KOMUI управляет
`storefront_status`.

### 8.3. Readiness checks

Перевод `draft -> ready/published` разрешается только при наличии:

- source catalog mapping;
- хотя бы одного активного variant;
- корректного SKU/size snapshot;
- цены больше нуля;
- уникального валидного slug;
- storefront title;
- description согласно принятому минимуму;
- primary media;
- валидной category/product type;
- успешного preview без критических конфликтов.

### 8.4. Поведение обновлений

- Добавление нового размера к опубликованной карточке может применяться
  автоматически при успешной валидации.
- Новое source media показывается в diff и учитывает exclusions.
- Изменение source-owned атрибутов не сбрасывает `published` без критической
  несовместимости.
- Архивирование источника устанавливает `source_archived=true`, но не удаляет
  карточку автоматически.
- Решение скрыть карточку принимает KOMUI admin с записью причины.

### 8.5. Критерии готовности

- Новый товар никогда не появляется на сайте только из-за catalog event.
- Публикация требует readiness validation.
- Storefront overrides сохраняются при повторной публикации.
- Ошибка одного товара не блокирует применение независимых карточек, но
  остается видимой в publication job.

## 9. Важное дополнение: ресурсные ограничения сервера

### 9.1. Подтвержденный baseline на 16 июля 2026 года

```text
CPU:       2 vCPU
RAM:       3.8 GiB
Swap:      2.0 GiB
Disk:      20 GiB
Used:      около 64%
Available: около 6.9 GiB
```

На сервере одновременно работают:

- PostgreSQL;
- Nginx;
- KOMUI production backend;
- KOMUI stage backend;
- GetoMerch Next.js admin;
- deployment/backup/healthcheck процессы.

Целевая архитектура поместится на этом сервере при текущем масштабе бизнеса,
но требует явных лимитов.

### 9.2. Рекомендуемые стартовые лимиты

| Компонент | Начальный лимит |
|---|---|
| GetoMerch web DB pool | 3–4 соединения |
| GetoMerch worker pool | 1–2 соединения |
| KOMUI prod backend pool | не более 4 соединений |
| KOMUI integration worker | 1–2 соединения |
| Worker concurrency | 1 для тяжелых jobs |
| Analytics rebuild | один процесс, вне backup/deploy окна |
| Media processing | последовательно или concurrency 1–2 |

Суммарный connection budget должен быть рассчитан вместе с PostgreSQL
`max_connections`, autovacuum и административным резервом. Нельзя просто
выставить pool max 10 в каждом процессе.

### 9.3. Systemd hardening и limits

Для сервисов рекомендуется определить:

- `MemoryHigh` и `MemoryMax`;
- `TasksMax`;
- restart policy с ограничением частоты;
- отдельные writable paths;
- `NoNewPrivileges=true`, где совместимо;
- `PrivateTmp=true`;
- корректный `TimeoutStopSec` для завершения jobs;
- запрет одновременного запуска нескольких тяжелых timers.

Значения memory limits необходимо подобрать по замерам production, а не
копировать одинаково для Next.js, backend и worker.

### 9.4. Диск и WAL/PITR

Основной риск PITR на диске 20 GiB — накопление WAL при недоступности Object
Storage.

Обязательные меры:

- мониторинг размера `pg_wal`;
- alert при неуспешном `archive_command`;
- ограниченный локальный spool;
- проверка доступности Yandex Object Storage;
- запрет хранения media binaries и старых build caches в PostgreSQL;
- регулярная очистка старых application releases;
- раздельные thresholds warning/critical;
- документированный emergency procedure при росте WAL.

Рекомендуемые ориентиры:

```text
disk warning:  75%
disk critical: 85%
минимальный свободный резерв: 4 GiB
```

PITR нельзя считать включенным только по наличию `archive_mode=on`: необходим
успешный restore drill во временный cluster.

### 9.5. Признаки необходимости масштабирования

Перенос PostgreSQL или workers на отдельный сервер нужно планировать, если:

- свободный диск стабильно меньше 4 GiB;
- swap активно используется под обычной нагрузкой;
- p95 API растет из-за background jobs;
- workers регулярно отстают от SLA;
- backup или analytics заметно мешают checkout;
- невозможно сохранить безопасный DB connection reserve;
- WAL/media growth требует постоянной ручной очистки.

## 10. Важное дополнение: структура архитектурной документации

### 10.1. Проблема одного большого файла

Основной документ одновременно содержит:

- текущий server baseline;
- архитектурные решения;
- модели таблиц;
- event contracts;
- state machines;
- monitoring;
- backup и restore;
- этапы внедрения.

Это затрудняет review и увеличивает вероятность, что оперативные данные
устареют внутри документа, который считается постоянным source of truth.

### 10.2. Рекомендуемая структура

```text
docs/architecture/
  README.md
  data-ownership.md
  catalog-model.md
  catalog-publication-contract.md
  order-event-contract.md
  order-state-machines.md
  fulfillment-model.md
  media-model.md

docs/runbooks/
  integration-reconciliation.md
  backup-restore.md
  pit-r-recovery.md
  catalog-cutover.md
  order-integration-rollback.md

docs/baselines/
  server-baseline-YYYY-MM-DD.md
```

Основной `GETOMERCH_KOMUI_SERVER_DATA_ARCHITECTURE.md` после разделения должен
оставаться кратким обзором решений и ссылаться на детальные контракты.

### 10.3. Иерархия источников истины

Рекомендуется явно зафиксировать:

1. Миграции БД определяют фактическую schema.
2. Версионированные OpenAPI/JSON Schema определяют HTTP/event payload.
3. State machine document определяет разрешенные переходы.
4. Architecture overview объясняет связи и владельцев.
5. Runbooks определяют операционные действия.
6. Baseline фиксирует состояние на конкретную дату и может устаревать, не
   изменяя архитектурное решение.

### 10.4. Правила обновления

- Изменение event schema обновляет producer, consumer contract и tests.
- Изменение таблицы оформляется миграцией и обновлением data model docs.
- Изменение ownership требует отдельного ADR и cutover plan.
- Server baseline не редактируется задним числом; создается новый snapshot.
- Документ не получает статус «реализовано», пока код, миграции, monitoring и
  rollback не проверены на сервере.

## 11. Рекомендуемый порядок внесения уточнений

### Шаг 1. Исправить основной архитектурный контракт

Добавить или уточнить:

- отдельные state machines;
- transition matrices;
- event idempotency decision table;
- canonical HMAC format и key rotation;
- правила catalog/order version gaps;
- single-writer cutover;
- draft publication workflow;
- media asset identity и exclusions;
- allocation DB invariants;
- resource budgets.

### Шаг 2. Зафиксировать исполнимые контракты

- JSON Schema для event envelope и payload каждого event type;
- OpenAPI для internal endpoints;
- SQL migrations для новых таблиц и constraints;
- enum/transition definitions в одном shared contract package или
  синхронизируемых generated types;
- compatibility tests producer/consumer.

Shared package не должен предоставлять общий DB client или смешивать
репозитории. Общими могут быть только схемы контрактов, типы и тестовые
fixtures.

### Шаг 3. Завершить server DB mutation layer GetoMerch

- выполнить этап транзакционных mutations из полного плана миграции;
- убрать Supabase REST из критических write-path;
- проверить row locks;
- выполнить fault-injection и concurrency tests;
- проверить inventory/ledger reconciliation.

### Шаг 4. Реализовать каталог и публикацию

- canonical catalog entities;
- stable variant/media IDs;
- KOMUI projection fields;
- draft/readiness;
- outbox/inbox;
- reconciliation;
- controlled single-writer cutover.

### Шаг 5. Реализовать fulfillment и заказы

- requirements/allocations/events;
- сначала перевести Ozon FBS на общий fulfillment;
- подтвердить constraint, запрещающий FBO fulfillment;
- затем подключить KOMUI paid order events;
- включить production status projection;
- проверить cancel/refund/return отдельно.

### Шаг 6. Включать тяжелые функции только после capacity review

- analytics rebuild;
- marking workers;
- media migration jobs;
- WAL archiving/PITR;
- дополнительные reconciliation timers.

Для каждого процесса до включения определить concurrency, memory budget,
timeout, retry policy, disk impact и alert.

## 12. Общие критерии принятия уточненной архитектуры

Архитектурные замечания из этого ревью считаются закрытыми, когда:

- независимые процессы заказа имеют отдельные статусы и transition tests;
- складские операции атомарны и безопасны при конкуренции;
- события имеют однозначную idempotency/version/HMAC семантику;
- одновременно активен только один writer source-owned catalog fields;
- allocation не может превысить on-hand на уровне общего transaction path;
- скрытое на витрине source media не возвращается после повторного импорта;
- новые карточки создаются как draft и проходят readiness checks;
- для всех сервисов определены DB, worker и memory budgets;
- PITR не может бесконтрольно заполнить локальный диск;
- детальные контракты вынесены в поддерживаемые документы и schemas;
- основной архитектурный документ, это ревью и полный migration plan добавлены
  в Git после согласования.

