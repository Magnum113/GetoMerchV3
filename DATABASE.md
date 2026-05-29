# GetoMerch — документация БД (Supabase Postgres)

Полная справка по каждой таблице: назначение, колонки, ограничения,
внешние ключи, индексы и где это используется в коде. Все таблицы живут в
схеме `public` с префиксом `merch_`. RLS включён везде с открытой политикой
`for all using (true) with check (true)` (однопользовательский режим — нет
аутентификации).

ID — `uuid` с дефолтом `gen_random_uuid()`. Временные метки — `timestamptz`
с дефолтом `now()`. Денежные суммы — `numeric` (без масштаба, чтобы не
терять копейки).

Скрипт миграций — `supabase/migrations/<YYYYMMDDHHMM>_<snake_case>.sql`.

---

## Содержание

**Справочники**
1. [`merch_warehouses`](#1-merch_warehouses)
2. [`merch_product_categories`](#2-merch_product_categories)
3. [`merch_fabric_types`](#3-merch_fabric_types)
4. [`merch_colors`](#4-merch_colors)
5. [`merch_sizes`](#5-merch_sizes)
6. [`merch_designs`](#6-merch_designs)
7. [`merch_decoration_types`](#7-merch_decoration_types)

**Каталог**
8. [`merch_products`](#8-merch_products)

**Остатки**
9. [`merch_inventory`](#9-merch_inventory)
10. [`merch_print_inventory`](#10-merch_print_inventory)

**Движения**
11. [`merch_transactions`](#11-merch_transactions)

**Цех вышивки**
12. [`merch_workshop_orders`](#12-merch_workshop_orders)
13. [`merch_workshop_order_items`](#13-merch_workshop_order_items)

**Ozon**
14. [`merch_ozon_orders`](#14-merch_ozon_orders)
15. [`merch_ozon_order_items`](#15-merch_ozon_order_items)
16. [`merch_ozon_finance_operations`](#16-merch_ozon_finance_operations)

**Расходы**
17. [`merch_expense_categories`](#17-merch_expense_categories)
18. [`merch_expenses`](#18-merch_expenses)

[Карта связей (FK-граф)](#карта-связей-fk-граф) · [Принципы и инварианты](#принципы-и-инварианты)

---

## 1. `merch_warehouses`

Физические места хранения: «свои» склады (где мы храним готовое и заготовки)
и «цеха» (внешние подрядчики, выполняющие вышивку). Тип склада завязан в
бизнес-логике повсюду — менять руками через UPDATE опасно.

| Колонка | Тип | NULL | Default | Описание |
|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | PK |
| `name` | text | NO | — | Отображаемое имя (например, «Мой склад», «Цех вышивки Махачкала») |
| `type` | text | NO | — | Один из `own` / `workshop`. CHECK-констрейнт |
| `address` | text | YES | — | Адрес, опционально |
| `contact` | text | YES | — | Контакт (телефон/телеграм), опционально |
| `notes` | text | YES | — | Свободные заметки |
| `created_at` | timestamptz | YES | `now()` | |

**Ограничения**

- `CHECK (type IN ('own', 'workshop'))`
- Никто на эту таблицу не каскадит — складов мало, их обычно правят руками
  через `/settings`

**Где используется**

- Все запросы `api.listWarehouses()` — селектор склада в формах
- `inventory-dashboard.tsx` — фильтр по складу с цветной точкой
  (`bg-emerald-500` для own, `bg-amber-500` для workshop)
- `shipOzonOrder` — приоритет отгрузки `preferred → own → workshop`
- Правила 1–4 в ARCHITECTURE.md — поведение зависит от `type`

---

## 2. `merch_product_categories`

Категории изделия: футболка, худи, свитшот. `slug` участвует в SKU
(`tshirt-reg-cherniy-l-blank`) и в логике дефолтов (например, дефолтная
закупка пустых).

| Колонка | Тип | NULL | Default | Описание |
|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | PK |
| `name` | text | NO | — | UNIQUE. Видимое имя («Футболка») |
| `slug` | text | NO | — | UNIQUE. Латиница, kebab-case (`tshirt`, `hoodie`, `sweatshirt`) |
| `created_at` | timestamptz | YES | `now()` | |

**Текущие значения**: `tshirt`, `hoodie`, `sweatshirt`.

**Где используется**

- `merch_products.category_id` (NO ACTION) — удалить категорию нельзя,
  пока есть привязанные SKU
- `buildSku` в `api.ts` — берёт `slug` для генерации артикула
- Стоимость заготовок: пустая `tshirt + reg` = 650 ₽, `tshirt + vrn` = 780 ₽,
  `hoodie`/`sweatshirt` = 1200 ₽ (см. ARCHITECTURE 15e)

---

## 3. `merch_fabric_types`

Тип ткани: обычная (`reg`), варёнка (`vrn`). Аналог категории, тоже участвует
в SKU и дефолтных ценах заготовок.

| Колонка | Тип | NULL | Default | Описание |
|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | PK |
| `name` | text | NO | — | UNIQUE («Обычная», «Варёнка») |
| `slug` | text | NO | — | UNIQUE (`reg`, `vrn`) |
| `created_at` | timestamptz | YES | `now()` | |

**Где используется**

- `merch_products.fabric_id` (NO ACTION)
- `buildSku` в `api.ts`
- Дефолтная цена заготовки зависит от пары `(category.slug, fabric.slug)`

---

## 4. `merch_colors`

Каталог цветов с hex-кодом для UI-индикаторов (точки рядом с названием
модели в матрицах остатков).

| Колонка | Тип | NULL | Default | Описание |
|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | PK |
| `name` | text | NO | — | UNIQUE («Чёрный», «Белый», «Бежевый») |
| `hex_code` | text | YES | — | `#000000`, `#FFFFFF` и т.п. Используется в `style.backgroundColor` |
| `created_at` | timestamptz | YES | `now()` | |

**Где используется**

- `merch_products.color_id` (NO ACTION)
- Все матрицы остатков, селекторы цвета — кружок индикатора

---

## 5. `merch_sizes`

Размеры (S, M, L, XL, XXL, XXXL). `sort_order` определяет порядок колонок
в матрицах остатков — это критично, без него размеры показывались бы в
алфавитном порядке (L→M→S→XL).

| Колонка | Тип | NULL | Default | Описание |
|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | PK |
| `name` | text | NO | — | UNIQUE («S», «M»...) |
| `sort_order` | integer | NO | `0` | Меньше → левее. Для S=1, M=2... XXXL=6 |
| `created_at` | timestamptz | YES | `now()` | |

**Где используется**

- `merch_products.size_id` (NO ACTION)
- `inventory-dashboard.tsx` — `sortedSizes = [...sizes].sort((a, b) => a.sort_order - b.sort_order)`
- Любая матрица остатков и формы приёмки — заголовки колонок

---

## 6. `merch_designs`

Каталог дизайнов. Тип определяет, для какого `decoration_type` дизайн
пригоден: `print` — для печати наклеек, `embroidery` — для вышивки.

| Колонка | Тип | NULL | Default | Описание |
|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | PK |
| `name` | text | NO | — | «Сатору Годжо (ЧБ)», «Itachi Swoosh» |
| `type` | text | NO | `'print'` | `print` / `embroidery`. CHECK |
| `description` | text | YES | — | Свободный текст |
| `image_url` | text | YES | — | URL картинки для превью в каталоге и в принт-карточке |
| `created_at` | timestamptz | YES | `now()` | |

**Ограничения**

- `CHECK (type IN ('print', 'embroidery'))`

**Где используется**

- `merch_products.design_id` (CASCADE) — удаление дизайна каскадно убивает
  готовые SKU с этим дизайном (и через них — связанные `merch_inventory`).
  Журнал транзакций сохраняется через SET NULL на `product_id`
- `merch_print_inventory.design_id` (CASCADE) — без дизайна нет принт-стока
- `merch_transactions.design_id` / `source_design_id` (SET NULL) — история сохраняется
- `merch_workshop_order_items.design_id` (SET NULL)
- `/designs` — CRUD-страница с загрузкой картинок в Supabase Storage

---

## 7. `merch_decoration_types`

Способ нанесения дизайна на заготовку. Поле `made_at` определяет, где
выполняется работа: `own` (мы наклеиваем принт у себя) или `workshop`
(передаём в цех вышивки).

| Колонка | Тип | NULL | Default | Описание |
|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | PK |
| `name` | text | NO | — | UNIQUE («Принт», «Вышивка») |
| `slug` | text | NO | — | UNIQUE (`print`, `embroidery`) |
| `made_at` | text | NO | — | `own` / `workshop`. CHECK |
| `created_at` | timestamptz | YES | `now()` | |

**Ограничения**

- `CHECK (made_at IN ('own', 'workshop'))`

**Где используется**

- `merch_products.decoration_type_id` (NO ACTION) — удалить нельзя пока
  есть готовые SKU
- `api.produce` — если `slug='print'`, при производстве автоматически
  списывается 1 принт со склада производства
- `availability(item)` в `/orders` — определяет `isPrint`. Для печатей
  пустые из склада workshop в подсчёт не идут (правило 4a в ARCHITECTURE)
- `workshopEligible` в `/orders` — кнопка «Отправить в цех» доступна
  только для позиций с `made_at='workshop'`

---

## 8. `merch_products`

Каталог SKU. Один SKU = уникальная комбинация
`category × fabric × color × size [× design × decoration_type]`. Поле
`is_blank=true` для заготовок (без дизайна), `is_blank=false` для готовых.
Поле `sku` совпадает с `offer_id` в Ozon — именно по нему матчатся заказы.

| Колонка | Тип | NULL | Default | Описание |
|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | PK |
| `category_id` | uuid | NO | — | FK → `merch_product_categories` (NO ACTION) |
| `fabric_id` | uuid | NO | — | FK → `merch_fabric_types` (NO ACTION) |
| `color_id` | uuid | NO | — | FK → `merch_colors` (NO ACTION) |
| `size_id` | uuid | NO | — | FK → `merch_sizes` (NO ACTION) |
| `design_id` | uuid | YES | — | FK → `merch_designs` (CASCADE). NULL для заготовок |
| `decoration_type_id` | uuid | YES | — | FK → `merch_decoration_types` (NO ACTION). NULL для заготовок |
| `sku` | text | YES | — | UNIQUE. Совпадает с `offer_id` в Ozon |
| `is_blank` | boolean | NO | `false` | `true` ⇒ design_id и decoration_type_id обязаны быть NULL |
| `cost_price` | numeric | YES | — | Закупочная себестоимость, ₽. Для заготовок (пустых) залита одноразово, для готовых выставлена через `/products` |
| `sale_price` | numeric | YES | — | Розничная цена (последняя известная). Тянется через `sync-prices` |
| `legacy_skus` | text[] | NO | `'{}'` | Старые `offer_id` после переименования в Ozon. Используется при матчинге заказов |
| `created_at` | timestamptz | YES | `now()` | |

**Ограничения**

- `CHECK design_decoration_consistency`:
  ```sql
  (is_blank=true  AND design_id IS NULL     AND decoration_type_id IS NULL)
  OR
  (is_blank=false AND design_id IS NOT NULL AND decoration_type_id IS NOT NULL)
  ```
  — нельзя «полу-готовый» SKU. Либо заготовка без украшения, либо готовое
  и с дизайном, и с типом нанесения.
- `UNIQUE (sku)` — `offer_id` уникален в каталоге
- Уникальный индекс пустой комбо: `UNIQUE (category, fabric, color, size) WHERE is_blank=true`
- Уникальный индекс готового комбо: `UNIQUE (category, fabric, color, size, design, decoration_type) WHERE is_blank=false`
- GIN-индекс на `legacy_skus` — быстрый поиск по старым `offer_id`

**Где используется**

- `merch_inventory.product_id` (CASCADE) — удаление товара убирает остатки
- `merch_ozon_order_items.product_id` (SET NULL)
- `merch_workshop_order_items.blank_product_id` / `result_product_id` (SET NULL)
- `merch_transactions.product_id` / `source_product_id` (SET NULL)

**Текущие дефолтные `cost_price` для заготовок**

| Категория | Ткань | Цена |
|---|---|---|
| tshirt | reg | 650 ₽ |
| tshirt | vrn | 780 ₽ |
| hoodie | reg | 1200 ₽ |
| sweatshirt | reg | 1200 ₽ |

Если у заготовки `cost_price IS NULL` — она попадёт в карточку «Стоимость
остатков» с нулевой стоимостью, ошибки не будет.

---

## 9. `merch_inventory`

Остатки готовых и пустых изделий: `(product_id, warehouse_id) → quantity`.
Одна строка на пару товар×склад. Никогда не отрицательное количество (CHECK).

| Колонка | Тип | NULL | Default | Описание |
|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | PK |
| `product_id` | uuid | NO | — | FK → `merch_products` (CASCADE) |
| `warehouse_id` | uuid | NO | — | FK → `merch_warehouses` (CASCADE) |
| `quantity` | integer | NO | `0` | CHECK `>= 0` |
| `updated_at` | timestamptz | YES | `now()` | |

**Ограничения**

- `UNIQUE (product_id, warehouse_id)` — не может быть двух строк на ту же пару
- `CHECK (quantity >= 0)`

**Индексы**

- `idx_inventory_product (product_id)`
- `idx_inventory_warehouse (warehouse_id)`

**Где используется**

- `api.listInventory()` фильтрует `quantity > 0` — пустые карточки не
  возвращаются, но при `adjustInventory` карточка создаётся и может
  остаться с 0 (если списали всё)
- `api.adjustInventory(productId, warehouseId, delta)` — единая точка
  изменения. Любое движение остатков идёт через неё + отдельную запись
  в `merch_transactions`
- `inventory-dashboard.tsx` — все матрицы и стоимость остатков

---

## 10. `merch_print_inventory`

Остатки готовых принтов (физические наклейки, которые потом наносим на
футболки). Принты живут только на «своих» складах — на цеха вышивки их не
возят. Бизнес-правило не CHECK-констрейнтом, а UX-фильтрами (см.
ARCHITECTURE 1).

| Колонка | Тип | NULL | Default | Описание |
|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | PK |
| `design_id` | uuid | NO | — | FK → `merch_designs` (CASCADE) |
| `warehouse_id` | uuid | NO | — | FK → `merch_warehouses` (CASCADE) |
| `quantity` | integer | NO | `0` | CHECK `>= 0` |
| `updated_at` | timestamptz | NO | `now()` | |

**Ограничения**

- `UNIQUE (design_id, warehouse_id)`
- `CHECK (quantity >= 0)`

**Где используется**

- `api.produce` (если `decoration_type.slug='print'`) — автосписание 1 шт
  принта на 1 готовое изделие. Перед списанием делается предпроверка
  наличия, чтобы не зацепить заготовки и развалить инвентарь.
- `print-inventory-actions.tsx` — приёмка / корректировка
- `inventory-dashboard.tsx` — карточка «Принты на складе»

---

## 11. `merch_transactions`

Журнал всех движений товара или принта. Append-only — записи не редактируются.
Откат делается обратной транзакцией типа `adjustment`. Связывает два
параллельных потока (товары и принты) — поэтому `product_id` и `design_id`
оба nullable, но прикладной код гарантирует, что одно из них заполнено.

| Колонка | Тип | NULL | Default | Описание |
|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | PK |
| `type` | text | NO | — | `receive` / `transfer` / `sale` / `production` / `adjustment` / `writeoff` |
| `product_id` | uuid | YES | — | FK → `merch_products` (SET NULL). Для движений товара |
| `design_id` | uuid | YES | — | FK → `merch_designs` (SET NULL). Для движений принтов |
| `source_product_id` | uuid | YES | — | FK → `merch_products` (SET NULL). Для `production` — какую заготовку использовали |
| `source_design_id` | uuid | YES | — | FK → `merch_designs` (SET NULL). Для `production` с принтом — какой дизайн использовали |
| `from_warehouse_id` | uuid | YES | — | FK → `merch_warehouses` (NO ACTION). Откуда уходит |
| `to_warehouse_id` | uuid | YES | — | FK → `merch_warehouses` (NO ACTION). Куда приходит |
| `quantity` | integer | NO | — | CHECK `> 0` |
| `workshop_order_id` | uuid | YES | — | FK → `merch_workshop_orders` (NO ACTION). Привязка к заказу в цех |
| `notes` | text | YES | — | Свободные заметки (часто содержат `posting_number` Ozon) |
| `occurred_at` | timestamptz | YES | `now()` | Фактическая дата движения (отличается от `created_at`, если задним числом) |
| `created_at` | timestamptz | YES | `now()` | Когда запись попала в БД |

**Ограничения**

- `CHECK (type IN ('receive', 'transfer', 'sale', 'production', 'adjustment', 'writeoff'))`
- `CHECK (quantity > 0)` — модуль количества, направление определяется типом и парой `from/to`
- **Нет CHECK** `product_id IS NOT NULL OR design_id IS NOT NULL`
  (раньше был, удалён миграцией `202605241500_drop_tx_subject_check.sql` —
  конфликтовал с `ON DELETE SET NULL` при удалении товара). Инвариант
  держит прикладной код в `api.ts`

**Индексы**

- `idx_transactions_date (occurred_at DESC)` — `/transactions` сортирует по дате
- `idx_transactions_product (product_id)` — журнал по конкретному SKU

**Типы движений**

| `type` | Что значит | from / to |
|---|---|---|
| `receive` | Поступление извне (купили заготовок, привезли принты) | only `to_warehouse_id` |
| `transfer` | Перемещение между складами | оба |
| `sale` | Продажа клиенту (Ozon отгрузка) | only `from_warehouse_id` |
| `production` | Производство (заготовка → готовое). Параллельно списывается принт, если `decoration_type='print'` | `to_warehouse_id` = место производства |
| `adjustment` | Корректировка с произвольным знаком. `to_warehouse_id` для +, `from_warehouse_id` для − | один из двух |
| `writeoff` | Списание (брак, потеря) | only `from_warehouse_id` |

**Где используется**

- `/transactions` — журнал, постранично
- Все методы `api.*` (receive, transfer, sale, produce, writeoff, adjust)
  пишут одну строку в `merch_transactions` параллельно с
  `adjustInventory`. Если падение посередине — данные неконсистентны
  (см. долг 11 в ARCHITECTURE)

---

## 12. `merch_workshop_orders`

Заказы во внешний цех вышивки. Жизненный цикл: `sent → ready → received`
(плюс терминальный `cancelled`). Раньше были статусы `pending`/`in_progress` —
удалены в миграции `202605231200`, см. правило 11 в ARCHITECTURE.

| Колонка | Тип | NULL | Default | Описание |
|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | PK |
| `order_number` | text | YES | — | UNIQUE. Человекочитаемый номер `WO-20260529-123` |
| `workshop_id` | uuid | NO | — | FK → `merch_warehouses` (NO ACTION). Тип склада обязан быть `workshop` (валидация в коде) |
| `status` | text | NO | `'sent'` | `sent` / `ready` / `received` / `cancelled`. CHECK |
| `notes` | text | YES | — | |
| `created_at` | timestamptz | YES | `now()` | |
| `sent_at` | timestamptz | YES | — | Когда отправили в работу (= created_at для всех новых) |
| `completed_at` | timestamptz | YES | — | Когда цех пометил `ready` |
| `received_at` | timestamptz | YES | — | Когда забрали (`received`) — триггерит автопроизводство |

**Ограничения**

- `CHECK (status IN ('sent', 'ready', 'received', 'cancelled'))`
- `UNIQUE (order_number)`

**Жизненный цикл**

```
   createWorkshopOrder              updateWorkshopOrderStatus
       │                                     │
       ▼                                     ▼
     sent ──── cancelled            sent ──→ ready ──→ received
       │                                                │
       └─ автоперемещение заготовок                     └─ автопроизводство:
          со своего склада в цех                           заготовки → готовое
          (если их там не хватает)                         в складе цеха
```

**Где используется**

- `merch_workshop_order_items.order_id` (CASCADE) — каскадное удаление позиций
- `merch_ozon_orders.workshop_order_id` (SET NULL) — связь с FBS-заказом
- `merch_transactions.workshop_order_id` (NO ACTION) — для аудита

---

## 13. `merch_workshop_order_items`

Позиции заказа в цех: какую заготовку взять, какой дизайн нанести.
`result_product_id` заполняется автоматически при переходе в `received`
(вызов `findOrCreateProduct` создаёт готовый SKU, если ещё не было).

| Колонка | Тип | NULL | Default | Описание |
|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | PK |
| `order_id` | uuid | NO | — | FK → `merch_workshop_orders` (CASCADE) |
| `blank_product_id` | uuid | YES | — | FK → `merch_products` (SET NULL). Заготовка |
| `design_id` | uuid | NO | — | FK → `merch_designs` (SET NULL). Какой дизайн нанести |
| `decoration_type_id` | uuid | NO | — | FK → `merch_decoration_types` (NO ACTION). Как нанести (обычно `embroidery`) |
| `result_product_id` | uuid | YES | — | FK → `merch_products` (SET NULL). Создаётся при `received` |
| `quantity` | integer | NO | — | CHECK `> 0` |
| `notes` | text | YES | — | |

**Индексы**

- `idx_workshop_items_order (order_id)`

---

## 14. `merch_ozon_orders`

Зеркало отправлений из личного кабинета Ozon. Объединяет FBS и FBO в одной
таблице — различает их по колонке `source`. FBS — те, что отправляем мы;
FBO — отправляет Ozon со своего склада, нам важны только для аналитики и
COGS-матчинга по `posting_number`.

| Колонка | Тип | NULL | Default | Описание |
|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | PK |
| `posting_number` | text | NO | — | UNIQUE. ID отправления у Ozon (`0131384148-0025-5`) |
| `order_id` | bigint | YES | — | Числовой ID заказа в Ozon |
| `order_number` | text | YES | — | Человекочитаемый номер заказа |
| `status` | text | NO | — | Один из `OZON_STATUS_LABELS` (см. types.ts). Приходит как есть от Ozon |
| `substatus` | text | YES | — | Под-статус Ozon, не используется в UI |
| `ozon_created_at` | timestamptz | YES | — | Когда заказ создан в Ozon |
| `in_process_at` | timestamptz | YES | — | Когда взят в обработку. По нему сортируем «активные» |
| `shipment_date` | timestamptz | YES | — | Дедлайн отгрузки (для FBS) |
| `delivery_method` | text | YES | — | «Доставка Ozon самостоятельно, Махачкала», «PVZ», «FBO» (как fallback) |
| `warehouse_name` | text | YES | — | Склад Ozon (для FBO) или склад продавца |
| `customer_name` | text | YES | — | Имя клиента (если приходит от Ozon) |
| `total_price` | numeric | YES | — | Сумма всех позиций × цена |
| `source` | text | YES | — | **`'fbs'` или `'fbo'`**. Индексировано. Заполняется при синхронизации |
| `raw` | jsonb | YES | — | Полный ответ Ozon на posting. Используется как страховка; не запрашиваем в обычных запросах |
| `synced_at` | timestamptz | NO | `now()` | Метка последнего апсерта |
| `shipped_at` | timestamptz | YES | — | Когда мы нажали «Отправил». Только для FBS |
| `shipped_from_warehouse_id` | uuid | YES | — | FK → `merch_warehouses` (SET NULL). Откуда отгрузили (для отката) |
| `workshop_order_id` | uuid | YES | — | FK → `merch_workshop_orders` (SET NULL). Связь с заказом в цех |
| `notes` | text | YES | — | |
| `created_at` | timestamptz | NO | `now()` | |

**Ограничения**

- `UNIQUE (posting_number)` — апсерт по этому ключу

**Индексы**

- `merch_ozon_orders_status_idx (status)`
- `merch_ozon_orders_created_idx (ozon_created_at DESC)`
- `merch_ozon_orders_shipped_idx (shipped_at)`
- `merch_ozon_orders_workshop_order_idx (workshop_order_id)`
- `merch_ozon_orders_source_idx (source)` — для фильтра FBS/FBO

**Где используется**

- `/orders` — список с фильтром `source != 'fbo'` (FBO скрываем)
- `analytics/orders-chart`, `ordersSummary`, `bucketizeOrdersRevenue` —
  считают обе схемы
- `analytics.ts buildCostIndex` — `byPosting`-индекс для точного COGS-матчинга
- `shipOzonOrder` пишет `shipped_at` и `shipped_from_warehouse_id`,
  `unshipOzonOrder` откатывает
- Внешняя ссылка в карточке:
  `https://seller.ozon.ru/app/postings/{source}?postingDetails={posting_number}`

**Источник записей**

- Кнопка «Синхронизировать» (`scope=active`) → `POST /v3/posting/fbs/unfulfilled/list`
  тянет только не-отгруженные FBS. FBO в этом сценарии НЕ обновляются
- Кнопка «Полная» (`scope=all`, дефолт 60 дней) → параллельно `/v3/posting/fbs/list`
  и `/v2/posting/fbo/list`, упсерт по `posting_number`
- При синхронизации позиций (`merch_ozon_order_items`) **уже отгруженные**
  заказы (`shipped_at IS NOT NULL`) пропускаются, чтобы не потерять
  `shipped_from_warehouse_id` на позициях

---

## 15. `merch_ozon_order_items`

Позиции отправления Ozon. Создаются при синхронизации (одна транзакция
DELETE + INSERT по `order_id` для неотправленных заказов).

| Колонка | Тип | NULL | Default | Описание |
|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | PK |
| `order_id` | uuid | NO | — | FK → `merch_ozon_orders` (CASCADE) |
| `offer_id` | text | NO | — | `offer_id` из Ozon — должно совпадать с `merch_products.sku` |
| `ozon_sku` | text | YES | — | Числовой SKU Ozon (как строка). Используется в COGS-fallback |
| `name` | text | YES | — | Название позиции у Ozon |
| `quantity` | integer | NO | — | Сколько штук в позиции |
| `price` | numeric | YES | — | Цена за штуку |
| `product_id` | uuid | YES | — | FK → `merch_products` (SET NULL). Заполняется матчингом `offer_id ↔ sku` (включая `legacy_skus`). NULL ⇒ позиция не сопоставлена с каталогом — показываем бейдж «Нет SKU в каталоге» |
| `shipped_from_warehouse_id` | uuid | YES | — | FK → `merch_warehouses` (SET NULL). Какой склад фактически отгрузил эту позицию (заполняется в `shipOzonOrder`) |
| `created_at` | timestamptz | NO | `now()` | |

**Индексы**

- `merch_ozon_order_items_order_idx (order_id)`
- `merch_ozon_order_items_product_idx (product_id)`
- `merch_ozon_order_items_offer_idx (offer_id)`

**Зачем нужен `ozon_sku`**

В Ozon Finance API события (`merch_ozon_finance_operations`) приходят с
`items[].sku` (числовой Ozon SKU). Иногда `posting_number` финопа не
матчится с нашими `merch_ozon_orders` (например, старые/неподтянутые
отправления). Тогда `buildCostIndex.bySku` использует пару
`ozon_sku ↔ product` как fallback. Это аппроксимация — для одной строки
items quantity выводим через `accruals / sale_price`, для много-товарных
финопов default = 1 шт на строку.

---

## 16. `merch_ozon_finance_operations`

Зеркало финансовых операций Ozon: продажи, возвраты, комиссии, логистика,
эквайринг, штрафы, подписки. Каждая операция — атомарное изменение баланса
продавца. Источник КАЖДОЙ цифры в дашборде (выручка, расходы, чистая прибыль).

| Колонка | Тип | NULL | Default | Описание |
|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | PK |
| `operation_id` | bigint | NO | — | UNIQUE. ID операции в Ozon (идемпотентный ключ) |
| `operation_type` | text | NO | — | Машинный тип (`OperationAgentDeliveredToCustomer`, `ClientReturnAgentOperation`, `DefectFineShipmentDelay`...) |
| `operation_type_name` | text | YES | — | Человекочитаемое название от Ozon |
| `operation_date` | timestamptz | NO | — | Дата операции (на ней основан кассовый метод выручки) |
| `posting_number` | text | YES | — | Привязка к отправлению. NULL для штрафов/подписок |
| `accruals_for_sale` | numeric | YES | — | Сколько начислено за продажу (положительное; для возвратов — отрицательное) |
| `sale_commission` | numeric | YES | — | Комиссия Ozon (отрицательная — удержали; положительная — вернули комиссию) |
| `amount` | numeric | NO | — | Нетто-движение по счёту продавца. Сумма `amount` всех операций за период = деньги, пришедшие от Ozon |
| `services` | jsonb | YES | — | Массив `{name: string, price: number}` — логистика, эквайринг и прочие услуги |
| `items` | jsonb | YES | — | Массив `{sku, name}` — какие товары участвовали. Без quantity |
| `raw` | jsonb | YES | — | Полный ответ Ozon (страховка) |
| `synced_at` | timestamptz | NO | `now()` | |

**Ограничения**

- `UNIQUE (operation_id)` — идемпотентный апсерт. Перед апсертом батч
  обязательно дедуплицировать (Ozon на границах месячных окон может
  вернуть одну и ту же операцию дважды → ошибка `21000` без дедупа)

**Индексы**

- `merch_ozon_finance_ops_date_idx (operation_date DESC)`
- `merch_ozon_finance_ops_type_idx (operation_type)`
- `merch_ozon_finance_ops_posting_idx (posting_number)`

**Где используется**

- Только в `lib/analytics.ts` (`computePeriodMetrics`, `bucketize`,
  `expenseBreakdown`, `topProductsByProfit`)
- Источник чисел для всех KPI и графиков на дашборде `/`
- Запросы фильтруются по `operation_date >= filter.from AND < filter.to`

**Формула прибыли**

```
cashFromOzon  = Σ amount  за период
COGS          = Σ stockCost(item.qty)  по сматченным позициям
tax           = max(0, cashFromOzon) × 0.06   (УСН 6%)
otherExpenses = Σ amount merch_expenses  за период
netProfit     = cashFromOzon − COGS − tax − otherExpenses
```

Все промежуточные расходы (комиссия, логистика, возвраты, налог, прочее)
сгруппированы в `expenseBreakdown` так, чтобы `Σ expenseBreakdown = revenue − netProfit`.

---

## 17. `merch_expense_categories`

Пользовательские категории ручных расходов (вне Ozon) — аренда, зарплата,
маркетинг, реквизит и т.п. Цвет используется в donut-диаграмме.

| Колонка | Тип | NULL | Default | Описание |
|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | PK |
| `name` | text | NO | — | «Аренда», «Реквизит», «Зарплаты» |
| `color` | text | YES | — | Hex для donut. Если NULL — используется дефолт из палитры |
| `sort_order` | integer | NO | `0` | Меньше → выше в списке |
| `archived` | boolean | NO | `false` | Архивированные не показываются в формах, но видны в исторических расходах |
| `created_at` | timestamptz | NO | `now()` | |

**Где используется**

- `merch_expenses.category_id` (SET NULL) — при удалении категории расходы
  остаются «без категории»
- `/expenses` — категории в селекторе, donut-расцветка

---

## 18. `merch_expenses`

Ручные расходы вне Ozon: то, что НЕ приходит в `merch_ozon_finance_operations`,
но влияет на чистую прибыль (аренда, зарплаты, маркетинг, налоги вне УСН).

| Колонка | Тип | NULL | Default | Описание |
|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | PK |
| `category_id` | uuid | YES | — | FK → `merch_expense_categories` (SET NULL) |
| `amount` | numeric | NO | — | CHECK `> 0`. ₽ |
| `occurred_at` | date | NO | `CURRENT_DATE` | Дата расхода (день, без времени) |
| `description` | text | YES | — | Свободное описание |
| `created_at` | timestamptz | NO | `now()` | |

**Ограничения**

- `CHECK (amount > 0)`

**Индексы**

- `merch_expenses_occurred_idx (occurred_at DESC)`
- `merch_expenses_category_idx (category_id)`

**Где используется**

- `/expenses` — CRUD-страница
- `computePeriodMetrics` — попадают в `otherExpenses` (по сматченной
  категории) и/или в `expenseBreakdown` (если у категории есть `color`,
  попадает отдельной долькой в donut)

---

## Карта связей (FK-граф)

```
merch_warehouses ──┬─< merch_inventory.warehouse_id          (CASCADE)
                   ├─< merch_print_inventory.warehouse_id    (CASCADE)
                   ├─< merch_transactions.from_warehouse_id  (NO ACTION)
                   ├─< merch_transactions.to_warehouse_id    (NO ACTION)
                   ├─< merch_ozon_orders.shipped_from_warehouse_id   (SET NULL)
                   ├─< merch_ozon_order_items.shipped_from_warehouse_id (SET NULL)
                   └─< merch_workshop_orders.workshop_id     (NO ACTION)

merch_product_categories ──< merch_products.category_id   (NO ACTION)
merch_fabric_types       ──< merch_products.fabric_id     (NO ACTION)
merch_colors             ──< merch_products.color_id      (NO ACTION)
merch_sizes              ──< merch_products.size_id       (NO ACTION)

merch_designs ──┬─< merch_products.design_id              (CASCADE)
                ├─< merch_print_inventory.design_id       (CASCADE)
                ├─< merch_transactions.design_id          (SET NULL)
                ├─< merch_transactions.source_design_id   (SET NULL)
                └─< merch_workshop_order_items.design_id  (SET NULL)

merch_decoration_types ──┬─< merch_products.decoration_type_id          (NO ACTION)
                         └─< merch_workshop_order_items.decoration_type_id (NO ACTION)

merch_products ──┬─< merch_inventory.product_id                       (CASCADE)
                 ├─< merch_transactions.product_id                    (SET NULL)
                 ├─< merch_transactions.source_product_id             (SET NULL)
                 ├─< merch_ozon_order_items.product_id                (SET NULL)
                 ├─< merch_workshop_order_items.blank_product_id      (SET NULL)
                 └─< merch_workshop_order_items.result_product_id     (SET NULL)

merch_workshop_orders ──┬─< merch_workshop_order_items.order_id  (CASCADE)
                        ├─< merch_ozon_orders.workshop_order_id  (SET NULL)
                        └─< merch_transactions.workshop_order_id (NO ACTION)

merch_ozon_orders ──< merch_ozon_order_items.order_id  (CASCADE)

merch_expense_categories ──< merch_expenses.category_id  (SET NULL)
```

---

## Принципы и инварианты

### Naming

- Все таблицы — префикс `merch_` (чтобы не пересекаться с системными
  таблицами Supabase: `auth.*`, `storage.*`)
- Колонки — `snake_case`
- FK всегда `<table_singular>_id` (`product_id`, не `productId` и не `prod`)
- ID — всегда `id uuid`

### Удаление

- **Справочники** (категория, ткань, цвет, размер, тип украшения) —
  `NO ACTION`. Удалить нельзя, пока есть SKU. Это правильное поведение:
  справочник менять руками опасно, обычно их добавляют, а не удаляют
- **Дизайн** (`merch_designs`) — CASCADE на готовые SKU и принт-сток,
  SET NULL на транзакции и заказы в цех. Удалили дизайн ⇒ исчезли все
  готовые SKU с этим дизайном (но журнал событий уцелел)
- **Продукт** (`merch_products`) — CASCADE на инвентарь, SET NULL на
  транзакции, позиции Ozon, позиции цеха. Журнал движений сохраняется
- **Склад** (`merch_warehouses`) — CASCADE на инвентарь и принт-сток,
  NO ACTION/SET NULL на остальное. Удалять склад с остатками нельзя
- **Категория расходов** — SET NULL. Расходы остаются без категории,
  попадают в «прочие»
- **Транзакции** — append-only. Удалять руками нельзя

### CHECK-констрейнты

| Таблица | Констрейнт | Что гарантирует |
|---|---|---|
| `merch_warehouses` | `type IN ('own','workshop')` | Тип склада |
| `merch_decoration_types` | `made_at IN ('own','workshop')` | Где наносим украшение |
| `merch_designs` | `type IN ('print','embroidery')` | Тип дизайна |
| `merch_products` | `design_decoration_consistency` | Заготовка ⇒ design+decoration=NULL; готовое ⇒ оба NOT NULL |
| `merch_inventory` | `quantity >= 0` | Не уйти в минус по остаткам |
| `merch_print_inventory` | `quantity >= 0` | Аналогично |
| `merch_transactions` | `type IN (receive,transfer,sale,production,adjustment,writeoff)` | Допустимые типы движения |
| `merch_transactions` | `quantity > 0` | Модуль; направление по from/to |
| `merch_workshop_orders` | `status IN (sent,ready,received,cancelled)` | Цикл цеха |
| `merch_expenses` | `amount > 0` | Расход — всегда положительный |

### UNIQUE-констрейнты и идемпотентность

| Таблица | Уникальность | Зачем |
|---|---|---|
| `merch_products` | `sku` | `offer_id` Ozon должен быть уникален |
| `merch_products` | `(category, fabric, color, size) WHERE is_blank` | Не дублировать заготовки |
| `merch_products` | `(category, fabric, color, size, design, decoration_type) WHERE NOT is_blank` | Не дублировать готовые |
| `merch_inventory` | `(product_id, warehouse_id)` | Один остаток на пару |
| `merch_print_inventory` | `(design_id, warehouse_id)` | Один остаток принта на пару |
| `merch_ozon_orders` | `posting_number` | Идемпотентный апсерт sync-orders |
| `merch_ozon_finance_operations` | `operation_id` | Идемпотентный апсерт sync-finance |
| `merch_workshop_orders` | `order_number` | Не дублировать номера заказов |

### RLS

Везде включён, политика открытая (`for all using (true) with check (true)`).
Это однопользовательский режим. Если когда-то появится второй пользователь —
переписывать политики и привязывать к `auth.uid()`.

### Транзакционность

Сейчас её нет на уровне БД для composite-операций (`produce` = списать
заготовку + добавить готовое + списать принт + записать в журнал). Каждая
операция — отдельный HTTP-запрос к PostgREST. Падение посередине →
неконсистентность. План на будущее (см. ARCHITECTURE 11): вынести в
Postgres RPC (`create function ... language plpgsql`) и обернуть в
транзакцию.

### Миграции

- Папка `supabase/migrations/`
- Имя: `<YYYYMMDDHHMM>_<snake_case>.sql`
- Применять через MCP-инструмент `apply_migration` или через CLI
  `supabase db push`
- Любая правка схемы (`ALTER TABLE`, `CREATE INDEX`, новые колонки) —
  только через миграцию, никаких ad-hoc DDL в проде
- Data-only правки (например, бекфилл новой колонки) — допустимо через
  `execute_sql`, но в production стоит оформлять миграцией, чтобы было
  воспроизводимо
