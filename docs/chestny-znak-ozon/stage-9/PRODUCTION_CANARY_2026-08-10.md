# Production canary этапа 9

Дата: 10 августа 2026 года.
Статус: инфраструктурная часть завершена; физическая подпись заблокирована
просроченной лицензией CryptoPro CSP на Mac владельца.

## Что проверено

- до изменения конфигурации создана и выгружена зашифрованная резервная копия
  `getomerch_production`;
- migrations `0013` и `0014`, safe views и broker-функции присутствуют в
  production;
- marking-worker работает от отдельного пользователя и PostgreSQL-роли без
  `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION` и `BYPASSRLS`;
- установлен remote-signer systemd drop-in: worker имеет `AF_INET/AF_INET6`
  для исходящего True API, Mac-agent secret ему недоступен;
- server credential Mac-агента синхронизирован с локальным агентом, файлы на
  VPS имеют режим `0600`;
- nginx exact location принимает корректный HMAC-протокол, а анонимный запрос
  получает `401`; нагрузочная проверка получила `429` после исчерпания burst;
- worker получил `HTTP 200` и ожидаемый JSON-контракт challenge отдельно от
  sandbox и production True API;
- Mac-агент перед тестом показывал свежий `ready`: Рутокен обнаружен, Unix
  signer доступен, метаданные сертификата действительны;
- включены только `MARKING_ENABLED`, `SIGNER_ENABLED` и `CRPT_READ_ENABLED` в
  sandbox contour; CRPT/Ozon/SUZ write, ввод, вывод, возвраты и automation
  остались `false`;
- в production отсутствуют реальные КМ и документы ГИС МТ, поэтому status
  check для КМ/документа не подменялся фиктивными идентификаторами.

## Найденные и исправленные дефекты

1. На VPS отсутствовал remote-signer drop-in, из-за чего marking-worker имел
   только `AF_UNIX` и не мог выйти в True API.
2. В marking env отсутствовали ИНН, оператор и GTIN allow-list. Установлен
   `owner` и 131 GTIN опубликованных, проверенных карточек Национального
   каталога.
3. Server agent credential не совпадал с локальным. Credential заменен без
   вывода секрета и web-процесс перезапущен.
4. Unix client закрывал сокет через `end()` до асинхронного ответа signer.
   Отправка заменена на `write()`, добавлен реальный delayed Unix socket test.
5. После восстановления соединения Mac-агент сохранял старую transport
   ошибку. Добавлена очистка только восстановившихся connection errors.
6. Остановленный Mac-агент не переходил в `offline`, а UI продолжал показывать
   устаревшие данные Рутокена. Read model теперь считает heartbeat старше 15
   секунд offline; карточки Рутокена и signer учитывают отсутствие связи.
7. Ошибка лицензии CSP считалась общей повторяемой provider error. Добавлен
   отдельный `provider_license_expired`, без автоматических retry и с понятным
   сообщением в интерфейсе.

## Почему физический canary не завершен

Локальный вызов CryptoPro теми же аргументами, что использует signer,
завершился `License is expired` до запроса PIN. Подпись, unified token и
read-only status request не создавались. Закрытый ключ не покидал Рутокен.

Это внешний эксплуатационный блокер, а не флаг или ошибка True API. Обходить
лицензию либо сохранять PIN нельзя.

## Единственный обязательный следующий шаг

1. Получить действующий серийный номер CryptoPro CSP у Контура/CryptoPro.
2. На Mac активировать его без помещения в shell history или Git. Предпочтён
   штатный интерфейс CryptoPro; CLI-команда, если используется вручную:

   ```bash
   sudo /opt/cprocsp/sbin/cpconfig -license -set '<SERIAL>'
   /opt/cprocsp/sbin/cpconfig -license -view
   ```

3. Запустить foreground signer и Mac-agent по
   [MAC_AGENT.md](MAC_AGENT.md).
4. Выполнить sandbox canary:

   ```bash
   npm run marking:stage9:canary -- --contour=sandbox
   ```

5. После успешной подписи повторить auth-only canary в production contour.
6. Status КМ/документа проверять только после появления первого реального КМ
   или external document ID в production БД.

Canary-команда сама отказывается запускаться при любом включённом внешнем
write-флаге. До успешной авторизации signer и Mac-agent остановлены; server
read-only контур остается включенным, но fail-closed без доступного агента.

## Актуализация 13 августа 2026 года

Владелец установил действующую лицензию CryptoPro CSP. Описанный выше
лицензионный блокер снят, но сам физический canary после установки еще не
выполнялся. Следующий шаг начинается с пункта 3: запустить signer и Mac-agent,
выполнить sandbox canary, а после успешной подписи повторить auth-only canary
в production contour. Все внешние write-флаги остаются выключенными.
