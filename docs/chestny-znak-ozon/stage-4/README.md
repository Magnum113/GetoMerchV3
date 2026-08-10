# Этап 4: product readiness и GTIN

Дата актуализации: 10 августа 2026 года.
Статус: развернут в production с внешними write flags off; реальный
SKU--GTIN reconciliation выполнен для актуального каталога Ozon.

## Реализовано

Forward-only миграция
[`0008_marking_product_readiness.sql`](../../../db/migrations/0008_marking_product_readiness.sql)
добавляет:

- атрибуты карточки Национального каталога для проверяемого GTIN;
- решение об обязательности маркировки и источник этого решения;
- операционные состояния профиля `draft`, `enabled`, `paused`, `blocked`;
- optimistic revision для защиты от одновременного редактирования;
- привязки профиля к Ozon и другим каналам;
- сохраняемые preview/apply запуски безопасного backfill.

Готовность проверяется в PostgreSQL. Обязательный к маркировке профиль нельзя
включить без проверенного GTIN и evidence, при несовпадении размера/цвета с
карточкой НК или при противоречии актуальному сигналу Ozon. Значение
`unknown` нельзя включить. Отсутствие или срок действия РД отображаются только
как справочная диагностика и не блокируют профиль.

Один GTIN можно разделить между вариантами только при явном подтверждении и
verified evidence у каждого профиля. При замене GTIN предыдущий профиль
архивируется, а история и channel snapshots сохраняются.

## API и интерфейс

Раздел `/marking` теперь содержит:

- все непустые товары, включая товары без marking profile;
- поиск по SKU, offer ID, Ozon SKU, GTIN, дизайну и категории;
- фильтры статуса, канала и конфликтов;
- редактор профиля, подтверждение GTIN, evidence и включение/приостановку;
- отдельный отчет о конфликтах;
- backfill с обязательным preview и явным apply.

Mutation API требует admin session, same-origin запрос, `X-Idempotency-Key`,
ограниченный JSON body и ожидаемую revision для изменения существующего
профиля. Роль приложения не имеет прямого write-доступа к таблицам и вызывает
только узкие `SECURITY DEFINER` функции.

## Правила backfill

Backfill:

- работает только по точным идентификаторам существующих товаров;
- не выводит GTIN из названия, дизайна или префикса артикула;
- не объединяет похожие SKU;
- не обрабатывает пустые изделия;
- создает только неактивные draft profiles;
- не подтверждает и не привязывает GTIN автоматически, даже если найден
  диагностический exact candidate;
- сохраняет item-level diff и итог применения.

## Проверки

Пройдены:

- GTIN validation и безопасная замена GTIN;
- optimistic concurrency и stale revision;
- все readiness blockers и информационные document warnings;
- конфликты размера/цвета, Ozon requirement, shared GTIN и нескольких GTIN у
  одного seller SKU;
- preview/apply идемпотентность и повторный apply;
- запрет эвристического включения и прямой записи app role;
- cursor pagination и empty state read models;
- clean migration rehearsal `0001-0008` и повторный verify;
- TypeScript и production build.

Проверки PostgreSQL выполнены во временной БД PostgreSQL 17 на VPS, после чего
миграция и read models развернуты в `getomerch_production`.

## Production reconciliation 10 августа 2026 года

Точный источник данных:
[`product-profile-manifest-2026-08-10.json`](./product-profile-manifest-2026-08-10.json).
Манифест содержит 138 актуальных Ozon-футболок и для каждой фиксирует seller
SKU, Ozon SKU, GTIN, цвет, размер и статус карточки Национального каталога.
Сопоставление по похожим названиям или префиксам не применяется.

Результат применения к `getomerch_production`:

- создано 138 активных marking profiles с `required`, `own_production`,
  `jit_after_order` и каналом `ozon_fbs`;
- 131 опубликованный GTIN проверен и имеет verified
  `product_profile_mapping` evidence;
- 124 профиля имеют readiness `ready` и operational status `enabled`;
- 7 опубликованных профилей приостановлены из-за последнего сигнала Ozon
  `not_required`; в read model это 7 явных
  `ozon_requirement_mismatch`, а не скрытое автоматическое разрешение;
- 7 новых профилей D26/D27 остаются `draft/paused`, пока карточки НК проходят
  модерацию; GTIN к ним намеренно не считается verified раньше публикации;
- локальные `D12-TSH-EMB-WHT-S` и `D12-TSH-EMB-WHT-M`, отсутствующие в
  актуальном каталоге Ozon, не включены в манифест и не получили профиль;
- восемь legacy GTIN без однозначного актуального Ozon SKU изолированы и не
  сопоставлялись эвристически;
- повторный apply дал тот же результат без дублей и без failed audit records.
- production verify выявил и устранил потерю строк при cursor pagination:
  readiness cursor теперь сохраняет микросекунды PostgreSQL, поэтому массово
  созданные в один момент товары не пропускаются между страницами.

Перед применением создана зашифрованная резервная копия
`getomerch-database-backup-20260810T114821Z.tar.gz.gpg`; off-site upload
завершился успешно. Внешние запросы в ГИС МТ, СУЗ и Ozon exemplar не
выполнялись.

Для повторной проверки без записи используется:

```bash
npm run marking:profiles:verify
```

Команда сверяет фактические profiles, channels, trade items, GTIN/evidence,
operational reasons, readiness и conflicts с версионированным манифестом.
`marking:profiles:reconcile -- --apply` после записи выполняет ту же проверку
автоматически.

## Внешний остаток

Семь карточек импорта НК `11887008` находятся в статусе `На модерации`:

- `D26-TSH-PRT-BLK-M/L/XL/XXL`;
- `D27-TSH-PRT-WGRY-L/XL/XXL`.

Национальный каталог указывает срок проверки от одного до трёх дней. После
перехода карточек в `Ожидает подписания` их нужно подписать УКЭП, убедиться в
статусе `Опубликована`, изменить только эти семь записей манифеста на
`published` и повторить preview/apply/verify. Создавать новые GTIN или дубли
карточек не нужно.

Семь Ozon-конфликтов нельзя автоматически подавлять. После получения нового
FBS snapshot с `required` повторный reconcile включит соответствующий профиль.
До этого safe policy оставляет его `paused`.

## Не входит в этап 4

- хранение и импорт полных КМ;
- физические единицы и назначения;
- PDF/DataMatrix;
- записи в Ozon, ГИС МТ или СУЗ.
