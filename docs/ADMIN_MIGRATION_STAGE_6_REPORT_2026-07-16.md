# Отчет по этапу 6: полный read-path GetoMerch Admin

Дата выполнения: `2026-07-16`.

Основной план: `docs/ADMIN_FULL_SERVER_MIGRATION_PLAN.md`.

## 1. Результат

Этап 6 завершен на изолированном rehearsal-контуре. Все read-only разделы
админки переведены на общий `src/lib/db`, прочитаны из локальной
`getomerch_rehearsal` и в strict-режиме сравнены с текущим Supabase.

Production не переключался:

- `/opt/getomerch/current` не изменен;
- `getomerch-admin.service` продолжает читать Supabase;
- `/etc/getomerch/database.env` не подключен к production unit;
- `getomerch_production` остается пустой;
- mutation-path остается в Supabase до этапа 7;
- базы и сервисы KOMUI не изменялись.

## 2. Реализованный read-path

Добавлены PostgreSQL и Supabase repositories и единые services для:

1. справочников и каталога;
2. товаров, поиска заготовок и счетчиков дизайнов;
3. остатков, принтов и inventory matrix;
4. журнала движений;
5. заказов в цех;
6. Ozon orders/items;
7. расходов, финансов, Ozon SKU map и истории импортов.

HTTP URL, параметры и response envelope `{ ok, data, meta }` сохранены. Все
read-only действия `/api/admin/rpc` также идут через этот слой. Mutation-
действия в том же dispatcher намеренно продолжают вызывать старый Supabase API.

## 3. Правила запросов

- По рабочим таблицам выбираются только явные колонки.
- `raw jsonb` заказов, финансов и позиций импорта не читается списками.
- Товары гидрируются справочниками server-side без `to_jsonb(table)`.
- Связанные продукты и позиции загружаются пакетами, а не N+1-запросами.
- Supabase `.in(...)` разбит на ограниченные пакеты.
- Матрица использует один список продуктов и одну SQL-агрегацию остатков.
- Списки имеют детерминированный дополнительный порядок по `id`.
- Shadow compare нормализует даты и порядок только там, где это является
  частью контракта, и не пишет строки данных или credentials в log.

## 4. Свежая rehearsal-копия

Перед проверкой создан и загружен off-site encrypted backup:

```text
getomerch-backup-20260716T181757Z.tar.gz.gpg
```

`getomerch_rehearsal` атомарно пересобрана через rollback-safe candidate.
Отчет на сервере:

```text
/var/lib/getomerch/rehearsals/20260716T181837Z/
status=success
elapsed_seconds=20
tables=20
rows=6621
schema_checks=18/18
data_checks=164/164
source_fingerprint=target_fingerprint
```

## 5. Contract и performance tests

Расширен `scripts/check-db-repositories.mjs`. Он проверяет auth boundary,
форму данных всех read-доменов, пагинацию товаров, фильтры, гидрацию,
inventory matrix, read-only RPC и источник чтения.

Проверенный stage-6 release:

```text
/opt/getomerch/rehearsals/stage6-20260716T181932Z
/opt/getomerch/rehearsals/current -> stage6-20260716T181932Z
getomerch-admin-rehearsal.service
127.0.0.1:3101
```

Режим процесса: local PostgreSQL primary + Supabase strict shadow. Результат:

```text
contract groups: 8/8 passed
ordinary API p95: 396 ms, 40 samples, limit 1000 ms
inventory matrix p95: 123 ms, 3 samples, limit 3000 ms
```

Эти значения включают ожидание второго запроса в Supabase для strict compare;
это более тяжелый режим, чем будущий одиночный production read.

## 6. EXPLAIN

`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF)` выполнен на свежей rehearsal:

| Query pattern | Execution time |
|---|---:|
| products page | `0.187 ms` |
| inventory list | `0.063 ms` |
| inventory matrix aggregate | `0.122 ms` |
| movements | `0.153 ms` |
| workshop orders/items | `0.021 / 0.082 ms` |
| Ozon orders/items | `0.658 / 0.428 ms` |
| expenses | `0.013 ms` |
| finance | `0.571 ms` |
| import history | `0.018 ms` |

Движения и финансы используют date indexes, Ozon items используют
`merch_ozon_order_items_order_idx`. Seq scan остается на таблицах от 0 до 678
строк и дает sub-millisecond execution. Новые индексы на этапе 6 не добавлены,
поскольку фактические планы не показали проблемного query pattern.

## 7. Управление rehearsal

Управляющий symlink теперь не привязан к номеру этапа:

```text
/opt/getomerch/rehearsals/current
```

Команды не изменились:

```bash
sudo /usr/local/sbin/getomerch-admin-rehearsal start
sudo /usr/local/sbin/getomerch-admin-rehearsal stop
sudo /usr/local/sbin/getomerch-admin-rehearsal restart
sudo /usr/local/sbin/getomerch-admin-rehearsal status
sudo /usr/local/sbin/getomerch-admin-rehearsal test
```

Unit runtime-only, слушает только loopback и не подключен к nginx.

## 8. Следующий этап

Этап 7 должен переносить mutation-path. До реализации SQL-транзакций нельзя
устанавливать `GETOMERCH_DB_WRITE_SOURCE=server` или подключать локальную
production DB к production unit. Приемка этапа 7 должна доказать атомарность
складских, производственных, цеховых и Ozon FBS операций с rollback tests.
