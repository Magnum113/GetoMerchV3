# Отчет об этапе 10: production cutover

Дата: `2026-07-17`.

Статус: выполнен. Production source of truth переключён с Supabase на
локальную PostgreSQL БД `getomerch_production`.

## 1. Временная шкала

- `13:04:56 UTC` — финальный writer scan и preflight: параллельных writers нет;
- `13:05:12 UTC` — первая попытка `prepare` остановилась до backup/import из-за
  неэкранированной строки maintenance reason; автоматический rollback вернул
  Supabase, пустую production DB и прежние timers;
- commit `26284a9` — maintenance reason записывается shell-safe;
- `13:06:35–13:07:53 UTC` — успешный `prepare`;
- `13:08:27 UTC` — зафиксирован `writesOpenedAt`;
- `13:08:30 UTC` — web writes, worker и hourly backup timer открыты;
- `13:11 UTC` — первая реальная Ozon orders sync через production worker;
- `13:12:51 UTC` — post-write backup, затем успешный restore drill.

Первая ошибка не достигла импорта и local write-path. Это подтверждено
состоянием `phase=aborted`, пустой `getomerch_production`, активным Supabase
timer и успешным повторным preflight до второй попытки.

## 2. Финальный frozen source

- Supabase archive: `getomerch-backup-20260717T130637Z.tar.gz.gpg`;
- encrypted size: `1 237 298` байт;
- off-site upload: `ok`;
- source rows: `6 621`;
- working tables: `20`;
- migration version: `0003`;
- data integrity checks: `164`;
- source/target fingerprint:
  `8746fcd1d471c82bfc7192bf2e18b22dc2f5cc74a7a798161617d2accadde620`;
- unexplained differences: `0`;
- KOMUI boundary guard: `unchanged`.

Supabase не получает новых production writes и сохраняется неизменённым минимум
30 дней. Старый `getomerch-backup.timer` остановлен.

## 3. Проверки до Go

- все primary UI sections, auth, health/jobs и KOMUI prod/stage API: `ok`;
- bounded load: p95 `68 ms`, matrix p95 `18 ms`;
- maintenance: reads/auth доступны, writes возвращают `503`;
- Ozon FBS list: `163 ms`;
- Ozon prices: `65 ms`;
- rollback-only transaction: `ok`;
- local backup `20260717T130739Z`: encrypted, uploaded off-site;
- restore drill `20260717T130742Z`: 25 tables, migration/counts/integrity/roles
  `ok`.

## 4. Состояние после Go

- cutover phase: `live`;
- read source: `server`;
- write source: `server`;
- maintenance: `off`;
- `getomerch-admin.service`: `active`;
- `getomerch-worker.service`: `active/enabled`;
- `getomerch-database-backup.timer`: `active/enabled`;
- `getomerch-backup.timer`: `inactive`;
- production business tables: `20`;
- automatic Ozon sync timers: отсутствуют/выключены первые 24 часа;
- `admin.komui.ru` и `komui.ru`: HTTP `200`.

Post-cutover read smoke прошёл повторно: все 6 групп `ok`, p95 `71 ms`, matrix
p95 `27 ms`. Worker запустился без recovery и retry ошибок.

## 5. Первый production mutation

Первая ручная active-orders синхронизация прошла через durable queue:

- job: `962a9208-01a5-47f8-a830-c5645933b7e7`;
- status: `succeeded`;
- attempts: `1`;
- fetched: `66`;
- created: `8`;
- updated: `58`;
- unmatched items: `0`;
- duration: `499 ms`.

После этого простой rollback на Supabase недопустим: он потеряет восемь новых и
58 обновлённых order snapshots, а также queue/audit state.

## 6. Post-write backup

- archive: `getomerch-database-backup-20260717T131251Z.tar.gz.gpg`;
- encrypted size: `1 060 445` байт;
- off-site namespace: `s3://komui-backups/getomerch/database/hourly/`;
- upload: `ok`;
- restore drill `20260717T131254Z`: `success`;
- migration, counts, integrity и runtime roles: `ok`.

Commit `327477a` исключил наследование `komui/stage` prefix из общего S3 env;
новые GetoMerch DB backup всегда используют отдельный namespace.

## 7. Граница rollback

`writesOpenedAt=2026-07-17T13:08:27Z`. Команда pre-write `abort` теперь
программно запрещена. При проблемах допустимы только:

1. forward-fix приложения или локальной БД;
2. остановка writes через maintenance;
3. восстановление локального PostgreSQL backup;
4. отдельный data replay в Supabase с учётом всех записей после boundary.

Supabase нельзя снова назначать write-source простым изменением env.

## 8. Этап 11

На период стабилизации остаются обязательными:

- 24 часа повышенного контроля web/worker/PostgreSQL/disk;
- проверка первого автоматического hourly backup;
- ручные Ozon sync, автоматические timers пока не включать;
- сверка заказов и финансовых агрегатов;
- ежедневный invariant report первые 14 дней;
- ротация старого Supabase DB password после проверки legacy consumers;
- Supabase project и keys не удалять минимум 30 дней.
