# Этап 1: platform и security prerequisites

Дата завершения реализации: `2026-07-26`.

Статус: `реализован с flags off`. Production deployment не выполнялся.
Запросы записи в Ozon, ГИС МТ и СУЗ не выполнялись.

## Реализовано

### Fail-closed configuration

- все marking flags по умолчанию `false`;
- подчиненные flags требуют глобальный flag;
- операции с КМ требуют systemd credential или абсолютный keyring path;
- Ozon write требует offer allow-list и server-side Ozon credentials;
- CRPT/SUZ write требуют GTIN allow-list и signer;
- automation требует JIT, Ozon write и CRPT write;
- health возвращает только безопасные состояния и количество allow-list
  записей, но не их значения.

Основной модуль:
`src/lib/marking/config.ts`.

### Защита КМ и ключей

- рекурсивная redaction для CIS/КМ, GS1, crypto tail, PDF, подписей,
  signed body, токенов и ключей;
- очередь отклоняет payload, содержащий полный КМ или чувствительные поля;
- progress, result, event details и error message очищаются до сохранения;
- Ozon error body и общие admin/worker ошибки проходят ту же redaction;
- AES-256-GCM использует случайный 96-bit IV и 128-bit auth tag;
- HMAC-SHA-256 использует отдельный versioned key;
- ciphertext и fingerprint содержат key version;
- старые версии остаются доступными для чтения после ротации.

Основные модули:

- `src/lib/marking/security/redaction.ts`;
- `src/lib/marking/security/keyring.ts`;
- `ops/getomerch-marking-keyring-init`.

### Очередь и процессы

- зарегистрировано 14 будущих marking job types;
- обычный worker явно claim-ит только 5 core Ozon job types;
- marking worker этапа 1 имеет пустой active claim-list;
- marking worker и signer завершаются с ошибкой, если marking ошибочно
  включен до появления handlers;
- подготовлены отдельные systemd units с запрещенной сетью и строгим
  filesystem/process sandbox;
- signer не получает database URL.

### PostgreSQL

Миграция `0005_marking_job_contracts.sql`:

- расширяет `jobs_type_check`;
- создает updateable security-barrier view
  `getomerch_jobs.marking_jobs`;
- view содержит только разрешенные `marking_*` типы и защищена
  `WITH LOCAL CHECK OPTION`.

Bootstrap создает роль `getomerch_marking_worker`:

- `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT`,
  `NOREPLICATION`, `NOBYPASSRLS`;
- доступ только к `getomerch_production` и `getomerch_rehearsal`;
- `SELECT` и column-limited `UPDATE` только filtered view;
- нет чтения базовой `getomerch_jobs.jobs`;
- нет enqueue, INSERT в `job_events`, sequence grants или доступа к
  business tables;
- HBA явно запрещает подключение к `komui_production`.

Файл: `ops/getomerch-marking-postgres-bootstrap`.

## Проверки

Выполнено:

- `npm run check:marking-security`;
- `npm run build`;
- повторный security scan готового `.next`;
- `bash -n` для bootstrap/recovery scripts;
- `systemd-analyze verify` на production VPS;
- migration/check SQL на временной PostgreSQL БД;
- проверка updateable view и запрета перехода из marking type в core type;
- временный PostgreSQL 17 cluster на VPS для полного bootstrap/ACL теста;
- генерация временного keyring: mode `0600`, корректные 32-byte keys,
  запрет overwrite;
- запуск worker и signer с flags off;
- подтверждение fail-fast при ошибочном включении global flag.

Все временные БД, кластеры, keyring и файлы на VPS удалены после проверок.

Существующие integration checks `check:db-jobs`, `check:admin-bff`,
`check:db-repositories` и `check:db-mutations` локально не запускались до
конца, потому что требуют production database/auth environment.
`check:ozon-dry-run` намеренно не запускался: внешние Ozon вызовы запрещены
границами этапа 1.

## Операционные артефакты

- `ops/chestny-znak/README.md`;
- `ops/chestny-znak/marking-production.env.example`;
- `ops/chestny-znak/marking-keyring.example.json`;
- `ops/systemd/getomerch-marking-worker.service`;
- `ops/systemd/getomerch-marking-signer.service`;
- `ops/getomerch-marking-keyring-init`;
- `ops/getomerch-marking-postgres-bootstrap`.

## Deployment boundary

Эти изменения еще не применены к production admin:

- migration `0005` не применена к `getomerch_production`;
- отдельная DB роль и реальные keyring credentials не созданы;
- systemd units не установлены и не включены;
- все production feature flags остаются off.

Deploy выполняется отдельной операцией после review/commit. Миграция меняет
CHECK constraint очереди и требует короткий `ACCESS EXCLUSIVE` lock на
`getomerch_jobs.jobs`, поэтому до deployment проверяются размер таблицы,
активные jobs и отсутствие длительных транзакций.
