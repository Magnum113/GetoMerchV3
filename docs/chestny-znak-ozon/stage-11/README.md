# Этап 11: shipping gate и дистанционный вывод

Дата реализации: 9 августа 2026 года.

Статус: реализован и проверен в изолированной PostgreSQL с внешними feature
flags `false`. Миграция `0016_marking_shipping_withdrawal.sql` в production не
применялась, реальный `LK_RECEIPT` в ГИС МТ не создавался.

## Рабочий flow

```text
оператор нажал «Передал Ozon» после фактической передачи FBS-заказа
  -> server-side shipping gate внутри складской транзакции
  -> списание готового товара и фиксация physical handover
  -> unit=shipped, custody=ozon, assignment=completed
  -> revisioned LK_RECEIPT с action=DISTANCE
  -> detached CAdES-BES через Mac signer
  -> True API create
  -> poll до accepted/rejected/manual review
  -> accepted: КМ=withdrawn
```

Создание заказа, печать, нанесение КМ, статус Ozon и синхронизация сами по себе
не являются фактом передачи. Единственный источник handover этапа 11 —
аудируемая операторская команда отгрузки в админке. Повтор команды не создаёт
вторую передачу или второй активный документ.
Новая передача принимает только gate, созданный тем же оператором и в рамках
того же server request.

## Shipping gate

Gate повторно вычисляется на сервере непосредственно перед изменением склада.
Для каждого required item проверяются:

- точное количество active assignments;
- unit `reserved`, active binding и физическое состояние `applied`;
- КМ `in_circulation`;
- принятый Ozon exemplar submission;
- статус posting `awaiting_packaging` или `awaiting_deliver`;
- одна verified location с КПП и ФИАС для всех единиц;
- положительная цена каждой единицы;
- отсутствие critical/manual-review процессов.

`enforce` откатывает всю транзакцию до изменения остатков. `observe` сохраняет
blockers и разрешает фактическую передачу; физические unit при этом всё равно
переходят в custody Ozon. Если безопасно построить withdrawal нельзя, создаётся
critical manual-review process, а принятие вывода не подделывается.

Предварительный индикатор в карточке заказа помогает оператору, но не заменяет
транзакционный gate. Для маркируемого заказа кнопка и confirm явно говорят о
фактической передаче Ozon и запуске дистанционного вывода.

## Документ вывода

Используется официальный ручной документ True API:

```text
type=LK_RECEIPT
action=DISTANCE
document_type=OTHER
product_cost=<цена в копейках>
```

Payload включает ИНН, дату передачи, номер posting, КПП, ФИАС и
`products[{cis, product_cost}]`. Состав сортируется детерминированно. Полные КМ,
payload и detached signature хранятся только зашифрованно и отсутствуют в safe
views, API JSON, job payloads и логах.

Состояния документа:

```text
draft -> payload_built -> signed -> submitting -> processing
  -> accepted | rejected | requires_manual_review
rejected/manual -> superseded -> новая revision
```

Неизвестный результат create получает `crpt_submit_outcome_unknown` и не
повторяется автоматически. Сначала требуется сверка в ЛК. Однозначно
отклонённый документ можно заменить исправленной ревизией.
После фактической передачи нельзя отменить ни submit, ни poll задания вывода:
ошибка или исчерпание попыток переводят процесс в ручную сверку.

## Срок и интерфейс

Handover сохраняет deadline не позднее третьего рабочего дня. Текущая версия
`weekday-conservative-v1` считает только понедельник-пятницу; перед production
rollout её нужно заменить или сверить с версионированным производственным
календарём РФ. Вкладка `Честный знак -> ГИС МТ` показывает:

- тип документа и revision;
- posting, offer ID, GTIN и fingerprint;
- handover time и deadline;
- document/withdrawal status и очищенную ошибку;
- просроченный неподтверждённый вывод как критический;
- безопасную кнопку исправленной ревизии.

## Данные

Миграция `0016` добавляет:

- `merch_marking_shipping_gate_evaluations`;
- `merch_marking_handovers`;
- `merch_marking_handover_units`;
- `merch_marking_withdrawal_confirmations`;
- связи withdrawal document с fulfillment order, handover и process;
- safe view `getomerch_marking.shipping_handover_safe`.

История gate/handover append-only. После handover обычный складской `unship`
запрещён: дальнейшее движение выполняется только возвратным flow этапа 12.

## Feature flags

```text
GETOMERCH_MARKING_WITHDRAWAL_ENABLED=false
GETOMERCH_MARKING_SHIPPING_GATE_MODE=observe
```

Для withdrawal также обязательны global marking, JIT, signer, CRPT read/write,
CRPT introduction, Ozon write и allow-lists GTIN/offer/admin. Все параметры
server-only. Worker не claim-ит withdrawal jobs при выключенном flag.

## Проверки

Пройдены:

- deterministic payload и `LK_RECEIPT/DISTANCE` contract test;
- Stage 6-10 marking regressions и security scan;
- clean migration `0001`-`0016`, повторный `up` и все SQL checks;
- параллельный JIT fixture этапа 6;
- gate observe/enforce, blocker до Ozon acceptance и разрешение после него;
- handover idempotency;
- цена `6700 руб. -> 670000 коп.`;
- `processing -> rejected -> superseded -> revision 2 -> accepted`;
- финальные `assignment=completed`, `unit=shipped`, `custody=ozon`,
  `code=withdrawn`;
- ACL и отсутствие ciphertext в safe view;
- привязка gate к actor/request и запрет отмены submit/poll lifecycle.

## До production rollout

1. Завершить реальные canary этапов 9-10: Mac signer, True API и один
   подтверждённый `in_circulation` КМ.
2. Заполнить и проверить КПП/ФИАС места передачи.
3. Применить migration с backup и всеми новыми flags off.
4. Сначала сравнить `observe` с реальными заказами, затем включить `enforce`
   только для pilot allow-list.
5. Выполнить один реальный handover и вручную сверить `LK_RECEIPT` и состояние
   КМ в ЛК.
6. Перед автоматизацией возвратов провести production canary реализованного
   этапа 12 по [stage-12/README.md](../stage-12/README.md).

Официальный контракт: [True API](https://docs.crpt.ru/gismt/True_API/).
