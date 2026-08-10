# Этап 13: СУЗ API и управляемое пополнение пула КМ

Дата реализации: 10 августа 2026 года.

Статус: реализован локально и проверен на чистой изолированной PostgreSQL.
Миграция `0018_marking_suz_orders.sql` в production не применялась, реальные
заказы КМ не создавались, `GETOMERCH_MARKING_SUZ_WRITE_ENABLED=false`.

## Рабочий flow

```text
прогноз по verified GTIN
  -> внутренний draft
  -> явное подтверждение оператора
  -> detached CAdES-BES точного JSON через Mac signer
  -> POST /api/v3/order
  -> polling статуса заказа
  -> сверка ранее выданных блоков
  -> получение недостающего блока КМ
  -> существующий AES-256-GCM/HMAC import pipeline
  -> pool_state=pending_utilisation
  -> поиск квитанции REPORT_UTILIZE
  -> SUCCESS + code=0 + точное совпадение количества
  -> pool_state=available
```

Для легкой промышленности во внешний контракт отправляются `productGroup=lp`,
`templateId=10`, `serialNumberType=OPERATOR`, `cisType=UNIT`,
`releaseMethodType=PRODUCTION` и `createMethodType=SELF_MADE`. Внутреннее
значение группы товара остается `clothes`; смешивать эти два справочника
нельзя.

## Безопасность и идемпотентность

- полный КМ проходит только через существующий защищенный import pipeline и
  хранится зашифрованным;
- API, safe views, job payloads, аудит и UI не возвращают полный КМ, подпись,
  `clientToken` или закрытый ключ;
- точные байты тела заказа подписываются detached CAdES-BES до отправки;
- приватный ключ остается на Рутокене и доступен только Mac signer-агенту;
- повтор HTTP-команды approval возвращает ранее сохраненный результат и не
  ставит второй submit job;
- один открытый заказ на GTIN и production mode защищен partial unique index;
- timeout после начала `POST /order` считается неизвестным результатом:
  автоматический повтор создания запрещен, заказ переводится в
  `manual_review`;
- `GET /codes` имеет побочный эффект выдачи блока. После неоднозначного ответа
  worker сначала получает список уже созданных блоков и повторно читает блок
  по `blockId`; слепой запрос нового блока запрещен;
- несовпадение OMS, GTIN, order ID, блока, количества или квитанции закрывает
  автоматизацию и создает ручную сверку.

## Прогноз пула

Safe view `getomerch_marking.suz_pool_forecast_safe` считает по каждому
verified GTIN:

- `available` и `pending_utilisation`;
- активную потребность FBS;
- фактический расход за настраиваемое окно;
- запас на lead time;
- уже заказанное, но еще не доступное количество;
- рекомендуемое количество с учетом minimum, target и лимита заказа.

Настройки minimum/target, lead time, окна среднего расхода и лимита заказа
версионируются optimistic lock. Forecast не создаёт внешний заказ сам:
автоматизация остается отдельным rollout-шагом, а первая версия требует
ручного draft и approval.

## Состояния и данные

Миграция `0018` добавляет:

- pool policy в `merch_marking_trade_items`;
- `merch_marking_code_orders` и `merch_marking_code_order_items`;
- связь полученного КМ с item заказа СУЗ;
- состояние пула `pending_utilisation`;
- безопасные прогноз и список заказов;
- узкие `SECURITY DEFINER` transitions без DML-доступа приложения к базовым
  таблицам;
- signer purpose `crpt_suz_order_detached_cades_bes`.

Основной lifecycle:

```text
draft -> approved -> submitting -> submitted -> ready -> receiving
  -> awaiting_utilisation -> completed

terminal exceptions: rejected | manual_review | cancelled
```

Полученный код не считается выпущенным и не резервируется FBS-заказу, пока
автоматический `REPORT_UTILIZE` не имеет `state=SUCCESS`, `code=0`, а
`processed`, `total`, requested, received и ingested количества не совпадают.

## Интерфейс и API

В разделе `Честный знак` добавлена вкладка `Заказы КМ`:

- прогноз и предупреждение о низком пуле;
- редактирование политики GTIN;
- создание draft с расчетным или ручным количеством;
- отдельное подтверждение отправки;
- статусы заказа, выдачи блока и квитанции;
- безопасные ошибки и действия `Проверить`/`Отменить`.

Endpoint `/api/admin/marking/suz` использует admin session, marking mutation
context, request ID и idempotency key. Длительные внешние вызовы выполняет
только отдельный marking worker.

## Server-only настройки

```env
GETOMERCH_MARKING_SUZ_WRITE_ENABLED=false
GETOMERCH_MARKING_SUZ_OMS_ID=
GETOMERCH_MARKING_SUZ_OMS_CONNECTION=
```

Для write также обязательны global marking, secure import, signer, allow-list
GTIN и allow-list операторов. OMS ID и connection нельзя передавать в
`NEXT_PUBLIC_*`, клиентский bundle или логи.

## Проверки

Пройдены:

- официальный SUZ API 3.0 request/response contract и динамический
  `clientToken` через `/auth/simpleSignIn/{omsConnection}`;
- exact-body detached signature и новый signer purpose;
- неизвестный результат create/codes и recovery по списку блоков;
- clean migration `0001`-`0018` и все SQL checks;
- forecast, optimistic lock политики и один open order на GTIN;
- draft -> approved -> submitted -> ready;
- secure ingestion без plaintext и `pending_utilisation` до квитанции;
- успешный `REPORT_UTILIZE` переводит ровно заказанные КМ в `available`;
- ACL: app не читает базовые SUZ-таблицы, safe views не содержат ciphertext;
- TypeScript, marking regressions, security scan и production build.

## До production rollout

1. Сначала выполнить реальные canary этапов 9-12, включая физическую подпись,
   True API и один подтвержденный полный FBS lifecycle.
2. Получить production OMS ID/connection из настроек СУЗ и хранить их только в
   server env/systemd credentials.
3. Применить migration `0018` с SUZ write flag `false`, проверить backup и
   read-only forecast.
4. Согласовать minimum/target и лимит только для одного allow-listed GTIN.
5. В sandbox выполнить один ручной draft/approval и сверить заказ, блок и
   `REPORT_UTILIZE` в ЛК.
6. В production заказать минимально допустимое платное количество и вручную
   сверить число доступных КМ.
7. Только после стабильной серии сверок разрешать автоматическое создание
   draft; автоматический approval/submit не включать на первом rollout.

Официальный контракт этапа зафиксирован локальным защищенным snapshot SUZ API
3.0 от 24 июля 2026 года. Документ из авторизованного ЛК и его sanitised
fixtures не публикуются в Git.
