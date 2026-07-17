# Отчет по этапу 4: первая репетиция миграции данных

Дата выполнения и проверки: `2026-07-16`.

Связанные документы:

- `docs/ADMIN_FULL_SERVER_MIGRATION_PLAN.md`;
- `docs/ADMIN_FULL_SERVER_MIGRATION_STATUS.md`;
- `docs/ADMIN_MIGRATION_STAGE_3_REPORT_2026-07-16.md`;
- `db/README.md`.

## 1. Результат

Этап 4 завершен. Свежий allowlist snapshot текущего Supabase production
успешно импортирован в постоянную `getomerch_rehearsal`:

- источник: ровно 20 рабочих таблиц;
- импортировано: `6 621` строк;
- source/target fingerprints: совпали для всех `20/20` таблиц;
- global fingerprint: совпал;
- data-integrity checks: `164/164` успешно;
- schema checks: `18/18` успешно;
- необъясненных расхождений: `0`;
- `getomerch_production`: не изменялась, `0` пользовательских таблиц;
- production runtime: не переключался и продолжает работать с Supabase.

Постоянная rehearsal теперь содержит проверенную копию данных на момент
snapshot. Она не является source of truth и не получает последующие изменения
Supabase автоматически.

## 2. Source archive

Для репетиции создан новый зашифрованный backup:

```text
getomerch-backup-20260716T165808Z.tar.gz.gpg
```

Архив:

- прошел SHA-256 и GPG verification;
- был загружен в off-site Object Storage;
- содержал allowlist export 20 таблиц, schema snapshot, counts, export manifest
  и source fingerprint;
- был не старше 97 секунд на момент начала импорта.

Native `pg_dump` через доступные Supabase endpoints в текущем окружении ранее
оказался ненадежным: direct endpoint недоступен по IPv4, session pooler
упирался в лимит, а Supavisor-запуск зависал на session setup. Поэтому этап 4
использовал существующий server-side REST export.

Чтобы REST export не принимал изменяющийся набор за стабильный snapshot,
exporter теперь:

1. читает каждую таблицу keyset-страницами по `id`;
2. проверяет exact count до и после чтения таблицы;
3. повторно полностью читает все 20 таблиц;
4. сравнивает SHA-256 полного упорядоченного row stream первого и второго
   прохода;
5. принимает export только при полном совпадении.

Оба прохода source snapshot совпали. Это существенно сильнее прежней проверки
counts, но не является PostgreSQL transaction snapshot. Перед production
cutover остается обязательным writer freeze либо восстановление надежного
direct/session-pooler dump-маршрута.

## 3. Безопасная схема импорта

Репетиция не очищала постоянную rehearsal в начале. Оркестратор
`/usr/local/sbin/getomerch-data-rehearsal` выполнил:

1. Проверку свежести, шифрования, checksum и manifest source archive.
2. Проверку пустоты `getomerch_production`, HBA и отсутствия локального DB env
   у production-процесса.
3. Создание отдельной одноразовой БД
   `getomerch_rehearsal_candidate_<timestamp>`.
4. Построение candidate из Git baseline `0001`.
5. Загрузку NDJSON в staging через PostgreSQL `COPY`.
6. Импорт всех таблиц в одной транзакции с
   `session_replication_role=replica` и сохранением исходных UUID.
7. `ANALYZE`, установку app/backup grants, schema/data checks и fingerprints.
8. Переименование прежней rehearsal в rollback-базу и candidate в
   `getomerch_rehearsal`.
9. Повторный healthcheck и migration verify уже через постоянные app/migrator
   env.
10. Удаление предыдущей rehearsal только после успешной финальной проверки.

При ошибке до swap candidate удаляется, а постоянная rehearsal не меняется.
При ошибке после первого rename оркестратор возвращает предыдущую БД на имя
`getomerch_rehearsal`.

Первые две технические попытки подтвердили этот rollback-механизм:

- root-only import SQL нельзя было открыть из `psql -f` под `postgres`, поэтому
  SQL теперь передается через stdin;
- integrity-файл был установлен с недоступной для `postgres` группой, поэтому
  добавлен preflight чтения и несекретный SQL установлен как readable.

Обе неуспешные candidate-базы были удалены автоматически; постоянная rehearsal
до успешной третьей попытки не менялась.

## 4. Количество строк

| Таблица | Строк |
|---|---:|
| `merch_warehouses` | 2 |
| `merch_product_categories` | 3 |
| `merch_fabric_types` | 2 |
| `merch_colors` | 5 |
| `merch_sizes` | 6 |
| `merch_designs` | 23 |
| `merch_decoration_types` | 2 |
| `merch_products` | 198 |
| `merch_inventory` | 132 |
| `merch_print_inventory` | 12 |
| `merch_transactions` | 665 |
| `merch_workshop_orders` | 32 |
| `merch_workshop_order_items` | 32 |
| `merch_ozon_orders` | 678 |
| `merch_ozon_order_items` | 682 |
| `merch_ozon_finance_operations` | 2 118 |
| `merch_expense_categories` | 1 |
| `merch_expenses` | 0 |
| `merch_ozon_import_runs` | 13 |
| `merch_ozon_import_items` | 2 015 |
| **Итого** | **6 621** |

Counts source и target совпали для каждой таблицы.

## 5. Fingerprints и агрегаты

`ops/getomerch-data-fingerprint.py` строит одинаковый детерминированный отчет
для source NDJSON и выгрузки строк из target PostgreSQL. Для каждой таблицы
сравниваются:

- точное число строк;
- SHA-256 упорядоченного набора primary keys;
- SHA-256 канонического содержимого всех строк;
- `min/max(created_at)`, если поле присутствует;
- `min/max(updated_at)`, если поле присутствует.

Дополнительно сравниваются без сохранения чувствительных значений в отчете:

- сумма quantities Ozon items;
- количество unmatched Ozon items;
- SHA-256 quantities, сгруппированных по заказу;
- SHA-256 финансовых сумм по месяцам;
- SHA-256 количества товаров по design/size/fabric/color;
- quantities и связи workshop items.

Результат:

```text
source_fingerprint_sha256 = 8746fcd1d471c82bfc7192bf2e18b22dc2f5cc74a7a798161617d2accadde620
target_fingerprint_sha256 = 8746fcd1d471c82bfc7192bf2e18b22dc2f5cc74a7a798161617d2accadde620
matched_tables = 20
global_match = true
```

## 6. Data-integrity checks

Добавлен проверочный файл
`db/checks/0001_getomerch_data_integrity.sql`. Он выполняется migration runner в
repeatable-read/read-only проверке и покрывает:

- все 90 `NOT NULL` колонок на фактических данных;
- форму и orphan rows всех 31 foreign keys;
- отсутствие unvalidated constraints;
- отсутствие неожиданных `merch_*` таблиц;
- отсутствие sequences в текущей UUID-only схеме;
- отрицательные остатки;
- дубли SKU, Ozon SKU, posting number и finance operation ID;
- неположительные quantities Ozon/workshop items.

Все `164` data checks вернули `actual=expected`. Baseline schema checks также
повторно прошли `18/18`.

## 7. Права и границы

На заполненной rehearsal проверено:

- `getomerch_app` читает 198 товаров и 678 Ozon-заказов;
- write app-role успешно выполняется внутри rollback-транзакции;
- DDL для app-role заблокирован;
- `getomerch_backup` читает данные и не может выполнять INSERT;
- app-role не может подключиться к `komui_production`;
- HBA errors: `0`;
- временных candidate/previous/restore БД после проверок: `0`.

Production/KOMUI guard до и после репетиции совпал. Роли и свойства баз KOMUI
не менялись. В процессе `getomerch-admin.service` отсутствует
`GETOMERCH_DATABASE_URL`.

## 8. Backup после репетиции

После успешной репетиции создан финальный архив, включающий новые инструменты и
root-only отчеты:

```text
getomerch-backup-20260716T170230Z.tar.gz.gpg
```

Он успешно:

- зашифрован и проверен;
- загружен off-site;
- восстановлен во временную БД;
- восстановил 20 таблиц с совпавшими counts и 6 backup invariants;
- прошел restore drill за 4 секунды;
- удалил временную БД.

## 9. Отчеты на сервере

```text
/var/lib/getomerch/rehearsals/20260716T170015Z/report.env
/var/lib/getomerch/rehearsals/20260716T170015Z/source-fingerprint.json
/var/lib/getomerch/rehearsals/20260716T170015Z/target-fingerprint.json
/var/lib/getomerch/rehearsals/20260716T170015Z/comparison.json
/var/lib/getomerch/rehearsals/20260716T170015Z/data-integrity.tsv
/var/lib/getomerch/rehearsals/20260716T170015Z/export-manifest.json
/var/lib/getomerch/rehearsals/20260716T170015Z/rehearsal.log
/var/lib/getomerch/rehearsals/latest
```

Права report-файлов: `root:root`, `0600`. Raw rows после репетиции удалены;
сохраняются только counts, hashes, результаты проверок и ссылки на
зашифрованный source archive.

## 10. Следующий этап

Этап 5 должен создать независимый database/service layer в приложении:

1. Ввести единый server-side интерфейс подключения к Supabase и локальному
   PostgreSQL.
2. Не переводить production runtime и не менять write-path.
3. Запустить приложение с rehearsal env в отдельном тестовом процессе.
4. Сначала реализовать read-only adapters и контрактные тесты.
5. Не использовать `SELECT *` по тяжелым таблицам и не смешивать БД KOMUI с
   GetoMerch.
