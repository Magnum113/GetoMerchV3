# Отчет по этапам 0–1 миграции GetoMerch Admin

Дата фиксации: `2026-07-16`.

Статус:

- этап 0 — выполнен;
- этап 1 — выполнен для migration scope из 20 рабочих таблиц;
- повторная очистка сервера не выполнялась: владелец уже освободил место, а
  фактический capacity gate был пройден без удаления данных.

## 1. Зафиксированный migration scope

Единственный allowlist рабочих таблиц хранится в
`ops/getomerch-working-tables.txt` и установлен на сервере как
`/usr/local/share/getomerch/working-tables.txt`.

В allowlist ровно 20 таблиц:

1. `merch_warehouses`;
2. `merch_product_categories`;
3. `merch_fabric_types`;
4. `merch_colors`;
5. `merch_sizes`;
6. `merch_designs`;
7. `merch_decoration_types`;
8. `merch_products`;
9. `merch_inventory`;
10. `merch_print_inventory`;
11. `merch_transactions`;
12. `merch_workshop_orders`;
13. `merch_workshop_order_items`;
14. `merch_ozon_orders`;
15. `merch_ozon_order_items`;
16. `merch_ozon_finance_operations`;
17. `merch_expense_categories`;
18. `merch_expenses`;
19. `merch_ozon_import_runs`;
20. `merch_ozon_import_items`.

## 2. Реестр потребителей Supabase

| Потребитель | Состояние | Доступ | Решение на cutover |
|---|---|---|---|
| `getomerch-admin.service`, `/opt/getomerch/current` | активен | REST read/write и server-side Postgres read | переводится по этапам 5–10 |
| `getomerch-backup.timer` | активен | read-only через Supabase REST | остается до окончательного cutover |
| `sku_mapping/*.mjs` в текущем репозитории | только ручной запуск | потенциальный write | запретить запуск в окно cutover |
| локальный `GetoMerchV4` | процесс не запущен, но env указывает на тот же project ref | потенциальный read/write | перед cutover удалить/заморозить credentials |
| старые локальные `GetoMerch`/`GetoMerchV2` | не запущены, используют другие Supabase projects | вне scope | не участвуют в миграции |
| KOMUI production/staging на VPS | активны | не используют project ref и 20 таблиц GetoMerch | не изменять |
| Supabase Edge Functions проекта | активные функции найдены, ссылок на 20 таблиц нет | вне рабочего scope | повторно проверить перед cutover |

На VPS не найдено cron/systemd-заданий или работающих legacy-процессов,
которые пишут в 20 таблиц помимо production-админки. Известные ручные клиенты
не считаются неизвестными writers, но остаются обязательным cutover gate.

## 3. Зафиксированные границы данных

- внутренние остатки GetoMerch не определяют availability storefront KOMUI;
- в резервировании заготовок и принтов участвует только Ozon FBS;
- Ozon FBO хранится для аналитики и не создает внутренний fulfillment;
- `komui_production` и будущая `getomerch_production` остаются разными БД;
- перенос shared catalog выполняется отдельными контрактами, а не cross-DB FK.

Полная модель описана в
`docs/GETOMERCH_KOMUI_SERVER_DATA_ARCHITECTURE.md`.

## 4. Capacity gate

Проверено на VPS перед export и после restore drill:

- корневой раздел: `64%` использовано;
- свободно около `6.9 GiB`;
- после полного export/restore свободный резерв остался выше `6.8 GiB`;
- временные restore databases после drill удалены;
- пороги плана `75% warning`, `85% critical`, минимум `4 GiB` пройдены.

Расширение диска до `40–60 GiB` остается требованием перед WAL/PITR, тяжелыми
workers или существенным ростом media, но не блокирует этапы 0–4.

## 5. Реализованный backup

### Ежедневный рабочий архив

`getomerch-backup.timer` запускает `/usr/local/sbin/getomerch-backup`.
Архив включает:

- данные ровно 20 allowlist-таблиц;
- reviewed schema snapshot: 20 таблиц, 81 constraint, 31 отдельный index и
  один trigger;
- 32 RLS policy records;
- точные counts и export manifest;
- runtime env/config, systemd/nginx config, deploy registry и свежие логи;
- SHA-256 manifest;
- AES-256 шифрование до off-site upload.

Данные читаются server-side через Supabase REST с server key, страницами по
500 строк. Ключ не передается в аргументах процессов, manifest или логи.

### Forensic-архив

Разовый запуск с `GETOMERCH_BACKUP_INCLUDE_FULL_SUPABASE_DUMP=true` добавляет:

- данные всех 31 текущих таблиц схемы `public`, включая backup/storefront
  таблицы вне migration allowlist;
- catalog snapshot из 724 объектов: tables, columns, constraints, indexes,
  functions, triggers и policies;
- PostgREST OpenAPI schema;
- export списка Supabase Auth users;
- отдельные counts и forensic manifest.

Это прикладной forensic archive проекта, а не физический backup внутренних
managed-схем Supabase. `auth` sessions, `net`, `realtime`, `vault` и служебные
данные платформы остаются под managed backup Supabase и не импортируются в
будущую `getomerch_production`.

Native `pg_dump` через Supavisor в текущем проекте зависает после служебного
`SET INTERVALSTYLE`; direct endpoint требует IPv6 либо Supabase IPv4 add-on,
которых на VPS нет. Поэтому рабочий RPO не зависит от этого маршрута.

## 6. Фактическая проверка

Контрольный полный архив:

```text
getomerch-backup-20260716T152619Z.tar.gz.gpg
```

Результаты:

- локальный encrypted archive: `2,286,908 bytes`;
- off-site upload: `s3://komui-backups/getomerch/admin-production/`;
- checksum object загружен рядом;
- restore во временную локальную PostgreSQL DB: успешно;
- восстановлено 20 таблиц;
- counts всех 20 таблиц совпали;
- проверено 6 business invariants, нарушений нет;
- фактический restore drill RTO: `5 секунд`;
- временная БД после проверки удалена.

Ежедневный backup без forensic-приложения также отдельно восстановлен успешно.

Текущий целевой RPO — не более 24 часов за счет daily timer. Целевой RTO до
двух часов пройден с большим запасом на текущем объеме. RPO до пяти минут
появится только после локальной БД и отдельного этапа WAL/PITR.

## 7. Установленные серверные компоненты

```text
/usr/local/sbin/getomerch-backup
/usr/local/sbin/getomerch-logical-export
/usr/local/sbin/getomerch-restore-drill
/usr/local/lib/getomerch/getomerch-rest-export.mjs
/usr/local/share/getomerch/working-tables.txt
/usr/local/share/getomerch/forensic-public-tables.txt
/usr/local/share/getomerch/working-schema-pre.sql
/usr/local/share/getomerch/working-schema-post.sql
/usr/local/share/getomerch/working-policies.csv
/usr/local/share/getomerch/supabase-public-catalog.jsonl
```

Отчеты restore drill находятся в
`/var/backups/getomerch/restore-drills/`.

## 8. Остаточные обязательные действия

Перед production cutover:

1. Заморозить или отозвать Supabase credentials в локальном `GetoMerchV4`.
2. Запретить ручной запуск legacy SKU scripts на все окно cutover.
3. Повторить consumer scan непосредственно перед переключением write-path.
4. После кратковременного диагностического запуска, при котором DB URL был
   виден только root-процессам VPS через process list, планово сменить пароль
   Supabase DB до cutover. В текущих скриптах URL больше не передается через
   process arguments.
5. Не считать forensic archive заменой Supabase managed backup внутренних
   платформенных схем.
