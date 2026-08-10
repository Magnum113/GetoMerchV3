# Этап 3: marking core и state machine

Дата проверки: 26 июля 2026 года.
Статус: реализован и проверен локально; production rollout не выполнялся.

## Реализовано

Forward-only миграция
[`0007_marking_core.sql`](../../../db/migrations/0007_marking_core.sql)
создает:

- `merch_marking_trade_items`;
- `merch_marking_trade_item_documents`;
- `merch_marking_product_profiles`;
- `merch_marking_locations`;
- `merch_marking_processes`;
- `merch_marking_evidence`;
- append-only `merch_marking_events`;
- приватные функции `getomerch_marking.create_process(...)` и
  `getomerch_marking.transition_process(...)`.

В схеме зафиксированы:

- canonical GTIN-14 и проверка check digit;
- отдельные `production_mode` и `fulfillment_marking_mode`;
- запрет активного marking profile для `is_blank=true`;
- обязательный verified trade item и verified evidence для включенного
  маркируемого профиля;
- отдельное evidence для совместного GTIN нескольких SKU;
- отсутствие РД не является readiness gate;
- optimistic lock через `version`;
- атомарное изменение процесса и добавление marking event;
- `ON DELETE RESTRICT` для исторических связей;
- `timestamptz` для всех моментов времени;
- reserved future columns для code/unit/assignment остаются `NULL` до
  появления соответствующих таблиц и foreign keys.

Роль `getomerch_app` имеет `SELECT` на core-таблицы, но не может выполнять
прямые `INSERT`, `UPDATE`, `DELETE` или `TRUNCATE`. Создание и переход процесса
доступны только через узкие функции, которые вызываются серверным
idempotent/audit mutation service.

## Код приложения

Добавлены:

- чистый domain layer в `src/lib/marking/domain`;
- process repository и mutation service;
- cursor-based read models с явными SQL-проекциями;
- защищенные read-only API:
  - `GET /api/admin/marking/readiness`;
  - `GET /api/admin/marking/processes`;
  - `GET /api/admin/marking/processes/:id`;
  - `GET /api/admin/marking/events`;
- read-only раздел админки `/marking` с вкладками товаров, процессов и
  истории.

API не возвращает `payload_envelope`, полные КМ, signatures или reserved
code-binding columns. Размер страницы ограничен 100 строками, продолжение
выполняется opaque cursor.

## Проверки

Пройдены:

- все разрешенные и запрещенные process transitions;
- GTIN normalization/check digit;
- несовместимые product/fulfillment modes;
- admin authentication boundary в каждом route;
- отсутствие `SELECT *` и secret columns в read models;
- clean apply миграций `0001-0007`;
- `db:migrate:verify`;
- повторный apply без pending migrations;
- invalid GTIN database constraint;
- profile readiness и отсутствие РД как gate;
- запрет profile для пустой заготовки;
- event/entity rollback в одной транзакции;
- конкурентный transition: один commit и один version conflict;
- запрет прямой записи app role в processes/events;
- read-model SQL и cursor pagination на заполненной схеме;
- read-model SQL и UI-compatible empty state на пустой marking schema;
- TypeScript и production build.

Проверки PostgreSQL выполнены во временной БД PostgreSQL 17 на VPS. Временная
БД и каталог удалены; `getomerch_production` не изменялась.

## Не входит в этап 3

- создание и редактирование product profiles в UI;
- backfill GTIN;
- хранение и импорт полных КМ;
- физические единицы и assignments;
- PDF/DataMatrix;
- любые записи в Ozon, ГИС МТ или СУЗ.

Это начинается с этапа 4 и последующих этапов. До отдельного rollout
production-приложение и production-БД остаются на прежней версии.
