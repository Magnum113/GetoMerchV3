# Отчёт по этапу 8: Ozon sync/import и фоновые задания

Дата завершения: `2026-07-17`.

Основной план:
`docs/ADMIN_FULL_SERVER_MIGRATION_PLAN.md`.

## 1. Итог

Этап 8 завершён на изолированном серверном контуре. Ozon orders, finance,
prices и import получили серверные service-реализации, durable PostgreSQL-
очередь и отдельный worker. Долгая операция больше не зависит от жизни одного
HTTP-соединения: route ставит job в очередь, UI опрашивает её состояние, а
worker забирает задания через `FOR UPDATE SKIP LOCKED`.

Production cutover не выполнялся:

- `admin.komui.ru` продолжает читать и писать текущий Supabase;
- production Ozon routes сохраняют прежний синхронный Supabase fallback;
- `/etc/getomerch/database.env` не подключён к production unit;
- `getomerch-worker.service` подготовлен, но не установлен и не включён;
- `getomerch_production` остаётся пустой;
- KOMUI production/staging и `/opt/komui` не изменялись.

## 2. Durable queue

Migration `db/migrations/0003_background_jobs.sql` добавляет приватную схему
`getomerch_jobs`:

- `jobs` хранит type, status, payload, result, progress, attempts, lock,
  heartbeat, cancellation и безопасную ошибку;
- `job_events` хранит журнал переходов без cookie, API keys и DB URL;
- частичный unique index запрещает две активные job одного типа и
  `dedupe_key`;
- уникальный `idempotency_key` и SHA-256 `request_hash` защищают повторный
  enqueue;
- terminal jobs очищаются только явной функцией и не раньше чем через 7 дней;
- `getomerch_app` имеет только необходимые runtime grants, backup-role —
  read-only доступ.

Поддерживаются пять типов заданий: orders, finance, prices, import preview и
import apply. Job claim, heartbeat, progress, retry, cancellation, recovery
stale worker и retention реализованы в `src/lib/jobs`.

Зеркальная migration для переходного dual-DDL контура добавлена в
`supabase/migrations/20260717120000_getomerch_background_jobs.sql`, но к
production Supabase не применялась.

## 3. Worker и авторизация

Worker запускается из `scripts/getomerch-worker.ts`, использует отдельный
маленький PostgreSQL pool и корректно обрабатывает SIGTERM/SIGINT. При
остановке незавершённая job возвращается в очередь; потерянный heartbeat
восстанавливается с ограничением attempts.

Подготовлены unit-файлы:

- `ops/systemd/getomerch-worker.service`;
- `ops/systemd/getomerch-worker-rehearsal.service`.

Внутренний worker обращается только к пяти точным Ozon route через Bearer token
`GETOMERCH_INTERNAL_SERVICE_TOKEN`. Middleware и сам route независимо
проверяют token constant-time. Остальные admin API по-прежнему требуют signed
admin cookie; token не расширяет доступ ко всей админке.

## 4. Ozon service layer

Добавлен общий Ozon client с timeout/AbortSignal, учётом `Retry-After`,
санитизированными ошибками и bounded retry только для `408`, `429`, `5xx` и
временных сетевых сбоев. Validation и бизнес-ошибки не ретраятся.

Сервис orders выполняет:

- полную pagination FBS и FBO;
- обновление stale/cancelled FBS, исчезнувших из active list;
- сопоставление SKU/legacy SKU на сервере;
- атомарный upsert order и замену items;
- сохранение `source=fbs|fbo`;
- запрет складского fulfillment для FBO;
- dry-run без записи.

Finance синхронизируется 28-дневными окнами с pagination по `page_count`,
дедупликацией и идемпотентным upsert. Prices используют cursor pagination и
обновляют товары по Ozon SKU или legacy SKU. Import preview строится
server-side, а apply использует атомарную транзакцию этапа 7; результат job
хранит только `runId` и summary, а подробности читаются отдельным API.

На server write-source Ozon route возвращает `202` и job descriptor. Клиентский
`src/lib/api.ts` прозрачно опрашивает job и сохраняет существующий UX. На
Supabase write-source остается прежнее синхронное поведение до cutover.

## 5. Серверная проверка

Проверочный release:
`/opt/getomerch/rehearsals/stage8-20260717T085113Z`.

Постоянная `getomerch_rehearsal` обновлена до migrations `0001`–`0003`.
Проверены 18 baseline schema checks, 164 data checks, 10 mutation checks и 13
job checks, включая сверку всех 13 constraints и 8 indexes job-схемы.

На disposable БД и процессе успешно пройдены 10 групп job/integration tests:

1. validation, admin/service auth и cancellation;
2. enqueue idempotency и active dedupe;
3. конкурентный claim двумя workers;
4. Ozon network retry и следующий job attempt;
5. stale/cancelled refresh и атомарная замена order items;
6. FBS pagination, FBO source и отсутствие дублей при replay;
7. finance pagination, replay idempotency и dry-run;
8. prices cursor pagination и update;
9. import preview detail и atomic apply;
10. stale heartbeat recovery и retention prune.

Реальный Ozon API проверен только в dry-run на disposable candidate:

- active orders: `65` позиций;
- prices: `154` товара;
- finance: `84` операции;
- import preview: `154` товара.

Fingerprints orders, finance и products до/после совпали: production Ozon
write не выполнялся. Read regression прошёл 8/8 групп; последняя повторная
проверка постоянного strict-shadow rehearsal дала p95 `400 ms` для обычных API
и `150 ms` для matrix.

## 6. Эксплуатационное состояние

- Symlink `/opt/getomerch/rehearsals/current` указывает на stage-8 release.
- Rehearsal service активен только на `127.0.0.1:3101`, без nginx route;
  persistent write-source остаётся `supabase`.
- Production release не менялся:
  `/opt/getomerch/releases/20260716T095237Z-admin-091ce3f850b6`.
- Production worker отсутствует и не запущен.
- Disposable process, HBA rule, env и test DB удалены; порт `3102` закрыт.
- Канонический migration bundle расположен в
  `/usr/local/lib/getomerch/database` и содержит `0001`–`0003`.
- Старые stage5–stage7 rehearsal releases удалены по retention; на диске
  осталось около `5.9 GiB`, использование около `69%`.

Во время проверки исправлены расхождения SQL checks, service-token boundary в
middleware, выбор канонического migration bundle bootstrap-скриптом, ACL
приватных схем и lockfile для чистого серверного `npm ci`.

## 7. Exit criteria

Критерий этапа выполнен: повторные sync не создают дублей, cancelled orders
обновляются, полная pagination проверена, FBO не меняет внутренний склад, а
progress/retry/cancellation переживают завершение HTTP-запроса и потерю worker.

Следующий этап — этап 9: построить свежую candidate БД из нового export,
повторить полный автоматический и ручной regression, проверить backup/restore
и провести отдельную rollback rehearsal без переключения production.
