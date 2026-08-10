# Этап 10: нанесение и ввод КМ в оборот

Дата реализации: 4 августа 2026 года.

Статус: реализован и проверен локально с внешними feature flags `false`.
Миграция `0015_marking_crpt_introduction.sql` в production не применялась,
реальный документ в ГИС МТ не создавался.

## Реализованный flow

```text
оператор подтвердил «КМ нанесен»
  -> marking_crpt_application_submit
  -> проверка GTIN, владельца и состояния КМ
  -> immutable canonical LP_INTRODUCE_GOODS payload
  -> detached CAdES-BES через Mac signer
  -> POST /api/v3/true-api/lk/documents/create?pg=lp
  -> durable external document ID
  -> GET /api/v4/true-api/doc/{id}/info?pg=lp&body=false
  -> accepted/rejected/manual review
  -> отдельная проверка КМ через True API
  -> только после in_circulation физическая единица становится reserved
```

Для товарной группы `lp` worker не вызывает `/utilisation` и не создает
дублирующий отчет о нанесении. До ввода он проверяет результат автоматического
отчета по фактическому состоянию КМ. Сведения о РД в payload не отправляются и
не являются gate.

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

При `crpt_submit_outcome_unknown` UI требует сначала сверить документ в ЛК и
не показывает опасную кнопку автоматического повторного submit.

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
- ACL и отсутствие encrypted material в safe views.

## Что остается до rollout

1. Проверить detached подпись реальным сертификатом на Mac и официальный
   комплект проверки DataMatrix.
2. Сверить pilot GTIN, место деятельности и allow-lists.
3. Применить миграции отдельным production rollout с backup и flags off.
4. Выполнить один canary в доступном тестовом контуре либо на одном реальном
   КМ с ручной сверкой в ЛК.
5. Включать Ozon exemplar только после подтвержденного `in_circulation`.

Ворота этапа не считаются закрытыми для production, пока один pilot КМ не
получит подтвержденный статус `in_circulation` в ГИС МТ.

Официальный контракт: [True API](https://docs.crpt.ru/gismt/True_API/).
