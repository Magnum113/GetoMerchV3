# Этап 2: generic fulfillment и Ozon marking projection

Дата завершения реализации: `2026-07-26`.

Статус: код, миграция, bounded backfill и read-only диагностика реализованы и
проверены в изолированной PostgreSQL 17. Production deployment, миграция
`getomerch_production` и production backfill не выполнялись. Внешних записей в
Ozon, ГИС МТ и СУЗ нет.

## Реализовано

### Generic fulfillment

Миграция `db/migrations/0006_generic_fulfillment.sql` создает:

- `merch_fulfillment_orders`;
- `merch_fulfillment_order_items`;
- `merch_fulfillment_events`.

Основные инварианты:

- Ozon FBS использует `source_channel=ozon_fbs` и
  `fulfillment_scheme=fbs`;
- будущий KOMUI adapter может использовать `source_channel=komui` и
  `fulfillment_scheme=d2c`;
- Ozon FBO не является допустимым fulfillment channel;
- один posting создает не более одного fulfillment order;
- одна source-строка posting создает не более одного fulfillment item;
- количество всегда положительное;
- событие item не может ссылаться на item другого fulfillment order;
- журнал событий append-only для роли приложения;
- удаление fulfillment orders/items ролью приложения запрещено.

### Стабильные строки Ozon

`merch_ozon_order_items` больше не удаляются и не создаются заново при каждой
синхронизации. Для строки используется стабильный source key на основе
`offer_id` и Ozon SKU. Если строка исчезает из нового snapshot, она получает
`source_active=false`, но остается в истории.

Все операционные потребители используют только активные строки:

- список заказов;
- списание и возврат внутреннего склада;
- создание заказа в цех;
- сопоставление SKU для финансовой аналитики.

Это исключает повторное списание исчезнувшей позиции и сохраняет стабильные
UUID для последующей сериализации физических единиц.

### Marking projection

Ozon snapshot сохраняет явную нормализованную проекцию:

- `offer_id`;
- Ozon SKU и `product_id`;
- quantity;
- `marking_requirement`: `required`, `not_required` или `unknown`;
- `exemplar_flow_available`: `true`, `false` или `null`;
- posting status/substatus.

Ozon передает два разных списка: обязательные КМ в
`products_requiring_mandatory_mark` и допустимые КМ в
`products_with_possible_mandatory_mark`. Для подтвержденного локального
профиля `required` оба сигнала разрешают JIT-поток: optional SKU сохраняется
как эффективный `marking_requirement=required` вместе с
`exemplar_flow_available=true`. Это не меняет правовую классификацию товара:
её источником остается проверенный товарный профиль и GTIN, а optional-сигнал
только подтверждает, что Ozon примет код в конкретном FBS posting.

Если Ozon не вернул достаточно данных или его признаки противоречат друг
другу, сохраняется `unknown`. Такое состояние не разрешит отгрузку после
реализации shipping gate. Широкий Ozon payload, данные покупателя и полный КМ
в fulfillment events не сохраняются.

FBS fulfillment upsert выполняется в той же транзакции, что и Ozon snapshot.
Повторный sync с тем же состоянием не создает новый order, item или event.
FBO сохраняется только в Ozon analytics tables и не получает fulfillment link.

### Read-only UI

В текущей вкладке заказов выводятся:

- ID исполнения FBS posting;
- ID позиции исполнения;
- статус `Маркировка требуется`, `Маркировка не требуется` или
  `Маркировка неизвестна`.

На этапе 2 эти данные только диагностические. Кнопок работы с КМ, блокировки
отгрузки и внешних вызовов еще нет.

## Backfill

Для исторических FBS-заказов добавлена команда:

```bash
npm run fulfillment:backfill:ozon
```

Параметры:

```text
GETOMERCH_FULFILLMENT_BACKFILL_LIMIT=100
GETOMERCH_FULFILLMENT_BACKFILL_MAX_BATCHES=1
GETOMERCH_FULFILLMENT_BACKFILL_ACTIVE_ONLY=true
```

Один batch обрабатывается одной транзакцией, использует
`FOR UPDATE SKIP LOCKED`, ограничен 500 заказами и выводит только агрегированные
счетчики. По умолчанию исключаются `cancelled`, `delivered` и `not_accepted`.
Первый production rollout должен начинаться с `activeOnly=true` и небольшого
batch; полный исторический backfill выполняется только после сверки.

Порядок production rollout:

1. Сделать backup и проверить отсутствие неоднозначных исторических строк
   `(order_id, offer_id, ozon_sku)`.
2. Включить maintenance для записи.
3. Применить миграции и выполнить `npm run db:migrate:verify`.
4. Развернуть совместимый release приложения и worker.
5. Выполнить активную синхронизацию Ozon.
6. Запускать bounded backfill и после каждого batch сверять количество
   оставшихся FBS orders без fulfillment.
7. Проверить UI, FBO isolation, inventory totals и только затем выключить
   maintenance.

Приложение этапа 2 нельзя выкладывать раньше миграции `0006`: PostgreSQL
repository ожидает новые явные колонки и таблицы.

## Проверки

Выполнено:

- `npm run check:fulfillment-stage2`;
- `npm run check:fulfillment-stage2:db` в изолированной PostgreSQL 17;
- `npm run check:marking-security`;
- `npm run build`;
- полный migration rehearsal `status -> up -> verify -> up -> verify`;
- upgrade-тест миграции поверх исторических FBS/FBO строк старой схемы;
- проверка source key при позднем появлении `product_id`;
- повторный sync без дублей;
- quantity `>1`;
- split posting;
- смена статуса и отмена;
- исчезновение source item без физического удаления истории;
- FBO без fulfillment и без изменения склада;
- bounded backfill;
- неизменность количества строк и сумм в inventory/transactions.

## Что остается до закрытия production-ворот

- отдельный reviewed deploy миграций `0005` и `0006`;
- активный production backfill;
- сверка, что все активные FBS строки получили fulfillment item;
- проверка текущих экранов заказов и склада на production данных;
- подтверждение, что первый реальный required-mark posting дает ожидаемые
  Ozon marking signals.

Следующий этап разработки: этап 3, marking core schema и независимые state
machines. Он по-прежнему не включает внешние production-записи.
