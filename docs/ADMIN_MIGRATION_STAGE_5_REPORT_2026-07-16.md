# Отчет по этапу 5 переноса GetoMerch Admin

Дата выполнения: `2026-07-16`.

Этап: независимый database/service layer приложения.

## 1. Итог

Этап 5 завершен. В приложении появился нейтральный server-only слой доступа к
данным с отдельными Supabase и PostgreSQL adapters. Реальные маршруты каталога
и товаров работают через repository/service contracts и сохранили текущий
HTTP-формат.

Отдельная сборка приложения запущена на VPS против `getomerch_rehearsal` и в
строгом shadow-режиме сравнивает ответы с Supabase. Все repository contract
tests прошли. Production-сервис не переключался и продолжает работать с
Supabase.

## 2. Реализованный слой

Добавлена структура:

```text
src/lib/db/
  config.ts
  errors.ts
  pool.ts
  transaction.ts
  repositories/
    catalog.ts
    products.ts
  services/
    catalog-service.ts
    product-service.ts
    runtime.ts
    shadow-compare.ts
```

Основные свойства:

- `GETOMERCH_DATABASE_URL` читается только лениво на сервере;
- новый pool не использует старое имя
  `GETOMERCH_SUPABASE_DATABASE_URL`;
- переменные фильтров и pagination передаются только параметрами SQL;
- PostgreSQL repositories выбирают явные колонки и не используют
  `SELECT *`;
- SQL, mapping, бизнес-оркестрация и HTTP-обработка разделены;
- ошибки БД превращаются в нейтральные server errors без SQL, строк и
  credentials в клиентском ответе;
- transaction helper поддерживает фиксированный allowlist isolation levels,
  `READ ONLY` и обязательный rollback;
- server write-source намеренно запрещен до этапа 7.

## 3. Переходные flags

Поддержаны:

```env
GETOMERCH_DB_READ_SOURCE=supabase|server
GETOMERCH_DB_WRITE_SOURCE=supabase|server
GETOMERCH_DB_SHADOW_COMPARE=false|true
GETOMERCH_DB_SHADOW_COMPARE_STRICT=false|true
```

До этапа 7 допустимо только
`GETOMERCH_DB_WRITE_SOURCE=supabase`. Попытка включить server writes завершается
configuration error, чтобы flag не создавал ложное ощущение выполненного
write-cutover.

Без явных flags production default остается:

```env
GETOMERCH_DB_READ_SOURCE=supabase
GETOMERCH_DB_WRITE_SOURCE=supabase
GETOMERCH_DB_SHADOW_COMPARE=false
```

## 4. Сохраненный HTTP-контракт

На новый слой переведены только два read-only маршрута, достаточные для
проверки паттерна этапа 5:

- `GET /api/admin/catalog`;
- `GET /api/admin/products`.

Сохранены:

- auth и стандартные `ok/data/meta` envelopes;
- имена массивов каталога;
- product shape с гидрированными category/fabric/color/size/design;
- `limit`, offset cursor, `nextCursor` и `hasMore`;
- фильтры `is_blank`, `design_id` и `search`;
- server-side pagination.

Остальные read-path переводятся по очереди на этапе 6. Mutation-path и Ozon
workers остаются на Supabase до этапов 7 и 8.

## 5. Shadow compare

Shadow compare запускает одинаковую repository operation в primary и shadow
adapter, нормализует только представление timestamp и сравнивает SHA-256
канонического JSON.

В журнал попадают только operation и hashes. Строки, персональные данные,
SQL и connection strings не логируются. В обычном режиме сбой shadow не ломает
primary response; в strict rehearsal-режиме mismatch или shadow query failure
завершает запрос ошибкой и проваливает contract test.

Во время первой проверки обнаружены два реальных различия порядка:

1. Названия дизайнов сортировались по разным database collations. Каталог
   теперь получает единый побайтный порядок, совпадающий с текущим Supabase
   contract.
2. SKU в локальном PostgreSQL попадали на страницы иначе, чем в PostgREST.
   SQL repository использует `COLLATE "C"`, поэтому pagination детерминирована
   и совпадает с Supabase.

Расхождений значений после нормализации порядка не осталось.

## 6. Контрактные тесты

Добавлена команда:

```bash
npm run check:db-repositories
```

Она проверяет:

- `401` без admin session;
- структуру всех восьми наборов каталога;
- непустые reference data;
- product hydration;
- первую и следующую страницу без пересечения;
- metadata cursor contract;
- фильтры blank/finished и поиск SKU;
- фактически выбранный read adapter.

Результаты:

| Контур | Источник | Результат |
|---|---|---|
| локальная production build | Supabase | 4/4 checks passed |
| текущий VPS production process `:3100` | Supabase | 4/4 checks passed |
| отдельный VPS rehearsal process `:3101` | local PostgreSQL + strict Supabase shadow | 4/4 checks passed |

Локальная и серверная `npm run build` также завершились успешно.

## 7. Rehearsal process на VPS

Проверенная сборка:

```text
/opt/getomerch/rehearsals/stage5-20260716T172213Z
/opt/getomerch/rehearsals/stage5-latest -> stage5-20260716T172213Z
```

Управление:

```bash
sudo /usr/local/sbin/getomerch-admin-rehearsal start
sudo /usr/local/sbin/getomerch-admin-rehearsal stop
sudo /usr/local/sbin/getomerch-admin-rehearsal restart
sudo /usr/local/sbin/getomerch-admin-rehearsal status
sudo /usr/local/sbin/getomerch-admin-rehearsal test
```

Скрипт создает runtime-only unit
`/run/systemd/system/getomerch-admin-rehearsal.service`. Unit не enabled,
исчезает после reboot и не имеет nginx route. Процесс:

- работает от `getomerch:getomerch`;
- слушает только `127.0.0.1:3101`;
- читает `/etc/getomerch/admin-production.env` для текущих server credentials;
- читает `/etc/getomerch/database-rehearsal.env` для локальной БД;
- использует read-source `server`, write-source `supabase` и strict shadow;
- валидирует root-only `0600` env и точное `PGDATABASE=getomerch_rehearsal`;
- не принимает `database.env` production target.

Через `pg_stat_activity` подтверждено соединение:

```text
getomerch_rehearsal:getomerch_app:getomerch-admin-rehearsal:idle
```

## 8. Production и KOMUI не изменены

После этапа проверено:

- `getomerch-admin.service` active;
- active release остался
  `/opt/getomerch/releases/20260716T095237Z-admin-091ce3f850b6`;
- в production process отсутствует `GETOMERCH_DATABASE_URL`;
- read-source production остается default Supabase;
- `https://admin.komui.ru/login` отвечает `200`;
- `https://komui.ru/` отвечает `200`;
- rehearsal порт доступен только через loopback;
- роли и БД KOMUI не менялись.

`getomerch_production` остается пустой. Ни production schema, ни данные, ни
write-path не переключались.

## 9. Артефакты

- `src/lib/db/**` — новый database/service layer;
- `scripts/check-db-repositories.mjs` — HTTP repository contract tests;
- `ops/getomerch-admin-rehearsal` — безопасное управление тестовым процессом;
- `ops/getomerch-backup` — новый operator script включен в encrypted backup;
- `.env.example` — переходные flags без секретов;
- этот отчет и обновленный migration status.

## 10. Следующий этап

Этап 6 переводит остальные read-path по доменам и для каждого фиксирует
Supabase/server parity, pagination, representative `EXPLAIN` и latency. Ни
один write-path при этом не переключается.
