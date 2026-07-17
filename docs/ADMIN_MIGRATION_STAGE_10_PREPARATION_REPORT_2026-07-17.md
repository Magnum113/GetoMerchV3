# Отчет о подготовке этапа 10: production cutover

Дата проверки: `2026-07-17`.

Статус: подготовительный Release E реализован, установлен и проверен на VPS.
Команды `prepare` и `go` намеренно не запускались. Production-админка продолжает
читать и записывать Supabase, а `getomerch_production` после всех тестов снова
пустая.

## 1. Принятые параметры

- окно обслуживания: `60 минут`;
- допустимый RPO локальной БД: до `60 минут`;
- локальный encrypted `pg_dump`: каждый час с обязательной выгрузкой off-site;
- Supabase сохраняется неизмененным минимум `30 дней`;
- простой abort на Supabase допустим только до первого write в локальную БД;
- worker запускается только после явного Go;
- автоматические Ozon timers остаются выключенными первые `24 часа`.

## 2. Реализованные механизмы

### Maintenance mode

- `GETOMERCH_MAINTENANCE_MODE=read_only` блокирует mutation API с `503`;
- login/logout и действительно read-only POST остаются доступны;
- mutation service, job queue и worker имеют независимый server-side guard;
- в интерфейсе отображается предупреждение о режиме только для чтения;
- `getomerch-maintenance` атомарно меняет root-only env, перезапускает только
  админку и проверяет фактический HTTP-код write probe.

### Локальный backup

- `getomerch-database-backup` делает custom-format dump всех таблиц `public`,
  `getomerch_meta`, `getomerch_audit` и `getomerch_jobs`;
- архив содержит counts, manifest, checksums и encrypted runtime config;
- upload во внешнее S3 обязателен, иначе запуск считается неуспешным;
- retention разделен на hourly, daily, weekly и monthly копии;
- `getomerch-database-restore-drill` восстанавливает свежий архив в одноразовую
  БД, сверяет counts, migrations, invariants и grants, затем удаляет БД.

### Cutover state machine

Доступны команды:

```text
getomerch-cutover preflight
getomerch-cutover prepare --confirm-maintenance
getomerch-cutover go --confirm-writes
getomerch-cutover abort --confirm-abort
getomerch-cutover status
```

`prepare` оставляет приложение в `read_only`: делает финальные Supabase/KOMUI
backup, строит production candidate, проверяет приложение, Ozon и rollback
transaction, затем делает первый локальный backup/restore. `go` заранее
фиксирует `writesOpenedAt`, открывает записи и только после этого включает
worker и hourly timer. После `writesOpenedAt` простой abort программно запрещен.

## 3. Проверка на VPS

Проверены оба режима импорта на одном свежем Supabase archive:

- source rows: `6 621`;
- working tables: `20`;
- data integrity checks: `164`;
- migration: `0003`;
- source/target fingerprint:
  `8746fcd1d471c82bfc7192bf2e18b22dc2f5cc74a7a798161617d2accadde620`;
- необъясненных расхождений: `0`;
- свойства и OID баз KOMUI не изменились.

Production-target rehearsal временно заполнил неиспользуемую локальную БД, не
подключая к ней приложение. На ней успешно выполнены:

- backup `getomerch-database-backup-20260717T125149Z.tar.gz.gpg`;
- размер encrypted archive: `1 047 824` байта;
- off-site upload: `ok`;
- restore drill `20260717T125200Z`: `success`;
- migration, counts, integrity и role checks: `ok`.

После проверки прежняя пустая БД была возвращена атомарным rename, а тестовая
заполненная БД удалена. Повторный `getomerch-cutover preflight` завершился
успешно.

Дополнительно проверены:

- isolated maintenance smoke на VPS: reads/auth доступны, writes заблокированы;
- Ozon read-only connectivity: FBS list и prices API доступны;
- `https://admin.komui.ru/login`: HTTP `200`;
- `https://komui.ru`: HTTP `200`;
- `getomerch-admin.service`: `active`;
- worker: `inactive/disabled`;
- новый local DB backup timer: `inactive/disabled`;
- прежний Supabase backup timer: `active`;
- свободный диск после теста: около `5.0 GiB`.

## 4. Состояние после проверки

- production source of truth: Supabase;
- maintenance: `off`;
- `getomerch_production`: `0` пользовательских таблиц;
- cutover phase: `idle`;
- production writes в локальную БД: не открывались;
- worker и hourly timer не включались;
- KOMUI production/staging не переключались и не останавливались.

## 5. Обязательные гейты перед `prepare`

1. Назначить точные начало окна и ответственного за решение Go/No-Go.
2. Ротировать ранее засвеченный пароль Supabase DB и проверить обновленные
   server-side подключения.
3. Закрыть/заморозить локальный `GetoMerchV4` и legacy SKU scripts.
4. Повторить consumer/writer scan и убедиться, что нет параллельного writer.
5. На время окна не выполнять ручные изменения в Supabase/Ozon через старые
   инструменты.

Финальные Supabase, KOMUI и config backup, сверка данных и read-only smoke уже
встроены в `prepare`; выполнять их вручную параллельно не требуется.

## 6. Остаточные замечания

- `npm run build` проходит.
- Репозиторий пока не имеет готовой неинтерактивной ESLint-конфигурации;
  `npm run lint` предлагает первичную настройку. Это отдельный CI-gap.
- `npm audit --omit=dev` показывает две moderate transitive-находки текущего
  Next/PostCSS дерева. Автоматический force-fix не применялся, поскольку он
  меняет major-версии и требует отдельной regression-проверки.
