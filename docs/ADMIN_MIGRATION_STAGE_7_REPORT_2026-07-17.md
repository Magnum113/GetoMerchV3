# Отчёт по этапу 7: транзакционный mutation-path

Дата завершения: `2026-07-17`.

Основной план:
`docs/ADMIN_FULL_SERVER_MIGRATION_PLAN.md`.

## 1. Итог

Этап 7 завершён на отдельном серверном rehearsal-контуре. Для локального
PostgreSQL реализован полный mutation-path текущего `/api/admin/rpc`, включая
атомарные складские, производственные, цеховые и Ozon FBS-операции.

Production cutover не выполнялся:

- `admin.komui.ru` продолжает читать и писать текущий Supabase;
- `/etc/getomerch/database.env` не подключён к production unit;
- `getomerch_production` остаётся пустой;
- KOMUI production/staging и их PostgreSQL-базы не изменялись;
- постоянный rehearsal service читает локальную БД, но его write-source
  оставлен `supabase`; запись в server DB включалась только для одноразового
  изолированного test process.

## 2. Схема безопасности записей

Добавлена forward-only migration `db/migrations/0002_mutation_safety.sql`:

- отдельная схема `getomerch_audit`;
- `operation_requests` как ledger идемпотентных запросов;
- `audit_log` для успешных и неуспешных опасных операций;
- ограничения длины и формата ключей, request hash и допустимых статусов;
- индексы для поиска по времени, операции и entity;
- уникальность успешного audit-события по idempotency key;
- точечные grants для `getomerch_app` и read-only `getomerch_backup`.

Migration зеркально добавлена в
`supabase/migrations/20260717090000_getomerch_mutation_safety.sql`, но к
production Supabase в рамках этапа 7 не применялась. Это часть dual-DDL
контракта до cutover, а не изменение текущей production-схемы.

Проверки migration находятся в `db/checks/0002_mutation_safety.sql`.

## 3. Runtime и транзакционная граница

Добавлен серверный mutation layer в `src/lib/db/mutations/` и расширен
`src/lib/db/transaction.ts`.

Реализованы следующие гарантии:

- одна бизнес-операция выполняется в одной SQL-транзакции;
- retry допускается только для PostgreSQL `40001` и `40P01`, число повторов
  ограничено;
- произвольные validation/business ошибки автоматически не повторяются;
- опасные RPC требуют `X-Idempotency-Key`;
- повтор того же запроса возвращает сохранённый результат без второго
  изменения остатков;
- тот же ключ с другим payload возвращает conflict;
- actor/session фиксируются как безопасный fingerprint signed admin session,
  raw cookie в БД и лог не записывается;
- audit не содержит API keys, паролей и database URL;
- fault injection разрешён только явным test env и только для БД с префиксом
  `getomerch_stage7_`.

`GETOMERCH_DB_WRITE_SOURCE=server` теперь поддерживается при наличии
`GETOMERCH_DATABASE_URL`, но production defaults остаются
`supabase/supabase/false` до этапа cutover.

## 4. Атомарные операции

На server write-path переведены текущие RPC mutations:

- CRUD справочников, дизайнов, товаров и расходов;
- приёмка, продажа, списание, корректировка и перемещение;
- приёмка и корректировка принт-стока;
- производство с единым списанием заготовки/принта, приходом готового товара и
  записью движения;
- создание заказа в цех и получение готовых изделий;
- Ozon FBS ship, unship и fulfillment;
- изменение связей Ozon order/product;
- вспомогательные catalog/product mutations.

Строки остатков создаются через idempotent UPSERT, затем блокируются
детерминированно через `SELECT ... FOR UPDATE`. Полная проверка доступности
выполняется до первого изменения количества. Ограничение `quantity >= 0`
остаётся последней защитой на уровне БД.

Ozon FBO явно исключён из внутреннего fulfillment: FBO-заказ не может списать
собственный склад, создать workshop order или получить `shipped_at` через
FBS mutation.

## 5. Sync/import boundary для этапа 8

Подготовлены транзакционные primitives:

- `syncOzonOrderSnapshot` — upsert order и атомарная замена items;
- `applyOzonImportRun` — атомарное применение import run/items.

Они намеренно ещё не подключены к фактическим Ozon API routes. Pagination,
network retry, distributed lock, stale/cancelled refresh и run lifecycle
относятся к этапу 8 и не должны смешиваться с уже проверенной доменной
транзакцией.

## 6. Идентичность товаров

В rehearsal-данных обнаружено пять исторических групп дублирующихся finished
product combinations. Поэтому уникальный индекс на всю finished-комбинацию не
добавлялся: он сделал бы migration неприменимой без отдельной очистки данных.

`findOrCreateProduct` защищён transaction-level advisory lock по canonical
combination и существующими unique constraints `sku`/`ozon_sku`. Решение не
маскирует исторические дубли и предотвращает новые конкурентные дубли через
этот mutation-path. Нормализация существующих пяти групп должна выполняться
отдельным data-remediation этапом после подтверждения владельцем.

## 7. Серверная проверка

Проверочная сборка:
`/opt/getomerch/rehearsals/stage7-20260717T074732Z`.

Проверка выполнена на disposable БД
`getomerch_stage7_20260717t074732z` и отдельном process на `127.0.0.1:3102`.
После тестов process, unit, env, HBA-rule и disposable БД удалены; порт `3102`
закрыт.

Успешно пройдены 12 групп mutation tests:

1. runtime guard для server write-source;
2. receive idempotency, replay и конфликт payload;
3. rollback приёмки после fault injection;
4. конкурентная защита остатка и запрет отрицательного количества;
5. commit перемещения и движение;
6. rollback производства по blank/finished/print;
7. commit производства по blank/finished/print;
8. rollback создания workshop order;
9. commit create/receive workshop order;
10. rollback Ozon FBS shipment;
11. idempotent FBS ship и commit unship;
12. изоляция Ozon FBO и audit success/failure.

Дополнительно прошли:

- 18 baseline schema checks;
- 164 data-integrity checks;
- 10 mutation-safety checks;
- read regression 8/8 групп;
- p95 disposable local read: обычные API `22 ms`, matrix `11 ms`;
- p95 постоянного strict-shadow rehearsal: обычные API `378 ms`, matrix
  `230 ms`.

Migration `0002` после disposable-проверки применена к постоянной
`getomerch_rehearsal`. Symlink `stage7-latest` указывает на проверочную
сборку. Production release не менялся и остаётся
`/opt/getomerch/releases/20260716T095237Z-admin-091ce3f850b6`.

## 8. Exit criteria

Критерий этапа выполнен: ошибки, принудительно внесённые в середину
приёмки, производства, создания заказа в цех и Ozon FBS shipment, не оставили
частичных остатков, движений или статусов. Повтор запросов с тем же
idempotency key не применяет операцию второй раз.

Следующий этап — этап 8: подключить подготовленные транзакционные primitives к
Ozon sync/import routes, добавить locks, полную pagination, bounded network
retry, run logs и фоновые задания без переключения production до отдельной
pre-production репетиции.
