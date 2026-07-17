# Отчет по этапу 3: изолированный PostgreSQL-контур

Дата выполнения и проверки: `2026-07-16`.

Связанные документы:

- `docs/ADMIN_FULL_SERVER_MIGRATION_PLAN.md`;
- `docs/ADMIN_FULL_SERVER_MIGRATION_STATUS.md`;
- `docs/ADMIN_MIGRATION_STAGE_2_REPORT_2026-07-16.md`;
- `db/README.md`.

## 1. Результат

Этап 3 завершен. На VPS создан отдельный PostgreSQL-контур GetoMerch, который
не использует базы и роли KOMUI:

- постоянная rehearsal-база `getomerch_rehearsal` построена из Git и содержит
  baseline `0001`;
- создана пустая `getomerch_production`, но данные в нее не импортированы;
- созданы четыре роли с разделенными правами;
- доступ ограничен локальными HBA-правилами;
- добавлены отдельные root-only env-файлы и DB healthcheck;
- конфигурация включена в зашифрованный backup;
- production-админка не переключалась и продолжает работать с Supabase.

Этот этап не является data migration или cutover. Первое наполнение данными
выполняется только в `getomerch_rehearsal` на этапе 4.

## 2. Фактическая топология

```text
getomerch-admin.service
  -> /etc/getomerch/admin-production.env
  -> Supabase production (текущий runtime, без изменений)

PostgreSQL 17 на VPS, только 127.0.0.1 / ::1
  getomerch_rehearsal
    owner: getomerch_owner
    schema migration: 0001
    data: пустой baseline
  getomerch_production
    owner: getomerch_owner
    schema migration: none
    data/schema: пустая целевая БД

komui_production / komui_staging
  -> существующий независимый контур KOMUI
```

В env текущего процесса `getomerch-admin.service` локальный
`GETOMERCH_DATABASE_URL` отсутствует. Создание целевых БД не меняет маршруты
чтения или записи приложения.

Текущий Next.js database layer начнет потреблять нейтральный target env только
на этапе 5. Поэтому test-env criterion этого инфраструктурного этапа проверен
отдельным server-side healthcheck под `getomerch_app`; запуск Next.js против
rehearsal повторяется после появления database/service layer.

## 3. Роли и права

| Роль | LOGIN | Назначение | Права |
|---|---:|---|---|
| `getomerch_owner` | нет | владелец схемы и объектов | DDL; не используется приложением |
| `getomerch_migrator` | да | отдельный migration runner | `NOINHERIT`, может `SET ROLE getomerch_owner` |
| `getomerch_app` | да | будущий runtime приложения | `SELECT/INSERT/UPDATE/DELETE`, без DDL |
| `getomerch_backup` | да | backup/проверки | только чтение |

Все login-роли имеют `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`,
`NOREPLICATION`, `NOBYPASSRLS` и ограничение числа подключений. Настроены
`application_name`, `statement_timeout`, `lock_timeout` и
`idle_in_transaction_session_timeout`.

Единственное membership между новыми ролями:

```text
getomerch_migrator -> getomerch_owner
  inherit: false
  set: true
  admin: false
```

Объекты rehearsal-схемы принадлежат `getomerch_owner`, а не login-роли.
Проверено:

- `getomerch_app` имеет CRUD на 20 рабочих таблицах;
- `getomerch_app` не имеет `CREATE` на базе или schema `public`;
- `getomerch_backup` имеет `SELECT` на 20 таблицах и не имеет write-прав;
- default privileges сохраняют эту модель для следующих миграций.

## 4. Изоляция HBA

Установлен отдельный include:

```text
/etc/postgresql/17/main/pg_hba_getomerch.conf
```

Он подключен в начале `/etc/postgresql/17/main/pg_hba.conf`, до общих правил.
Правила разрешают ролям GetoMerch SCRAM-подключение только:

- по Unix socket;
- с `127.0.0.1/32`;
- с `::1/128`;
- только к `getomerch_rehearsal` и `getomerch_production`.

Все подключения ролей GetoMerch к другим БД отклоняются до общих HBA-правил.
Роли `komui_app`, `komui_migrator`, `komui_backup` отдельно отклоняются от
целевых БД GetoMerch. Для новых БД также отозван `PUBLIC CONNECT`.

ACL существующих баз KOMUI намеренно не менялся: изоляция GetoMerch -> KOMUI
обеспечена ранним HBA `reject`. Проверены реальные подключения:

```text
komui_app -> getomerch_production: blocked
getomerch_app -> komui_production: blocked
getomerch_migrator -> komui_production: blocked
getomerch_backup -> komui_production: blocked
```

PostgreSQL не перезапускался. Применялся только `pg_reload_conf()`. Все девять
GetoMerch HBA-правил загружены без ошибок.

## 5. Server env и секреты

Созданы root-owned файлы с правами `0600`:

| Файл | Назначение |
|---|---|
| `/etc/getomerch/database-credentials.env` | сгенерированные пароли новых DB-ролей |
| `/etc/getomerch/database.env` | app-role для будущей production БД |
| `/etc/getomerch/database-rehearsal.env` | app-role для rehearsal |
| `/etc/getomerch/migrator-production.env` | migrator для production |
| `/etc/getomerch/migrator-rehearsal.env` | migrator для rehearsal |
| `/etc/getomerch/database-backup.env` | read-only роль production |
| `/etc/getomerch/database-backup-rehearsal.env` | read-only роль rehearsal |

URL и пароли не выводятся в логи, отчеты или process arguments. Имена новых
server-only URL дополнительно внесены в scanner клиентского bundle deploy-
скрипта. Эти файлы пока не подключены к systemd unit production-админки.

## 6. Добавленные артефакты

### В репозитории

- `ops/getomerch-postgres-bootstrap` — идемпотентное создание ролей, HBA,
  env-файлов, rehearsal и пустой production БД;
- `ops/getomerch-db-healthcheck` — `SELECT 1`, проверка имени БД и версии
  migration ledger без печати URL;
- `db/scripts/migrate.mjs` — поддержка нейтрального SSL env и безопасного
  `SET ROLE getomerch_owner`;
- `ops/getomerch-backup` — архивирование нового DB-контура;
- `ops/getomerch-deploy-from-git` — запрет утечки новых DB URL в клиентский
  bundle.

### На сервере

```text
/usr/local/sbin/getomerch-postgres-bootstrap
/usr/local/sbin/getomerch-db-healthcheck
/usr/local/lib/getomerch/database/db/
/usr/local/lib/getomerch/database/node_modules -> /opt/getomerch/current/node_modules
```

Fallback bundle позволяет выполнять migration runner до следующего deploy,
не изменяя активный release приложения.

## 7. Проверки

### Rehearsal

- PostgreSQL: `17.10`;
- baseline: `0001_getomerch_baseline.sql`;
- таблиц `public`: `20`;
- schema checks: `18/18` успешно;
- повторный запуск bootstrap: успешно, pending migrations нет;
- healthcheck:
  `database=getomerch_rehearsal role=getomerch_app select_1=ok migration_version=0001`.

### Production target

- БД существует и принадлежит `getomerch_owner`;
- пользовательских таблиц: `0`;
- migration ledger отсутствует;
- healthcheck:
  `database=getomerch_production role=getomerch_app select_1=ok migration_version=none`.

Пустое состояние production является обязательным результатом этапа 3. Ни
baseline, ни snapshot данных туда до production rehearsal/cutover не
применяются.

### Сервисы и границы

- `getomerch-admin.service`: active;
- `getomerch-backup.timer`: active;
- PostgreSQL: active;
- `https://admin.komui.ru/login`: HTTP `200`;
- `https://komui.ru`: HTTP `200`;
- production BFF: Ozon orders возвращает `200`;
- production BFF: `/api/admin/inventory?limit=10` возвращает известный `500`
  текущего Supabase read-path; дефект существовал до этапа 3 и остается
  отдельным gate до приемки read-path;
- start time PostgreSQL не менялся во время этапа;
- характеристики ролей и БД `komui_*` до и после bootstrap совпали.

### Backup и восстановление

После установки контура создан свежий зашифрованный архив:

```text
/var/backups/getomerch/daily/getomerch-backup-20260716T161625Z.tar.gz.gpg
```

Он успешно проверен и выгружен в off-site Object Storage. Restore drill
`restore-drill-20260716T161653Z.txt` завершился успешно за 5 секунд:

- восстановлены 20 рабочих таблиц;
- counts совпали;
- 6 business invariants прошли;
- временная БД удалена.

Backup включает DB env, HBA include, bootstrap/healthcheck и fallback migration
bundle только внутри зашифрованного архива.

## 8. Эксплуатационные нюансы

- Строка `include_if_exists` в PostgreSQL 17 должна содержать путь без одинарных
  кавычек. Bootstrap удаляет старый вариант и ставит корректный include.
- Нельзя `source` произвольные production env KOMUI для аудита: значения могут
  содержать shell-символы. Проверки границ должны разбирать env как данные и не
  печатать значения.
- Пароли ролей не ротируются при обычном повторном bootstrap. Ротация требует
  явного `GETOMERCH_ROTATE_DATABASE_PASSWORDS=true`.
- Bootstrap не рестартует PostgreSQL или приложения и проверяет неизменность
  свойств ролей/БД `komui_*`.
- `getomerch_production` нельзя наполнять вручную до предусмотренного планом
  production rehearsal и cutover.

## 9. Следующий этап

Этап 4 должен работать только с `getomerch_rehearsal`:

1. Получить согласованный allowlist snapshot 20 таблиц Supabase.
2. Пересоздать rehearsal из baseline `0001`.
3. Импортировать данные с сохранением UUID.
4. Выполнить `ANALYZE`, schema checks, counts, PK checksums, FK и business
   invariants.
5. Сохранить машинный отчет без секретов.
6. Не изменять `getomerch_production` и runtime production-админки.
