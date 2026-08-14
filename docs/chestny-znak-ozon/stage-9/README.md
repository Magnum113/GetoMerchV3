# Этап 9: signer и read-only ГИС МТ

Дата реализации: 4 августа 2026 года. Актуализировано: 13 августа 2026 года.
Статус: код и production-инфраструктура этапа завершены. Реальная attached
CAdES-BES подпись через Рутокен и auth-only production True API canary успешно
выполнены; unified token получен только в памяти worker. Все write-флаги
остались выключенными.
Подробный протокол:
[PRODUCTION_CANARY_2026-08-10.md](PRODUCTION_CANARY_2026-08-10.md). Инструкция
агента: [MAC_AGENT.md](MAC_AGENT.md).

## Что реализовано

- отдельный foreground signer на Mac без сетевого listener;
- аутентифицированный versioned-протокол по Unix socket;
- allow-list caller identity и единственный разрешённый purpose
  `crpt_auth_attached_cades_bes`;
- HMAC запроса и ответа, SHA-256 payload, временное окно и replay guard;
- provider adapter, запускающий защищённый CryptoPro executable без shell;
- проверка публичных метаданных сертификата: thumbprint, ИНН/ОГРН, срок и
  алгоритм ГОСТ 2012;
- True API challenge -> attached CAdES-BES -> unified token;
- token только в памяти marking-worker, single-flight refresh и один retry
  после HTTP 401;
- read-only проверка одного КМ через `cises/info` и документа через актуальный
  v4 `doc/{id}/info`;
- durable jobs, безопасная история проверок и ручная проверка при несовпадении
  GTIN/ИНН или неизвестном статусе ГИС МТ;
- marking-worker работает через `getomerch_jobs.marking_jobs`, пишет события
  только через проверяемую `append_marking_job_event` и не имеет доступа к
  общей очереди либо business-таблицам;
- вкладка `ГИС МТ` и команда проверки КМ из `Пул КМ`;
- migration/check `0013_marking_crpt_readonly.sql`;
- encrypted remote-signing broker `0014`, HMAC API и Mac relay;
- operational UI: Mac, Рутокен, PIN, сертификат, auth token и очередь;
- unit/security/PostgreSQL проверки этапа.

Этап не содержит заказа КМ, отчёта о нанесении, ввода/вывода из оборота или
любого другого write-запроса ГИС МТ. `GETOMERCH_MARKING_CRPT_WRITE_ENABLED`
остаётся `false`.

## Секреты и границы

Фактический ключ находится на Рутокене владельца, поэтому production-вариант
не переносит signer на VPS. Mac сам инициирует HTTPS к VPS, а локальный signer
остаётся за Unix socket. Подробная граница описана в [MAC_AGENT.md](MAC_AGENT.md).

Секреты разделены по четырём процессам:

- web на VPS получает marking keyring и отдельный `marking-agent-secrets` для
  HMAC endpoint; private key и local signer secret ему недоступны;
- marking-worker получает keyring и строку подключения выделенной DB-роли,
  создаёт зашифрованную broker-задачу и не получает agent credential;
- Mac relay получает agent secret и credential клиента локального signer, но
  не получает keyring, database URL или Ozon credentials;
- local signer получает allow-list локальных клиентов, публичные metadata
  сертификата и путь к `cryptcp`; сети и database URL у него нет.

После migrations `0013/0014` нужно повторно выполнить
`getomerch-marking-postgres-bootstrap`: worker получает только broker-функции
create/get/consume, а роль web — функции heartbeat/claim/complete/fail и safe
views. Полный КМ, challenge, подпись и token запрещены в job payload, read API,
`result_redacted`, journal и screenshots.

## True API contracts

Реализация опирается на официальный True API:

- `GET /api/v3/true-api/auth/key`;
- `POST /api/v3/true-api/auth/simpleSignIn` с attached CAdES-BES;
- `POST /api/v3/true-api/cises/info?pg=lp`;
- `GET /api/v4/true-api/doc/{docId}/info?pg=lp&body=false`.

Production base: `https://markirovka.crpt.ru`; sandbox base:
`https://markirovka.sandbox.crptech.ru`. Старый v3 document-info endpoint не
используется. Перед rollout контракт повторно сверяется с актуальной версией
официальной документации.

## Конфигурация

На VPS transport обязательно `remote`; CryptoPro и provider path в server env
не задаются:

```text
GETOMERCH_MARKING_ENABLED=true
GETOMERCH_MARKING_SIGNER_ENABLED=true
GETOMERCH_MARKING_CRPT_READ_ENABLED=true
GETOMERCH_MARKING_CRPT_WRITE_ENABLED=false
GETOMERCH_MARKING_CRPT_CONTOUR=sandbox
GETOMERCH_MARKING_CRPT_INN=<ИНН владельца/организации>
GETOMERCH_MARKING_ALLOWED_GTINS=<pilot GTIN-14>
GETOMERCH_MARKING_ALLOWED_ADMIN_IDS=owner
GETOMERCH_MARKING_SIGNER_TRANSPORT=remote
```

Web получает systemd credentials `marking-keyring` и
`marking-agent-secrets`. Worker получает `marking-keyring` и отдельный
`marking-database.env`. Agent secret не нужен worker и не должен добавляться в
его unit.

На Mac создаются два независимых HMAC secret и закрытый env:

```bash
ops/chestny-znak/init-mac-agent-credentials
```

Публичные metadata сертификата и Mac env имеют режим `0600`. Фактический
сертификат проверяется штатным ARM64 CryptoPro:

```bash
/opt/cprocsp/bin/certmgr -list -store uMy -thumbprint <THUMBPRINT>
```

Нужно сверить subject, ИНН/ОГРН, срок, ГОСТ 2012 и `PrivateKey Link: Yes`.
PIN не помещается в env или credential. Signer скрыто читает его один раз при
старте, хранит только в очищаемом буфере памяти процесса и передаёт каждому
`cryptcp -askpin` через stdin. При остановке или ошибке PIN буфер очищается.

## Systemd rollout

На VPS не запускается `getomerch-marking-signer.service`. Web получает
`getomerch-admin-marking-agent.conf`, worker —
`getomerch-marking-worker-remote-signer.conf`; nginx получает отдельные
`limit_req_zone` и exact location snippets. Полные команды, порядок
`nginx -t`, credential install и rollback приведены в [MAC_AGENT.md](MAC_AGENT.md).

На Mac signing-сессия запускается одной командой
`ops/chestny-znak/run-mac-signing-session`: relay работает в фоне, signer
остаётся foreground-процессом и один раз запрашивает PIN. Автозапуск через
launchd без интерактивной разблокировки не используется.

## Порядок canary

1. Backup и migrations `0013/0014`, затем `db:migrate:verify` и повторный
   `getomerch-marking-postgres-bootstrap`.
2. Установить server credential, remote worker drop-in и nginx snippets, не
   включая CRPT read/write.
3. Запустить foreground local signer и Mac relay, проверить heartbeat,
   Рутокен, срок сертификата и состояние PIN в UI.
4. Включить `CRPT_READ` на sandbox и выполнить одну физическую подпись через
   `Проверить авторизацию`.
5. Проверить status выделенного тестового КМ и документа без создания новых
   сущностей.
6. Переключить contour на production и повторить только read-only проверки.
7. Сверить результат с ЛК, проверить offline/извлечение Рутокена/ошибочный PIN
   и убедиться, что write flag по-прежнему `false`.

Любой mismatch GTIN/ИНН, неизвестный remote status или некорректный ответ не
должен открывать следующий шаг. Запрос остаётся в истории как `manual_review`
или `failed`.

## Ротация сертификата

1. Установить новый сертификат/контейнер на Mac и проверить его через
   `certmgr` под тем же пользователем, который запускает signer.
2. Сформировать новый metadata JSON с режимом `0600`.
3. Остановить Mac relay и signer, атомарно заменить metadata file.
4. Запустить signer и relay, проверить thumbprint/validity в UI и journal.
5. Перезапустить marking-worker, чтобы удалить старый token из памяти.
6. Выполнить sandbox или production read-only auth canary.
7. Старый сертификат сохранять в архиве согласно требованиям к юридически
   значимым документам; будущие документы этапа 10 хранят thumbprint подписи.

История проверок Stage 9 не зависит от private key. Ротация не переписывает
старые запросы.

## Проверки

```bash
npm run check:marking-stage9
npm run check:marking-mac-agent
npm run check:marking-mac-agent:db
npm run check:marking-security
npm run check:marking-stage9:db
npx tsc --noEmit
npm run build
```

## Остаточный rollout gate

- статус КМ и документа проверить после появления реального объекта: сейчас в
  production нет ни одного КМ и документа, фиктивные значения запрещены.

Egress challenge, nginx auth/rate-limit, offline/restart, срок сертификата,
физическая подпись, production auth и fail-closed flags проверены. Все
CRPT/Ozon/SUZ write-флаги остаются выключенными.
