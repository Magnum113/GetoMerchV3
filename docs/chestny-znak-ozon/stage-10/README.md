# Этап 10: нанесение и ввод КМ в оборот

Дата актуализации: 14 августа 2026 года.

Статус: развернут; первый production canary завершился инцидентом и не закрыл
этап. Детали: [PRODUCTION_CANARY_2026-08-14.md](PRODUCTION_CANARY_2026-08-14.md).

## Реализованный flow

```text
оператор подтвердил «КМ нанесен»
  -> marking_crpt_application_submit
  -> проверка GTIN, владельца и состояния КМ
  -> immutable canonical LP_INTRODUCE_GOODS payload
  -> detached CAdES-BES через Mac signer
  -> POST /api/v3/true-api/lk/documents/create?pg=lp
  -> durable external document ID
  -> GET /api/v4/true-api/doc/{id}/info?pg=lp&body=false&content=false
  -> accepted/rejected/manual review
  -> отдельная проверка КМ через True API
  -> только после in_circulation физическая единица становится reserved
```

Для товарной группы `lp` worker не вызывает `/utilisation` и не создает
дублирующий отчет о нанесении. До ввода он проверяет результат автоматического
отчета по фактическому состоянию КМ. Проверенные вид, номер и дата РД
передаются в `products[].certificate_document_data`. Без них worker переводит
документ в manual review до подписи и внешнего submit.

## Данные и защита

Миграция добавляет:

- `merch_marking_documents` — ревизии юридически значимых документов;
- `merch_marking_document_codes` — состав и результат по каждой единице;
- `merch_marking_document_confirmations` — отдельный факт подтверждения
  `in_circulation` после принятия документа;
- safe views `getomerch_marking.document_safe` и
  `getomerch_marking.document_code_safe`.

Полный КМ, canonical payload и detached signature хранятся зашифрованно.
Safe views, UI, job payloads и события содержат только GTIN, fingerprint,
digest, внешний ID и очищенные статусы/ошибки.

Pipeline документа:

```text
draft -> payload_built -> signed -> submitting -> processing
  -> accepted | rejected | requires_manual_review
rejected/manual -> superseded -> новая revision
```

Принятие документа и состояние КМ разделены:

```text
document.status = accepted
confirmation.circulation_state = pending | confirmed | requires_manual_review
```

Неизвестный результат create-запроса получает
`crpt_submit_outcome_unknown`. Такой документ нельзя автоматически заменить
новой ревизией: сначала нужна сверка в личном кабинете, иначе возможен дубль.
Если worker перезапустился после перехода в `submitting`, он не повторяет POST,
а переводит документ в ту же ручную сверку.

## Интерфейс

Во вкладке `Честный знак -> ГИС МТ` показаны:

- готовность Mac-агента, Рутокена, signer и авторизации;
- отдельные флаги чтения, записи и ввода в оборот;
- заказ, offer ID, GTIN и fingerprint каждого документа;
- ревизия, внешний ID, status документа и подтверждение `in_circulation`;
- очищенная причина отклонения или ручной проверки;
- создание исправленной ревизии для однозначно отклоненного документа;
- повторная проверка КМ для принятого документа без подтвержденного оборота.

При `crpt_submit_outcome_unknown` UI позволяет указать внешний ID и выполняет
read-only сверку через изолированный marking-worker. Веб-процесс только ставит
задание в durable queue и не имеет права выполнять DB-функцию привязки.
Привязка разрешена только при совпадении типа, товарной группы, ИНН и SHA-256
исходного содержимого документа; автоматический повторный submit до сверки
запрещён. UI обновляет результат фонового задания каждые 10 секунд.

## Feature flags

Новый отдельный gate:

```text
GETOMERCH_MARKING_CRPT_INTRODUCTION_ENABLED=false
```

Для значения `true` также обязательны global marking, JIT, signer, CRPT read,
CRPT write и allow-lists GTIN/offer/admin. Все значения server-only.

## Проверки

Пройдены:

- `npx tsc --noEmit`;
- `npm run check:marking-stage10`;
- чистая rehearsal миграций `0001`-`0015` на временной PostgreSQL;
- повторный migration `up` и все SQL checks;
- транзакционный DB-сценарий
  `rejected -> superseded -> revision 2 -> accepted -> in_circulation`;
- повторный terminal poll и повторное confirmation без второго события;
- ACL и отсутствие encrypted material в safe views;
- миграция `0022`: `getomerch_app` не может выполнить reconciliation,
  `getomerch_marking_worker` может;
- сверка одинакового raw/Base64 content по одному SHA-256 и отказ при mismatch.

## Что остается до rollout

1. Получить и проверить применимый РД для пилотного товара.
2. Провести новый canary на свежем FBS-заказе до физической передачи Ozon.
3. Подтвердить `in_circulation`, затем выполнить Ozon set/status.
4. Проверить DataMatrix официальным комплектом разработчика и на принтере.
5. Только после этого переходить к дистанционному выводу и возвратам.

Ворота этапа не считаются закрытыми для production, пока один pilot КМ не
получит подтвержденный статус `in_circulation` в ГИС МТ.

Официальный контракт: [True API](https://docs.crpt.ru/gismt/True_API/).
