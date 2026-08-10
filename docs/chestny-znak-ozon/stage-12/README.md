# Этап 12: возвраты и FBS -> FBO

Дата реализации: 10 августа 2026 года.

Статус: основной контур реализован локально и проверен на чистой изолированной
PostgreSQL. Миграция `0017_marking_returns_fbo.sql` в production не применялась,
синхронизация возвратов Ozon и запись `LP_RETURN` выключены feature flags.

## Границы этапа

Этап обрабатывает возвраты только для сериализованной единицы, которая ранее
была физически передана Ozon по FBS и однозначно связана с accepted
`LK_RECEIPT/DISTANCE`. Статус Ozon является внешним evidence, но не командой
изменить КМ, custody или склад.

Адаптер `/v3/returns/company/fbs` сохраняет очищенный snapshot, его SHA-256 и
версию контракта. Он не определяет направление возврата. Оператор отдельно
подтверждает:

- `to_seller` или `to_ozon_fbo`;
- был ли товар оплачен покупателем, что влияет на поля `LP_RETURN`.

Если posting/item нельзя связать ровно с одним исходным assignment, unit и КМ,
case получает `manual_review`. Сопоставление только по GTIN, SKU или позиции в
списке запрещено. Production-sync нельзя включать до повторной сверки
актуального ответа Ozon Seller API на реальном read-only запросе.

## Возврат КМ в оборот

Для принятого исходного withdrawal создаётся revisioned документ:

```text
type=LP_RETURN
return_type=REMOTE_SALE_RETURN
```

При `paid=true` payload дополнительно содержит реквизиты первичного документа;
при `paid=false` эти поля не отправляются. Полный КМ, payload и detached
signature хранятся зашифрованно. Неизвестный результат create переводит
документ в ручную сверку и не повторяется вслепую.

Если исходный withdrawal не был принят, no-op разрешён только при свежей
read-only проверке ГИС МТ: КМ `in_circulation`, владелец и GTIN совпадают,
проверка не старше 24 часов. Локальное поле состояния само по себе для no-op
недостаточно.

## Возврат продавцу

```text
Ozon evidence
  -> оператор подтвердил направление и paid
  -> reconciliation исходного withdrawal
  -> LP_RETURN accepted / доказанный no-op
  -> ожидание физической приёмки
  -> оператор указал склад и состояние
```

Внутренний остаток увеличивается на одну единицу только для состояния
`intact` и только в одной транзакции с фиксацией приёмки. Повтор запроса
блокируется version check и состоянием case.

Состояния `relabel_same_code`, `remark_required` и `destroy_pending` переводят
unit в quarantine без складского прихода. Автоматизация повторной этикетки,
перемаркировки и утилизации остаётся отдельным hardening-процессом; текущий
этап не делает повреждённую единицу доступным остатком.

## Переход FBS -> FBO

После принятого возврата КМ в оборот оператор указывает reference приёмки FBO и
reference документа ЭДО. Это аудируемое подтверждение оператора, а не
автоматическая проверка ЭДО API. После него:

- unit остаётся `shipped`;
- custody становится `ozon_fbo`;
- собственный warehouse очищается;
- внутренний остаток не меняется;
- повторный seller withdrawal для последующей FBO-продажи не создаётся.

Автоматическая подготовка/подписание УПД и проверка его terminal status не
входят в этап 12. До интеграции ЭДО закрывать переход можно только после ручной
сверки документов Ozon и ЭДО. Поздний возврат этой FBO-единицы продавцу должен
идти отдельным процессом возврата от агента, а не повторным FBS return case.

## Данные и API

Миграция `0017` добавляет:

- `merch_marking_return_cases`;
- append-only `merch_marking_return_case_events`;
- `merch_marking_return_confirmations`;
- custody `ozon_fbo`;
- `return_to_circulation` documents и safe views;
- узкие `SECURITY DEFINER` transitions без DML-доступа приложения к базовым
  return-таблицам.

Рабочий endpoint: `/api/admin/marking/returns`. В разделе `Честный знак` есть
вкладка `Возвраты` с синхронизацией, подтверждением направления, подготовкой
`LP_RETURN`, физической приёмкой и фиксацией FBO/ЭДО evidence.

## Feature flags

```text
GETOMERCH_MARKING_RETURNS_ENABLED=false
GETOMERCH_MARKING_OZON_RETURNS_SYNC_ENABLED=false
```

Первый flag требует включённых этапов signer, CRPT read/write, introduction,
withdrawal, JIT и pilot allow-lists. Второй дополнительно требует server-only
ключи Ozon. Worker не claim-ит return jobs при выключенных flags.

## Проверки

Пройдены:

- deterministic `LP_RETURN/REMOTE_SALE_RETURN` payload и paid/unpaid ветки;
- строгий Ozon parser без вывода destination из строк статуса;
- clean migration `0001`-`0017` и все SQL checks;
- ACL: у `getomerch_app` нет DML к return-таблицам и ciphertext в safe views;
- duplicate Ozon event и повторная подготовка документа;
- `processing -> accepted -> in_circulation`;
- seller receipt увеличивает остаток ровно один раз;
- CRPT acceptance до физической приёмки не меняет остаток;
- FBS -> FBO меняет custody без складского прихода;
- повтор seller/FBO confirmation блокируется;
- после accepted `LP_RETURN` направление можно исправить с отдельным событием,
  но признак оплаты уже неизменяем;
- quantity `2` без однозначной serial identity уходит в `manual_review`.

## До production rollout

1. Завершить реальные canary этапов 9-11.
2. На read-only запросе подтвердить актуальную схему и пагинацию Ozon FBS
   returns; при расхождении обновить versioned adapter.
3. Применить migration с обоими новыми flags `false` и проверить backup.
4. Включить вкладку возвратов только для pilot allow-list.
5. Вручную провести один возврат продавцу и сверить `LP_RETURN` в ГИС МТ.
6. Отдельно провести один реальный FBS -> FBO со сверкой Ozon/ЭДО evidence.
7. До автоматического закрытия FBO-перехода подключить и проверить ЭДО API.

Контракты: [True API](https://docs.crpt.ru/gismt/True_API/) и
[Ozon Seller API](https://docs.ozon.ru/api/seller/).
