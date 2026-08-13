# Этап 4: product readiness и GTIN

Дата актуализации: 13 августа 2026 года.
Статус: развернут в production с внешними write flags off; реальный
SKU--GTIN reconciliation выполнен для всех 138 товаров актуального каталога
Ozon.

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
- clean migration rehearsal `0001-0019` и повторный verify;
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
- 138 опубликованных GTIN проверены и имеют verified
  `product_profile_mapping` evidence;
- 138 опубликованных профилей имеют readiness `ready` и operational status
  `enabled`;
- все семь новых профилей D26/D27 подписаны УКЭП, опубликованы в НК и включены
  только после проверки точного SKU--GTIN соответствия;
- локальные `D12-TSH-EMB-WHT-S` и `D12-TSH-EMB-WHT-M`, отсутствующие в
  актуальном каталоге Ozon, не включены в манифест и не получили профиль;
- восемь legacy GTIN без однозначного актуального Ozon SKU изолированы и не
  сопоставлялись эвристически;
- Ozon requirement conflicts отсутствуют;
- повторный apply использует уже проверенные profile/GTIN без повторной записи,
  а idempotency-ключ меняется вместе с версией входного snapshot;
- production verify выявил и устранил потерю строк при cursor pagination:
  readiness cursor теперь сохраняет микросекунды PostgreSQL, поэтому массово
  созданные в один момент товары не пропускаются между страницами.

Перед применением создана зашифрованная резервная копия
`getomerch-database-backup-20260810T114821Z.tar.gz.gpg`; off-site upload
завершился успешно. После итоговой проверки создана контрольная копия
`getomerch-database-backup-20260810T120709Z.tar.gz.gpg`, также успешно
проверенная и загруженная off-site. Внешние запросы в ГИС МТ, СУЗ и Ozon
exemplar не выполнялись.

Для повторной проверки без записи используется:

```bash
npm run marking:profiles:verify
```

Команда сверяет фактические profiles, channels, trade items, GTIN/evidence,
operational reasons, readiness и conflicts с версионированным манифестом.
`marking:profiles:reconcile -- --apply` после записи выполняет ту же проверку
автоматически.

## Актуализация Национального каталога 13 августа 2026 года

Все семь карточек импорта НК `11887008` опубликованы:

- `D26-TSH-PRT-BLK-M/L/XL/XXL`;
- `D27-TSH-PRT-WGRY-L/XL/XXL`.

Статус `Опубликована`, технические наименования и GTIN проверены в
Национальном каталоге. Манифест переведен на версию
`national-catalog-ozon-2026-08-13-v2`; повторный preview/apply/verify дал 138
verified/enabled/ready profiles, 0 blocked и 0 conflicts. Новые GTIN и дубли
карточек не создавались.

Повторная проверка реального Ozon API показала, что семь прежних конфликтов
были ошибкой проекции: SKU отсутствовали в обязательном массиве, но находились
в `optional.products_with_possible_mandatory_mark`. Ozon разрешал передавать
КМ, однако синхронизация теряла optional-массив и записывала `not_required`.
Начиная с release `172a1147be37` optional-сигнал включает эффективный JIT-поток
и сохраняет `exemplar_flow_available=true`. После активной синхронизации 44
отправлений семь профилей включены через audit API; marking conflicts равны
нулю.

Миграция `0019_marking_live_ozon_requirement.sql` исключает завершенные и
отмененные FBS posting из текущего Ozon requirement. Исторический сигнал
терминального заказа сохраняется в данных, но больше не блокирует актуальный
товарный профиль.

## Не входит в этап 4

- хранение и импорт полных КМ;
- физические единицы и назначения;
- PDF/DataMatrix;
- записи в Ozon, ГИС МТ или СУЗ.
