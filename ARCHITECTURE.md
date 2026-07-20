# GetoMerch — архитектура и правила разработки

Документ для разработчиков и дизайнеров, которые будут дорабатывать проект.
Здесь — устройство системы, договорённости по коду и UI, бизнес-правила и
ограничения, которые нельзя нарушать.

---

## 1. Что это вообще

Учёт мерча для одного селлера на Ozon:

- Заготовки (пустые футболки/худи) разных цветов и размеров
- Принты, которые наклеиваются на заготовки → готовое изделие
- Вышивка, которую делает внешний цех → готовое изделие
- Заказы с Ozon (FBS + FBO) подтягиваются автоматически. На странице
  `/orders` показываем только FBS (их мы отправляем сами); FBO живут в БД
  только ради аналитики (воронка заказов, COGS по `posting_number`). FBS-отправка
  одной кнопкой списывает товар со склада
- Аналитический дашборд на `/` — выручка, расходы (включая комиссии Ozon из
  Finance API, налог УСН 6%, прочие удержания), чистая прибыль с разбивкой
  по периоду, топ продуктов, и **стоимость остатков** по складам (заготовки
  + готовые в закупочных ценах)
- Раздел `/expenses` для ручных расходов вне Ozon (аренда, зарплаты,
  маркетинг и т.п.) с пользовательскими категориями

Пользователь — один (владелец бизнеса). Многопользовательской системы и ролей нет.

---

## 2. Стек

| Слой | Что используем | Версия | Зачем |
|---|---|---|---|
| Фреймворк | **Next.js (App Router)** | 15 | SSR не используем, но Route Handlers (`/api/*`) держат ключи Ozon на сервере |
| UI | **React** | 19 | |
| Стили | **Tailwind CSS** | 3.4 | Никакого CSS-in-JS, никаких отдельных `.css` файлов кроме `globals.css` |
| Компоненты | **shadcn/ui** (Radix Primitives + CVA) | — | Лежат в `src/components/ui/*`, не из npm — модифицируем напрямую |
| Иконки | **lucide-react** | — | Других иконок не добавлять |
| Графики | **recharts** | 2.x | Для аналитики (`PeriodChart`, `ExpenseDonut`, `Sparkline`). Обёрнуты тонким `ChartContainer`/`ChartTooltipCard` в `components/ui/chart.tsx` для подхвата CSS-переменных темы |
| Тосты | **sonner** | — | Везде `toast.success/error(...)`, не `alert()` |
| Формы | Локальный state + точечная валидация | — | Для коротких форм пишем «руками». Если форма становится сложной (≥5 полей с валидацией), добавляем form/validation-библиотеки отдельным осознанным решением |
| БД | **Supabase Postgres** сейчас; локальный PostgreSQL после cutover | — | Supabase RLS действует в текущем runtime; целевая БД изолируется server-side ролями |
| Клиент БД | `@supabase/supabase-js` (server-only), `pg` | — | Браузер ходит в `/api/admin/...`; после миграции доменные read/write-path будут использовать локальный `pg` |
| Дата/время | `Intl.DateTimeFormat('ru-RU')` | — | Форматирование держим в `src/lib/utils.ts`, отдельную библиотеку дат не тащим без необходимости |

**Не добавлять без причины:** другие UI-киты (MUI, AntD, Mantine), CSS-фреймворки кроме Tailwind, ORM поверх Supabase (Prisma, Drizzle), state-менеджеры (Redux, Zustand, Jotai) — пока нечего шарить между страницами. `pg` уже используется как низкоуровневый server-only read-path, это не повод добавлять ORM.

---

## 3. Структура проекта

```
src/
  app/                      # Next.js App Router
    api/auth/               # login/logout для production-админки
    api/admin/              # BFF с единым database/service layer
      jobs/                 # list/detail/cancel durable background jobs
    api/ozon/               # серверные роуты для Ozon (ключи прячутся здесь)
      sync-prices/          # POST → /v5/product/info/prices
      sync-orders/          # POST → /v3/posting/fbs/list + /v2/posting/fbo/list
      sync-finance/         # POST → /v3/finance/transaction/list (ВСЕ операции)
    inventory/              # /inventory — остатки по складам (матрицы)
    orders/                 # /orders — заказы Ozon
    products/               # /products — каталог SKU
    workshop/               # /workshop — заказы в цех вышивки
    transactions/           # /transactions — журнал движений
    designs/                # /designs — каталог дизайнов
    expenses/               # /expenses — ручные расходы и их категории
    login/                  # /login — форма входа в production-админку
    settings/               # /settings — справочники (склады, цвета, размеры)
    page.tsx                # / — аналитический дашборд (KPI, динамика, donut, топ)
    layout.tsx              # общий layout с Sidebar
  components/
    ui/                     # shadcn-компоненты (Button, Card, Dialog, ..., chart)
    analytics/              # компоненты дашборда (period-chart, expense-donut,
                            #   sparkline, expense-dialog, categories-dialog)
    sidebar.tsx             # навигация
    inventory-actions.tsx   # диалоги Приёмка/Перемещение/Производство/Продажа
    inventory-dashboard.tsx # дашборд остатков (матрицы, дефицит, KPI) — на /inventory
    print-inventory-actions.tsx  # диалоги для принтов
    product-display.tsx     # унифицированный вывод названия SKU
    product-picker.tsx      # выбор SKU через каскад селектов
    warehouse-select.tsx    # селект склада (с filterType="own"|"workshop")
  lib/
    api.ts                  # ВСЕ обращения к БД из клиента — здесь
    analytics.ts            # чистые функции расчёта метрик дашборда
                            #   (computePeriodMetrics, bucketize,
                            #   expenseBreakdown, topProductsByProfit, lookupCost)
    types.ts                # типы доменных сущностей и константы лейблов
    utils.ts                # cn, formatDate, formatMoney, toError
    supabase/client.ts        # browser client; route handlers используют @supabase/supabase-js напрямую
    admin/postgres.ts       # server-only pg Pool для прямых чтений Supabase Postgres
    admin/product-postgres.ts # server-only гидрация товаров для direct Postgres route
    admin/supabase-api.ts   # server-side Supabase REST helper для BFF fallback
    db/
      repositories/        # явные PostgreSQL/Supabase queries и row mapping
      services/            # domain read operations и strict shadow compare
      pool.ts               # lazy pool только к целевой server DB
      transaction.ts        # transaction helper server mutation-path
    jobs/                  # durable queue, claim, heartbeat, retry и worker
    ozon/                  # server-side Ozon client и sync/import services
    auth/                   # password hash + signed HttpOnly cookie session
  middleware.ts             # admin cookie; service token только для 5 Ozon routes
ops/
  getomerch-deploy-from-git # production deploy на server release
  getomerch-deploy-status   # status/smoke текущего admin контура
  getomerch-rollback        # rollback на предыдущий успешный release
  getomerch-postgres-bootstrap # изолированные DB-роли, HBA и target БД
  getomerch-db-healthcheck  # SELECT 1 + имя БД + migration version
  getomerch-data-rehearsal  # rollback-safe импорт snapshot в rehearsal
  getomerch-server-write-rehearsal # disposable mutation/jobs/Ozon regression
  getomerch-local-db-restore-drill # encrypted native pg_dump/restore check
  getomerch-supabase-rollback-rehearsal # pre-write rollback runtime
  systemd/                  # production worker и hourly DB backup units
db/
  migrations/               # целевые server PostgreSQL migrations
  checks/                    # read-only проверки фактической схемы
  scripts/                   # status/up/verify и clean rehearsal
scripts/
  generate-admin-password-hash.mjs # генерация ADMIN_AUTH_PASSWORD_HASH
  getomerch-worker.ts       # отдельный процесс durable Ozon jobs
  check-db-jobs.mjs         # queue/concurrency/retry/integration checks
  check-ozon-dry-run.mjs    # guarded real Ozon smoke без DB writes
supabase/
  migrations/               # SQL-миграции, имя: <YYYYMMDDHHMM>_<snake_case>.sql
```

---

## 4. Доменная модель

### 4.1. Сущности БД

| Таблица | Что хранит |
|---|---|
| `merch_warehouses` | Склады. Поле `type` ∈ {`own`, `workshop`} — критично, на нём завязана бизнес-логика |
| `merch_product_categories` | Категории (футболка, худи, свитшот). `slug` используется в SKU и в дефолтах |
| `merch_fabric_types` | Типы ткани (обычная, варёнка). Аналогично |
| `merch_colors` | Цвета с `hex_code` |
| `merch_sizes` | Размеры с `sort_order` (используется во всех матрицах для упорядочивания) |
| `merch_designs` | Дизайны. Поле `type` ∈ {`print`, `embroidery`} — определяет, для какого `decoration_type` дизайн пригоден |
| `merch_decoration_types` | Типы украшения. `slug` ∈ {`print`, `embroidery`}; `made_at` ∈ {`own`, `workshop`} |
| `merch_products` | SKU = уникальная комбинация `category × fabric × color × size [× design × decoration_type]`. Колонка `is_blank` = `true` если без украшения. `sku` = `offer_id` в Ozon (когда заполнено). `legacy_skus text[]` — для переименованных в Ozon offer_id |
| `merch_inventory` | Остатки `(product_id, warehouse_id) → quantity`. UNIQUE по паре, `quantity >= 0` |
| `merch_print_inventory` | Остатки готовых принтов `(design_id, warehouse_id) → quantity` |
| `merch_transactions` | Журнал любых движений товара или принта. `product_id` и `design_id` оба nullable, но обязательно одно из двух. Поле `type` ∈ {`receive`, `transfer`, `sale`, `production`, `adjustment`, `writeoff`} |
| `merch_workshop_orders` / `_items` | Заказы в цех вышивки. Жизненный цикл: `sent → ready → received` (плюс терминальный `cancelled`). Колонка `merch_ozon_orders.workshop_order_id` указывает на заказ в цех, созданный из заказа Ozon |
| `merch_ozon_orders` / `_items` | Зеркало отправлений Ozon: FBS из `/v3/posting/fbs/list` и FBO из `/v2/posting/fbo/list`. Колонка `source text` ∈ {`fbs`, `fbo`} (с индексом `merch_ozon_orders_source_idx`) — основной фильтр на странице `/orders` и в логике приоритета складов. Поле `workshop_order_id` (nullable, `ON DELETE SET NULL`) используется только для FBS-заказов, если для отгрузки требуется производство вышивки. `_items.ozon_sku` (Ozon SKU как строка) используется как fallback-индекс для COGS на финопах без сматченного posting |
| `merch_ozon_finance_operations` | Зеркало `/v3/finance/transaction/list`. UNIQUE по `operation_id`. Поля: `operation_type` (например `OperationAgentDeliveredToCustomer`, `ClientReturnAgentOperation`, `DefectFineShipmentDelay`), `operation_type_name`, `operation_date`, `posting_number` (nullable — у штрафов/подписок его нет), `accruals_for_sale` (положительная для продажи, отрицательная для возврата), `sale_commission` (отрицательная для удержания, положительная для возврата комиссии), `amount` (нетто-движение по счёту), `services` (jsonb массив `{name, price}`), `items` (jsonb — только `{sku, name}`, без quantity), `raw` (полный ответ Ozon на всякий случай) |
| `merch_expense_categories` | Пользовательские категории ручных расходов: `name`, `color` (hex для donut), `sort_order`, `archived` |
| `merch_expenses` | Ручные расходы вне Ozon. `amount > 0`, `occurred_at date`, `category_id` (`ON DELETE SET NULL`). Используются в дашборде в категории «Прочие расходы» и в собственных категориях donut |

### 4.2. Бизнес-правила (НЕ нарушать)

Это инварианты, которые система обещает пользователю. Если нарушите — сломаете
ментальную модель и доверие.

#### Склады

1. **Принт-сток живёт ТОЛЬКО на «Мой склад» (`type='own'`).** Принты — это
   физические наклейки, которые пользователь сам наносит на футболки. В цехе
   вышивки им делать нечего. UI приёмки принтов фиксирует склад только своих
   типов; дашборд скрывает блок «Принты» при фильтре по цеху.

2. **Готовая продукция из цеха вышивки не задерживается там.** После того как
   цех выполнил заказ, изделия либо уходят клиенту напрямую с цеха, либо
   перемещаются на свой склад. В дашборде при фильтре `workshop`:
   - Матрица «Готовые по размерам» скрыта
   - Из сводки «Дефицит» убрана строка готовых
   - В KPI скрыта карточка «Готовых SKU»

3. **На своём складе живут:** заготовки всех типов, готовые с принтом, готовые
   с вышивкой (вернувшиеся из цеха), принты.

4. **На складе цеха живут:** заготовки, переданные в работу. Готовые могут
   мелькнуть транзитом (после production) до отправки/возврата.

4a. **Заготовки из цеха вышивки на свой склад НЕ возвращаются для печати
    принтов.** Принт наносится только из заготовок, которые лежат у меня на
    своём складе. Поэтому в индикаторах наличия для заказов Ozon с
    `decoration_type.made_at='own'` (принты) пустые из складов
    `type='workshop'` исключаются из подсчёта `blank`/`blankByWh`, а в
    бейджах используется формулировка «… на моём складе». Реализация —
    флаг `excludeWorkshop` в хелперах `peek`/`take` внутри мемоизированного
    расчёта `availabilityByItem` в `src/app/orders/page.tsx` (см. правило 9a).

#### Производство

5. **Минимум остатков = 2 шт** на каждую пару `(товар × размер)`. Это «целевой
   запас», ниже которого срабатывает индикатор дефицита. Хранится константой
   `MIN_STOCK` в `inventory-dashboard.tsx`. Не правило БД — только UX-индикатор.

6. **При производстве с `decoration_type=print` принт автоматически списывается
   1:1.** Логика в `api.produce`: подгружает finished SKU, проверяет наличие
   принта, при недостатке — выбрасывает ошибку ДО списания заготовок. UI
   `ProduceDialog` показывает остаток принта и блокирует кнопку.

7. **При production создаётся одна транзакция типа `production`** с
   `product_id = finished`, `source_product_id = blank`, `source_design_id = print`
   (если применимо). Это нужно для журнала и аудита.

#### Заказы Ozon

8. **`merch_products.sku` = `offer_id` в Ozon.** По этому полю заказы матчатся
   к каталогу. Если в Ozon переименовали offer_id, добавляем старое значение в
   `merch_products.legacy_skus[]` — sync будет матчить и старое, и новое.

9. **Кнопка «Отправил заказ» делает sale per item** через приоритетную выборку
   склада (preferred → own → workshop). Если на одном складе мало — берёт со
   следующего. Записывает в `merch_ozon_order_items.shipped_from_warehouse_id`
   для возможности отката.

9a. **Остаток распределяется между заказами — один и тот же товар не может
    быть «доступен» сразу двум заказам.** Раньше каждая позиция независимо
    сравнивала `остаток ≥ нужно`, поэтому при остатке 1 шт и двух одинаковых
    заказах оба показывали «Готово». Теперь в `orders/page.tsx` есть единый
    мемоизированный проход `availabilityByItem` (`Map<itemId, ItemAvailability>`):

    - Берём все активные заказы (не FBO, не отгруженные, не терминальные) и
      сортируем по срочности: `shipment_date` ↑ → `in_process_at` ↑ → `created_at`.
    - Делаем мутируемые копии пулов остатков: `prodRem` (готовые **и** пустые —
      это разные `product_id`, лежат в одной мапе), `printRem` (принты по
      `design_id`). Идём по заказам по очереди; каждая позиция «резервирует»
      из пулов то, что ей выделено (хелпер `take`, свой склад первым), а
      следующий заказ видит уже уменьшенный остаток (хелпер `peek`).
    - Резервируются **готовые, пустые и принты**. Поэтому при остатке 1 шт
      товар достанется только первому (самому срочному) заказу; остальные
      покажут «нужно производство» / «нет».
    - Поля результата (`finished`/`blank`/`print`) — это количество,
      **выделенное конкретному заказу**, а не глобальный остаток. На этой же
      карте построены `orderReady`, `workshopEligible`, `canProduceAndShip`.

9b. **Индикатор наличия принтов для производства.** Для печатных позиций
    (`isPrint`, т.е. `decoration_type.made_at !== 'workshop'`, с заданным
    `design_id`) рядом с бейджем «есть пустые» показывается `PrintBadge`:
    зелёный «Принты на складе: N» если хватает на нужное количество, иначе
    красный «Принтов не хватает: N / нужно». Это позволяет видеть, можно ли
    реально произвести изделие, когда готового нет. Принты тоже распределяются
    между заказами (правило 9a), поэтому один принт = один заказ.

9c. **Кнопка «Произвёл и отправил» — производство у себя в один клик.**
    Появляется, когда готового изделия нет, но на своём складе хватает
    **пустых + принтов** под весь заказ. Условие — `canProduceAndShip`: заказ
    не привязан к цеху, есть `own`-склад, и каждая позиция либо уже `ready`,
    либо печатная с `canOwnProduce` (готовые + `min(пустые, принты)` ≥ нужно),
    причём хотя бы одна позиция требует производства. По клику
    `api.fulfillOzonViaProduction`: для каждой позиции производит нехватку
    относительно остатка готового на **всех** складах (`api.produce` списывает
    заготовку и принт 1:1 на `own`-складе), затем `shipOzonOrder` отгружает.
    Нехватку считаем по сумме готового по всем складам, чтобы не печатать
    лишнее, если готовое уже где-то лежит.

    Приоритет кнопок в карточке: «Отправил заказ» (всё готово) → «Произвёл и
    отправил» (можно изготовить у себя) → «Отправить в цех» (вышивка,
    правило 13). Если заказ уже привязан к цеху — только «Произвели и
    отправили» (правило 14).

10. **Заказы со статусами `delivering`/`delivered`/`driver_pickup`/`sent_by_seller`/
    `arbitration`/`client_arbitration`/`not_accepted`/`cancelled` уже на стороне
    Ozon** — не показываем индикатор наличия и кнопку «Отправил». Они находятся
    в табе «Отправленные» или «Все».

10a. **FBO-заказы скрыты на странице `/orders`.** Их отгружает сам Ozon со
    своего склада, никаких действий от нас не требуется. Фильтр живёт в
    `orders/page.tsx` (`if (o.source === "fbo") return false`). В аналитике
    (воронка `ordersSummary`, `bucketizeOrdersRevenue`) и в COGS-проводках
    они по-прежнему учитываются — поэтому сами записи из БД не выкидываем.

10b. **Внешняя ссылка на отправление Ozon.** Кнопка-стрелка в карточке
    заказа ведёт на `https://seller.ozon.ru/app/postings/{fbs|fbo}?postingDetails={posting_number}`.
    Сегмент `fbs`/`fbo` выбирается по `order.source`. Старый формат
    `/app/orders/fbs/{number}` не работает — не возвращать.

#### Цех вышивки

11. **Заказ в цех создаётся сразу в статусе `sent`.** Статусы `pending`
    («черновик») и `in_progress` («в работе») были удалены — отправка в цех ≡
    «цех взял в работу», дублировать не нужно. Поток: `sent → ready → received`
    (плюс терминальный `cancelled`, доступен только из `sent`).
    `api.createWorkshopOrder` сразу выставляет `sent_at` и перемещает заготовки
    со своего склада в цех, если их там не хватает.

12. **Заказ в цех `received` → автопроизводство** в цехе. Готовое остаётся в
    цехе (т.к. цех сам отправляет клиенту). Перемещения на свой склад больше
    нет (см. правило 2).

13. **Заказ Ozon на вышивку без готового остатка → «Отправить в цех».** Если у
    заказа Ozon все позиции с `decoration_type.made_at='workshop'`, готовых нет
    и заготовок хватает, в карточке доступна кнопка «Отправить в цех» —
    `api.createWorkshopOrderFromOzon` создаёт связанный заказ в цех (мапит
    finished → blank через `findBlankFor`) и проставляет
    `merch_ozon_orders.workshop_order_id`.

14. **«Произвели и отправили» закрывает оба заказа одним кликом.** Пока
    `workshop_order_id` заполнен, в карточке Ozon доступна только эта кнопка
    (не голая «Отправил заказ»). `api.fulfillOzonViaWorkshop` сначала ведёт
    заказ в цех в `received` (производство → списание заготовок + готовое в
    цехе), затем вызывает `shipOzonOrder` (отгрузка готового из цеха через
    штатный приоритет складов).

#### Аналитика и финансы

15a. **Чистая прибыль = `cashFromOzon − COGS − налог − прочие_расходы`.**
    `cashFromOzon` = сумма `amount` всех финопов за период (уже с учётом
    удержанных комиссий, штрафов, возвратов). COGS считаем по проданным
    позициям. Налог УСН 6% считаем от `max(0, revenue − returns)`, то есть
    от выкупленной выручки до удержаний Ozon; это соответствует учёту УСН
    «Доходы» для маркетплейсов, где комиссия/услуги Ozon не уменьшают
    налоговую базу (см. письмо ФНС России от 08.05.2024 № СД-4-3/5416@:
    https://www.nalog.gov.ru/rn77/taxation/taxes/usn/14923199/). Прочие
    расходы = `merch_expenses` за период. Формула живёт в
    `computePeriodMetrics` (`lib/analytics.ts`) — менять только там.

15a-1. **Историческая себестоимость в аналитике.** Для готовых SKU по
    умолчанию берём `product.cost_price`, но с `2026-05-15` печатные футболки
    (`category=tshirt`, `decoration_type=print`) в расчётах COGS считаются по
    900 ₽ за штуку независимо от текущего `cost_price`. Это временное
    бизнес-правило живёт рядом с `computePeriodMetrics` в `lib/analytics.ts`;
    при добавлении новых исторических цен не размазывать их по компонентам.

15a-2. **График «Динамика» показывает факт по финансовым операциям, а не
    прогноз.** Недоставленные/невыкупленные заказы не дооцениваются в
    `PeriodChart`: прибыль появляется только когда Ozon прислал финоперацию.
    Прогнозы с ожидаемым процентом выкупа считать отдельной аналитикой,
    чтобы не смешивать факт и forecast.

15b. **Все расходы для разбивки (донат, KPI «Расходы») = `revenue −
    netProfit`, чтобы «Выручка − Расходы = Прибыль» сходилось.**
    Сумма всех записей `expenseBreakdown` (включая `Возвраты покупателей`,
    `Себестоимость`, `Комиссия Ozon`, `Логистика и услуги Ozon`,
    `Прочие удержания Ozon` (residual), `Налог УСН 6%` и пользовательские
    категории) обязана быть равна `metrics.totalExpenses`. Если добавляете
    новую линию расхода — добавляйте её и в `totalExpenses`, и в
    `expenseBreakdown` синхронно, иначе KPI разойдутся.

15c. **«Прочие удержания Ozon» — это residual, не сумма штрафов руками.**
    Считается как `revenue − returns − cashFromOzon − ozonCommission −
    ozonServices`. Туда попадают `OperationReturnGoodsFBSofRMS`,
    `DefectFineShipmentDelay`, `MarketplaceRedistributionOfAcquiringOperation`,
    `OperationSubscriptionPremium`, упаковка и т.п. Не пытайтесь перечислить
    их явно — Ozon регулярно добавляет новые `operation_type`.

15d. **COGS на финопе ищется в два шага: posting → SKU-fallback.**
    `lookupCost(op, costIndex)`:
    1. Если `op.posting_number` есть в `merch_ozon_orders` — берём готовый
       `byPosting` с точным quantity и применяем историческую себестоимость
       на дату `operation_date`. После интеграции FBO это основной путь и для
       FBS, и для FBO.
    2. Иначе (очень старые/неподтянутые заказы) — fallback через `costIndex.bySku`
       по `op.items[].sku`. Quantity для одно-товарного финопа выводим как
       `round(accruals_for_sale / sale_price)` (только если отношение
       близко к целому — допуск 15%). Для много-товарных финопов default
       qty=1 на каждую запись items. Это аварийная аппроксимация, см. раздел 11.

15e. **Стоимость остатков (карточка «Стоимость остатков» на дашборде).**
    Считается как `Σ(inventory.quantity × product.cost_price)` с разбивкой
    по складу × (пустые / готовые). Компонент —
    `src/components/analytics/stock-value-card.tsx`, данные тянутся через
    `api.listInventory()` (продукт уже джойнится вместе с `cost_price`).
    Базовые `cost_price` для заготовок: футболка обычная 650 ₽, футболка
    варёнка 780 ₽, худи/свитшот 1200 ₽ — значения залиты в БД одноразовым
    UPDATE по `category.slug` + `fabric.slug`. Для новых заготовок цену
    выставлять руками через `/products` или редактор. Если у продукта
    `cost_price IS NULL` — он попадёт в карточку с 0 ₽, без ошибки.

#### Целостность данных

16. **FK при удалении товара (`merch_products`):**
    - `merch_transactions.product_id` / `source_product_id` → `ON DELETE SET NULL` (сохраняем историю)
    - `merch_inventory.product_id` → `ON DELETE CASCADE` (без товара нет складской карточки)
    - `merch_workshop_order_items.blank_product_id` / `result_product_id` → `ON DELETE SET NULL`
    - `merch_ozon_order_items.product_id` → `ON DELETE SET NULL`

17. **FK при удалении дизайна (`merch_designs`):**
    - `merch_products.design_id` → `ON DELETE CASCADE` (готовый SKU без дизайна не имеет смысла — каскадно убьёт `merch_inventory`, история транзакций сохранится через `SET NULL` на `product_id`)
    - `merch_workshop_order_items.design_id` → `ON DELETE SET NULL` (заказ в цех остаётся как историческая запись)
    - `merch_print_inventory.design_id` → `ON DELETE CASCADE` (без дизайна нет принт-стока)
    - `merch_transactions.design_id` / `source_design_id` → `ON DELETE SET NULL`

18. **Транзакции не редактируются и не удаляются вручную.** Хочешь откатить —
    создавай корректирующую транзакцию (`adjustment`).

19. **В `merch_transactions` `product_id` и `design_id` оба nullable, без check
    `OR NOT NULL`.** На INSERT прикладной код гарантирует, что одно из двух
    заполнено. CHECK-констрейнт был раньше, но конфликтовал с `ON DELETE SET NULL`
    при удалении товара (см. миграцию `202605241500_drop_tx_subject_check.sql`).
    Не возвращайте его обратно — выберите триггер `BEFORE INSERT` или валидацию
    в коде, если хотите формальную гарантию.

20. **`merch_ozon_finance_operations` — append-only, дедуп по `operation_id`.**
    Перед upsert обязательно дедуплицировать партию (Ozon на границах
    месячных окон возвращает одну и ту же операцию дважды, иначе словите
    `21000 ON CONFLICT DO UPDATE command cannot affect row a second time`).
    См. `/api/ozon/sync-finance/route.ts`.

---

## 5. Слой API (`src/lib/api.ts`)

**Единое окно к Supabase для клиентского кода.** Никаких `createClient()` в
страницах/компонентах напрямую — всё через `api.*`.

Договорённости:

- Все методы возвращают доменные типы из `lib/types.ts`, не «сырые» строки PostgREST
- Ошибки оборачиваем `toError(...)` → у любой возвращённой ошибки есть `.message`
- До server cutover клиентские mutations идут через `/api/admin/rpc`; BFF
  добавляет request/idempotency headers и выбирает Supabase либо server
  write-source по runtime flag.
- Server mutations реализованы в `src/lib/db/mutations` и выполняют каждую
  составную бизнес-операцию в одной SQL-транзакции.
- Остатки создаются idempotent UPSERT и блокируются через детерминированный
  `SELECT ... FOR UPDATE`; произвольные business errors не ретраятся.
- Bulk-операции могут выполняться параллельно только для независимых ресурсов.
  Конкурирующие операции над одной строкой остатка сериализует PostgreSQL.

Серверные роуты (`src/app/api/ozon/*`) — единственное место, где живут ключи
Ozon (`OZON_API_KEY`, `OZON_CLIEN_ID`; локально из `.env.local`, в production
из `/etc/getomerch/admin-production.env`). С клиента к Ozon не ходим напрямую.

При `GETOMERCH_DB_WRITE_SOURCE=server` долгие Ozon route создают запись в
`getomerch_jobs.jobs`, возвращают `202`, а `src/lib/api.ts` опрашивает
`/api/admin/jobs/<id>`. Worker забирает job через `FOR UPDATE SKIP LOCKED` и
обновляет progress/heartbeat. При production default `supabase` сохраняется
прежний синхронный route до отдельного cutover.

---

## 6. UI и дизайн

### 6.1. Принципы

- **Плотная компоновка**, без воздуха ради воздуха. Это рабочий инструмент, не
  лендинг
- **Цвет — функционально**: красный = критично (0, ошибка), янтарный = внимание
  (1, ниже минимума, ждёт упаковки), зелёный = норма (≥2, успешно), синий = в
  процессе (доставляется, в работе), серый/zinc = нейтральное / историческое
- **Tabular numbers** (`tabular-nums`) на всех числах в таблицах и KPI
- **Truncate** длинных строк, не переносить
- **Эмодзи и Капс не использовать** в текстах кнопок и заголовках

### 6.2. Компоненты shadcn/ui

Базовые блоки лежат в `src/components/ui/`. Не импортируем из npm — копируем и
дорабатываем напрямую. Если нужного компонента нет — добавляем через CLI
`npx shadcn add <name>` (он положит файл в ту же папку).

Текущий набор: `badge`, `button`, `card`, `chart`, `dialog`, `empty-state`,
`input`, `label`, `page-header`, `pill`, `select`, `separator`, `sonner`,
`table`, `tabs`, `textarea`.

`chart.tsx` — тонкая собственная обёртка над Recharts (`ChartContainer`,
`ChartTooltipCard`). НЕ из шадcn-каталога — добавляли вручную, чтобы
ось/легенда/тултип брали цвета из наших CSS-переменных и хорошо
выглядели в тёмной теме. Не перезаписывайте через `npx shadcn add chart`.

Особо отметить:
- **`Pill`** — компактная toggle-кнопка для inline-фильтров и сегмент-контролов.
  Два варианта формы (`shape="rounded"` по умолчанию, `shape="square"` для
  табоподобных переключателей) и состояние `active`. Используем вместо голых
  `<button>` с классами. Не путать с `Button` — `Pill` плотнее, без тени, и
  имеет встроенное `active`-состояние.

### 6.3. Цветовая палитра состояний — семантические токены

Используем **семантические Tailwind-классы**, а не «эмеральд-100». Цвета
живут в `globals.css` как CSS-переменные и доступны в Tailwind через
`tailwind.config.ts → theme.extend.colors.state`.

| Семантика | Класс фона | Класс текста | Когда |
|---|---|---|---|
| Норма / готово | `bg-state-success` | `text-state-success-fg` | ≥ MIN_STOCK, готово к отправке, успешная операция |
| Внимание / ниже минимума | `bg-state-warning` | `text-state-warning-fg` | 1 шт, ждёт упаковки, требует внимания |
| Критично / 0 / ошибка | `bg-state-danger` | `text-state-danger-fg` | 0 в наличии, FK violation, отмена |
| В процессе / транзит | `bg-state-info` | `text-state-info-fg` | Доставляется, в работе, на упаковке |
| Нейтральное | `bg-state-neutral` | `text-state-neutral-fg` | Без статуса, исторические записи |
| Свой склад (индикатор-точка) | `bg-emerald-500` | — | Точка-индикатор в селекторах |
| Цех (индикатор-точка) | `bg-amber-500` | — | Точка-индикатор в селекторах |

**Чтобы поменять оттенок состояния глобально** — правьте CSS-переменные
`--state-{success|warning|danger|info|neutral}-{bg|fg}` в `globals.css`. Каждая
тема (light/dark) имеет свой набор. Не вшивайте `bg-emerald-100`/`bg-amber-100`
напрямую — изоляцию ломает.

Для исключений (статусные бейджи Ozon/Workshop с фиксированными оттенками) —
см. `OZON_STATUS_COLORS` / `WORKSHOP_STATUS_COLORS` в `lib/types.ts`.

### 6.4. Иконки

Из `lucide-react`. Договорённые соответствия:

- Изделия / готовая продукция → `Package`
- Заготовки → `Shirt`
- Принты → `Image as ImageIcon`
- Склад → `Warehouse as WarehouseIcon`
- Цех / производство → `Hammer`
- Дашборд → `LayoutGrid` / `LayoutDashboard`
- Заказы Ozon → `ShoppingBag`
- Поиск → `Search`
- Дефицит / предупреждение → `AlertTriangle`
- Готово / ОК → `CheckCircle2`
- Доставка → `Truck`
- Корректировка → `Settings`
- Удаление / корзина → `Trash2`
- Размер шестерёнки/корзинки в inline-кнопках → `h-3.5 w-3.5`

### 6.5. Типографика и spacing

- Заголовки страниц — через `PageHeader` (title + description + action)
- Заголовки секций (внутри Card) — `<CardTitle className="text-base">` (16px)
- Подписи мелкие — `text-xs text-muted-foreground` (12px)
- Спан сетки на десктопе — 1280px виден целиком, sidebar 256px
- Промежутки между крупными блоками — `space-y-5` или `space-y-6`
- Промежутки внутри карточек — `gap-3`

### 6.6. Формы и диалоги

- Все формы — в `<Dialog>` (не отдельные страницы)
- При закрытии диалога — сброс формы (`reset()`)
- Кнопка submit:
  - `disabled` пока невалидно
  - Текст «...» во время `busy`
  - После успеха — `toast.success(...)`, `onDone?()` (reload родителя), `onOpenChange(false)`
- Bulk-формы (приёмка) — внизу всегда счётчик «Итого: N шт по M SKU» + кнопка
- Дефолты в формах — заранее выбираем самый частый случай (Мой склад /
  Футболка / Обычная)

### 6.7. Таблицы и матрицы

- В матрицах остатков sticky-колонка слева — название группы (`sticky left-0 bg-background`)
- В шапке таблицы — `text-xs text-muted-foreground font-medium`
- Сортировка размеров — всегда по `sort_order` из `merch_sizes`
- На каждый цвет ткани — кружок-индикатор `h-3 w-3 rounded-full border` с `backgroundColor: hex`
- При наличии разбивки по складам — мелкая подпись `м5·ц2` под ячейкой (первая
  буква имени склада + qty)
- В матрицах остатков на `/inventory` есть тоггл **«Скрыть пустые»**
  (`inventory-dashboard.tsx`, по умолчанию `true`). Прячет строки, где
  `total = 0` по всем размерам — чтобы зачищенные модели не засоряли
  список. Состояние локальное (`useState`), не персистится

---

## 7. Соглашения по коду

### 7.1. TypeScript

- `strict: true` в `tsconfig.json` — не отключаем
- Типы доменных сущностей — в `lib/types.ts`, переиспользуем
- Не использовать `any`. Если PostgREST вернул `unknown` — каст через `as unknown as Type[]` после select
- Для коллекций по ключу — `Map<string, T>`, не `Record<string, T>` (быстрее и явнее)

### 7.2. React

- Хуки в правильном порядке: state → memo → effect → handlers
- `useMemo` для тяжёлых вычислений по данным (агрегации, фильтры). Для лёгких — не злоупотреблять
- Никаких `useEffect` для производных значений — это `useMemo`
- Никаких `setState` внутри render

### 7.3. Стили

- Один `cn(...)` хелпер из `lib/utils.ts` — объединение Tailwind-классов. Любой conditional className — через него
- Не использовать `style={...}` кроме случаев с динамическим цветом (`backgroundColor: hex_code`)

### 7.4. Бэкенд / миграции БД

- После cutover новое DDL оформляется следующей forward-only миграцией в
  `db/migrations/`; `supabase/migrations/` остаётся историческим архивом.
- `db/migrations/0001_getomerch_baseline.sql` неизменяем; исправления и новые
  объекты добавляются только миграцией с большим номером.
- Server PostgreSQL migrations применяются отдельной deploy-командой
  `npm run db:migrate:up` под `getomerch_migrator`, не при старте Next.js.
- Перед применением обязательны `npm run db:rehearsal` и
  `npm run db:migrate:verify`.
- В текущем Supabase production RLS включён с открытыми policy; в целевой
  локальной БД эти policy и Supabase-роли отсутствуют, доступ ограничивается
  server-side ролями PostgreSQL.
- Все таблицы — префикс `merch_`
- Колонки snake_case
- Все FK прописывать явно с правильным `ON DELETE` (см. правило 15)
- Любой `select` с join: при двух FK на одну таблицу — обязательно `relation!fk_column(...)`,
  иначе PostgREST вернёт `PGRST201`. Пример в `api.listTransactions` (две связи на `merch_products`)

#### Переходный read-path

Все admin read-route и read-only RPC используют `src/lib/db`. Один runtime flag
выбирает Supabase adapter либо локальный PostgreSQL adapter. Production после
cutover использует локальную БД; rehearsal process использует отдельную БД и
может сравнивать полный результат с frozen Supabase snapshot.

```env
GETOMERCH_DB_READ_SOURCE=supabase|server
GETOMERCH_DB_WRITE_SOURCE=supabase|server
GETOMERCH_DB_SHADOW_COMPARE=false|true
GETOMERCH_DB_SHADOW_COMPARE_STRICT=false|true
```

Server write-source разрешён только при наличии локальной
`GETOMERCH_DATABASE_URL` и использует транзакционный mutation layer. Production
defaults после cutover — `server/server/false`. Read
repositories обязаны использовать явные колонки, параметризованные фильтры,
детерминированный порядок, batch hydration и pagination.

`/api/admin/inventory` возвращает bounded page и `offset/nextOffset/hasMore`.
Клиентские `/orders` и `/inventory` используют общий bounded page loop, поэтому
availability и список изделий получают один полный снимок положительных
остатков. Matrix aggregation суммирует остатки эквивалентных SKU, а
`design_version`, `hoodie_fit` и `hoodie_fabric` входят в ключ реального
finished-варианта.

Старый direct доступ к Supabase DB временно остаётся только для ограниченных
legacy/diagnostic веток периода стабилизации и использует transaction pooler:

```env
GETOMERCH_SUPABASE_DATABASE_URL=postgresql://postgres.<project-ref>:<password>@<region>.pooler.supabase.com:6543/postgres
GETOMERCH_POSTGRES_SSL=true
GETOMERCH_POSTGRES_POOL_MAX=1
GETOMERCH_POSTGRES_POOL_MAX_USES=1
```

Важные мелочи:

- использовать transaction pooler `:6543`; прямой Supabase host `:5432` на
  текущем VPS может падать из-за IPv6 `ENETUNREACH`, а session pooler `:5432`
  упирался в `max clients reached in session mode`;
- `POOL_MAX=1` и `POOL_MAX_USES=1` сохранять до отдельного нагрузочного теста;
  pooler был нестабилен при переиспользовании соединений;
- не делать `SELECT *` по таблицам с тяжёлыми `jsonb`, особенно
  `merch_ozon_orders.raw`; выбирать только нужные колонки;
- не использовать `to_jsonb(table)` и широкие join-гидрации;
- Ozon orders/finance/import list не должны читать `raw jsonb`;
- matrix строится из явного списка product dimensions и одной SQL-агрегации;
- добавлять индекс только после `EXPLAIN (ANALYZE, BUFFERS)`.

### 7.5. Git

- Один логически цельный коммит на одну задачу
- Сообщение коммита — императив на английском, тело — что и зачем
- Не пушим `--force` в main
- Pre-commit hooks не пропускаем (`--no-verify` запрещён)

---

## 8. Тёмная тема

Включается через системные настройки (Tailwind `darkMode: 'media'` в дефолте Next.js).
Все цвета должны иметь `dark:` вариант. Когда добавляете новый бейдж — сразу
указывайте обе версии (см. таблицу 6.3).

---

## 9. Локализация

UI — на русском (целевой пользователь говорит по-русски). Тосты, ошибки,
лейблы — везде русский. В коде:

- Имена переменных/функций — английский (`shipOzonOrder`, `blankShortage`)
- Комментарии к коду — английский или русский по контексту, краткие
- Строки UI — русский, в JSX напрямую (без i18n-библиотек — не нужно пока)

Числа: `tabular-nums` для выравнивания, форматирование через `Intl.NumberFormat('ru-RU')`
(см. `formatMoney` в `utils.ts`).

Даты: `Intl.DateTimeFormat('ru-RU')` через `formatDate`/`formatDateShort`.

---

## 10. Внешние интеграции

### 10.1. Ozon Seller API

- База: `https://api-seller.ozon.ru`
- Auth: заголовки `Client-Id` (из `OZON_CLIEN_ID`, именно с опечаткой — так в .env)
  и `Api-Key` (из `OZON_API_KEY`)
- Используемые методы:
  - `POST /v5/product/info/prices` — синхронизация цен (`/api/ozon/sync-prices`)
  - `POST /v3/posting/fbs/list` — синхронизация FBS-заказов (`/api/ozon/sync-orders`)
  - `POST /v3/posting/fbs/get` — точечное обновление ранее активных FBS,
    которые пропали из `unfulfilled/list` (например, были отменены)
  - `POST /v2/posting/fbo/list` — синхронизация FBO-заказов для аналитики
    заказов и точного COGS по FBO-финоперациям (`/api/ozon/sync-orders`,
    только при `scope=all`)
  - `POST /v3/finance/transaction/list` — синхронизация всех финансовых
    операций для аналитики (`/api/ozon/sync-finance`). Ограничение Ozon:
    максимум 1 месяц на запрос → ходим 28-дневными окнами, идемпотентный
    upsert по `operation_id` после дедупликации внутри партии
- Матчинг с каталогом:
  - Заказы FBS/FBO: `offer_id ↔ merch_products.sku` (или одному из `legacy_skus`)
  - Финопы: сначала `posting_number ↔ merch_ozon_orders.posting_number`,
    иначе по `items[].sku ↔ merch_ozon_order_items.ozon_sku` (fallback для
    старых/неподтянутых отправлений)
- При синхронизации в `merch_ozon_orders.source` записывается `'fbs'` или
  `'fbo'` (взято из `posting.source`, который sync-route стампит на каждом
  объекте до апсерта). Используется в UI для скрытия FBO со страницы заказов
  и для построения корректной внешней ссылки на seller.ozon.ru
- Глубокая ссылка на отправление в кабинете Ozon:
  `https://seller.ozon.ru/app/postings/{fbs|fbo}?postingDetails={posting_number}`.
  Сегмент выбирается по `merch_ozon_orders.source`
- Запросы только с сервера. С клиента — через `fetch('/api/ozon/...')`
- Общий `src/lib/ozon/client.ts` задаёт timeout/AbortSignal и bounded retry
  только для `408`, `429`, `5xx` и временных network errors; validation и
  бизнес-ошибки не повторяются
- Server write-path использует durable jobs для orders/finance/prices/import,
  active dedupe, idempotency, progress, cancellation и stale heartbeat recovery
- Внутренний Bearer token принимается только пятью точными Ozon route и
  повторно проверяется самим Route Handler; остальные API требуют admin cookie
- Кнопка «Обновить данные Ozon» в дашборде запускает sync-orders (180 дней,
  `scope=all`) + sync-finance параллельно

### 10.2. Что НЕ интегрировано (на будущее)

- Push/email-уведомления о новых заказах
- Двусторонняя синхронизация остатков (мы только тянем, не отдаём)
- WB, Yandex.Market

---

## 11. Серверный контур и эксплуатация

GetoMerchV3 теперь развёрнут на production-сервере KOMUI как отдельная
админка `https://admin.komui.ru`. Это не часть публичного магазина `komui.ru`
и не папка внутри `/opt/komui`.

### 11.1. Границы с проектом KOMUI

На сервере живут два независимых проекта:

```text
/opt/komui      # публичный магазин, backend, static frontend, PostgreSQL KOMUI
/opt/getomerch  # эта админка Next.js
```

Нельзя:

- копировать `GetoMerchV3` внутрь `/opt/komui`;
- объединять git-репозитории;
- писать напрямую в PostgreSQL магазина из этой админки;
- менять deploy/status/rollback магазина ради задач админки, если явно не
  меняется Telegram bot или общий nginx/systemd слой.

Связь с магазином идёт только через server-side KOMUI API:

```text
Next.js admin route/BFF
  -> https://komui.ru/api/admin/...
  -> PostgreSQL магазина
```

Admin token хранится только в server-side env. В `NEXT_PUBLIC_*` можно класть
только публичные ключи Supabase.

### 11.2. Production-схема

```text
GitHub GetoMerchV3.git
  -> /opt/getomerch/deploy-source
  -> /opt/getomerch/releases/<timestamp>-admin-<commit>
  -> /opt/getomerch/current
  -> systemd: getomerch-admin.service
  -> 127.0.0.1:3100
  -> nginx: admin.komui.ru
```

Сервис:

```text
unit: /etc/systemd/system/getomerch-admin.service
user: getomerch
working dir: /opt/getomerch/current
env: /etc/getomerch/admin-production.env
command: npm start -- --hostname 127.0.0.1 --port 3100
```

`/etc/getomerch/admin-production.env` — единственный подключенный runtime env
production-админки. В нём лежат auth-секреты, ключи Supabase/Ozon/KOMUI и
direct Postgres URL к Supabase для read-path. Целевой локальный
`/etc/getomerch/database.env` намеренно не подключен к systemd unit до
production cutover. После изменения активного env нужен:

```bash
sudo systemctl restart getomerch-admin.service
sudo /usr/local/sbin/getomerch-deploy-status
```

Отдельный `/etc/getomerch/backup.env` используется только для `pg_dump` в
backup-скрипте. Наличие DB URL в backup env не включает direct Postgres в
приложении.

Nginx vhost `admin.komui.ru` проксирует на `127.0.0.1:3100`, передаёт
`Host`, `X-Forwarded-Proto`, `X-Forwarded-Host`, `X-Forwarded-Port` и
обслуживает Let's Encrypt certificate. Старой nginx Basic Auth на админке нет:
доступ закрывает само Next.js-приложение.

### 11.3. Авторизация

Production-админка однопользовательская. Вход:

```text
/login
POST /api/auth/login
POST /api/auth/logout
```

Пароль хранится только хешем:

```env
ADMIN_AUTH_PASSWORD_HASH=pbkdf2_sha256$310000$...
ADMIN_AUTH_COOKIE_SECRET=...
ADMIN_AUTH_COOKIE_NAME=getomerch_admin_session
ADMIN_AUTH_SESSION_DAYS=60
```

Хеш генерируется:

```bash
printf '%s' 'your-password' | node scripts/generate-admin-password-hash.mjs
```

После входа ставится HttpOnly Secure SameSite=Lax cookie. Значение cookie —
подписанный HMAC-SHA256 token с `sub`, `iat`, `exp`; это не boolean-флаг.
`src/middleware.ts` защищает все страницы и `/api/*`, кроме `/login`,
`/api/auth/*`, `_next` и статических файлов. Route Handlers всё равно должны
хранить секреты только на сервере.

### 11.4. Deploy, status, rollback

Команды на сервере:

```bash
sudo /usr/local/sbin/getomerch-deploy-from-git prod main
sudo /usr/local/sbin/getomerch-deploy-status
sudo /usr/local/sbin/getomerch-rollback prod
```

Deploy flow:

1. Берёт `origin/<branch>` в `/opt/getomerch/deploy-source`.
2. Собирает Next.js в одноразовой `/opt/getomerch/build-source`.
3. Создаёт immutable release в `/opt/getomerch/releases`.
4. Ставит production dependencies прямо внутрь release.
5. Переключает `/opt/getomerch/current`.
6. Рестартит `getomerch-admin.service`.
7. Проверяет `/login`, protected API без cookie и публичный редирект
   `admin.komui.ru -> /login`.
8. Пишет событие в registry.

Если smoke падает после активации, deploy script возвращает предыдущий active
release. Rollback script выбирает предыдущий успешный admin release из
`/var/lib/getomerch/deploy-registry.jsonl` или принимает конкретное имя release.

Файлы состояния:

```text
/var/lib/getomerch/deploy-registry.jsonl
/var/lib/getomerch/deploy-current.json
/var/log/getomerch/deploy/
/var/cache/getomerch/npm
```

После успешного deploy runtime-артефакты в `/opt/getomerch/deploy-source`
очищаются. Работать должен active release, а не git checkout.

### 11.5. Telegram deploy bot

Текущий Telegram deploy bot магазина KOMUI расширен admin-кнопками:

```text
Deploy admin prod
Status admin prod
Rollback admin prod
```

Они вызывают `getomerch-deploy-from-git`, `getomerch-deploy-status` и
`getomerch-rollback`. Unit `komui-deploy-bot.service` имеет `ReadWritePaths`
на `/opt/getomerch`, `/var/lib/getomerch`, `/var/log/getomerch`,
`/var/cache/getomerch`.

Важно: кнопки магазина `Deploy stage` / `Deploy prod` по-прежнему относятся к
KOMUI, а кнопки `Deploy admin prod` / `Rollback admin prod` — только к этой
админке.

Ответ `Status admin prod` форматируется ботом как операционная сводка, а не как
сырой stdout. Он проверяет web, worker, PostgreSQL, nginx, database backup timer,
failed systemd units, HTTP auth smoke, свежесть off-site backup, Git/release и
свободное место. Для диагностики полный вывод сохраняется в
`getomerch-deploy-status`.

### 11.6. Данные и backup

С `2026-07-17 13:08 UTC` основной рабочей БД админки является локальная
`getomerch_production`. Supabase зафиксирован как read-only archive/diagnostic
source минимум на 30 дней и не участвует в production runtime:

- `getomerch_production` содержит live production data, `getomerch_audit` и
  private `getomerch_jobs` schemas; web и worker работают в режиме
  `GETOMERCH_DB_READ_SOURCE=server` / `GETOMERCH_DB_WRITE_SOURCE=server`;
- `getomerch_rehearsal` остаётся изолированной проверочной БД для migration и
  restore drill; это не live replica и не источник production reads/writes;
- объекты принадлежат NOLOGIN-роли `getomerch_owner`;
- `getomerch_migrator` выполняет DDL через явный `SET ROLE`;
- `getomerch_app` имеет только runtime CRUD, а `getomerch_backup` — чтение;
- `/etc/postgresql/17/main/pg_hba_getomerch.conf` разрешает новым ролям только
  локальные подключения к GetoMerch БД и блокирует GetoMerch <-> KOMUI;
- app/migrator/backup env хранятся раздельно в `/etc/getomerch`, принадлежат
  root и имеют права `0600`;
- `/usr/local/sbin/getomerch-db-healthcheck` проверяет `SELECT 1`, точное имя
  БД и migration version без вывода URL;
- `/usr/local/sbin/getomerch-data-rehearsal` строит candidate DB, импортирует
  allowlist snapshot, сверяет fingerprints/integrity и сохраняет предыдущую
  rehearsal для rollback до финального healthcheck;
- bootstrap использует `pg_reload_conf()`, не перезапускает PostgreSQL и
  проверяет неизменность ролей/БД `komui_*`.

Текущий runtime и backup после cutover устроены так:

- web и worker используют `/etc/getomerch/database.env` и локальную
  `getomerch_production`;
- `getomerch-database-backup.timer` запускает hourly encrypted local backup;
- старый `getomerch-backup.timer` остановлен, а финальный Supabase archive
  хранится неизменённым минимум 30 дней;
- hourly local backup хранится в `/var/backups/getomerch/database` и
  выгружается под prefix `getomerch/database/hourly`;
- local archive содержит `pg_dump -Fc`, counts, migration version, checksums и
  encrypted runtime config; `/usr/local/sbin/getomerch-database-restore-drill`
  проверяет его во временной БД;
- финальный frozen Supabase archive хранится отдельно под prefix
  `getomerch/admin-production`; он содержит exact export 20 working tables,
  reviewed DDL/policies/counts и runtime/deploy config;
- Supabase URL и server key не попадают в process arguments или manifest;
- forensic Supabase archive дополнительно сохраняет 31 историческую
  `public`-таблицу, catalog, OpenAPI и Auth users, но не заменяет managed backup
  внутренних схем Supabase.

Этапы 3 и 4 полного переноса создали и проверили rehearsal-контур. Финальный
frozen REST export с exact counts и SHA-256 был использован этапом 10 для
production cutover. Подробности ранней репетиции:
`docs/ADMIN_MIGRATION_STAGE_4_REPORT_2026-07-16.md`.

Этапы 5–9 завершены. Новый `src/lib/db` задает нейтральную границу:

- repository владеет SQL/PostgREST и mapping;
- service владеет операцией и shadow comparison;
- Route Handler сохраняет auth, validation и HTTP contract;
- локальный pool лениво читает только `GETOMERCH_DATABASE_URL`;
- server adapter использует явные колонки, параметризованные filters и SQL
  pagination;
- server mutation layer владеет SQL-транзакциями, row locks, idempotency и
  audit опасных операций.

На эту границу переведены все admin read-route и read-only RPC: каталог,
товары, остатки, матрица, движения, цех, Ozon, расходы, финансы и история
импорта. Текущие admin RPC mutations используют server implementation;
production default — local PostgreSQL. Отдельный runtime-only
`getomerch-admin-rehearsal.service` использует `getomerch_rehearsal`, strict
Supabase shadow и `127.0.0.1:3101`; nginx к нему не подключен, а persistent
write-source оставлен Supabase. До cutover server writes были проверены на disposable БД 12/12
группами concurrency/idempotency/fault tests. Ozon services и durable queue
проверены ещё 10/10 integration groups; после Go production worker активирован,
а первая реальная orders sync прошла через durable queue. Проверки и метрики:
`docs/ADMIN_MIGRATION_STAGE_6_REPORT_2026-07-16.md` и
`docs/ADMIN_MIGRATION_STAGE_7_REPORT_2026-07-17.md` и
`docs/ADMIN_MIGRATION_STAGE_8_REPORT_2026-07-17.md`.

Этап 9 дважды повторил полный pre-production flow на свежем encrypted export.
Отдельные root-only scripts проверяют disposable server writes, native
PostgreSQL backup/restore и возврат приложения на Supabase до открытия записей.
Candidate release `/opt/getomerch/rehearsals/stage9-20260717T104528Z` слушает
только `127.0.0.1:3101`; это историческая pre-cutover контрольная точка.
Результаты: `docs/ADMIN_MIGRATION_STAGE_9_REPORT_2026-07-17.md`.

### 11.7. Управляемый production cutover

Release E добавляет runtime maintenance boundary и явную машину состояний
cutover. `read_only` проверяется middleware, server mutation runner, durable
queue и worker startup. Read API и login остаются доступны; UI получает
актуальное состояние через `/api/admin/health` и показывает постоянную плашку.

```text
Supabase production
  -> final encrypted/off-site archive
  -> verified production candidate
  -> getomerch_production (read_only)
  -> read/API/KOMUI/Ozon connectivity smoke
  -> encrypted local backup + restore drill
  -> explicit Go
  -> web writes, then worker
```

Состояние хранится root-only в `/var/lib/getomerch/cutover/state.json`.
`abort` восстанавливает предыдущий env и пустую целевую БД только до
`writesOpenedAt`. После этой отметки автоматический возврат на Supabase
запрещен: используется forward-fix либо отдельный data replay.

Локальный backup отделен от финального Supabase archive и backup магазина:
`getomerch-database-backup.timer` работает hourly с read-only DB role и
off-site prefix `getomerch/database/hourly`. Worker и этот timer устанавливаются
заранее disabled и включаются только после Go. Сейчас оба активны; старый
Supabase backup timer остановлен. Автоматические Ozon sync timers первые 24 часа
не включаются, ручные sync выполняются через durable queue.

В `/etc/getomerch/admin-production.env` нельзя руками менять секреты без
понимания, какие route handlers и внешние API их используют.

### 11.8. Ozon-нюанс

Для всех футболок на Ozon должны использоваться габариты упаковки
`300 x 230 x 40 мм` и вес `250 г`. Это бизнес-инвариант, который нужно
сохранять при создании новых карточек и копировании размеров.

---

## 12. Долги и известные ограничения

- Production пишет через локальный transaction mutation-path; простой rollback
  на Supabase после первого write запрещён. Нужен forward-fix либо отдельный
  data replay с учётом audit/idempotency ledger.
- Транзакционные primitives для Ozon order snapshot и import run готовы, но
  фактические sync/import routes, pagination, locks и run lifecycle относятся
  к этапу 8.
- У приложения есть единая owner-auth через signed HttpOnly cookie, но текущая
  Supabase RLS остается открытой `using (true)`. До закрытия Supabase runtime
  browser access должен оставаться только через BFF; целевой PostgreSQL
  ограничивается ролями и HBA, а не Supabase policies.
- Нет soft-delete у товаров. Удалённые SKU исчезают навсегда (история сохраняется
  через `SET NULL` в транзакциях)
- Дашборд строит матрицу из всего каталога — если в каталоге много «фантомных»
  SKU (не использующихся), они засоряют матрицу. Решение для будущего:
  флаг `is_active` или фильтр «модели с движениями за N дней»
- В данных есть пять исторических групп одинаковых finished product
  combinations, поэтому общий unique index для finished-combo пока не введён.
  Server `findOrCreateProduct` использует transaction advisory lock и
  `UNIQUE(sku/ozon_sku)`; исторические дубли требуют отдельного data
  remediation после подтверждения владельцем.
- Новый repository layer обслуживает production `/orders`, `/inventory` и
  matrix из локальной БД; старый hybrid route удалён.
- Если каталог вырастет на порядки, matrix лучше вынести в Postgres RPC или
  materialized summary, но текущий объём закрыт без старой полной pg-гидрации
  товаров.
- Текущая direct Postgres-гидрация товаров избегает широких join и `to_jsonb`.
  Если потребуется больше связанных данных, сначала проверить query plan и
  поведение через Supabase pooler, а не возвращать `SELECT *`/широкие JSON
  запросы.
- FBS + FBO заказы уже подтягиваются в `merch_ozon_orders`, поэтому COGS по
  финоперациям обычно считается через точный `posting_number`. COGS-фолбэк по
  Ozon SKU остаётся только как страховка для старых/неподтянутых отправлений:
  он аппроксимирует quantity (см. правило 15d), для много-товарных финопов
  считает 1 шт на строку `items`.
- `merch_expenses` без soft-delete. Удаление — навсегда. Если важна
  отчётность за прошлые периоды — лучше архивировать категорию
  (`archived=true`) вместо удаления записей

---

## 13. Чеклист перед мерджем

- [ ] `npx tsc --noEmit` без ошибок
- [ ] Сценарий проверен в браузере (preview server)
- [ ] Изменение схемы БД оформлено миграцией в `supabase/migrations/`
- [ ] Если добавил поле в БД — обновил тип в `lib/types.ts` и `api.ts`
- [ ] Если добавил состояние/действие — учёл оба warehouse-типа (own/workshop)
- [ ] Если добавил статус в Ozon-таблицу — добавил перевод в `OZON_STATUS_LABELS`
      и цвет в `OZON_STATUS_COLORS`
- [ ] Если добавил действие пользователя — есть `toast.success`/`toast.error` на исход
- [ ] Дефолты формы выставлены под самый частый случай
- [ ] Тёмная тема: каждый цветной бейдж имеет `dark:` версию
- [ ] В журнал транзакций пишется запись на любое движение остатков
- [ ] Если добавил расходную линию в `computePeriodMetrics` —
      синхронно отразил её в `expenseBreakdown` и `totalExpenses`
      (иначе KPI «Расходы» разойдётся с суммой donut)
