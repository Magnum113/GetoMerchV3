# Этап 5: защищенный пул КМ и импорт

Дата проверки: 13 августа 2026 года.
Статус: развернут в production. Первый контролируемый выпуск и импорт пяти
реальных КМ завершен с выключенным после операции import-флагом.

Отчет пилота:
[`PRODUCTION_PILOT_IMPORT_2026-08-13.md`](./PRODUCTION_PILOT_IMPORT_2026-08-13.md).

## Реализовано

Forward-only миграция
[`0009_marking_code_pool.sql`](../../../db/migrations/0009_marking_code_pool.sql)
добавляет:

- пакеты двухфазного импорта и безопасные строки preview;
- зашифрованный пул КМ;
- HMAC-алиасы всех активных версий ключей для дедупликации при ротации;
- состояния пула, карантин и контролируемое освобождение;
- append-only события по КМ;
- security-barrier views без ciphertext, nonce, auth tag, HMAC и serial;
- узкие `SECURITY DEFINER` команды для app role;
- очистку зашифрованного staging после apply и после истечения preview.

Полный КМ хранится только как AES-256-GCM envelope. В базе нет plaintext-поля
полного КМ. Дедупликация использует HMAC-SHA-256, а интерфейс и обычные API
показывают только GTIN, 12-символьный fingerprint и операционные состояния.

## Импорт

Поддерживаются TXT и одноколоночный CSV: один GS1 DataMatrix payload в строке.
Endpoint обрабатывает тело потоково, без временного plaintext-файла, с
ограничениями `2 MiB` и `5000` непустых строк.

Flow:

1. Администратор выбирает ожидаемый GTIN и файл.
2. Сервер проверяет GS1 AI `01`, `21`, `91`, `92`, GTIN и формат.
3. Валидный payload сразу шифруется в памяти и получает HMAC для каждой
   активной версии ключа.
4. Создается preview со статусами `valid`, `duplicate_file`,
   `duplicate_pool`, `gtin_mismatch` или `rejected`.
5. Отдельная команда apply атомарно переносит валидные строки в пул.
6. Staging envelope стирается сразу после apply. Не примененный preview живет
   24 часа и затем очищается maintenance timer.

Apply защищен идемпотентностью и database constraints. Два параллельных
импорта одного КМ создают ровно одну запись пула.

## Доступ

Импорт доступен только если одновременно:

- `GETOMERCH_MARKING_ENABLED=true`;
- `GETOMERCH_MARKING_IMPORT_ENABLED=true`;
- GTIN есть в `GETOMERCH_MARKING_ALLOWED_GTINS`;
- actor ID есть в `GETOMERCH_MARKING_ALLOWED_ADMIN_IDS`;
- web service получил versioned keyring через systemd credential.

УКЭП и приватный ключ signer-а web service не получает.

## API и интерфейс

Добавлены:

```text
POST /api/admin/marking/imports/preview
GET  /api/admin/marking/imports
GET  /api/admin/marking/imports/:id
POST /api/admin/marking/imports/:id/apply
GET  /api/admin/marking/pool
POST /api/admin/marking/codes/:id/quarantine
POST /api/admin/marking/codes/:id/release
```

Раздел `/marking` содержит вкладки `Пул КМ` и `Импорты`, preview расхождений,
явный apply и карточку карантина. Освобождение из карантина требует причины и
подтверждения уничтожения всех распечатанных копий.

## Очистка preview

[`scrub-marking-imports.ts`](../../../scripts/scrub-marking-imports.ts)
вызывает узкую database-функцию без доступа к полным КМ и пишет в журнал
только количество очищенных пакетов.

Production timer:

```text
getomerch-marking-import-scrub.service
getomerch-marking-import-scrub.timer
```

Он запускается каждые 15 минут и после пропущенного запуска (`Persistent=true`).

## Проверки

Пройдены:

- потоковый parsing с разрывами внутри GS1 payload;
- BOM, CRLF и quoted single-column CSV;
- поврежденный и слишком большой файл;
- дубли внутри файла, в существующем пуле и concurrent race;
- несовпадающий GTIN;
- точная расшифровка корректным keyring и отказ с посторонним;
- rollback apply transaction;
- HMAC-покрытие всех активных версий;
- запрет прямого чтения base tables ролью приложения;
- отсутствие crypto/serial в safe views, read API, UI, audit и events;
- карантин, optimistic revision и контролируемое освобождение;
- очистка просроченного staging;
- cursor pagination пула и импортов;
- полная миграционная проверка PostgreSQL 17 на заполненной временной БД.

## Не входит в этап 5

- резерв КМ под конкретный заказ;
- физические единицы, назначения и списание материалов;
- PDF/DataMatrix 58x40;
- записи в Ozon, ГИС МТ или СУЗ.

Production migration уже применена. 13 августа 2026 года пять КМ для GTIN
`04628837736075` успешно прошли preview/apply и находятся в пуле как
`available + emitted`; дублей и отказов нет. Ручной import-флаг после пилота
снова выключен. Следующий production-шаг выполняется в этапе 10.
