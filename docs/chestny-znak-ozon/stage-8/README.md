# Этап 8. Ozon exemplar adapter

Дата завершения программной части: 3 августа 2026 года.

Статус: реализовано и проверено локально с feature flags off. Миграция
`0012_marking_ozon_exemplars.sql` не применялась к production, реальные КМ и
реальные Ozon exemplar endpoints не вызывались.

## Что реализовано

- единый versioned contract Ozon для `create-or-get`, `validate`, `set`,
  `status` и `update` по snapshot этапа 0;
- revisioned full-posting batches и отдельный статус каждой физической
  единицы/assignment;
- строгое равенство количества active applied assignments, quantity Ozon и
  exemplar IDs;
- идемпотентное повторное действие: тот же assignment snapshot переиспользует
  batch, исправление создаёт superseding revision;
- durable jobs `marking_ozon_validate`, `marking_ozon_submit` и
  `marking_ozon_poll` в отдельном marking-worker;
- `set` считается только началом асинхронной обработки; accepted фиксируется
  исключительно после `ship_available`;
- при неопределённом сетевом результате после `set` worker сначала вызывает
  status и не повторяет передачу вслепую;
- частичный отказ, timeout и неизвестный статус сохраняются отдельно и не
  изменяют CRPT/physical state;
- API и действия `Проверить КМ в Ozon` / `Передать КМ в Ozon` в FBS-заказе и
  назначениях, плюс отдельная вкладка Ozon в разделе `Честный знак`;
- кнопка проверки появляется только после подготовки и физического нанесения
  КМ на все маркируемые единицы posting, а не на одну строку;
- для отклонённого, частично отклонённого, зависшего или отправленного на
  ручную проверку пакета предусмотрена явная correction revision из вкладки
  Ozon; PostgreSQL-ошибки этапа выводятся оператору понятными сообщениями.

## Безопасность

Полный КМ не помещается в job payload, обычный JSON, audit, response snapshot
или лог. Worker получает ciphertext через узкую `SECURITY DEFINER`-функцию,
расшифровывает КМ только перед вызовом Ozon и зануляет plaintext/ciphertext
buffers после операции. Для Ozon передаётся GS1 payload без scanner symbology
identifier `]d2`, с сохранением ASCII GS.

`create-or-get` считается потенциальной внешней мутацией и, как `set`, закрыт
глобальным flag, Ozon write flag и allow-list оператора, GTIN и offer ID.
Роль `getomerch_app` не имеет прямого доступа к двум base tables этапа.

## Проверки

- recorded sanitized fixtures официального Ozon Seller API;
- неизвестный remote status переводится в manual review;
- изолированная PostgreSQL 17: multi-unit quantity, idempotency, correction,
  partial rejection и ACL;
- штатный migrator `0001-0012` и `db:migrate:verify`;
- `check:marking-stage8`, общие security checks, TypeScript и production build.

## Что осталось до production

1. Завершить этапы 9-10, чтобы КМ получил подтверждённый статус ввода в оборот
   до `set`.
2. Выполнить отложенную официальную/физическую приёмку шаблона этикетки.
3. Применить миграции и настроить marking-worker только отдельным rollout.
4. Включить Ozon flag для одного allow-listed posting/GTIN/offer.
5. Выполнить canary `create-or-get`, затем validate, один `set` и сверить
   terminal status с кабинетом Ozon Seller.
6. До сверки не включать automation и shipping gate enforce.

Следующий этап разработки: этап 9, signer и read-only ГИС МТ.
